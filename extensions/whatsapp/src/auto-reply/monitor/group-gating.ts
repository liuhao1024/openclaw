import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveWhatsAppGroupsConfigPath } from "../../group-config-path.js";
import {
  getPrimaryIdentityId,
  getReplyContext,
  getSelfIdentity,
  getSenderIdentity,
  identitiesOverlap,
} from "../../identity.js";
import type { WebInboundMessage } from "../../inbound/types.js";
import type { MentionConfig } from "../mentions.js";
import { buildMentionConfig, debugMention, resolveOwnerList } from "../mentions.js";
import { stripMentionsForCommand } from "./commands.js";
import { resolveAcceptedGroupActivationFor } from "./group-activation.js";
import {
  hasControlCommand,
  implicitMentionKindWhen,
  parseActivationCommand,
  createChannelHistoryWindow,
  resolveInboundMentionDecision,
} from "./group-gating.runtime.js";
import type { GroupHistoryEntry } from "./group-history.js";
import { noteGroupMember } from "./group-members.js";
import type {
  WhatsAppGroupActivationFacts,
  WhatsAppGroupGatingResult,
  WhatsAppGroupMentionFacts,
  WhatsAppGroupProcessingFacts,
} from "./processing-facts.js";

export type { GroupHistoryEntry } from "./group-history.js";

type ApplyGroupGatingParams = {
  cfg: OpenClawConfig;
  msg: WebInboundMessage;
  mentionText?: string;
  deferMissingMention?: boolean;
  groupHistoryKey: string;
  agentId: string;
  sessionKey: string;
  baseMentionConfig: MentionConfig;
  authDir?: string;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupHistoryLimit: number;
  groupMemberNames: Map<string, Map<string, string>>;
  selfChatMode?: boolean;
  logVerbose: (msg: string) => void;
  replyLogger: {
    debug: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
  };
};

const MAX_GROUP_DROP_WARNINGS = 100;
const groupDropWarned = new Set<string>();

export function resetGroupDropWarningsForTests() {
  groupDropWarned.clear();
}

function shouldWarnForGroupDrop(warnKey: string): boolean {
  if (groupDropWarned.has(warnKey)) {
    return false;
  }
  groupDropWarned.add(warnKey);
  while (groupDropWarned.size > MAX_GROUP_DROP_WARNINGS) {
    const oldest = groupDropWarned.values().next().value;
    if (!oldest) {
      break;
    }
    groupDropWarned.delete(oldest);
  }
  return true;
}

function isOwnerSender(baseMentionConfig: MentionConfig, msg: WebInboundMessage) {
  const sender = getSenderIdentity(msg).e164;
  if (!sender) {
    return false;
  }
  const owners = resolveOwnerList(baseMentionConfig, getSelfIdentity(msg).e164 ?? undefined);
  return owners.includes(sender);
}

function recordPendingGroupHistoryEntry(params: {
  msg: WebInboundMessage;
  body?: string;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupHistoryKey: string;
  groupHistoryLimit: number;
}) {
  const senderIdentity = getSenderIdentity(params.msg);
  const admittedSenderId = senderIdentity.e164 ?? undefined;
  const sender =
    senderIdentity.name && admittedSenderId
      ? `${senderIdentity.name} (${admittedSenderId})`
      : (senderIdentity.name ??
        admittedSenderId ??
        getPrimaryIdentityId(senderIdentity) ??
        "Unknown");
  createChannelHistoryWindow({ historyMap: params.groupHistories }).record({
    historyKey: params.groupHistoryKey,
    limit: params.groupHistoryLimit,
    entry: {
      sender,
      body: params.body ?? params.msg.payload.body,
      timestamp: params.msg.event.timestamp,
      id: params.msg.event.id,
      senderJid: senderIdentity.jid ?? params.msg.platform.senderJid,
    },
  });
}

function skipGroupMessageAndStoreHistory(
  params: ApplyGroupGatingParams,
  verboseMessage: string,
  processingFacts: WhatsAppGroupProcessingFacts,
  body?: string,
): WhatsAppGroupGatingResult {
  params.logVerbose(verboseMessage);
  recordPendingGroupHistoryEntry({
    msg: params.msg,
    body,
    groupHistories: params.groupHistories,
    groupHistoryKey: params.groupHistoryKey,
    groupHistoryLimit: params.groupHistoryLimit,
  });
  return { shouldProcess: false, ...processingFacts };
}

const unmentionedFacts = (): WhatsAppGroupProcessingFacts => ({
  mention: {
    effectiveWasMentioned: false,
    shouldBypassMention: false,
  },
  activation: {
    kind: "absent",
    reason: "not_reached",
  },
});

function activationFactsFor(
  msg: WebInboundMessage,
  activation: Awaited<ReturnType<typeof resolveAcceptedGroupActivationFor>>,
): WhatsAppGroupActivationFacts {
  return {
    kind: "known",
    active: activation === "always",
    defaultRequiresMention: msg.admission.conversation.requireMention,
  };
}

export async function applyGroupGating(
  params: ApplyGroupGatingParams,
): Promise<WhatsAppGroupGatingResult> {
  const sender = getSenderIdentity(params.msg);
  const self = getSelfIdentity(params.msg, params.authDir);
  const admission = params.msg.admission;
  const conversationId = admission.conversation.id;
  const admittedSender = sender;
  const resolvedPolicy = admission.resolvedPolicy;
  const groupAllowlist = resolvedPolicy.groupAllowlist;
  if (groupAllowlist.allowlistEnabled && !groupAllowlist.allowed) {
    const accountId = admission.accountId;
    const warnKey = `${accountId}:${conversationId}`;
    if (shouldWarnForGroupDrop(warnKey)) {
      const groupsPath = resolveWhatsAppGroupsConfigPath({ cfg: params.cfg, accountId });
      params.replyLogger.warn(
        { conversationId, accountId, groupsPath },
        `WhatsApp group ${conversationId} not in ${groupsPath} — inbound dropped. Add the group JID to ${groupsPath} (or add "*" there to admit all groups). Sender authorization still applies.`,
      );
    }
    params.logVerbose(
      `Dropping message from unregistered WhatsApp group ${conversationId}. Add the group JID to channels.whatsapp.groups, or add "*" there to admit all groups. Sender authorization still applies.`,
    );
    return { shouldProcess: false, ...unmentionedFacts() };
  }

  noteGroupMember(
    params.groupMemberNames,
    params.groupHistoryKey,
    sender.e164 ?? undefined,
    sender.name ?? undefined,
  );

  const baseMentionConfig = {
    ...params.baseMentionConfig,
    allowFrom: resolvedPolicy.configuredAllowFrom,
  };
  const mentionConfig = {
    ...buildMentionConfig(params.cfg, params.agentId),
    allowFrom: resolvedPolicy.configuredAllowFrom,
  };
  const mentionMsg =
    params.mentionText !== undefined
      ? { ...params.msg, payload: { ...params.msg.payload, body: params.mentionText } }
      : params.msg;
  const commandBody = stripMentionsForCommand(
    mentionMsg.payload.body,
    mentionConfig.mentionRegexes,
    self.e164,
  );
  const activationCommand = parseActivationCommand(commandBody);
  const owner = isOwnerSender(baseMentionConfig, params.msg);
  const hasControlCommandBody = hasControlCommand(commandBody, params.cfg);
  const shouldBypassMention = owner && hasControlCommandBody;

  if (activationCommand.hasCommand && !owner) {
    return skipGroupMessageAndStoreHistory(
      params,
      `Ignoring /activation from non-owner in group ${conversationId}`,
      unmentionedFacts(),
    );
  }

  const mentionDebug = debugMention(mentionMsg, mentionConfig, params.authDir);
  params.replyLogger.debug(
    {
      conversationId,
      wasMentioned: mentionDebug.wasMentioned,
      ...mentionDebug.details,
    },
    "group mention debug",
  );
  const wasMentioned = mentionDebug.wasMentioned;
  const activation = await resolveAcceptedGroupActivationFor({
    cfg: params.cfg,
    msg: params.msg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const activationFacts = activationFactsFor(params.msg, activation);
  const requireMention = activation !== "always";
  const replyContext = getReplyContext(params.msg, params.authDir);
  const sharedNumberSelfChat = params.selfChatMode === true;
  // Detect reply-to-bot: compare JIDs, LIDs, and E.164 numbers.
  // WhatsApp may report the quoted message sender as either a phone JID
  // (xxxxx@s.whatsapp.net) or a LID (xxxxx@lid), so we compare both.
  // But in shared-number/selfChatMode setups, replies from the same self number
  // should not count as implicit bot mentions unless the message explicitly
  // mentioned the bot in text.
  const implicitReplyToSelf = sharedNumberSelfChat && identitiesOverlap(self, admittedSender);
  const implicitMentionKinds = implicitMentionKindWhen(
    "quoted_bot",
    !implicitReplyToSelf && identitiesOverlap(self, replyContext?.sender),
  );
  const mentionDecision = resolveInboundMentionDecision({
    facts: {
      canDetectMention: true,
      wasMentioned,
      implicitMentionKinds,
    },
    policy: {
      isGroup: true,
      requireMention,
      allowTextCommands: false,
      hasControlCommand: false,
      commandAuthorized: false,
    },
  });
  const effectiveWasMentioned = mentionDecision.effectiveWasMentioned || shouldBypassMention;
  const mentionFacts: WhatsAppGroupMentionFacts = {
    effectiveWasMentioned,
    shouldBypassMention,
  };
  if (!shouldBypassMention && requireMention && mentionDecision.shouldSkip) {
    if (params.deferMissingMention === true) {
      params.logVerbose(
        `Deferring group mention skip until audio preflight completes in ${conversationId}`,
      );
      return {
        shouldProcess: false,
        mention: {
          ...mentionFacts,
          needsMentionText: true,
        },
        activation: activationFacts,
      };
    }
    return skipGroupMessageAndStoreHistory(
      params,
      `Group message stored for context (no mention detected) in ${conversationId}: ${mentionMsg.payload.body}`,
      {
        mention: mentionFacts,
        activation: activationFacts,
      },
      params.mentionText,
    );
  }

  return {
    shouldProcess: true,
    mention: mentionFacts,
    activation: activationFacts,
  };
}
