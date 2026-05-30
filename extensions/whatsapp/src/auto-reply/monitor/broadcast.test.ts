import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { describe, expect, it, vi } from "vitest";
import { createTestWebInboundMessage } from "../../inbound/admission.test-support.js";
import { maybeBroadcastMessage } from "./broadcast.js";

type BroadcastProcessMessage = Parameters<typeof maybeBroadcastMessage>[0]["processMessage"];

describe("maybeBroadcastMessage", () => {
  it("resolves group activation for the broadcast target instead of reusing base-route facts", async () => {
    const msg = createTestWebInboundMessage({
      admissionOverrides: {
        chatType: "group",
        conversationId: "1203630@g.us",
        requireMention: true,
      },
    });
    const audioPreflight = {
      kind: "transcript",
      transcript: "pre-computed broadcast transcript",
    } as const;
    const processMessage = vi.fn<BroadcastProcessMessage>(async () => true);

    await maybeBroadcastMessage({
      cfg: {
        broadcast: {
          "1203630@g.us": ["backup"],
        },
      } as OpenClawConfig,
      msg,
      peerId: "1203630@g.us",
      route: {
        agentId: "main",
        accountId: "default",
        sessionKey: "agent:main:whatsapp:default:group:1203630@g.us",
        mainSessionKey: "agent:main:main",
      } as ReturnType<typeof resolveAgentRoute>,
      groupHistoryKey: "whatsapp:default:group:1203630@g.us",
      groupHistories: new Map([["whatsapp:default:group:1203630@g.us", []]]),
      audioPreflight,
      routeLifecycle: {
        kind: "group",
        processingFacts: {
          mention: {
            effectiveWasMentioned: false,
            shouldBypassMention: false,
          },
          activation: {
            kind: "known",
            active: true,
            defaultRequiresMention: true,
          },
        },
      },
      processMessage,
    });

    expect(processMessage).toHaveBeenCalledTimes(1);
    const opts = processMessage.mock.calls[0]?.[3];
    expect(opts?.audioPreflight).toEqual(audioPreflight);
    expect(opts).not.toHaveProperty("preflightAudioTranscript");
    expect(opts?.routeLifecycle).toEqual({
      kind: "group",
      processingFacts: {
        mention: {
          effectiveWasMentioned: false,
          shouldBypassMention: false,
        },
        activation: {
          kind: "known",
          active: false,
          defaultRequiresMention: true,
        },
      },
    });
  });

  it("preserves receipt-feedback eligibility for activated broadcast targets", async () => {
    const msg = createTestWebInboundMessage({
      admissionOverrides: {
        chatType: "group",
        conversationId: "1203630@g.us",
        requireMention: false,
      },
    });
    const processMessage = vi.fn<BroadcastProcessMessage>(async () => true);

    await maybeBroadcastMessage({
      cfg: {
        broadcast: {
          "1203630@g.us": ["backup"],
        },
      } as OpenClawConfig,
      msg,
      peerId: "1203630@g.us",
      route: {
        agentId: "main",
        accountId: "default",
        sessionKey: "agent:main:whatsapp:default:group:1203630@g.us",
        mainSessionKey: "agent:main:main",
      } as ReturnType<typeof resolveAgentRoute>,
      groupHistoryKey: "whatsapp:default:group:1203630@g.us",
      groupHistories: new Map([["whatsapp:default:group:1203630@g.us", []]]),
      audioPreflight: { kind: "not_audio" },
      routeLifecycle: {
        kind: "group",
        processingFacts: {
          mention: {
            effectiveWasMentioned: false,
            shouldBypassMention: false,
          },
          activation: {
            kind: "absent",
            reason: "not_reached",
          },
        },
      },
      processMessage,
    });

    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(processMessage.mock.calls[0]?.[3].routeLifecycle).toEqual({
      kind: "group",
      processingFacts: {
        mention: {
          effectiveWasMentioned: false,
          shouldBypassMention: false,
        },
        activation: {
          kind: "known",
          active: true,
          defaultRequiresMention: false,
        },
      },
    });
  });

  it("finalizes a shared direct status reaction after broadcast fan-out", async () => {
    const msg = createTestWebInboundMessage({
      admissionOverrides: {
        chatType: "direct",
        conversationId: "+15550000002",
      },
    });
    const processMessage = vi.fn<BroadcastProcessMessage>(async () => true);
    const statusReactionController = {
      setQueued: vi.fn(async () => undefined),
      setThinking: vi.fn(async () => undefined),
      setTool: vi.fn(async () => undefined),
      setCompacting: vi.fn(async () => undefined),
      cancelPending: vi.fn(),
      setDone: vi.fn(async () => undefined),
      setError: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      restoreInitial: vi.fn(async () => undefined),
    };

    await maybeBroadcastMessage({
      cfg: {
        broadcast: {
          "+15550000002": ["backup"],
        },
      } as OpenClawConfig,
      msg,
      peerId: "+15550000002",
      route: {
        agentId: "main",
        accountId: "default",
        sessionKey: "agent:main:whatsapp:default:direct:+15550000002",
        mainSessionKey: "agent:main:main",
      } as ReturnType<typeof resolveAgentRoute>,
      groupHistoryKey: "whatsapp:default:direct:+15550000002",
      groupHistories: new Map(),
      audioPreflight: { kind: "transcript", transcript: "pre-computed transcript" },
      routeLifecycle: { kind: "direct" },
      ackAlreadySent: true,
      statusReactionController,
      processMessage,
    });

    expect(processMessage).toHaveBeenCalledTimes(1);
    const opts = processMessage.mock.calls[0]?.[3];
    expect(opts?.ackAlreadySent).toBe(true);
    expect(opts).not.toHaveProperty("statusReactionController");
    expect(statusReactionController.setThinking).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(statusReactionController.setDone).toHaveBeenCalledTimes(1);
      expect(statusReactionController.restoreInitial).toHaveBeenCalledTimes(1);
    });
    expect(statusReactionController.setError).not.toHaveBeenCalled();
  });

  it("finalizes a shared group status reaction after broadcast fan-out", async () => {
    const msg = createTestWebInboundMessage({
      admissionOverrides: {
        chatType: "group",
        conversationId: "1203630@g.us",
        requireMention: false,
      },
    });
    const processMessage = vi.fn<BroadcastProcessMessage>(async () => true);
    const statusReactionController = {
      setQueued: vi.fn(async () => undefined),
      setThinking: vi.fn(async () => undefined),
      setTool: vi.fn(async () => undefined),
      setCompacting: vi.fn(async () => undefined),
      cancelPending: vi.fn(),
      setDone: vi.fn(async () => undefined),
      setError: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      restoreInitial: vi.fn(async () => undefined),
    };

    await maybeBroadcastMessage({
      cfg: {
        broadcast: {
          "1203630@g.us": ["backup"],
        },
      } as OpenClawConfig,
      msg,
      peerId: "1203630@g.us",
      route: {
        agentId: "main",
        accountId: "default",
        sessionKey: "agent:main:whatsapp:default:group:1203630@g.us",
        mainSessionKey: "agent:main:main",
      } as ReturnType<typeof resolveAgentRoute>,
      groupHistoryKey: "whatsapp:default:group:1203630@g.us",
      groupHistories: new Map([["whatsapp:default:group:1203630@g.us", []]]),
      audioPreflight: { kind: "transcript", transcript: "pre-computed transcript" },
      routeLifecycle: {
        kind: "group",
        processingFacts: {
          mention: {
            effectiveWasMentioned: true,
            shouldBypassMention: false,
          },
          activation: {
            kind: "known",
            active: false,
            defaultRequiresMention: true,
          },
        },
      },
      ackAlreadySent: true,
      statusReactionController,
      processMessage,
    });

    expect(processMessage).toHaveBeenCalledTimes(1);
    const opts = processMessage.mock.calls[0]?.[3];
    expect(opts?.ackAlreadySent).toBe(true);
    expect(opts).not.toHaveProperty("statusReactionController");
    expect(statusReactionController.setThinking).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(statusReactionController.setDone).toHaveBeenCalledTimes(1);
      expect(statusReactionController.restoreInitial).toHaveBeenCalledTimes(1);
    });
    expect(statusReactionController.setError).not.toHaveBeenCalled();
  });
});
