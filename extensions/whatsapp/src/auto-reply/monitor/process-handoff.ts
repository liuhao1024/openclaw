import type {
  AckReactionHandle,
  StatusReactionController,
} from "openclaw/plugin-sdk/channel-feedback";
import type { WhatsAppAudioPreflightResult } from "./audio-preflight.js";
import type { GroupHistoryEntry } from "./group-history.js";
import type {
  WhatsAppGroupActivationFacts,
  WhatsAppGroupProcessingFacts,
} from "./processing-facts.js";

export type WhatsAppRouteLifecycleFacts =
  | { kind: "direct" }
  | { kind: "group"; processingFacts: WhatsAppGroupProcessingFacts };

export type WhatsAppReceiptFeedback =
  | { kind: "none" }
  | { kind: "ack"; ackReaction: AckReactionHandle }
  | { kind: "status"; statusReactionController: StatusReactionController };

export const WHATSAPP_DIRECT_ROUTE_LIFECYCLE: WhatsAppRouteLifecycleFacts = {
  kind: "direct",
};

export const WHATSAPP_NO_RECEIPT_FEEDBACK: WhatsAppReceiptFeedback = { kind: "none" };

export function createWhatsAppGroupRouteLifecycle(
  processingFacts: WhatsAppGroupProcessingFacts,
): WhatsAppRouteLifecycleFacts {
  return {
    kind: "group",
    processingFacts,
  };
}

export function createWhatsAppBroadcastRouteLifecycle(
  routeLifecycle: WhatsAppRouteLifecycleFacts,
  activation?: WhatsAppGroupActivationFacts,
): WhatsAppRouteLifecycleFacts {
  if (routeLifecycle.kind === "direct") {
    return routeLifecycle;
  }

  return {
    kind: "group",
    processingFacts: {
      mention: routeLifecycle.processingFacts.mention,
      activation:
        activation ??
        ({
          kind: "absent",
          reason: "broadcast_target",
        } satisfies WhatsAppGroupActivationFacts),
    },
  };
}

export type WhatsAppProcessMessageHandoff = {
  audioPreflight: WhatsAppAudioPreflightResult;
  routeLifecycle: WhatsAppRouteLifecycleFacts;
  groupHistory?: GroupHistoryEntry[];
  suppressGroupHistoryClear?: boolean;
  ackAlreadySent?: boolean;
  ackReaction?: AckReactionHandle | null;
  statusReactionController?: StatusReactionController | null;
};

export type WhatsAppBroadcastProcessHandoff = Pick<
  WhatsAppProcessMessageHandoff,
  | "audioPreflight"
  | "routeLifecycle"
  | "ackAlreadySent"
  | "ackReaction"
  | "statusReactionController"
>;

export function createWhatsAppBroadcastProcessHandoff(params: {
  audioPreflight: WhatsAppAudioPreflightResult;
  routeLifecycle: WhatsAppRouteLifecycleFacts;
  broadcastActivation?: WhatsAppGroupActivationFacts | undefined;
  groupHistory?: GroupHistoryEntry[] | undefined;
  ackAlreadySent?: boolean | undefined;
  ackReaction?: AckReactionHandle | null | undefined;
}): WhatsAppProcessMessageHandoff {
  const handoff: WhatsAppProcessMessageHandoff = {
    audioPreflight: params.audioPreflight,
    routeLifecycle: createWhatsAppBroadcastRouteLifecycle(
      params.routeLifecycle,
      params.broadcastActivation,
    ),
    suppressGroupHistoryClear: true,
  };
  if (params.groupHistory !== undefined) {
    handoff.groupHistory = params.groupHistory;
  }
  if (params.ackAlreadySent === true) {
    handoff.ackAlreadySent = true;
  }
  if (params.ackReaction !== undefined) {
    handoff.ackReaction = params.ackReaction;
  }
  return handoff;
}

export function createWhatsAppReceiptFeedbackHandoff(
  feedback: WhatsAppReceiptFeedback,
): Pick<
  WhatsAppProcessMessageHandoff,
  "ackAlreadySent" | "ackReaction" | "statusReactionController"
> {
  if (feedback.kind === "ack") {
    return {
      ackAlreadySent: true,
      ackReaction: feedback.ackReaction,
    };
  }
  if (feedback.kind === "status") {
    return {
      statusReactionController: feedback.statusReactionController,
    };
  }
  return {};
}

export function createWhatsAppBroadcastReceiptFeedbackHandoff(params: {
  feedback: WhatsAppReceiptFeedback;
  chatType: "direct" | "group";
}): Pick<
  WhatsAppProcessMessageHandoff,
  "ackAlreadySent" | "ackReaction" | "statusReactionController"
> {
  if (params.feedback.kind === "ack") {
    if (params.chatType === "group") {
      return {};
    }
    return {
      ackAlreadySent: true,
      ackReaction: params.feedback.ackReaction,
    };
  }
  if (params.feedback.kind === "status") {
    return {
      ackAlreadySent: true,
      statusReactionController: params.feedback.statusReactionController,
    };
  }
  return {};
}
