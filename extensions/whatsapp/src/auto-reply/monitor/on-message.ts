import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { getReplyFromConfig } from "openclaw/plugin-sdk/reply-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { buildGroupHistoryKey } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveWhatsAppGroupSessionRoute } from "../../group-session-key.js";
import { getSenderIdentity } from "../../identity.js";
import type { WebInboundMessage } from "../../inbound/types.js";
import { buildMentionConfig } from "../mentions.js";
import type { MentionConfig } from "../mentions.js";
import {
  WHATSAPP_AUDIO_PREFLIGHT_NOT_AUDIO,
  WHATSAPP_AUDIO_PREFLIGHT_NOT_PROVIDED,
  type WhatsAppAudioPreflightResult,
  resolveWhatsAppAudioPreflightTranscript,
  resolveWhatsAppAudioPreflightInput,
  transcribeWhatsAppAudioPreflight,
} from "./audio-preflight.js";
import { maybeBroadcastMessage } from "./broadcast.js";
import type { EchoTracker } from "./echo.js";
import { applyGroupGating } from "./group-gating.js";
import type { GroupHistoryEntry } from "./group-history.js";
import { updateLastRouteInBackground } from "./last-route.js";
import { resolvePeerId } from "./peer.js";
import {
  WHATSAPP_DIRECT_ROUTE_LIFECYCLE,
  WHATSAPP_NO_RECEIPT_FEEDBACK,
  createWhatsAppBroadcastReceiptFeedbackHandoff,
  createWhatsAppGroupRouteLifecycle,
  createWhatsAppReceiptFeedbackHandoff,
  type WhatsAppProcessMessageHandoff,
  type WhatsAppReceiptFeedback,
  type WhatsAppRouteLifecycleFacts,
} from "./process-handoff.js";
import { processMessage } from "./process-message.js";
import {
  finalizeWhatsAppStatusReaction,
  startWhatsAppReceiptFeedback,
} from "./receipt-feedback.js";

export function createWebOnMessageHandler(params: {
  cfg: OpenClawConfig;
  loadConfig?: () => OpenClawConfig;
  verbose: boolean;
  connectionId: string;
  maxMediaBytes: number;
  groupHistoryLimit: number;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupMemberNames: Map<string, Map<string, string>>;
  echoTracker: EchoTracker;
  backgroundTasks: Set<Promise<unknown>>;
  replyResolver: typeof getReplyFromConfig;
  replyLogger: ReturnType<(typeof import("openclaw/plugin-sdk/runtime-env"))["getChildLogger"]>;
  baseMentionConfig: MentionConfig;
}) {
  const processForRoute = async (
    cfg: OpenClawConfig,
    msg: WebInboundMessage,
    route: ReturnType<typeof resolveAgentRoute>,
    groupHistoryKey: string,
    opts: WhatsAppProcessMessageHandoff,
  ) => {
    const processParams: Parameters<typeof processMessage>[0] = {
      cfg,
      msg,
      route,
      ...opts,
      groupHistoryKey,
      groupHistories: params.groupHistories,
      groupMemberNames: params.groupMemberNames,
      connectionId: params.connectionId,
      verbose: params.verbose,
      maxMediaBytes: params.maxMediaBytes,
      replyResolver: params.replyResolver,
      replyLogger: params.replyLogger,
      backgroundTasks: params.backgroundTasks,
      rememberSentText: params.echoTracker.rememberText,
      echoHas: params.echoTracker.has,
      echoForget: params.echoTracker.forget,
      buildCombinedEchoKey: params.echoTracker.buildCombinedKey,
    };
    return processMessage(processParams);
  };

  return async (msg: WebInboundMessage) => {
    const cfg = params.loadConfig?.() ?? params.cfg;
    const admittedAccountId = msg.admission.accountId;
    const conversationId = msg.admission.conversation.id;
    const chatType = msg.admission.conversation.kind;
    const peerId = resolvePeerId(msg);
    const baseRoute = resolveAgentRoute({
      cfg,
      channel: "whatsapp",
      accountId: admittedAccountId,
      peer: {
        kind: chatType === "group" ? "group" : "direct",
        id: peerId,
      },
    });
    const route = chatType === "group" ? resolveWhatsAppGroupSessionRoute(baseRoute) : baseRoute;
    const groupHistoryKey =
      chatType === "group"
        ? buildGroupHistoryKey({
            channel: "whatsapp",
            accountId: route.accountId,
            peerKind: "group",
            peerId,
          })
        : route.sessionKey;
    const baseMentionConfig = buildMentionConfig(cfg);

    // Same-phone mode logging retained.
    if (conversationId === msg.platform.recipientJid) {
      logVerbose(`📱 Same-phone mode detected (from === to: ${conversationId})`);
    }

    // Skip if this is a message we just sent (echo detection)
    if (params.echoTracker.has(msg.payload.body)) {
      logVerbose("Skipping auto-reply: detected echo (message matches recently sent text)");
      params.echoTracker.forget(msg.payload.body);
      return;
    }

    // Preflight audio transcription: run once before broadcast fan-out so all
    // agents share the same transcript instead of each making a separate STT call.
    // For DMs, only do this on the real inbound path after access-control/pairing
    // checks have already passed in inbound/monitor.ts. For groups, the first
    // gating pass must approve the group/sender before STT is attempted.
    const audioPreflightInput = resolveWhatsAppAudioPreflightInput({
      msg,
    });
    let audioPreflight: WhatsAppAudioPreflightResult =
      audioPreflightInput.kind === "available"
        ? WHATSAPP_AUDIO_PREFLIGHT_NOT_PROVIDED
        : WHATSAPP_AUDIO_PREFLIGHT_NOT_AUDIO;
    let routeLifecycle: WhatsAppRouteLifecycleFacts = WHATSAPP_DIRECT_ROUTE_LIFECYCLE;
    let receiptFeedback: WhatsAppReceiptFeedback = WHATSAPP_NO_RECEIPT_FEEDBACK;
    const runAudioPreflightOnce = async () => {
      if (audioPreflight.kind !== "not_provided" || audioPreflightInput.kind !== "available") {
        return;
      }
      receiptFeedback = await startWhatsAppReceiptFeedback({
        cfg,
        msg,
        agentId: route.agentId,
        verbose: params.verbose,
        routeLifecycle,
        queueStatusReaction: "await",
        info: params.replyLogger.info.bind(params.replyLogger),
        warn: params.replyLogger.warn.bind(params.replyLogger),
      });
      audioPreflight = await transcribeWhatsAppAudioPreflight({
        input: audioPreflightInput.input,
        cfg,
      });
    };
    const finalizeDroppedReceiptFeedback = async () => {
      if (receiptFeedback.kind !== "status") {
        return;
      }
      await finalizeWhatsAppStatusReaction({
        cfg,
        controller: receiptFeedback.statusReactionController,
        outcome: "error",
        hasFinalResponse: false,
      });
      receiptFeedback = WHATSAPP_NO_RECEIPT_FEEDBACK;
    };

    if (chatType === "group") {
      const groupMsg = msg;
      const sender = getSenderIdentity(msg);
      const senderE164 = sender.e164 ?? undefined;
      const metaCtx = {
        From: conversationId,
        To: msg.platform.recipientJid,
        SessionKey: route.sessionKey,
        AccountId: admittedAccountId,
        ChatType: chatType,
        ConversationLabel: conversationId,
        GroupSubject: msg.group?.subject,
        SenderName: sender.name ?? undefined,
        SenderId: msg.admission.sender.id,
        SenderE164: senderE164,
        Provider: "whatsapp",
        Surface: "whatsapp",
        OriginatingChannel: "whatsapp",
        OriginatingTo: conversationId,
      } satisfies MsgContext;
      updateLastRouteInBackground({
        cfg,
        backgroundTasks: params.backgroundTasks,
        storeAgentId: route.agentId,
        sessionKey: route.sessionKey,
        channel: "whatsapp",
        to: conversationId,
        accountId: route.accountId,
        ctx: metaCtx,
        warn: params.replyLogger.warn.bind(params.replyLogger),
      });

      let gating = await applyGroupGating({
        cfg,
        msg: groupMsg,
        deferMissingMention: audioPreflightInput.kind === "available",
        groupHistoryKey,
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        baseMentionConfig,
        authDir: msg.admission.account.authDir,
        selfChatMode: msg.admission.account.selfChatMode,
        groupHistories: params.groupHistories,
        groupHistoryLimit: params.groupHistoryLimit,
        groupMemberNames: params.groupMemberNames,
        logVerbose,
        replyLogger: params.replyLogger,
      });
      if (!gating.shouldProcess && gating.mention.needsMentionText === true) {
        routeLifecycle = createWhatsAppGroupRouteLifecycle(gating);
        await runAudioPreflightOnce();
        const audioTranscript = resolveWhatsAppAudioPreflightTranscript(audioPreflight);
        gating = await applyGroupGating({
          cfg,
          msg: groupMsg,
          ...(audioTranscript !== undefined ? { mentionText: audioTranscript } : {}),
          groupHistoryKey,
          agentId: route.agentId,
          sessionKey: route.sessionKey,
          baseMentionConfig,
          authDir: msg.admission.account.authDir,
          selfChatMode: msg.admission.account.selfChatMode,
          groupHistories: params.groupHistories,
          groupHistoryLimit: params.groupHistoryLimit,
          groupMemberNames: params.groupMemberNames,
          logVerbose,
          replyLogger: params.replyLogger,
        });
      }
      if (!gating.shouldProcess) {
        await finalizeDroppedReceiptFeedback();
        return;
      }
      routeLifecycle = createWhatsAppGroupRouteLifecycle(gating);
    }

    await runAudioPreflightOnce();

    // Broadcast groups: when we'd reply anyway, run multiple agents.
    // Does not bypass group mention/activation gating above.
    if (
      await maybeBroadcastMessage({
        cfg,
        msg,
        peerId,
        route,
        groupHistoryKey,
        groupHistories: params.groupHistories,
        audioPreflight,
        routeLifecycle,
        ...createWhatsAppBroadcastReceiptFeedbackHandoff({
          feedback: receiptFeedback,
          chatType,
        }),
        processMessage: (m, r, k, opts) => processForRoute(cfg, m, r, k, opts),
      })
    ) {
      return;
    }

    await processForRoute(cfg, msg, route, groupHistoryKey, {
      audioPreflight,
      routeLifecycle,
      ...createWhatsAppReceiptFeedbackHandoff(receiptFeedback),
    });
  };
}
