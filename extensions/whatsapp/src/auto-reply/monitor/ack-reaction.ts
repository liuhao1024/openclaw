import {
  createAckReactionHandle,
  type AckReactionHandle,
} from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { WebInboundMessage } from "../../inbound/types.js";
import { sendReactionWhatsApp } from "../../send.js";
import { formatError } from "../../session.js";
import type { WhatsAppRouteLifecycleFacts } from "./process-handoff.js";
import { resolveWhatsAppReactionTarget } from "./reaction-decision.js";

export async function maybeSendAckReaction(params: {
  cfg: OpenClawConfig;
  msg: WebInboundMessage;
  agentId: string;
  verbose: boolean;
  routeLifecycle: WhatsAppRouteLifecycleFacts;
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
}): Promise<AckReactionHandle | null> {
  const target = await resolveWhatsAppReactionTarget({
    cfg: params.cfg,
    msg: params.msg,
    agentId: params.agentId,
    verbose: params.verbose,
    routeLifecycle: params.routeLifecycle,
  });
  if (!target) {
    return null;
  }

  params.info(
    { chatId: target.chatId, messageId: target.messageId, emoji: target.emoji },
    "sending ack reaction",
  );
  return createAckReactionHandle({
    ackReactionValue: target.emoji,
    send: () =>
      sendReactionWhatsApp(target.chatId, target.messageId, target.emoji, target.sendOptions),
    remove: () => sendReactionWhatsApp(target.chatId, target.messageId, "", target.sendOptions),
    onSendError: (err) => {
      params.warn(
        {
          error: formatError(err),
          chatId: target.chatId,
          messageId: target.messageId,
        },
        "failed to send ack reaction",
      );
      logVerbose(`WhatsApp ack reaction failed for chat ${target.chatId}: ${formatError(err)}`);
    },
  });
}
