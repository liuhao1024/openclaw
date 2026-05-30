import { beforeEach, describe, expect, it, vi } from "vitest";

const events: string[] = [];
const transcribeFirstAudioMock = vi.fn();
const maybeSendAckReactionMock = vi.fn();
const processMessageMock = vi.fn();
const maybeBroadcastMessageMock = vi.fn();
const createStatusReactionControllerMock = vi.fn();
const statusReactionController = {
  setQueued: vi.fn(async () => {
    events.push("status-queued");
  }),
  setThinking: vi.fn(async () => undefined),
  setTool: vi.fn(async () => undefined),
  setCompacting: vi.fn(async () => undefined),
  cancelPending: vi.fn(),
  setDone: vi.fn(async () => undefined),
  setError: vi.fn(async () => undefined),
  clear: vi.fn(async () => undefined),
  restoreInitial: vi.fn(async () => undefined),
};
const ackReactionHandle = {
  ackReactionPromise: Promise.resolve(true),
  ackReactionValue: "👀",
  remove: vi.fn(async () => undefined),
};
const applyGroupGatingMock = vi.fn();
const groupMentionFacts = {
  shouldProcess: true,
  mention: {
    effectiveWasMentioned: true,
    shouldBypassMention: false,
  },
  activation: {
    kind: "known",
    active: false,
    defaultRequiresMention: true,
  },
};
const groupMentionDeferralFacts = {
  shouldProcess: false,
  mention: {
    effectiveWasMentioned: false,
    shouldBypassMention: false,
    needsMentionText: true,
  },
  activation: {
    kind: "known",
    active: false,
    defaultRequiresMention: true,
  },
};
const transcriptAudioPreflight = {
  kind: "transcript",
  transcript: "transcribed voice note",
};
const noTranscriptAudioPreflight = {
  kind: "no_transcript",
};
const notAudioPreflight = {
  kind: "not_audio",
};

vi.mock("./audio-preflight.runtime.js", () => ({
  transcribeFirstAudio: (...args: unknown[]) => transcribeFirstAudioMock(...args),
}));

vi.mock("./ack-reaction.js", () => ({
  maybeSendAckReaction: (...args: unknown[]) => maybeSendAckReactionMock(...args),
}));

vi.mock("./process-message.js", () => ({
  processMessage: (...args: unknown[]) => processMessageMock(...args),
}));

vi.mock("./broadcast.js", () => ({
  maybeBroadcastMessage: (...args: unknown[]) => maybeBroadcastMessageMock(...args),
}));

vi.mock("./status-reaction.js", () => ({
  createWhatsAppStatusReactionController: (...args: unknown[]) =>
    createStatusReactionControllerMock(...args),
}));

vi.mock("./group-gating.js", () => ({
  applyGroupGating: (...args: unknown[]) => applyGroupGatingMock(...args),
}));

vi.mock("./last-route.js", () => ({
  updateLastRouteInBackground: () => {},
}));

vi.mock("./peer.js", () => ({
  resolvePeerId: (msg: { admission: { conversation: { id: string } } }) =>
    msg.admission.conversation.id,
}));

vi.mock("../config.runtime.js", () => ({
  getRuntimeConfig: () => ({
    channels: {
      whatsapp: {
        ackReaction: { enabled: true },
      },
    },
  }),
}));

vi.mock("../../group-session-key.js", () => ({
  resolveWhatsAppGroupSessionRoute: (route: unknown) => route,
}));

vi.mock("../../identity.js", () => ({
  getPrimaryIdentityId: () => undefined,
  getSenderIdentity: () => ({ e164: "+15550000002", name: "Alice" }),
}));

vi.mock("../../text-runtime.js", () => ({
  normalizeE164: (value: string) => value,
}));

vi.mock("openclaw/plugin-sdk/routing", () => ({
  buildGroupHistoryKey: () => "group-key",
  resolveAgentRoute: () => ({
    agentId: "main",
    accountId: "default",
    sessionKey: "agent:main:whatsapp:+15550000002",
    mainSessionKey: "agent:main:main",
  }),
}));

import { createTestWebInboundMessage } from "../../inbound/admission.test-support.js";
import type { WebInboundMessage } from "../../inbound/types.js";
import { createWebOnMessageHandler } from "./on-message.js";

function makeAudioMsg(): WebInboundMessage {
  return createTestWebInboundMessage({
    payload: {
      body: "<media:audio>",
      media: {
        type: "audio/ogg; codecs=opus",
        path: "/tmp/voice.ogg",
      },
    },
  });
}

function makeTextMsg(): WebInboundMessage {
  return createTestWebInboundMessage({
    payload: {
      body: "plain text",
    },
  });
}

function makeGroupAudioMsg(): WebInboundMessage {
  return createTestWebInboundMessage({
    admissionOverrides: {
      chatType: "group",
      conversationId: "1203630@g.us",
      requireMention: true,
    },
    payload: {
      body: "<media:audio>",
      media: {
        type: "audio/ogg; codecs=opus",
        path: "/tmp/voice.ogg",
      },
    },
  });
}

function makeEchoTracker() {
  return {
    has: () => false,
    forget: () => {},
    rememberText: () => {},
    buildCombinedKey: (p: { combinedBody: string }) => p.combinedBody,
  };
}

function mockObjectArg(mockFn: ReturnType<typeof vi.fn>, label: string, callIndex = 0) {
  const call = mockFn.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected ${label} call ${callIndex}`);
  }
  const arg = call.at(0);
  if (!arg || typeof arg !== "object") {
    throw new Error(`Expected ${label} call ${callIndex} object argument`);
  }
  return arg as Record<string, unknown>;
}

function expectAudioPreflightHandoff(
  processParams: Record<string, unknown>,
  expected: Record<string, unknown>,
) {
  expect(processParams.audioPreflight).toEqual(expected);
  expect(processParams).not.toHaveProperty("preflightAudioTranscript");
}

describe("createWebOnMessageHandler audio preflight", () => {
  beforeEach(() => {
    events.length = 0;
    maybeBroadcastMessageMock.mockReset();
    maybeBroadcastMessageMock.mockImplementation(async () => false);
    maybeSendAckReactionMock.mockReset();
    maybeSendAckReactionMock.mockImplementation(async () => {
      events.push("ack");
      return ackReactionHandle;
    });
    transcribeFirstAudioMock.mockReset();
    transcribeFirstAudioMock.mockImplementation(async () => {
      events.push("stt");
      return "transcribed voice note";
    });
    processMessageMock.mockReset();
    processMessageMock.mockResolvedValue(true);
    createStatusReactionControllerMock.mockReset();
    createStatusReactionControllerMock.mockResolvedValue(statusReactionController);
    Object.values(statusReactionController).forEach((mock) => mock.mockClear());
    applyGroupGatingMock.mockReset();
    applyGroupGatingMock.mockResolvedValue(groupMentionFacts);
  });

  it("sends ack reaction before audio preflight for voice notes", async () => {
    const handler = createWebOnMessageHandler({
      cfg: {
        channels: {
          whatsapp: {
            ackReaction: { enabled: true },
          },
        },
      } as never,
      verbose: false,
      connectionId: "conn-1",
      maxMediaBytes: 1024 * 1024,
      groupHistoryLimit: 20,
      groupHistories: new Map(),
      groupMemberNames: new Map(),
      echoTracker: makeEchoTracker() as never,
      backgroundTasks: new Set(),
      replyResolver: vi.fn() as never,
      replyLogger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
      } as never,
      baseMentionConfig: {} as never,
    });

    await handler(makeAudioMsg());

    expect(events).toEqual(["ack", "stt"]);
    expect(processMessageMock).toHaveBeenCalledTimes(1);
    const processParams = mockObjectArg(processMessageMock, "processMessage");
    expectAudioPreflightHandoff(processParams, transcriptAudioPreflight);
    expect(processParams.ackAlreadySent).toBe(true);
    expect(processParams.ackReaction).toBe(ackReactionHandle);
  });

  it("sends queued status reaction before audio preflight when status reactions are enabled", async () => {
    const handler = createWebOnMessageHandler({
      cfg: {
        messages: { statusReactions: { enabled: true } },
        channels: {
          whatsapp: {
            ackReaction: { enabled: true },
          },
        },
      } as never,
      verbose: false,
      connectionId: "conn-1",
      maxMediaBytes: 1024 * 1024,
      groupHistoryLimit: 20,
      groupHistories: new Map(),
      groupMemberNames: new Map(),
      echoTracker: makeEchoTracker() as never,
      backgroundTasks: new Set(),
      replyResolver: vi.fn() as never,
      replyLogger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
      } as never,
      baseMentionConfig: {} as never,
    });

    await handler(makeAudioMsg());

    expect(events).toEqual(["status-queued", "stt"]);
    expect(maybeSendAckReactionMock).not.toHaveBeenCalled();
    expect(createStatusReactionControllerMock).toHaveBeenCalledTimes(1);
    expect(processMessageMock).toHaveBeenCalledTimes(1);
    const processParams = mockObjectArg(processMessageMock, "processMessage");
    expectAudioPreflightHandoff(processParams, transcriptAudioPreflight);
    expect(processParams.statusReactionController).toBe(statusReactionController);
    expect(processParams.ackAlreadySent).toBeUndefined();
  });

  it("transcribes a group broadcast voice note once and fans the result to every target", async () => {
    maybeBroadcastMessageMock.mockImplementation(
      async (params: {
        ackAlreadySent?: boolean;
        ackReaction?: unknown;
        audioPreflight?: unknown;
        routeLifecycle?: unknown;
        processMessage: (
          msg: WebInboundMessage,
          route: unknown,
          groupHistoryKey: string,
          opts?: Record<string, unknown>,
        ) => Promise<boolean>;
        msg: WebInboundMessage;
        groupHistoryKey: string;
      }) => {
        expect(params.audioPreflight).toEqual(transcriptAudioPreflight);
        expect(params).not.toHaveProperty("preflightAudioTranscript");
        expect(params.ackAlreadySent).toBeUndefined();
        expect(params.ackReaction).toBeUndefined();
        expect(params.routeLifecycle).toEqual({
          kind: "group",
          processingFacts: groupMentionFacts,
        });
        await params.processMessage(
          params.msg,
          {
            agentId: "main",
            accountId: "default",
            sessionKey: "agent:main:whatsapp:group:1203630@g.us",
            mainSessionKey: "agent:main:main",
          },
          params.groupHistoryKey,
          {
            audioPreflight: params.audioPreflight,
            routeLifecycle: params.routeLifecycle,
          },
        );
        await params.processMessage(
          params.msg,
          {
            agentId: "backup",
            accountId: "default",
            sessionKey: "agent:backup:whatsapp:group:1203630@g.us",
            mainSessionKey: "agent:backup:main",
          },
          params.groupHistoryKey,
          {
            audioPreflight: params.audioPreflight,
            routeLifecycle: params.routeLifecycle,
          },
        );
        return true;
      },
    );
    const handler = createWebOnMessageHandler({
      cfg: {
        channels: {
          whatsapp: {
            ackReaction: { enabled: true },
          },
        },
        broadcast: {
          "1203630@g.us": ["main", "backup"],
        },
      } as never,
      verbose: false,
      connectionId: "conn-1",
      maxMediaBytes: 1024 * 1024,
      groupHistoryLimit: 20,
      groupHistories: new Map(),
      groupMemberNames: new Map(),
      echoTracker: makeEchoTracker() as never,
      backgroundTasks: new Set(),
      replyResolver: vi.fn() as never,
      replyLogger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
      } as never,
      baseMentionConfig: {} as never,
    });

    await handler(makeGroupAudioMsg());

    expect(events).toEqual(["ack", "stt"]);
    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(maybeSendAckReactionMock.mock.calls[0]?.[0]).toMatchObject({
      routeLifecycle: {
        kind: "group",
        processingFacts: groupMentionFacts,
      },
    });
    expect(processMessageMock).toHaveBeenCalledTimes(2);
    const firstProcessParams = mockObjectArg(processMessageMock, "processMessage", 0);
    const secondProcessParams = mockObjectArg(processMessageMock, "processMessage", 1);
    expectAudioPreflightHandoff(firstProcessParams, transcriptAudioPreflight);
    expectAudioPreflightHandoff(secondProcessParams, transcriptAudioPreflight);
  });

  it("uses group voice transcript for mention gating before dispatch", async () => {
    applyGroupGatingMock
      .mockResolvedValueOnce(groupMentionDeferralFacts)
      .mockResolvedValueOnce(groupMentionFacts);
    const handler = createWebOnMessageHandler({
      cfg: {
        channels: {
          whatsapp: {
            ackReaction: { enabled: true },
          },
        },
      } as never,
      verbose: false,
      connectionId: "conn-1",
      maxMediaBytes: 1024 * 1024,
      groupHistoryLimit: 20,
      groupHistories: new Map(),
      groupMemberNames: new Map(),
      echoTracker: makeEchoTracker() as never,
      backgroundTasks: new Set(),
      replyResolver: vi.fn() as never,
      replyLogger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
      } as never,
      baseMentionConfig: {} as never,
    });

    await handler(makeGroupAudioMsg());

    expect(applyGroupGatingMock).toHaveBeenCalledTimes(2);
    const firstGatingParams = mockObjectArg(applyGroupGatingMock, "applyGroupGating");
    expect(firstGatingParams.deferMissingMention).toBe(true);
    expect(firstGatingParams).not.toHaveProperty("mentionText");
    expect(events).toEqual(["ack", "stt"]);
    const secondGatingParams = mockObjectArg(applyGroupGatingMock, "applyGroupGating", 1);
    expect(secondGatingParams.mentionText).toBe("transcribed voice note");
    expect(secondGatingParams).not.toHaveProperty("deferMissingMention");
    expect(processMessageMock).toHaveBeenCalledTimes(1);
    const processParams = mockObjectArg(processMessageMock, "processMessage");
    expectAudioPreflightHandoff(processParams, transcriptAudioPreflight);
    expect(processParams.ackAlreadySent).toBe(true);
    expect(processParams.ackReaction).toBe(ackReactionHandle);
    expect(processParams.routeLifecycle).toEqual({
      kind: "group",
      processingFacts: groupMentionFacts,
    });
    expect(processParams).not.toHaveProperty("wasMentioned");
  });

  it("passes admitted account authDir into group gating", async () => {
    const handler = createWebOnMessageHandler({
      cfg: {
        channels: {
          whatsapp: {
            ackReaction: { enabled: true },
          },
        },
      } as never,
      verbose: false,
      connectionId: "conn-1",
      maxMediaBytes: 1024 * 1024,
      groupHistoryLimit: 20,
      groupHistories: new Map(),
      groupMemberNames: new Map(),
      echoTracker: makeEchoTracker() as never,
      backgroundTasks: new Set(),
      replyResolver: vi.fn() as never,
      replyLogger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
      } as never,
      baseMentionConfig: {} as never,
    });
    const msg = createTestWebInboundMessage({
      admissionOverrides: {
        chatType: "group",
        conversationId: "1203630@g.us",
        account: {
          authDir: "/admitted/auth",
        },
      },
      payload: {
        body: "plain group text",
      },
    });

    await handler(msg);

    expect(applyGroupGatingMock).toHaveBeenCalledTimes(1);
    expect(mockObjectArg(applyGroupGatingMock, "applyGroupGating").authDir).toBe("/admitted/auth");
  });

  it("finalizes preflight status feedback when group voice remains ungated after transcription", async () => {
    applyGroupGatingMock.mockResolvedValueOnce(groupMentionDeferralFacts).mockResolvedValueOnce({
      shouldProcess: false,
      mention: {
        effectiveWasMentioned: false,
        shouldBypassMention: false,
      },
      activation: {
        kind: "known",
        active: false,
        defaultRequiresMention: true,
      },
    });
    const handler = createWebOnMessageHandler({
      cfg: {
        messages: { statusReactions: { enabled: true } },
        channels: {
          whatsapp: {
            ackReaction: { enabled: true },
          },
        },
      } as never,
      verbose: false,
      connectionId: "conn-1",
      maxMediaBytes: 1024 * 1024,
      groupHistoryLimit: 20,
      groupHistories: new Map(),
      groupMemberNames: new Map(),
      echoTracker: makeEchoTracker() as never,
      backgroundTasks: new Set(),
      replyResolver: vi.fn() as never,
      replyLogger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
      } as never,
      baseMentionConfig: {} as never,
    });

    await handler(makeGroupAudioMsg());

    expect(events).toEqual(["status-queued", "stt"]);
    expect(applyGroupGatingMock).toHaveBeenCalledTimes(2);
    expect(processMessageMock).not.toHaveBeenCalled();
    expect(maybeBroadcastMessageMock).not.toHaveBeenCalled();
    expect(statusReactionController.setError).toHaveBeenCalledTimes(1);
    expect(statusReactionController.restoreInitial).toHaveBeenCalledTimes(1);
  });

  it("passes routing ctx fields to transcribeFirstAudio so echoTranscript can deliver (#79778)", async () => {
    let capturedCtx: unknown;
    transcribeFirstAudioMock.mockImplementation(async ({ ctx }: { ctx: unknown }) => {
      capturedCtx = ctx;
      return "transcribed voice note";
    });
    const handler = createWebOnMessageHandler({
      cfg: {
        channels: {
          whatsapp: {
            ackReaction: { enabled: true },
          },
        },
      } as never,
      verbose: false,
      connectionId: "conn-1",
      maxMediaBytes: 1024 * 1024,
      groupHistoryLimit: 20,
      groupHistories: new Map(),
      groupMemberNames: new Map(),
      echoTracker: makeEchoTracker() as never,
      backgroundTasks: new Set(),
      replyResolver: vi.fn() as never,
      replyLogger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
      } as never,
      baseMentionConfig: {} as never,
    });

    await handler(makeAudioMsg());

    expect(capturedCtx).toEqual({
      MediaPaths: ["/tmp/voice.ogg"],
      MediaTypes: ["audio/ogg; codecs=opus"],
      From: "+15550000002",
      To: "+15550000001",
      Provider: "whatsapp",
      Surface: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "+15550000002",
      AccountId: "default",
    });
  });

  it("passes a named no-transcript audio result when preflight produced no transcript", async () => {
    transcribeFirstAudioMock.mockImplementation(async () => {
      events.push("stt");
      return undefined;
    });
    const handler = createWebOnMessageHandler({
      cfg: {
        channels: {
          whatsapp: {
            ackReaction: { enabled: true },
          },
        },
      } as never,
      verbose: false,
      connectionId: "conn-1",
      maxMediaBytes: 1024 * 1024,
      groupHistoryLimit: 20,
      groupHistories: new Map(),
      groupMemberNames: new Map(),
      echoTracker: makeEchoTracker() as never,
      backgroundTasks: new Set(),
      replyResolver: vi.fn() as never,
      replyLogger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
      } as never,
      baseMentionConfig: {} as never,
    });

    await handler(makeAudioMsg());

    expect(events).toEqual(["ack", "stt"]);
    expect(processMessageMock).toHaveBeenCalledTimes(1);
    const processParams = mockObjectArg(processMessageMock, "processMessage");
    expectAudioPreflightHandoff(processParams, noTranscriptAudioPreflight);
  });

  it("passes a named not-applicable audio result for non-audio messages", async () => {
    const handler = createWebOnMessageHandler({
      cfg: {
        channels: {
          whatsapp: {
            ackReaction: { enabled: true },
          },
        },
      } as never,
      verbose: false,
      connectionId: "conn-1",
      maxMediaBytes: 1024 * 1024,
      groupHistoryLimit: 20,
      groupHistories: new Map(),
      groupMemberNames: new Map(),
      echoTracker: makeEchoTracker() as never,
      backgroundTasks: new Set(),
      replyResolver: vi.fn() as never,
      replyLogger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
      } as never,
      baseMentionConfig: {} as never,
    });

    await handler(makeTextMsg());

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(processMessageMock).toHaveBeenCalledTimes(1);
    const processParams = mockObjectArg(processMessageMock, "processMessage");
    expectAudioPreflightHandoff(processParams, notAudioPreflight);
  });

  it("does not transcribe group voice when policy gating rejects before mention", async () => {
    applyGroupGatingMock.mockResolvedValueOnce({
      shouldProcess: false,
      mention: {
        effectiveWasMentioned: false,
        shouldBypassMention: false,
      },
    });
    const handler = createWebOnMessageHandler({
      cfg: {
        channels: {
          whatsapp: {
            ackReaction: { enabled: true },
          },
        },
      } as never,
      verbose: false,
      connectionId: "conn-1",
      maxMediaBytes: 1024 * 1024,
      groupHistoryLimit: 20,
      groupHistories: new Map(),
      groupMemberNames: new Map(),
      echoTracker: makeEchoTracker() as never,
      backgroundTasks: new Set(),
      replyResolver: vi.fn() as never,
      replyLogger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
      } as never,
      baseMentionConfig: {} as never,
    });

    await handler(makeGroupAudioMsg());

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(maybeSendAckReactionMock).not.toHaveBeenCalled();
    expect(processMessageMock).not.toHaveBeenCalled();
  });
});
