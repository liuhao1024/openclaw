import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { buildAgentSessionKey, deriveLastRoutePolicy } from "openclaw/plugin-sdk/routing";
import {
  buildAgentMainSessionKey,
  DEFAULT_MAIN_KEY,
  normalizeAgentId,
} from "openclaw/plugin-sdk/routing";
import { resolveWhatsAppGroupSessionRoute } from "../../group-session-key.js";
import type { WebInboundMessage } from "../../inbound/types.js";
import { formatError } from "../../session.js";
import { whatsappInboundLog } from "../loggers.js";
import { resolveAcceptedGroupActivationFor } from "./group-activation.js";
import type { GroupHistoryEntry } from "./group-history.js";
import {
  createWhatsAppBroadcastProcessHandoff,
  type WhatsAppBroadcastProcessHandoff,
  type WhatsAppProcessMessageHandoff,
} from "./process-handoff.js";
import type { WhatsAppGroupActivationFacts } from "./processing-facts.js";
import { finalizeWhatsAppStatusReaction } from "./receipt-feedback.js";

function buildBroadcastRouteKeys(params: {
  cfg: OpenClawConfig;
  msg: WebInboundMessage;
  route: ReturnType<typeof resolveAgentRoute>;
  peerId: string;
  agentId: string;
}) {
  const chatType = params.msg.admission.conversation.kind;
  const sessionKey = buildAgentSessionKey({
    agentId: params.agentId,
    channel: "whatsapp",
    accountId: params.route.accountId,
    peer: {
      kind: chatType === "group" ? "group" : "direct",
      id: params.peerId,
    },
    dmScope: params.cfg.session?.dmScope,
    identityLinks: params.cfg.session?.identityLinks,
  });
  const mainSessionKey = buildAgentMainSessionKey({
    agentId: params.agentId,
    mainKey: DEFAULT_MAIN_KEY,
  });

  return {
    sessionKey,
    mainSessionKey,
    lastRoutePolicy: deriveLastRoutePolicy({
      sessionKey,
      mainSessionKey,
    }),
  };
}

export async function maybeBroadcastMessage(
  params: {
    cfg: OpenClawConfig;
    msg: WebInboundMessage;
    peerId: string;
    route: ReturnType<typeof resolveAgentRoute>;
    groupHistoryKey: string;
    groupHistories: Map<string, GroupHistoryEntry[]>;
    processMessage: (
      msg: WebInboundMessage,
      route: ReturnType<typeof resolveAgentRoute>,
      groupHistoryKey: string,
      opts: WhatsAppProcessMessageHandoff,
    ) => Promise<boolean>;
  } & WhatsAppBroadcastProcessHandoff,
) {
  const broadcastAgents = params.cfg.broadcast?.[params.peerId];
  if (!broadcastAgents || !Array.isArray(broadcastAgents)) {
    return false;
  }
  if (broadcastAgents.length === 0) {
    return false;
  }

  const strategy = params.cfg.broadcast?.strategy || "parallel";
  whatsappInboundLog.info(`Broadcasting message to ${broadcastAgents.length} agents (${strategy})`);

  const agentIds = params.cfg.agents?.list?.map((agent) => normalizeAgentId(agent.id));
  const hasKnownAgents = (agentIds?.length ?? 0) > 0;
  const chatType = params.msg.admission.conversation.kind;
  const groupHistorySnapshot =
    chatType === "group" ? (params.groupHistories.get(params.groupHistoryKey) ?? []) : undefined;
  const statusReactionController = params.statusReactionController ?? null;
  if (statusReactionController) {
    void statusReactionController.setThinking();
  }

  const processForAgent = async (agentId: string): Promise<boolean> => {
    const normalizedAgentId = normalizeAgentId(agentId);
    if (hasKnownAgents && !agentIds?.includes(normalizedAgentId)) {
      whatsappInboundLog.warn(`Broadcast agent ${agentId} not found in agents.list; skipping`);
      return false;
    }
    const routeKeys = buildBroadcastRouteKeys({
      cfg: params.cfg,
      msg: params.msg,
      route: params.route,
      peerId: params.peerId,
      agentId: normalizedAgentId,
    });
    const baseAgentRoute = {
      ...params.route,
      agentId: normalizedAgentId,
      ...routeKeys,
    };
    const agentRoute =
      chatType === "group" ? resolveWhatsAppGroupSessionRoute(baseAgentRoute) : baseAgentRoute;

    try {
      let broadcastActivation: WhatsAppGroupActivationFacts | undefined;
      if (chatType === "group") {
        const activation = await resolveAcceptedGroupActivationFor({
          cfg: params.cfg,
          msg: params.msg,
          agentId: agentRoute.agentId,
          sessionKey: agentRoute.sessionKey,
        });
        broadcastActivation = {
          kind: "known",
          active: activation === "always",
          defaultRequiresMention: params.msg.admission.conversation.requireMention,
        };
      }
      const opts = createWhatsAppBroadcastProcessHandoff({
        audioPreflight: params.audioPreflight,
        routeLifecycle: params.routeLifecycle,
        broadcastActivation,
        groupHistory: groupHistorySnapshot,
        ackAlreadySent: params.ackAlreadySent,
        ackReaction: params.ackReaction,
      });
      return await params.processMessage(params.msg, agentRoute, params.groupHistoryKey, opts);
    } catch (err) {
      whatsappInboundLog.error(`Broadcast agent ${agentId} failed: ${formatError(err)}`);
      return false;
    }
  };

  let didProcess = false;
  if (strategy === "sequential") {
    for (const agentId of broadcastAgents) {
      didProcess = (await processForAgent(agentId)) || didProcess;
    }
  } else {
    const results = await Promise.allSettled(broadcastAgents.map(processForAgent));
    didProcess = results.some((result) => result.status === "fulfilled" && result.value);
  }

  if (chatType === "group") {
    params.groupHistories.set(params.groupHistoryKey, []);
  }
  if (statusReactionController) {
    void finalizeWhatsAppStatusReaction({
      cfg: params.cfg,
      controller: statusReactionController,
      outcome: didProcess ? "done" : "error",
      hasFinalResponse: didProcess,
    });
  }

  return true;
}
