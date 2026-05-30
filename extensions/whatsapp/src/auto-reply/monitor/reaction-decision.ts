import { shouldAckReactionForWhatsApp } from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getSenderIdentity } from "../../identity.js";
import type { WebInboundMessage } from "../../inbound/types.js";
import { resolveWhatsAppReactionLevel } from "../../reaction-level.js";
import type { sendReactionWhatsApp } from "../../send.js";
import { resolveWhatsAppAckEmoji } from "./ack-emoji.js";
import type { WhatsAppRouteLifecycleFacts } from "./process-handoff.js";

export type WhatsAppReactionDecision = {
  emoji: string;
  accountId: string;
};

type WhatsAppReactionSendOptions = Parameters<typeof sendReactionWhatsApp>[3];

export type WhatsAppReactionTarget = WhatsAppReactionDecision & {
  chatId: string;
  messageId: string;
  sendOptions: WhatsAppReactionSendOptions;
};

function resolveGroupActivatedForReaction(routeLifecycle: WhatsAppRouteLifecycleFacts): boolean {
  if (routeLifecycle.kind !== "group") {
    return false;
  }
  const activation = routeLifecycle.processingFacts.activation;
  return activation.kind === "known" ? activation.active : false;
}

function resolveGroupMentionedForReaction(routeLifecycle: WhatsAppRouteLifecycleFacts): boolean {
  return routeLifecycle.kind === "group"
    ? routeLifecycle.processingFacts.mention.effectiveWasMentioned
    : false;
}

export function resolveWhatsAppReactionDecision(params: {
  cfg: OpenClawConfig;
  msg: WebInboundMessage;
  agentId: string;
  routeLifecycle: WhatsAppRouteLifecycleFacts;
}): WhatsAppReactionDecision | null {
  const accountId = params.msg.admission.accountId;

  const reactionLevel = resolveWhatsAppReactionLevel({
    cfg: params.cfg,
    accountId,
  });
  if (reactionLevel.level === "off") {
    return null;
  }

  const ackConfig = params.cfg.channels?.whatsapp?.ackReaction;
  const emoji = resolveWhatsAppAckEmoji({
    cfg: params.cfg,
    agentId: params.agentId,
    ackConfig,
  });
  const directEnabled = ackConfig?.direct ?? true;
  const groupMode = ackConfig?.group ?? "mentions";
  const chatType = params.msg.admission.conversation.kind;
  const groupActivated = resolveGroupActivatedForReaction(params.routeLifecycle);

  const shouldReact = shouldAckReactionForWhatsApp({
    emoji,
    isDirect: chatType === "direct",
    isGroup: chatType === "group",
    directEnabled,
    groupMode,
    wasMentioned: resolveGroupMentionedForReaction(params.routeLifecycle),
    groupActivated,
  });
  if (!shouldReact) {
    return null;
  }
  return {
    emoji,
    accountId,
  };
}

export async function resolveWhatsAppReactionTarget(params: {
  cfg: OpenClawConfig;
  msg: WebInboundMessage;
  agentId: string;
  verbose: boolean;
  routeLifecycle: WhatsAppRouteLifecycleFacts;
}): Promise<WhatsAppReactionTarget | null> {
  const messageId = params.msg.event.id;
  if (!messageId) {
    return null;
  }
  const decision = resolveWhatsAppReactionDecision({
    cfg: params.cfg,
    msg: params.msg,
    agentId: params.agentId,
    routeLifecycle: params.routeLifecycle,
  });
  if (!decision) {
    return null;
  }

  const sender = getSenderIdentity(params.msg);
  const chatType = params.msg.admission.conversation.kind;
  return {
    ...decision,
    chatId: params.msg.platform.chatJid,
    messageId,
    sendOptions: {
      verbose: params.verbose,
      fromMe: false,
      ...(chatType === "group" && sender.jid ? { participant: sender.jid } : {}),
      accountId: decision.accountId,
      cfg: params.cfg,
    },
  };
}
