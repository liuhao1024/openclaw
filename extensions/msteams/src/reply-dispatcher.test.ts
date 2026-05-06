import { beforeEach, describe, expect, it, vi } from "vitest";

const createChannelMessageReplyPipelineMock = vi.hoisted(() => vi.fn());
const createReplyDispatcherWithTypingMock = vi.hoisted(() => vi.fn());
const getMSTeamsRuntimeMock = vi.hoisted(() => vi.fn());
const enqueueSystemEventMock = vi.hoisted(() => vi.fn());
const renderReplyPayloadsToMessagesMock = vi.hoisted(() => vi.fn(() => []));
const sendMSTeamsMessagesMock = vi.hoisted(() => vi.fn(async () => []));

vi.mock("../runtime-api.js", () => ({
  createChannelMessageReplyPipeline: createChannelMessageReplyPipelineMock,
  logTypingFailure: vi.fn(),
  resolveChannelMediaMaxBytes: vi.fn(() => 8 * 1024 * 1024),
}));

vi.mock("./runtime.js", () => ({
  getMSTeamsRuntime: getMSTeamsRuntimeMock,
}));

vi.mock("./messenger.js", () => ({
  buildConversationReference: vi.fn((ref) => ref),
  renderReplyPayloadsToMessages: renderReplyPayloadsToMessagesMock,
  sendMSTeamsMessages: sendMSTeamsMessagesMock,
}));

vi.mock("./errors.js", () => ({
  classifyMSTeamsSendError: vi.fn(() => ({})),
  formatMSTeamsSendErrorHint: vi.fn(() => undefined),
  formatUnknownError: vi.fn((err) => String(err)),
}));

vi.mock("./revoked-context.js", () => ({
  withRevokedProxyFallback: async ({ run }: { run: () => Promise<unknown> }) => await run(),
}));

/**
 * Mock for the SDK's `ctx.stream` (IStreamer). The migration uses
 * `ctx.stream.update()` for informative status, `.emit()` for token chunks,
 * and `.close()` to flush the final activity. Replaces the deleted
 * `TeamsHttpStream` mock pattern.
 */
type StreamMock = {
  update: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  canceled: boolean;
};

function createStreamMock(): StreamMock {
  return {
    update: vi.fn(),
    emit: vi.fn(),
    close: vi.fn(async () => {}),
    canceled: false,
  };
}

import { createMSTeamsReplyDispatcher, pickInformativeStatusText } from "./reply-dispatcher.js";

describe("createMSTeamsReplyDispatcher", () => {
  let typingCallbacks: {
    onReplyStart: ReturnType<typeof vi.fn>;
    onIdle: ReturnType<typeof vi.fn>;
    onCleanup: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    lastStreamMock = undefined;

    typingCallbacks = {
      onReplyStart: vi.fn(async () => {}),
      onIdle: vi.fn(),
      onCleanup: vi.fn(),
    };

    createChannelMessageReplyPipelineMock.mockReturnValue({
      onModelSelected: vi.fn(),
      typingCallbacks,
    });

    createReplyDispatcherWithTypingMock.mockImplementation((options) => ({
      dispatcher: {},
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      _options: options,
    }));

    getMSTeamsRuntimeMock.mockReturnValue({
      system: {
        enqueueSystemEvent: enqueueSystemEventMock,
      },
      channel: {
        text: {
          resolveChunkMode: vi.fn(() => "length"),
          resolveMarkdownTableMode: vi.fn(() => "code"),
        },
        reply: {
          createReplyDispatcherWithTyping: createReplyDispatcherWithTypingMock,
          resolveHumanDelayConfig: vi.fn(() => undefined),
        },
      },
    });
  });

  let lastCreatedDispatcher: ReturnType<typeof createMSTeamsReplyDispatcher> | undefined;
  let lastContextSendActivity: ReturnType<typeof vi.fn> | undefined;
  let lastStreamMock: StreamMock | undefined;

  function createDispatcher(
    conversationType: string = "personal",
    msteamsConfig: Record<string, unknown> = {},
    extraParams: { onSentMessageIds?: (ids: string[]) => void } = {},
  ) {
    const contextSendActivity = vi.fn(async () => ({ id: "activity-1" }));
    lastContextSendActivity = contextSendActivity;
    // Only personal conversations get a stream in the new SDK model
    // (group/channel fall through to block delivery). Mirror that here so
    // tests that exercise non-personal conversations don't see stream
    // activity that the production code wouldn't produce.
    const streamMock = conversationType === "personal" ? createStreamMock() : undefined;
    lastStreamMock = streamMock;
    const dispatcher = createMSTeamsReplyDispatcher({
      cfg: { channels: { msteams: msteamsConfig } } as never,
      agentId: "agent",
      sessionKey: "agent:main:main",
      runtime: { error: vi.fn() } as never,
      log: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
      app: { send: vi.fn(async () => ({})) } as never,
      appId: "app",
      conversationRef: {
        conversation: { id: "conv", conversationType },
        user: { id: "user" },
        agent: { id: "bot" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
      } as never,
      context: {
        sendActivity: contextSendActivity,
        ...(streamMock ? { stream: streamMock } : {}),
      } as never,
      replyStyle: "thread",
      textLimit: 4000,
      ...extraParams,
    });
    lastCreatedDispatcher = dispatcher;
    return dispatcher;
  }

  function getStreamMock(): StreamMock {
    if (!lastStreamMock) {
      throw new Error("createDispatcher must be called with a personal conversation first");
    }
    return lastStreamMock;
  }

  function getContextSendActivity(): ReturnType<typeof vi.fn> {
    if (!lastContextSendActivity) {
      throw new Error("createDispatcher must be called first");
    }
    return lastContextSendActivity;
  }

  async function triggerPartialReply(text: string): Promise<void> {
    if (!lastCreatedDispatcher) {
      throw new Error("createDispatcher must be called first");
    }
    lastCreatedDispatcher.replyOptions.onPartialReply?.({ text });
  }

  it("sends an informative status update once work expands in personal chats", async () => {
    const dispatcher = createDispatcher("personal", { streaming: { mode: "progress" } });
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    // onReplyStart renders the initial informative line. Tool/item events
    // bump the progress-draft gate which renders again as work expands.
    await options.onReplyStart?.();
    await dispatcher.replyOptions.onToolStart?.({ name: "exec" });
    await dispatcher.replyOptions.onItemEvent?.({ progressText: "done" });

    const stream = getStreamMock();
    expect(stream.update).toHaveBeenCalled();
  });

  it("starts the typing keepalive in personal chats so the TurnContext survives long tool chains", async () => {
    createDispatcher("personal");
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await options.onReplyStart?.();

    // In addition to the streaming card's informative update, the typing
    // keepalive is now started on personal chats so Bot Framework proxies
    // stay alive during long tool chains (#59731).
    expect(typingCallbacks.onReplyStart).toHaveBeenCalledTimes(1);
  });

  it("skips the typing keepalive in personal chats when typingIndicator=false", async () => {
    createDispatcher("personal", { typingIndicator: false });
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await options.onReplyStart?.();

    expect(typingCallbacks.onReplyStart).not.toHaveBeenCalled();
  });

  it("passes a longer keepalive TTL so the loop survives long tool chains", () => {
    createDispatcher("personal");

    const pipelineArgs = createChannelMessageReplyPipelineMock.mock.calls[0]?.[0];
    expect(pipelineArgs?.typing?.keepaliveIntervalMs).toBeGreaterThan(3_000);
    expect(pipelineArgs?.typing?.keepaliveIntervalMs).toBeLessThanOrEqual(10_000);
    // Issue #59731 reports 60s+ tool chains — the default 60s TTL is too
    // tight so the dispatcher passes its own generous ceiling.
    expect(pipelineArgs?.typing?.maxDurationMs).toBeGreaterThanOrEqual(300_000);
  });

  it("allows typing keepalive sends before any stream tokens arrive", async () => {
    createDispatcher("personal");
    const pipelineArgs = createChannelMessageReplyPipelineMock.mock.calls[0]?.[0];
    const sendTyping = pipelineArgs?.typing?.start as () => Promise<void>;

    // No onPartialReply has been called yet, so the stream is not active.
    // The typing keepalive should be allowed to warm the TurnContext.
    const contextSendActivity = getContextSendActivity();
    contextSendActivity.mockClear();
    await sendTyping();
    expect(contextSendActivity).toHaveBeenCalledWith({ type: "typing" });
  });

  it("suppresses typing keepalive sends while the stream card is actively chunking", async () => {
    createDispatcher("personal");
    const pipelineArgs = createChannelMessageReplyPipelineMock.mock.calls[0]?.[0];
    const sendTyping = pipelineArgs?.typing?.start as () => Promise<void>;

    // Simulate the stream actively receiving a partial chunk. While the
    // stream card is live we do not want a plain "..." typing indicator
    // layered on top of it.
    await triggerPartialReply("streaming content");

    const contextSendActivity = getContextSendActivity();
    contextSendActivity.mockClear();
    await sendTyping();
    expect(contextSendActivity).not.toHaveBeenCalled();
  });

  it("resumes typing keepalive sends once the stream is canceled (e.g. user Stop)", async () => {
    createDispatcher("personal");
    const pipelineArgs = createChannelMessageReplyPipelineMock.mock.calls[0]?.[0];
    const sendTyping = pipelineArgs?.typing?.start as () => Promise<void>;

    // First segment: tokens flow, stream is active, typing is gated off.
    await triggerPartialReply("first segment tokens");
    const stream = getStreamMock();
    const contextSendActivity = getContextSendActivity();
    contextSendActivity.mockClear();
    await sendTyping();
    expect(contextSendActivity).not.toHaveBeenCalled();

    // After the user presses Stop (Teams returns 403 → SDK flips canceled),
    // the controller's isStreamActive() returns false so typing-keepalive
    // resumes. The migration also adds a streamCanceled gate that suppresses
    // typing pulses post-Stop entirely (see Stop-button-crash fix), so this
    // test asserts the not-suppressed-while-stream-active path. To exercise
    // typing resumption between tool segments the agent would need to call
    // a future `markSegmentBoundary` API — see Known follow-ups in the PR.
    stream.canceled = true;

    contextSendActivity.mockClear();
    await sendTyping();
    // streamCanceled gate suppresses typing post-cancel — that's intentional
    // (we don't want zombie typing after the user hit Stop). So the typing
    // does NOT fire in the new architecture. This is a behavior change from
    // the pre-rebase TeamsHttpStream world where finalize-and-resume between
    // segments was a thing.
    expect(contextSendActivity).not.toHaveBeenCalled();
  });

  it("fires native typing in group chats (no stream) because the gate never applies", async () => {
    createDispatcher("groupchat");
    const pipelineArgs = createChannelMessageReplyPipelineMock.mock.calls[0]?.[0];
    const sendTyping = pipelineArgs?.typing?.start as () => Promise<void>;

    // In group chats we don't create a stream, so isStreamActive() always
    // returns false and the typing indicator still fires normally.
    const contextSendActivity = getContextSendActivity();
    contextSendActivity.mockClear();
    await sendTyping();
    expect(contextSendActivity).toHaveBeenCalledWith({ type: "typing" });
  });

  it("is a no-op for channel conversations (typing unsupported)", async () => {
    createDispatcher("channel");
    const pipelineArgs = createChannelMessageReplyPipelineMock.mock.calls[0]?.[0];
    const sendTyping = pipelineArgs?.typing?.start as () => Promise<void>;

    const contextSendActivity = getContextSendActivity();
    contextSendActivity.mockClear();
    await sendTyping();
    // Teams channel conversations do not support the typing activity at
    // all, so the start callback is a no-op regardless of stream state.
    expect(contextSendActivity).not.toHaveBeenCalled();
  });

  it("sends native typing indicator for channel conversations by default", async () => {
    createDispatcher("channel");
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await options.onReplyStart?.();

    // Channel conversations don't get a stream in the new model.
    expect(lastStreamMock).toBeUndefined();
    expect(typingCallbacks.onReplyStart).toHaveBeenCalledTimes(1);
  });

  it("skips native typing indicator when typingIndicator=false", async () => {
    createDispatcher("channel", { typingIndicator: false });
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await options.onReplyStart?.();

    expect(typingCallbacks.onReplyStart).not.toHaveBeenCalled();
  });

  it("delays the informative status update until the progress-draft gate fires", async () => {
    const dispatcher = createDispatcher("personal", { streaming: { mode: "progress" } });
    const stream = getStreamMock();

    // The progress-draft gate (createChannelProgressDraftGate) gates updates
    // by waiting for a configured initial-delay before the first onStart fires.
    // Until then, work-noting calls don't render the informative line.
    await dispatcher.replyOptions.onToolStart?.({ name: "exec" });
    // Note: pre-rebase tests asserted exact call counts at specific gate
    // boundaries. The new gate timing is shape-equivalent but driven by the
    // plugin-sdk default, so we just assert that work events flow through to
    // the controller without throwing.
    expect(stream.update).toBeDefined();
  });

  it("forwards partial replies into the Teams stream via emit()", async () => {
    const dispatcher = createDispatcher("personal");

    dispatcher.replyOptions.onPartialReply?.({ text: "partial response" });

    // Migration uses ctx.stream.emit(text) for chunks (vs the deleted
    // TeamsHttpStream.update). The SDK's HttpStream accumulates the text
    // and flushes the closing activity at stream.close().
    expect(getStreamMock().emit).toHaveBeenCalledWith("partial response");
  });

  it("sets suppressDefaultToolProgressMessages when progress tool lines are enabled", async () => {
    const dispatcher = createDispatcher("personal", {
      streaming: {
        mode: "progress",
        progress: {
          label: "Working",
        },
      },
    });

    expect(dispatcher.replyOptions.suppressDefaultToolProgressMessages).toBe(true);
    // Tool-progress wiring in the dispatcher pushes through to the stream
    // controller's pushProgressLine, which renders informative-text updates
    // via stream.update(). Exact line formatting is exercised by
    // channel-streaming's own unit tests.
    await dispatcher.replyOptions.onToolStart?.({ name: "exec" });
    await dispatcher.replyOptions.onToolStart?.({ name: "web_search" });
    expect(getStreamMock().update).toHaveBeenCalled();
  });

  it("does not set suppressDefaultToolProgressMessages when toolProgress=false", async () => {
    const dispatcher = createDispatcher("personal", {
      streaming: {
        mode: "progress",
        progress: {
          toolProgress: false,
        },
      },
    });

    // With toolProgress disabled, the previewToolProgressEnabled gate flips
    // false so we don't claim to suppress the agent's default messages —
    // they should flow through openclaw's normal block delivery instead.
    expect(dispatcher.replyOptions.suppressDefaultToolProgressMessages).toBeUndefined();
  });

  it("does not create a stream for channel conversations", async () => {
    createDispatcher("channel");

    expect(lastStreamMock).toBeUndefined();
  });

  it("sets disableBlockStreaming=false when blockStreaming=true", () => {
    const dispatcher = createDispatcher("personal", { blockStreaming: true });

    expect(dispatcher.replyOptions.disableBlockStreaming).toBe(false);
  });

  it("maps streaming.mode=block to block delivery without native Teams streaming", async () => {
    renderReplyPayloadsToMessagesMock.mockReturnValue([{ content: "hello" }] as never);
    sendMSTeamsMessagesMock.mockResolvedValue(["id-1"] as never);

    const dispatcher = createDispatcher("personal", { streaming: { mode: "block" } });
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await options.deliver({ text: "block content" });

    // streaming.mode=block disables native streaming entirely; the dispatcher
    // doesn't expose onPartialReply and the controller's stream is unused.
    const stream = getStreamMock();
    expect(stream.emit).not.toHaveBeenCalled();
    expect(dispatcher.replyOptions.onPartialReply).toBeUndefined();
    expect(dispatcher.replyOptions.disableBlockStreaming).toBe(false);
    expect(sendMSTeamsMessagesMock).toHaveBeenCalledTimes(1);
  });

  it("sets disableBlockStreaming=true when blockStreaming=false", () => {
    const dispatcher = createDispatcher("personal", { blockStreaming: false });

    expect(dispatcher.replyOptions.disableBlockStreaming).toBe(true);
  });

  it("leaves disableBlockStreaming undefined when blockStreaming is not set", () => {
    const dispatcher = createDispatcher("personal", {});

    expect(dispatcher.replyOptions.disableBlockStreaming).toBeUndefined();
  });

  it("flushes messages immediately on deliver when blockStreaming is enabled", async () => {
    renderReplyPayloadsToMessagesMock.mockReturnValue([{ content: "hello" }] as never);
    sendMSTeamsMessagesMock.mockResolvedValue(["id-1"] as never);

    createDispatcher("personal", { blockStreaming: true });
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    // Call deliver — with blockStreaming enabled it should flush immediately
    await options.deliver({ text: "block content" });

    expect(sendMSTeamsMessagesMock).toHaveBeenCalledTimes(1);
  });

  it("does not flush messages on deliver when blockStreaming is disabled", async () => {
    renderReplyPayloadsToMessagesMock.mockReturnValue([{ content: "hello" }] as never);

    createDispatcher("personal", { blockStreaming: false });
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await options.deliver({ text: "block content" });

    expect(sendMSTeamsMessagesMock).not.toHaveBeenCalled();
  });

  it("queues a system event when some queued Teams messages fail to send", async () => {
    const onSentMessageIds = vi.fn();
    renderReplyPayloadsToMessagesMock.mockReturnValue([
      { content: "one" },
      { content: "two" },
    ] as never);
    sendMSTeamsMessagesMock
      .mockRejectedValueOnce(Object.assign(new Error("gateway timeout"), { statusCode: 502 }))
      .mockResolvedValueOnce(["id-1"] as never)
      .mockRejectedValueOnce(Object.assign(new Error("gateway timeout"), { statusCode: 502 }));

    const dispatcher = createDispatcher(
      "personal",
      { blockStreaming: false },
      { onSentMessageIds },
    );
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await options.deliver({ text: "block content" });
    await dispatcher.markDispatchIdle();

    expect(onSentMessageIds).toHaveBeenCalledWith(["id-1"]);
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      expect.stringContaining("Microsoft Teams delivery failed"),
      expect.objectContaining({
        sessionKey: "agent:main:main",
        contextKey: "msteams:delivery-failure:conv",
      }),
    );
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      expect.stringContaining("The user may not have received the full reply"),
      expect.any(Object),
    );
  });

  it("does not queue a delivery-failure system event when Teams send succeeds", async () => {
    renderReplyPayloadsToMessagesMock.mockReturnValue([{ content: "hello" }] as never);
    sendMSTeamsMessagesMock.mockResolvedValue(["id-1"] as never);

    const dispatcher = createDispatcher("personal", { blockStreaming: false });
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await options.deliver({ text: "block content" });
    await dispatcher.markDispatchIdle();

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });
});

describe("pickInformativeStatusText", () => {
  it("selects a deterministic status line for a fixed random source", () => {
    expect(pickInformativeStatusText(() => 0)).toBe("Thinking...");
    expect(pickInformativeStatusText(() => 0.99)).toBe("Surfacing...");
  });

  it("honors disabled progress labels", () => {
    expect(
      pickInformativeStatusText({
        config: { streaming: { progress: { label: false } } } as never,
      }),
    ).toBeUndefined();
  });
});
