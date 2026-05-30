import {
  createStatusReactionController,
  type StatusReactionController,
} from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { WebInboundMessage } from "../../inbound/types.js";
import { sendReactionWhatsApp } from "../../send.js";
import type { WhatsAppRouteLifecycleFacts } from "./process-handoff.js";
import { resolveWhatsAppReactionTarget } from "./reaction-decision.js";

export type { StatusReactionController };

export type WhatsAppStatusReactionParams = {
  cfg: OpenClawConfig;
  msg: WebInboundMessage;
  agentId: string;
  verbose: boolean;
  routeLifecycle: WhatsAppRouteLifecycleFacts;
};

export async function createWhatsAppStatusReactionController(
  params: WhatsAppStatusReactionParams,
): Promise<StatusReactionController | null> {
  const statusReactionsConfig = params.cfg.messages?.statusReactions;
  if (statusReactionsConfig?.enabled !== true) {
    return null;
  }

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

  return createStatusReactionController({
    enabled: true,
    adapter: {
      setReaction: async (emoji: string) => {
        await sendReactionWhatsApp(target.chatId, target.messageId, emoji, target.sendOptions);
      },
      clearReaction: async () => {
        await sendReactionWhatsApp(target.chatId, target.messageId, "", target.sendOptions);
      },
    },
    initialEmoji: target.emoji,
    emojis: statusReactionsConfig.emojis,
    timing: statusReactionsConfig.timing,
    onError: (err) => {
      logVerbose(
        `WhatsApp status-reaction error for chat ${target.chatId}/${target.messageId}: ${String(err)}`,
      );
    },
  });
}
