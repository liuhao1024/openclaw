import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestWebInboundMessage } from "../../inbound/admission.test-support.js";
import type { WebInboundMessage } from "../../inbound/types.js";
import { maybeSendAckReaction } from "./ack-reaction.js";
import type { WhatsAppRouteLifecycleFacts } from "./process-handoff.js";
import type { WhatsAppGroupProcessingFacts } from "./processing-facts.js";

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

function createConfig(
  reactionLevel: "off" | "ack" | "minimal" | "extensive",
  extras?: Partial<NonNullable<OpenClawConfig["channels"]>["whatsapp"]>,
): OpenClawConfig {
  return {
    channels: {
      whatsapp: {
        reactionLevel,
        ackReaction: {
          emoji: "👀",
          direct: true,
          group: "mentions",
        },
        ...extras,
      },
    },
  } as OpenClawConfig;
}

type AckReactionParams = Parameters<typeof maybeSendAckReaction>[0];

const directRouteLifecycle: WhatsAppRouteLifecycleFacts = { kind: "direct" };

function groupRouteLifecycle(processingFacts: WhatsAppGroupProcessingFacts) {
  return {
    kind: "group",
    processingFacts,
  } satisfies WhatsAppRouteLifecycleFacts;
}

const runAckReaction = (overrides: Partial<AckReactionParams> = {}) => {
  const params = {
    cfg: createConfig("ack"),
    msg: createMessage(),
    agentId: "agent",
    verbose: false,
    routeLifecycle: directRouteLifecycle,
    info: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  } satisfies AckReactionParams;
  return maybeSendAckReaction(params);
};

const expectAckReactionSent = (accountId: string, cfg: OpenClawConfig = createConfig("ack")) => {
  expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(
    "mutable-chat@s.whatsapp.net",
    "msg-1",
    "👀",
    {
      verbose: false,
      fromMe: false,
      accountId,
      cfg,
    },
  );
};

describe("maybeSendAckReaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["ack", "minimal", "extensive"] as const)(
    "sends ack reactions when reactionLevel is %s",
    async (reactionLevel) => {
      const cfg = createConfig(reactionLevel);
      const ackReaction = await runAckReaction({
        cfg,
      });

      expect(ackReaction?.ackReactionValue).toBe("👀");
      await expect(ackReaction?.ackReactionPromise).resolves.toBe(true);
      expectAckReactionSent("default", cfg);
    },
  );

  it("suppresses ack reactions when reactionLevel is off", async () => {
    const ackReaction = await runAckReaction({
      cfg: createConfig("off"),
    });

    expect(ackReaction).toBeNull();
    expect(hoisted.sendReactionWhatsApp).not.toHaveBeenCalled();
  });

  it("uses the admitted account reactionLevel override for ack gating", async () => {
    const cfg = createConfig("off", {
      accounts: {
        work: {
          reactionLevel: "ack",
        },
      },
    });
    const ackReaction = await runAckReaction({
      cfg,
      msg: createMessage({ accountId: "work" }),
    });

    expect(ackReaction?.ackReactionValue).toBe("👀");
    expectAckReactionSent("work", cfg);
  });

  it("uses the agent identity emoji when WhatsApp ackReaction has no emoji", async () => {
    const cfg = {
      agents: {
        list: [{ id: "agent", identity: { emoji: "🔥" } }],
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

    const ackReaction = await runAckReaction({ cfg });

    expect(ackReaction?.ackReactionValue).toBe("🔥");
    await expect(ackReaction?.ackReactionPromise).resolves.toBe(true);
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

  it("returns a handle that removes the ack with an empty reaction", async () => {
    const cfg = createConfig("ack");
    const ackReaction = await runAckReaction({ cfg });

    await ackReaction?.remove();

    expect(hoisted.sendReactionWhatsApp).toHaveBeenLastCalledWith(
      "mutable-chat@s.whatsapp.net",
      "msg-1",
      "",
      {
        verbose: false,
        fromMe: false,
        accountId: "default",
        cfg,
      },
    );
  });

  it("records ack send failures on the handle", async () => {
    const cfg = createConfig("ack");
    const warn = vi.fn();
    hoisted.sendReactionWhatsApp.mockRejectedValueOnce(new Error("session down"));

    const ackReaction = await runAckReaction({ cfg, warn });

    await expect(ackReaction?.ackReactionPromise).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(
      {
        error: "session down",
        chatId: "mutable-chat@s.whatsapp.net",
        messageId: "msg-1",
      },
      "failed to send ack reaction",
    );
  });

  it("sends group mention-mode reactions from explicit mention facts", async () => {
    const cfg = createConfig("ack");
    const ackReaction = await runAckReaction({
      cfg,
      msg: createMessage({ chatType: "group" }),
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
    });

    expect(ackReaction?.ackReactionValue).toBe("👀");
    await expect(ackReaction?.ackReactionPromise).resolves.toBe(true);
    expectAckReactionSent("default", cfg);
  });

  it("uses provided activation facts from the route lifecycle", async () => {
    const cfg = createConfig("ack");
    const ackReaction = await runAckReaction({
      cfg,
      msg: createMessage({ chatType: "group" }),
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
    });

    expect(ackReaction?.ackReactionValue).toBe("👀");
    await expect(ackReaction?.ackReactionPromise).resolves.toBe(true);
    expectAckReactionSent("default", cfg);
  });

  it("does not infer group activation when lifecycle marks target activation absent", async () => {
    const cfg = createConfig("ack");

    const ackReaction = await runAckReaction({
      cfg,
      msg: createMessage({ chatType: "group" }),
      agentId: "backup",
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

    expect(ackReaction).toBeNull();
    expect(hoisted.sendReactionWhatsApp).not.toHaveBeenCalled();
  });
});
