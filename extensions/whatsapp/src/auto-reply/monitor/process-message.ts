import {
  logAckFailure,
  removeAckReactionHandleAfterReply,
} from "openclaw/plugin-sdk/channel-feedback";
import {
  runChannelInboundEvent,
  type CommandTurnContext,
} from "openclaw/plugin-sdk/channel-inbound";
import { recordInboundSession } from "openclaw/plugin-sdk/conversation-runtime";
import {
  createInternalHookEvent,
  deriveInboundMessageHookContext,
  fireAndForgetBoundedHook,
  toInternalMessageReceivedContext,
  toPluginMessageContext,
  toPluginMessageReceivedEvent,
  triggerInternalHook,
} from "openclaw/plugin-sdk/hook-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveBatchedReplyThreadingPolicy } from "openclaw/plugin-sdk/reply-reference";
import { getSenderIdentity } from "../../identity.js";
import { resolveWhatsAppCommandAccess } from "../../inbound-policy.js";
import type { WebInboundMessage } from "../../inbound/types.js";
import { newConnectionId } from "../../reconnect.js";
import { formatError } from "../../session.js";
import { deliverWebReply } from "../deliver-reply.js";
import { whatsappInboundLog } from "../loggers.js";
import { elide } from "../util.js";
import {
  resolveWhatsAppAudioPreflightTranscript,
  resolveWhatsAppAudioPreflightInput,
  transcribeWhatsAppAudioPreflight,
} from "./audio-preflight.js";
import type { GroupHistoryEntry } from "./group-history.js";
import {
  resolveVisibleWhatsAppGroupHistory,
  resolveVisibleWhatsAppReplyContext,
} from "./inbound-context.js";
import {
  buildWhatsAppInboundContext,
  dispatchWhatsAppBufferedReply,
  resolveWhatsAppDmRouteTarget,
  resolveWhatsAppResponsePrefix,
  updateWhatsAppMainLastRoute,
} from "./inbound-dispatch.js";
import { trackBackgroundTask, updateLastRouteInBackground } from "./last-route.js";
import { buildInboundLine } from "./message-line.js";
import type { WhatsAppProcessMessageHandoff } from "./process-handoff.js";
import { startWhatsAppReceiptFeedback } from "./receipt-feedback.js";
import {
  buildHistoryContextFromEntries,
  createChannelMessageReplyPipeline,
  formatInboundEnvelope,
  logVerbose,
  normalizeE164,
  resolveInboundSessionEnvelopeContext,
  resolvePinnedMainDmOwnerFromAllowlist,
  isControlCommandMessage,
  shouldComputeCommandAuthorized,
  shouldLogVerbose,
  type getChildLogger,
  type getReplyFromConfig,
  type HistoryEntry,
  type LoadConfigFn,
  type resolveAgentRoute,
} from "./runtime-api.js";

const WHATSAPP_MESSAGE_RECEIVED_HOOK_LIMITS = {
  maxConcurrency: 8,
  maxQueue: 128,
  timeoutMs: 2_000,
};

type WhatsAppMessageReceivedHookConfig = {
  pluginHooks?: {
    messageReceived?: boolean;
  };
  accounts?: Record<string, unknown>;
};

function readWhatsAppMessageReceivedHookOptIn(value: unknown): boolean | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const pluginHooks = (value as WhatsAppMessageReceivedHookConfig).pluginHooks;
  if (pluginHooks?.messageReceived === undefined) {
    return undefined;
  }
  return pluginHooks.messageReceived;
}

function shouldEmitWhatsAppMessageReceivedHooks(params: {
  cfg: ReturnType<LoadConfigFn>;
  accountId?: string;
}): boolean {
  const channelConfig = params.cfg.channels?.whatsapp as
    | WhatsAppMessageReceivedHookConfig
    | undefined;
  const accountConfig =
    params.accountId && channelConfig?.accounts
      ? channelConfig.accounts[params.accountId]
      : undefined;

  return (
    readWhatsAppMessageReceivedHookOptIn(accountConfig) ??
    readWhatsAppMessageReceivedHookOptIn(channelConfig) ??
    false
  );
}

function emitWhatsAppMessageReceivedHooks(params: {
  ctx: Awaited<ReturnType<typeof buildWhatsAppInboundContext>>;
  sessionKey: string;
}): void {
  const canonical = deriveInboundMessageHookContext(params.ctx);
  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("message_received")) {
    fireAndForgetBoundedHook(
      () =>
        hookRunner.runMessageReceived(
          toPluginMessageReceivedEvent(canonical),
          toPluginMessageContext(canonical),
        ),
      "whatsapp: message_received plugin hook failed",
      undefined,
      WHATSAPP_MESSAGE_RECEIVED_HOOK_LIMITS,
    );
  }
  fireAndForgetBoundedHook(
    () =>
      triggerInternalHook(
        createInternalHookEvent(
          "message",
          "received",
          params.sessionKey,
          toInternalMessageReceivedContext(canonical),
        ),
      ),
    "whatsapp: message_received internal hook failed",
    undefined,
    WHATSAPP_MESSAGE_RECEIVED_HOOK_LIMITS,
  );
}

function emitWhatsAppMessageReceivedHooksIfEnabled(params: {
  cfg: ReturnType<LoadConfigFn>;
  ctx: Awaited<ReturnType<typeof buildWhatsAppInboundContext>>;
  accountId?: string;
  sessionKey: string;
}): void {
  if (
    !shouldEmitWhatsAppMessageReceivedHooks({
      cfg: params.cfg,
      accountId: params.accountId,
    })
  ) {
    return;
  }

  emitWhatsAppMessageReceivedHooks({
    ctx: params.ctx,
    sessionKey: params.sessionKey,
  });
}

function resolvePinnedMainDmRecipient(params: {
  cfg: ReturnType<LoadConfigFn>;
  allowFrom?: string[];
}): string | null {
  return resolvePinnedMainDmOwnerFromAllowlist({
    dmScope: params.cfg.session?.dmScope,
    allowFrom: params.allowFrom,
    normalizeEntry: (entry) => normalizeE164(entry),
  });
}

type ProcessMessageParams = {
  cfg: ReturnType<LoadConfigFn>;
  msg: WebInboundMessage;
  route: ReturnType<typeof resolveAgentRoute>;
  groupHistoryKey: string;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupMemberNames: Map<string, Map<string, string>>;
  connectionId: string;
  verbose: boolean;
  maxMediaBytes: number;
  replyResolver: typeof getReplyFromConfig;
  replyLogger: ReturnType<typeof getChildLogger>;
  backgroundTasks: Set<Promise<unknown>>;
  rememberSentText: (
    text: string | undefined,
    opts: {
      combinedBody?: string;
      combinedBodySessionKey?: string;
      logVerboseMessage?: boolean;
    },
  ) => void;
  echoHas: (key: string) => boolean;
  echoForget: (key: string) => void;
  buildCombinedEchoKey: (p: { sessionKey: string; combinedBody: string }) => string;
  maxMediaTextChunkLimit?: number;
} & WhatsAppProcessMessageHandoff;

export async function processMessage(params: ProcessMessageParams) {
  const admission = params.msg.admission;
  const resolvedPolicy = admission.resolvedPolicy;
  const event = params.msg.event;
  const payload = params.msg.payload;
  const media = payload.media;
  const platform = params.msg.platform;
  const conversationId = admission.conversation.id;
  const chatType = admission.conversation.kind;
  const accountId = admission.accountId;
  const admittedAccount = admission.account;
  const audioPreflightInput = resolveWhatsAppAudioPreflightInput({
    msg: params.msg,
  });
  const resolveContextVisibilityMode = () => resolvedPolicy.contextVisibility.mode ?? "all";
  const { storePath, envelopeOptions, previousTimestamp } = resolveInboundSessionEnvelopeContext({
    cfg: params.cfg,
    agentId: params.route.agentId,
    sessionKey: params.route.sessionKey,
  });
  let audioPreflight = params.audioPreflight;
  if (audioPreflight.kind === "not_provided" && audioPreflightInput.kind === "available") {
    audioPreflight = await transcribeWhatsAppAudioPreflight({
      input: audioPreflightInput.input,
      cfg: params.cfg,
      onError: () => {
        // Transcription failure is non-fatal: fall back to <media:audio> placeholder.
        if (shouldLogVerbose()) {
          logVerbose("whatsapp: audio preflight transcription failed, using placeholder");
        }
      },
    });
  }
  const audioTranscript = resolveWhatsAppAudioPreflightTranscript(audioPreflight);

  // If we have a transcript, replace the agent-facing body so the agent sees the spoken text.
  // mediaPath and mediaType are intentionally preserved so that inboundAudio detection
  // (used by features such as messages.tts.auto: "inbound") still sees this as an
  // audio message. The transcript and transcribed media index are also stored on
  // context so downstream media understanding does not transcribe it again.
  const msgForAgent =
    audioTranscript !== undefined
      ? { ...params.msg, payload: { ...params.msg.payload, body: audioTranscript } }
      : params.msg;

  let combinedBody = buildInboundLine({
    cfg: params.cfg,
    msg: msgForAgent,
    agentId: params.route.agentId,
    previousTimestamp,
    envelope: envelopeOptions,
  });
  let shouldClearGroupHistory = false;
  const rawGroupHistory =
    chatType === "group"
      ? (params.groupHistory ?? params.groupHistories.get(params.groupHistoryKey) ?? [])
      : undefined;
  const visibleGroupHistory =
    rawGroupHistory && rawGroupHistory.length > 0
      ? resolveVisibleWhatsAppGroupHistory({
          history: rawGroupHistory,
          mode: resolveContextVisibilityMode(),
          groupPolicy: resolvedPolicy.contextVisibility.groupPolicy,
          groupAllowFrom: resolvedPolicy.contextVisibility.groupAllowFrom,
        })
      : rawGroupHistory;

  if (chatType === "group") {
    const history = visibleGroupHistory ?? [];
    if (history.length > 0) {
      const historyEntries: HistoryEntry[] = history.map((m) => ({
        sender: m.sender,
        body: m.body,
        timestamp: m.timestamp,
      }));
      combinedBody = buildHistoryContextFromEntries({
        entries: historyEntries,
        currentMessage: combinedBody,
        excludeLast: false,
        formatEntry: (entry) => {
          return formatInboundEnvelope({
            channel: "WhatsApp",
            from: conversationId,
            timestamp: entry.timestamp,
            body: entry.body,
            chatType: "group",
            senderLabel: entry.sender,
            envelope: envelopeOptions,
          });
        },
      });
    }
    shouldClearGroupHistory = !(params.suppressGroupHistoryClear ?? false);
  }

  // Echo detection uses combined body so we don't respond twice.
  const combinedEchoKey = params.buildCombinedEchoKey({
    sessionKey: params.route.sessionKey,
    combinedBody,
  });
  if (params.echoHas(combinedEchoKey)) {
    logVerbose("Skipping auto-reply: detected echo for combined message");
    params.echoForget(combinedEchoKey);
    return false;
  }

  // Send ack reaction immediately upon message receipt (post-gating). Callers
  // that do preflight work before processMessage can send it first and set
  // ackAlreadySent so slow STT does not delay user-visible receipt feedback.
  // Skip if the status reaction controller is handling lifecycle signaling.
  let statusReactionController = params.statusReactionController ?? null;
  let ackReaction = params.ackReaction ?? null;
  const shouldStartReceiptFeedback =
    !statusReactionController &&
    params.ackAlreadySent !== true &&
    (params.cfg.messages?.statusReactions?.enabled === true || !ackReaction);
  if (shouldStartReceiptFeedback) {
    const receiptFeedback = await startWhatsAppReceiptFeedback({
      cfg: params.cfg,
      msg: params.msg,
      agentId: params.route.agentId,
      verbose: params.verbose,
      routeLifecycle: params.routeLifecycle,
      queueStatusReaction: "background",
      info: params.replyLogger.info.bind(params.replyLogger),
      warn: params.replyLogger.warn.bind(params.replyLogger),
    });
    if (receiptFeedback.kind === "status") {
      statusReactionController = receiptFeedback.statusReactionController;
    } else if (receiptFeedback.kind === "ack") {
      ackReaction = receiptFeedback.ackReaction;
    }
  }

  const correlationId = event.id ?? newConnectionId();
  params.replyLogger.info(
    {
      connectionId: params.connectionId,
      correlationId,
      from: conversationId,
      to: platform.recipientJid,
      body: elide(combinedBody, 240),
      mediaType: media?.type ?? null,
      mediaPath: media?.path ?? null,
    },
    "inbound web message",
  );

  const fromDisplay = conversationId;
  const kindLabel = media?.type ? `, ${media.type}` : "";
  whatsappInboundLog.info(
    `Inbound message ${fromDisplay} -> ${platform.recipientJid} (${chatType}${kindLabel}, ${combinedBody.length} chars)`,
  );
  if (shouldLogVerbose()) {
    whatsappInboundLog.debug(`Inbound body: ${elide(combinedBody, 400)}`);
  }

  const sender = getSenderIdentity(params.msg);
  const admittedSenderE164 = sender.e164 ?? undefined;
  const visibleReplyTo = params.msg.quote
    ? resolveVisibleWhatsAppReplyContext({
        msg: params.msg,
        authDir: admittedAccount.authDir,
        mode: resolveContextVisibilityMode(),
        groupPolicy: resolvedPolicy.contextVisibility.groupPolicy,
        groupAllowFrom: resolvedPolicy.contextVisibility.groupAllowFrom,
      })
    : null;
  const dmRouteTarget = resolveWhatsAppDmRouteTarget({
    msg: params.msg,
    normalizeE164,
  });
  const shouldCheckCommandAuth = shouldComputeCommandAuthorized(payload.body, params.cfg);
  const isTextCommand = isControlCommandMessage(payload.body, params.cfg);
  const commandAccess = shouldCheckCommandAuth
    ? resolveWhatsAppCommandAccess({
        admission,
        commandBody: payload.body,
      })
    : undefined;
  const commandAuthorized = commandAccess?.authorized;
  const commandTurn: CommandTurnContext = isTextCommand
    ? {
        kind: "text-slash",
        source: "text",
        authorized: Boolean(commandAuthorized),
        body: payload.body,
      }
    : {
        kind: "normal",
        source: "message",
        authorized: false,
        body: payload.body,
      };
  const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
    cfg: params.cfg,
    agentId: params.route.agentId,
    channel: "whatsapp",
    accountId,
  });
  const responsePrefix = resolveWhatsAppResponsePrefix({
    cfg: params.cfg,
    agentId: params.route.agentId,
    isSelfChat: chatType !== "group" && admission.isSelfChat,
    pipelineResponsePrefix: replyPipeline.responsePrefix,
  });
  const replyThreading = resolveBatchedReplyThreadingPolicy(
    admittedAccount.replyToMode ?? "off",
    event.isBatched === true,
  );

  const conversationSystemPrompt = resolvedPolicy.systemPrompt;

  const ctxPayload = buildWhatsAppInboundContext({
    bodyForAgent: msgForAgent.payload.body,
    combinedBody,
    commandBody: payload.body,
    commandAuthorized,
    commandTurn,
    groupHistory: visibleGroupHistory,
    groupMemberRoster: params.groupMemberNames.get(params.groupHistoryKey),
    groupSystemPrompt: conversationSystemPrompt,
    msg: params.msg,
    rawBody: payload.body,
    route: params.route,
    sender: {
      id: admission.sender.id || undefined,
      name: sender.name ?? undefined,
      e164: admittedSenderE164,
    },
    ...(audioTranscript !== undefined ? { transcript: audioTranscript } : {}),
    ...(audioTranscript !== undefined ? { mediaTranscribedIndexes: [0] } : {}),
    replyThreading,
    visibleReplyTo: visibleReplyTo ?? undefined,
    wasMentioned:
      params.routeLifecycle.kind === "group"
        ? params.routeLifecycle.processingFacts.mention.effectiveWasMentioned
        : undefined,
  });
  emitWhatsAppMessageReceivedHooksIfEnabled({
    cfg: params.cfg,
    ctx: ctxPayload,
    accountId,
    sessionKey: params.route.sessionKey,
  });

  const pinnedMainDmRecipient = resolvePinnedMainDmRecipient({
    cfg: params.cfg,
    allowFrom: resolvedPolicy.configuredAllowFrom,
  });
  updateWhatsAppMainLastRoute({
    backgroundTasks: params.backgroundTasks,
    cfg: params.cfg,
    ctx: ctxPayload,
    dmRouteTarget,
    pinnedMainDmRecipient,
    route: params.route,
    updateLastRoute: updateLastRouteInBackground,
    warn: params.replyLogger.warn.bind(params.replyLogger),
  });

  const turnResult = await runChannelInboundEvent({
    channel: "whatsapp",
    accountId,
    raw: params.msg,
    adapter: {
      ingest: () => ({
        id: event.id ?? `${conversationId}:${Date.now()}`,
        timestamp: event.timestamp,
        rawText: ctxPayload.RawBody ?? "",
        textForAgent: ctxPayload.BodyForAgent,
        textForCommands: ctxPayload.CommandBody,
        raw: params.msg,
      }),
      resolveTurn: () => ({
        channel: "whatsapp",
        accountId,
        routeSessionKey: params.route.sessionKey,
        storePath,
        ctxPayload,
        recordInboundSession,
        record: {
          onRecordError: (err) => {
            params.replyLogger.warn(
              {
                error: formatError(err),
                storePath,
                sessionKey: params.route.sessionKey,
              },
              "failed updating session meta",
            );
          },
          trackSessionMetaTask: (task) => {
            trackBackgroundTask(params.backgroundTasks, task);
          },
        },
        runDispatch: () =>
          dispatchWhatsAppBufferedReply({
            cfg: params.cfg,
            connectionId: params.connectionId,
            context: ctxPayload,
            conversationId,
            deliverReply: deliverWebReply,
            groupHistories: params.groupHistories,
            groupHistoryKey: params.groupHistoryKey,
            maxMediaBytes: params.maxMediaBytes,
            maxMediaTextChunkLimit: params.maxMediaTextChunkLimit,
            msg: params.msg,
            onModelSelected,
            rememberSentText: params.rememberSentText,
            replyLogger: params.replyLogger,
            replyPipeline: {
              ...replyPipeline,
              responsePrefix,
            },
            replyResolver: params.replyResolver,
            route: params.route,
            shouldClearGroupHistory,
            statusReactionController,
          }),
      }),
    },
  });
  const didSendReply = turnResult.dispatched ? turnResult.dispatchResult : false;
  removeAckReactionHandleAfterReply({
    removeAfterReply: Boolean(params.cfg.messages?.removeAckAfterReply && didSendReply),
    ackReaction,
    onError: (err) => {
      logAckFailure({
        log: logVerbose,
        channel: "whatsapp",
        target: `${conversationId}/${event.id ?? "unknown"}`,
        error: err,
      });
    },
  });
  return didSendReply;
}
