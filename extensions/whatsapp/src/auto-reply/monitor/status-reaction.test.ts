import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestWebInboundMessage } from "../../inbound/admission.test-support.js";
import type { WebInboundMessage } from "../../inbound/types.js";
import type { WhatsAppRouteLifecycleFacts } from "./process-handoff.js";
import type { WhatsAppGroupProcessingFacts } from "./processing-facts.js";
import { createWhatsAppStatusReactionController } from "./status-reaction.js";

const hoisted = vi.hoisted(() => ({
  sendReactionWhatsApp: vi.fn(async () => undefined),
}));

vi.mock("../../send.js", () => ({
  sendReactionWhatsApp: hoisted.sendReactionWhatsApp,
}));

function createMessage(
  params: { accountId?: string; chatType?: "direct" | "group" } = {},
): WebInboundMessage {
  const accountId = params.accountId ?? "default";
  const chatType = params.chatType ?? "direct";
  return createTestWebInboundMessage({
    admissionOverrides: {
      accountId,
      chatType,
      conversationId: chatType === "group" ? "1203630@g.us" : "15551234567@s.whatsapp.net",
      requireMention: true,
    },
    event: {
      id: "msg-1",
    },
    platform: {
      chatJid: "mutable-chat@s.whatsapp.net",
    },
  });
}

function createStatusConfig(): OpenClawConfig {
  return {
    messages: {
      statusReactions: {
        enabled: true,
        timing: {
          debounceMs: 1_000_000,
          stallSoftMs: 1_000_000,
          stallHardMs: 1_000_000,
          doneHoldMs: 0,
          errorHoldMs: 0,
        },
      },
    },
    channels: {
      whatsapp: {
        reactionLevel: "ack",
        ackReaction: {
          emoji: "👀",
          direct: true,
          group: "mentions",
        },
      },
    },
  } as OpenClawConfig;
}

const directRouteLifecycle: WhatsAppRouteLifecycleFacts = { kind: "direct" };

function groupRouteLifecycle(processingFacts: WhatsAppGroupProcessingFacts) {
  return {
    kind: "group",
    processingFacts,
  } satisfies WhatsAppRouteLifecycleFacts;
}

describe("createWhatsAppStatusReactionController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the agent identity emoji when WhatsApp ackReaction has no emoji", async () => {
    const cfg = {
      agents: {
        list: [{ id: "agent", identity: { emoji: "🔥" } }],
      },
      messages: {
        statusReactions: {
          enabled: true,
          timing: {
            debounceMs: 1_000_000,
            stallSoftMs: 1_000_000,
            stallHardMs: 1_000_000,
            doneHoldMs: 0,
            errorHoldMs: 0,
          },
        },
      },
      channels: {
        whatsapp: {
          reactionLevel: "ack",
          ackReaction: {
            direct: true,
            group: "mentions",
          },
        },
      },
    } as OpenClawConfig;

    const controller = await createWhatsAppStatusReactionController({
      cfg,
      msg: createMessage(),
      agentId: "agent",
      verbose: false,
      routeLifecycle: directRouteLifecycle,
    });

    void controller?.setQueued();
    await vi.waitFor(() => {
      expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(
        "mutable-chat@s.whatsapp.net",
        "msg-1",
        "🔥",
        {
          verbose: false,
          fromMe: false,
          accountId: "default",
          cfg,
        },
      );
    });
    await controller?.clear();
  });

  it("sends status reactions with the admitted account id", async () => {
    const cfg = {
      messages: {
        statusReactions: {
          enabled: true,
          timing: {
            debounceMs: 1_000_000,
            stallSoftMs: 1_000_000,
            stallHardMs: 1_000_000,
            doneHoldMs: 0,
            errorHoldMs: 0,
          },
        },
      },
      channels: {
        whatsapp: {
          reactionLevel: "ack",
          ackReaction: {
            emoji: "👀",
            direct: true,
            group: "mentions",
          },
        },
      },
    } as OpenClawConfig;

    const controller = await createWhatsAppStatusReactionController({
      cfg,
      msg: createMessage({ accountId: "work" }),
      agentId: "agent",
      verbose: false,
      routeLifecycle: directRouteLifecycle,
    });

    void controller?.setQueued();
    await vi.waitFor(() => {
      expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(
        "mutable-chat@s.whatsapp.net",
        "msg-1",
        "👀",
        {
          verbose: false,
          fromMe: false,
          accountId: "work",
          cfg,
        },
      );
    });
    await controller?.clear();
  });

  it("sends group mention-mode status reactions from explicit mention facts", async () => {
    const cfg = createStatusConfig();
    const params = {
      cfg,
      msg: createMessage({ chatType: "group" }),
      agentId: "agent",
      verbose: false,
      routeLifecycle: groupRouteLifecycle({
        mention: {
          effectiveWasMentioned: true,
          shouldBypassMention: false,
        },
        activation: {
          kind: "known",
          active: false,
          defaultRequiresMention: true,
        },
      }),
    } satisfies Parameters<typeof createWhatsAppStatusReactionController>[0];

    const controller = await createWhatsAppStatusReactionController(params);

    void controller?.setQueued();
    await vi.waitFor(() => {
      expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(
        "mutable-chat@s.whatsapp.net",
        "msg-1",
        "👀",
        {
          verbose: false,
          fromMe: false,
          accountId: "default",
          cfg,
        },
      );
    });
    await controller?.clear();
  });

  it("uses provided activation facts from the route lifecycle", async () => {
    const cfg = createStatusConfig();
    const controller = await createWhatsAppStatusReactionController({
      cfg,
      msg: createMessage({ chatType: "group" }),
      agentId: "agent",
      verbose: false,
      routeLifecycle: groupRouteLifecycle({
        mention: {
          effectiveWasMentioned: false,
          shouldBypassMention: false,
        },
        activation: {
          kind: "known",
          active: true,
          defaultRequiresMention: true,
        },
      }),
    } satisfies Parameters<typeof createWhatsAppStatusReactionController>[0]);

    void controller?.setQueued();
    await vi.waitFor(() => {
      expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(
        "mutable-chat@s.whatsapp.net",
        "msg-1",
        "👀",
        {
          verbose: false,
          fromMe: false,
          accountId: "default",
          cfg,
        },
      );
    });
    await controller?.clear();
  });

  it("does not infer group activation when lifecycle marks target activation absent", async () => {
    const cfg = createStatusConfig();

    const controller = await createWhatsAppStatusReactionController({
      cfg,
      msg: createMessage({ chatType: "group" }),
      agentId: "backup",
      verbose: false,
      routeLifecycle: groupRouteLifecycle({
        mention: {
          effectiveWasMentioned: false,
          shouldBypassMention: false,
        },
        activation: {
          kind: "absent",
          reason: "broadcast_target",
        },
      }),
    });

    expect(controller).toBeNull();
    expect(hoisted.sendReactionWhatsApp).not.toHaveBeenCalled();
  });
});
