import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the lazy-loaded audio preflight runtime boundary
const transcribeFirstAudioMock = vi.fn();
const maybeSendAckReactionMock = vi.fn();

vi.mock("./audio-preflight.runtime.js", () => ({
  transcribeFirstAudio: (...args: unknown[]) => transcribeFirstAudioMock(...args),
}));

// Controllable shouldComputeCommandAuthorized for command-sync tests
let shouldComputeCommandResult = false;
let shouldComputeCommandBodies: string[] = [];

// Minimal mocks for process-message dependencies
vi.mock("../../accounts.js", () => ({
  resolveWhatsAppAccount: () => ({
    accountId: "default",
    dmPolicy: "pairing",
    groupPolicy: "allowlist",
    allowFrom: [],
  }),
}));

vi.mock("../../identity.js", () => ({
  getPrimaryIdentityId: () => undefined,
  getSelfIdentity: () => ({ e164: "+15550000001" }),
  getSenderIdentity: () => ({ e164: "+15550000002", name: "Alice" }),
}));

vi.mock("../../reconnect.js", () => ({
  newConnectionId: () => "test-conn-id",
}));

vi.mock("../../session.js", () => ({
  formatError: (err: unknown) => String(err),
}));

vi.mock("../deliver-reply.js", () => ({
  deliverWebReply: vi.fn(async () => {}),
}));

vi.mock("../loggers.js", () => ({
  whatsappInboundLog: { info: () => {}, debug: () => {} },
}));

vi.mock("./ack-reaction.js", () => ({
  maybeSendAckReaction: (...args: unknown[]) => maybeSendAckReactionMock(...args),
}));

vi.mock("./inbound-context.js", () => ({
  resolveVisibleWhatsAppGroupHistory: () => [],
  resolveVisibleWhatsAppReplyContext: () => null,
}));

vi.mock("./last-route.js", () => ({
  trackBackgroundTask: () => {},
  updateLastRouteInBackground: () => {},
}));

vi.mock("./message-line.js", () => ({
  buildInboundLine: (params: { msg: WebInboundMessage }) => params.msg.payload.body,
}));

vi.mock("./runtime-api.js", () => ({
  buildHistoryContextFromEntries: (_p: { currentMessage: string }) => _p.currentMessage,
  createChannelMessageReplyPipeline: () => ({ onModelSelected: undefined }),
  formatInboundEnvelope: (p: { body: string }) => p.body,
  isControlCommandMessage: () => false,
  logVerbose: () => {},
  normalizeE164: (v: string) => v,
  readStoreAllowFromForDmPolicy: async () => [],
  recordSessionMetaFromInbound: async () => {},
  resolveChannelContextVisibilityMode: () => "standard",
  resolveInboundSessionEnvelopeContext: () => ({
    storePath: "/tmp/sessions.json",
    envelopeOptions: {},
    previousTimestamp: undefined,
  }),
  resolvePinnedMainDmOwnerFromAllowlist: () => null,
  resolveDmGroupAccessWithCommandGate: () => ({ commandAuthorized: true }),
  shouldComputeCommandAuthorized: (body: string) => {
    shouldComputeCommandBodies.push(body);
    return shouldComputeCommandResult || body.startsWith("/");
  },
  shouldLogVerbose: () => false,
  type: undefined,
}));

vi.mock("./inbound-dispatch.js", () => ({
  buildWhatsAppInboundContext: (params: {
    bodyForAgent?: string;
    combinedBody: string;
    commandAuthorized?: boolean;
    commandBody?: string;
    msg: WebInboundMessage;
    mediaTranscribedIndexes?: number[];
    rawBody?: string;
    transcript?: string;
  }) => ({
    Body: params.combinedBody,
    BodyForAgent: params.bodyForAgent ?? params.msg.payload.body,
    CommandAuthorized: params.commandAuthorized,
    CommandBody: params.commandBody ?? params.msg.payload.body,
    MediaPath: params.msg.payload.media?.path,
    MediaType: params.msg.payload.media?.type,
    MediaTranscribedIndexes: params.mediaTranscribedIndexes,
    RawBody: params.rawBody ?? params.msg.payload.body,
    Transcript: params.transcript,
  }),
  dispatchWhatsAppBufferedReply: vi.fn(async () => true),
  resolveWhatsAppDmRouteTarget: () => "+15550000002",
  resolveWhatsAppResponsePrefix: () => undefined,
  updateWhatsAppMainLastRoute: () => {},
}));

import { createTestWebInboundMessage } from "../../inbound/admission.test-support.js";
import type { WebInboundMessage } from "../../inbound/types.js";
import { dispatchWhatsAppBufferedReply } from "./inbound-dispatch.js";
import { processMessage } from "./process-message.js";

type TestRoute = Parameters<typeof processMessage>[0]["route"];
type Phase5AudioPreflightResult =
  | { kind: "not_provided" }
  | { kind: "not_audio" }
  | { kind: "no_transcript" }
  | { kind: "transcript"; transcript: string };

type Phase5ProcessMessageParams = Parameters<typeof processMessage>[0] & {
  audioPreflight: Phase5AudioPreflightResult;
};

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

type AudioMessageOverrides = {
  body?: string;
  media?: WebInboundMessage["payload"]["media"];
};

function makeAudioMsg(overrides: AudioMessageOverrides = {}): WebInboundMessage {
  return createTestWebInboundMessage({
    event: { id: "msg-1" },
    payload: {
      body: overrides.body ?? "<media:audio>",
      media: overrides.media ?? {
        type: "audio/ogg; codecs=opus",
        path: "/tmp/voice.ogg",
      },
    },
  });
}

function makeRoute(overrides: Partial<TestRoute> = {}): TestRoute {
  return {
    agentId: "main",
    sessionKey: "agent:main:main",
    mainSessionKey: "agent:main:main",
    accountId: "default",
    ...overrides,
  } as TestRoute;
}

function makeParams(msgOverrides: AudioMessageOverrides = {}) {
  return {
    cfg: {
      tools: { media: { audio: { enabled: true } } },
      channels: { whatsapp: {} },
      commands: { useAccessGroups: false },
    } as never,
    msg: makeAudioMsg(msgOverrides),
    route: makeRoute(),
    groupHistoryKey: "whatsapp:default:+15550000002",
    groupHistories: new Map(),
    groupMemberNames: new Map(),
    connectionId: "conn-1",
    verbose: false,
    maxMediaBytes: 1024 * 1024,
    replyResolver: vi.fn() as never,
    replyLogger: {
      info: () => {},
      warn: () => {},
      debug: () => {},
      error: () => {},
    } as never,
    backgroundTasks: new Set<Promise<unknown>>(),
    rememberSentText: () => {},
    echoHas: () => false,
    echoForget: () => {},
    buildCombinedEchoKey: (p: { combinedBody: string }) => p.combinedBody,
    audioPreflight: { kind: "not_provided" },
    routeLifecycle: { kind: "direct" },
  } satisfies Phase5ProcessMessageParams;
}

function makeAckReactionHandle() {
  return {
    ackReactionPromise: Promise.resolve(true),
    ackReactionValue: "👀",
    remove: vi.fn(async () => undefined),
  };
}

function makeRemoveAckAfterReplyParams(): Phase5ProcessMessageParams {
  return {
    ...makeParams(),
    cfg: {
      tools: { media: { audio: { enabled: true } } },
      channels: { whatsapp: {} },
      commands: { useAccessGroups: false },
      messages: { removeAckAfterReply: true },
    } as never,
    audioPreflight: {
      kind: "transcript",
      transcript: "pre-computed transcript from caller",
    },
  };
}

function firstTranscriptionContext(): Record<string, unknown> {
  const call = transcribeFirstAudioMock.mock.calls[0]?.[0] as
    | { ctx?: Record<string, unknown> }
    | undefined;
  if (!call?.ctx) {
    throw new Error("expected transcribeFirstAudio ctx");
  }
  return call.ctx;
}

function firstDispatchContext(): Record<string, unknown> {
  const calls = vi.mocked(dispatchWhatsAppBufferedReply).mock.calls as unknown[][];
  const dispatch = calls[0]?.[0] as { context?: Record<string, unknown> } | undefined;
  if (!dispatch?.context) {
    throw new Error("expected WhatsApp dispatch context");
  }
  return dispatch.context;
}

function expectContextFields(context: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(context[key]).toEqual(value);
  }
}

describe("processMessage audio preflight transcription", () => {
  beforeEach(() => {
    transcribeFirstAudioMock.mockReset();
    maybeSendAckReactionMock.mockReset();
    maybeSendAckReactionMock.mockResolvedValue(null);
    shouldComputeCommandResult = false;
    shouldComputeCommandBodies = [];
    vi.mocked(dispatchWhatsAppBufferedReply).mockClear();
  });

  it("replaces <media:audio> body with transcript when transcription succeeds", async () => {
    transcribeFirstAudioMock.mockResolvedValueOnce("okay let's test this voice message");

    await processMessage(makeParams());

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expectContextFields(firstTranscriptionContext(), {
      AccountId: "default",
      From: "+15550000002",
      MediaPaths: ["/tmp/voice.ogg"],
      MediaTypes: ["audio/ogg; codecs=opus"],
      OriginatingChannel: "whatsapp",
      OriginatingTo: "+15550000002",
      Provider: "whatsapp",
      Surface: "whatsapp",
      To: "+15550000001",
    });

    const context = firstDispatchContext();
    expectContextFields(context, {
      Body: "okay let's test this voice message",
      BodyForAgent: "okay let's test this voice message",
      CommandBody: "<media:audio>",
      RawBody: "<media:audio>",
      Transcript: "okay let's test this voice message",
      MediaTranscribedIndexes: [0],
    });
    // payload media path/type must be preserved so inboundAudio detection (used by
    // features like messages.tts.auto: "inbound") still recognises this as audio.
    expectContextFields(context, {
      MediaPath: "/tmp/voice.ogg",
      MediaType: "audio/ogg; codecs=opus",
    });
  });

  it("falls back to <media:audio> placeholder when transcription fails", async () => {
    transcribeFirstAudioMock.mockRejectedValueOnce(new Error("provider unavailable"));

    await processMessage(makeParams());

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);

    expectContextFields(firstDispatchContext(), {
      Body: "<media:audio>",
      BodyForAgent: "<media:audio>",
    });
  });

  it("falls back to <media:audio> placeholder when transcription returns undefined", async () => {
    transcribeFirstAudioMock.mockResolvedValueOnce(undefined);

    await processMessage(makeParams());

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);

    expectContextFields(firstDispatchContext(), {
      Body: "<media:audio>",
      BodyForAgent: "<media:audio>",
    });
  });

  it("does not call transcribeFirstAudio when mediaType is not audio", async () => {
    await processMessage(
      makeParams({ body: "<media:image>", media: { type: "image/jpeg", path: "/tmp/img.jpg" } }),
    );

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
  });

  it("does not call transcribeFirstAudio when body is not <media:audio>", async () => {
    await processMessage(
      makeParams({ body: "hello there", media: { type: "audio/ogg; codecs=opus" } }),
    );

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
  });

  it("does not call transcribeFirstAudio when mediaPath is absent", async () => {
    await processMessage(makeParams({ media: { type: "audio/ogg; codecs=opus" } }));

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
  });

  it("does not call transcribeFirstAudio when payload media type is absent", async () => {
    await processMessage(makeParams({ body: "<media:audio>", media: { path: "/tmp/voice.ogg" } }));

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();

    // Body passes through as-is without a mediaType to confirm audio
    expectContextFields(firstDispatchContext(), {
      Body: "<media:audio>",
    });
  });

  it("does not use transcript body for command detection", async () => {
    transcribeFirstAudioMock.mockResolvedValueOnce("/new start a new session");

    await processMessage(makeParams());

    expect(shouldComputeCommandBodies).toEqual(["<media:audio>"]);

    expectContextFields(firstDispatchContext(), {
      Body: "/new start a new session",
      BodyForAgent: "/new start a new session",
      CommandBody: "<media:audio>",
      RawBody: "<media:audio>",
      Transcript: "/new start a new session",
      MediaTranscribedIndexes: [0],
    });
  });

  it("uses the lifecycle audio transcript result, skipping transcribeFirstAudio", async () => {
    await processMessage({
      ...makeParams(),
      audioPreflight: {
        kind: "transcript",
        transcript: "pre-computed transcript from fan-out caller",
      },
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();

    expectContextFields(firstDispatchContext(), {
      Body: "pre-computed transcript from fan-out caller",
      BodyForAgent: "pre-computed transcript from fan-out caller",
      CommandBody: "<media:audio>",
      RawBody: "<media:audio>",
      Transcript: "pre-computed transcript from fan-out caller",
      MediaTranscribedIndexes: [0],
    });
  });

  it("does not send a duplicate ack when caller already sent it", async () => {
    await processMessage({
      ...makeParams(),
      audioPreflight: {
        kind: "transcript",
        transcript: "pre-computed transcript from caller",
      },
      ackAlreadySent: true,
      ackReaction: makeAckReactionHandle(),
    });

    expect(maybeSendAckReactionMock).not.toHaveBeenCalled();
  });

  it("removes caller-provided ack after a successful visible reply", async () => {
    const ackReaction = makeAckReactionHandle();

    await processMessage({
      ...makeRemoveAckAfterReplyParams(),
      ackReaction,
    });
    await flushMicrotasks();

    expect(ackReaction.remove).toHaveBeenCalledTimes(1);
  });

  it("removes internally sent ack after a successful visible reply", async () => {
    const ackReaction = makeAckReactionHandle();
    maybeSendAckReactionMock.mockResolvedValueOnce(ackReaction);

    await processMessage(makeRemoveAckAfterReplyParams());
    await flushMicrotasks();

    expect(maybeSendAckReactionMock).toHaveBeenCalledTimes(1);
    expect(ackReaction.remove).toHaveBeenCalledTimes(1);
  });

  it("keeps ack when no visible reply was delivered", async () => {
    const ackReaction = makeAckReactionHandle();
    maybeSendAckReactionMock.mockResolvedValueOnce(ackReaction);
    vi.mocked(dispatchWhatsAppBufferedReply).mockResolvedValueOnce(false);

    await processMessage(makeRemoveAckAfterReplyParams());
    await flushMicrotasks();

    expect(ackReaction.remove).not.toHaveBeenCalled();
  });

  it("keeps ack when the ack send failed", async () => {
    const ackReaction = {
      ...makeAckReactionHandle(),
      ackReactionPromise: Promise.resolve(false),
    };
    maybeSendAckReactionMock.mockResolvedValueOnce(ackReaction);

    await processMessage(makeRemoveAckAfterReplyParams());
    await flushMicrotasks();

    expect(ackReaction.remove).not.toHaveBeenCalled();
  });

  it("skips internal STT when lifecycle audio preflight already produced no transcript", async () => {
    await processMessage({
      ...makeParams(),
      audioPreflight: { kind: "no_transcript" },
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();

    // Body falls back to the original <media:audio> placeholder, not retried transcript.
    expectContextFields(firstDispatchContext(), {
      Body: "<media:audio>",
    });
  });
});
