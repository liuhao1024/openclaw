import {
  DEFAULT_TIMING,
  type StatusReactionController,
} from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { WebInboundMessage } from "../../inbound/types.js";
import { maybeSendAckReaction } from "./ack-reaction.js";
import {
  WHATSAPP_NO_RECEIPT_FEEDBACK,
  type WhatsAppReceiptFeedback,
  type WhatsAppRouteLifecycleFacts,
} from "./process-handoff.js";
import { createWhatsAppStatusReactionController } from "./status-reaction.js";

export async function startWhatsAppReceiptFeedback(params: {
  cfg: OpenClawConfig;
  msg: WebInboundMessage;
  agentId: string;
  verbose: boolean;
  routeLifecycle: WhatsAppRouteLifecycleFacts;
  queueStatusReaction: "await" | "background";
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
}): Promise<WhatsAppReceiptFeedback> {
  if (params.cfg.messages?.statusReactions?.enabled === true) {
    const statusReactionController = await createWhatsAppStatusReactionController({
      cfg: params.cfg,
      msg: params.msg,
      agentId: params.agentId,
      verbose: params.verbose,
      routeLifecycle: params.routeLifecycle,
    });
    if (!statusReactionController) {
      return WHATSAPP_NO_RECEIPT_FEEDBACK;
    }

    const queued = statusReactionController.setQueued();
    if (params.queueStatusReaction === "await") {
      await queued;
    } else {
      void queued;
    }
    return { kind: "status", statusReactionController };
  }

  const ackReaction = await maybeSendAckReaction({
    cfg: params.cfg,
    msg: params.msg,
    agentId: params.agentId,
    verbose: params.verbose,
    routeLifecycle: params.routeLifecycle,
    info: params.info,
    warn: params.warn,
  });
  return ackReaction ? { kind: "ack", ackReaction } : WHATSAPP_NO_RECEIPT_FEEDBACK;
}

export async function finalizeWhatsAppStatusReaction(params: {
  cfg: OpenClawConfig;
  controller: StatusReactionController;
  outcome: "done" | "error";
  hasFinalResponse: boolean;
}): Promise<void> {
  const timing = {
    ...DEFAULT_TIMING,
    ...params.cfg.messages?.statusReactions?.timing,
  };
  const removeAckAfterReply = params.cfg.messages?.removeAckAfterReply ?? false;

  if (params.outcome === "done") {
    await params.controller.setDone();
    if (removeAckAfterReply) {
      await new Promise<void>((resolve) => setTimeout(resolve, timing.doneHoldMs));
      await params.controller.clear();
    } else {
      await params.controller.restoreInitial();
    }
    return;
  }

  await params.controller.setError();
  if (params.hasFinalResponse) {
    if (removeAckAfterReply) {
      await new Promise<void>((resolve) => setTimeout(resolve, timing.errorHoldMs));
      await params.controller.clear();
    } else {
      await params.controller.restoreInitial();
    }
    return;
  }
  if (removeAckAfterReply) {
    await new Promise<void>((resolve) => setTimeout(resolve, timing.errorHoldMs));
  }
  await params.controller.restoreInitial();
}
