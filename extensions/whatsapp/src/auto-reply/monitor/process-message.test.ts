import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppIdentity } from "../../identity.js";
import type { WhatsAppSendResult } from "../../inbound/send-result.js";

// Hoisted mocks used across tests so vi.mock factories can reference them.
const {
  buildContextMock,
  getSenderIdentityMock,
  isControlCommandMessageMock,
  resolveWhatsAppCommandAccessMock,
  resolveVisibleWhatsAppGroupHistoryMock,
  resolveVisibleWhatsAppReplyContextMock,
  runMessageReceivedMock,
  shouldComputeCommandAuthorizedMock,
  trackBackgroundTaskMock,
} = vi.hoisted(() => ({
  buildContextMock: vi.fn(),
  getSenderIdentityMock: vi.fn(
    (_msg: unknown, _authDir?: string): WhatsAppIdentity => ({
      name: "Alice",
      e164: "+15550002222",
    }),
  ),
  isControlCommandMessageMock: vi.fn(() => false),
  resolveWhatsAppCommandAccessMock: vi.fn((params: { admission: { resolvedPolicy?: unknown } }) => {
    const policy = params.admission.resolvedPolicy as
      | {
          commandAuthorization?: {
            evaluated: boolean;
            authorized: boolean;
            reasonCode: string;
          };
        }
      | undefined;
    const admitted = policy?.commandAuthorization;
    return admitted
      ? {
          evaluated: admitted.evaluated,
          requested: true,
          authorized: admitted.authorized,
          shouldBlockControlCommand: false,
          reasonCode: admitted.reasonCode,
        }
      : {
          evaluated: false,
          requested: false,
          authorized: false,
          shouldBlockControlCommand: false,
          reasonCode: "allowed",
        };
  }),
  resolveVisibleWhatsAppGroupHistoryMock: vi.fn((params: unknown) => {
    const history = (params as { history?: unknown }).history;
    return Array.isArray(history) ? history : [];
  }),
  resolveVisibleWhatsAppReplyContextMock: vi.fn((_: unknown): unknown => null),
  runMessageReceivedMock: vi.fn(async () => undefined),
  shouldComputeCommandAuthorizedMock: vi.fn(() => false),
  trackBackgroundTaskMock: vi.fn(),
}));

function acceptedSendResult(kind: "media" | "text", id: string): WhatsAppSendResult {
  return {
    kind,
    messageId: id,
    keys: [{ id }],
    providerAccepted: true,
  };
}

vi.mock("../../inbound-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../inbound-policy.js")>();
  return {
    ...actual,
    resolveWhatsAppCommandAccess: resolveWhatsAppCommandAccessMock,
  };
});

vi.mock("./inbound-dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./inbound-dispatch.js")>();
  return {
    ...actual,
    buildWhatsAppInboundContext: buildContextMock,
    dispatchWhatsAppBufferedReply: async () => ({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    }),
    resolveWhatsAppDmRouteTarget: () => null,
    resolveWhatsAppResponsePrefix: () => undefined,
    updateWhatsAppMainLastRoute: () => {},
  };
});

vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: (hookName: string) => hookName === "message_received",
    runMessageReceived: runMessageReceivedMock,
  }),
}));

vi.mock("../../identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../identity.js")>();
  return {
    ...actual,
    getPrimaryIdentityId: () => null,
    getSelfIdentity: () => ({ e164: "+15550001111" }),
    getSenderIdentity: getSenderIdentityMock,
  };
});

vi.mock("../../reconnect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../reconnect.js")>();
  return { ...actual, newConnectionId: () => "test-conn-id" };
});

vi.mock("../../session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../session.js")>();
  return { ...actual, formatError: (e: unknown) => String(e) };
});

vi.mock("../deliver-reply.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../deliver-reply.js")>();
  return { ...actual, deliverWebReply: async () => {} };
});

vi.mock("../loggers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../loggers.js")>();
  return {
    ...actual,
    whatsappInboundLog: { info: () => {}, debug: () => {} },
  };
});

vi.mock("./ack-reaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ack-reaction.js")>();
  return { ...actual, maybeSendAckReaction: async () => {} };
});

vi.mock("./inbound-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./inbound-context.js")>();
  return {
    ...actual,
    resolveVisibleWhatsAppGroupHistory: resolveVisibleWhatsAppGroupHistoryMock,
    resolveVisibleWhatsAppReplyContext: resolveVisibleWhatsAppReplyContextMock,
  };
});

vi.mock("./last-route.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./last-route.js")>();
  return {
    ...actual,
    trackBackgroundTask: trackBackgroundTaskMock,
    updateLastRouteInBackground: () => {},
  };
});

vi.mock("./message-line.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./message-line.js")>();
  return { ...actual, buildInboundLine: () => "hi" };
});

vi.mock("./runtime-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime-api.js")>();
  return {
    ...actual,
    buildHistoryContextFromEntries: () => "hi",
    createChannelMessageReplyPipeline: () => ({
      onModelSelected: () => {},
      responsePrefix: undefined,
    }),
    formatInboundEnvelope: () => "hi",
    logVerbose: () => {},
    normalizeE164: (v: string) => v,
    recordSessionMetaFromInbound: async () => {},
    resolveChannelContextVisibilityMode: () => "off",
    resolveInboundSessionEnvelopeContext: () => ({
      storePath: "/tmp",
      envelopeOptions: {},
      previousTimestamp: undefined,
    }),
    resolvePinnedMainDmOwnerFromAllowlist: () => null,
    isControlCommandMessage: isControlCommandMessageMock,
    shouldComputeCommandAuthorized: shouldComputeCommandAuthorizedMock,
    shouldLogVerbose: () => false,
  };
});

import { clearInternalHooks, registerInternalHook } from "openclaw/plugin-sdk/hook-runtime";
import { createTestWebInboundMessage } from "../../inbound/admission.test-support.js";
import type { WebInboundMessage } from "../../inbound/types.js";
import type { WhatsAppRouteLifecycleFacts } from "./process-handoff.js";
import { processMessage } from "./process-message.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ProcessMessageConfig = Parameters<typeof processMessage>[0]["cfg"];
type ProcessMessageGroupHistory = NonNullable<Parameters<typeof processMessage>[0]["groupHistory"]>;
type ProcessMessageConfigWithWhatsAppPluginHooks = ProcessMessageConfig & {
  channels?: ProcessMessageConfig["channels"] & {
    whatsapp?: NonNullable<NonNullable<ProcessMessageConfig["channels"]>["whatsapp"]> & {
      pluginHooks?: {
        messageReceived?: boolean;
      };
    };
  };
};

const GROUP_JID = "123@g.us";

async function withTempAuthDir<T>(fn: (authDir: string) => Promise<T>): Promise<T> {
  const authDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-process-message-"));
  try {
    return await fn(authDir);
  } finally {
    await fs.rm(authDir, { recursive: true, force: true });
  }
}

const baseMsg = createTestWebInboundMessage({
  admissionOverrides: {
    chatType: "group",
    conversationId: GROUP_JID,
    groupPolicy: "allowlist",
    groupAllowFrom: [],
  },
  event: {
    id: "msg1",
  },
  payload: {
    body: "hi",
  },
  platform: {
    recipientJid: "+15550001111",
    sendComposing: async () => {},
    reply: async () => acceptedSendResult("text", "r1"),
    sendMedia: async () => acceptedSendResult("media", "m1"),
  },
});

function withResolvedPolicy(
  msg: WebInboundMessage,
  resolvedPolicy: Record<string, unknown>,
): WebInboundMessage {
  return {
    ...msg,
    admission: {
      ...msg.admission,
      resolvedPolicy,
    } as WebInboundMessage["admission"],
  };
}

const baseRoute = {
  agentId: "main",
  channel: "whatsapp",
  accountId: "default",
  sessionKey: "agent:main:whatsapp:group:123@g.us",
  mainSessionKey: "agent:main:whatsapp:group:123@g.us",
  lastRoutePolicy: "main",
  matchedBy: "default",
};

function callProcessMessage(
  overrides: {
    cfg?: Parameters<typeof processMessage>[0]["cfg"];
    msg?: Parameters<typeof processMessage>[0]["msg"];
    groupHistory?: ProcessMessageGroupHistory;
    routeLifecycle?: WhatsAppRouteLifecycleFacts;
  } = {},
) {
  const params = {
    cfg: (overrides.cfg ?? {}) as never,
    msg: overrides.msg ?? baseMsg,
    route: baseRoute as never,
    groupHistoryKey: "whatsapp:default:group:123@g.us",
    groupHistories: new Map(),
    groupMemberNames: new Map(),
    connectionId: "conn-1",
    verbose: false,
    maxMediaBytes: 1024,
    replyResolver: (async () => undefined) as never,
    replyLogger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    backgroundTasks: new Set(),
    rememberSentText: () => {},
    echoHas: () => false,
    echoForget: () => {},
    buildCombinedEchoKey: ({ sessionKey }) => sessionKey,
    audioPreflight: { kind: "not_audio" },
    routeLifecycle: overrides.routeLifecycle ?? {
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
    },
    ...(overrides.groupHistory !== undefined ? { groupHistory: overrides.groupHistory } : {}),
  } satisfies Parameters<typeof processMessage>[0] & { groupHistory?: ProcessMessageGroupHistory };
  return processMessage(params);
}

function mockCallArg(mockFn: ReturnType<typeof vi.fn>, label: string, callIndex = 0, argIndex = 0) {
  const call = mockFn.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected ${label} call ${callIndex}`);
  }
  if (!(argIndex in call)) {
    throw new Error(`Expected ${label} call ${callIndex} argument ${argIndex}`);
  }
  return call[argIndex];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("processMessage group system prompt wiring", () => {
  beforeEach(() => {
    buildContextMock.mockReset();
    isControlCommandMessageMock.mockReset();
    isControlCommandMessageMock.mockReturnValue(false);
    resolveWhatsAppCommandAccessMock.mockClear();
    resolveVisibleWhatsAppGroupHistoryMock.mockReset();
    resolveVisibleWhatsAppGroupHistoryMock.mockImplementation((params: unknown) => {
      const history = (params as { history?: unknown }).history;
      return Array.isArray(history) ? history : [];
    });
    resolveVisibleWhatsAppReplyContextMock.mockReset();
    resolveVisibleWhatsAppReplyContextMock.mockReturnValue(null);
    runMessageReceivedMock.mockClear();
    shouldComputeCommandAuthorizedMock.mockReset();
    shouldComputeCommandAuthorizedMock.mockReturnValue(false);
    trackBackgroundTaskMock.mockClear();
    clearInternalHooks();
    buildContextMock.mockImplementation(
      (params: { groupSystemPrompt?: string; combinedBody?: string }) => ({
        GroupSystemPrompt: params.groupSystemPrompt,
        Body: params.combinedBody ?? "",
      }),
    );
    getSenderIdentityMock.mockReset();
    getSenderIdentityMock.mockReturnValue({ name: "Alice", e164: "+15550002222" });
  });

  afterEach(() => {
    clearInternalHooks();
  });

  it("resolves group systemPrompt from admission and passes it into buildWhatsAppInboundContext", async () => {
    await callProcessMessage({
      msg: withResolvedPolicy(
        createTestWebInboundMessage({
          admissionOverrides: {
            chatType: "group",
            conversationId: GROUP_JID,
          },
          event: {
            id: baseMsg.event.id,
          },
          payload: {
            body: baseMsg.payload.body,
          },
          platform: {
            recipientJid: baseMsg.platform.recipientJid,
            sendComposing: baseMsg.platform.sendComposing,
            reply: baseMsg.platform.reply,
            sendMedia: baseMsg.platform.sendMedia,
          },
        }),
        {
          systemPrompt: "from admission",
        },
      ),
    });

    expect(
      (
        mockCallArg(buildContextMock, "buildWhatsAppInboundContext") as {
          groupSystemPrompt?: string;
        }
      ).groupSystemPrompt,
    ).toBe("from admission");
  });

  it("normalizes sender context with the admitted account authDir", async () => {
    await withTempAuthDir(async (authDir) => {
      await fs.writeFile(
        path.join(authDir, "lid-mapping-777_reverse.json"),
        JSON.stringify("+1777"),
      );
      const actualIdentity =
        await vi.importActual<typeof import("../../identity.js")>("../../identity.js");
      getSenderIdentityMock.mockImplementationOnce((msg, authDir) =>
        actualIdentity.getSenderIdentity(
          msg as Parameters<typeof actualIdentity.getSenderIdentity>[0],
          authDir,
        ),
      );

      await callProcessMessage({
        msg: createTestWebInboundMessage({
          admissionOverrides: {
            chatType: "group",
            conversationId: GROUP_JID,
            senderId: "777@lid",
            account: {
              authDir,
            },
          },
          platform: {
            sender: {
              name: "Mapped Sender",
            },
          },
        }),
      });

      expect(buildContextMock.mock.calls[0]?.[0]).toMatchObject({
        sender: {
          id: "777@lid",
          name: "Mapped Sender",
          e164: "+1777",
        },
      });
    });
  });

  it("filters supplemental context with admission-owned context visibility facts", async () => {
    const visibleHistory = [
      {
        sender: "Admitted Sender",
        body: "visible from admission policy",
        senderJid: "15550007777@s.whatsapp.net",
      },
    ];
    const visibleReplyTo = {
      id: "quote-from-admission-policy",
      body: "visible quote",
      sender: {
        jid: "15550007777@s.whatsapp.net",
        e164: "+15550007777",
      },
    };
    const usesAdmittedContextVisibility = (params: unknown) => {
      const record = params as {
        groupPolicy?: unknown;
        groupAllowFrom?: unknown;
      };
      return (
        record.groupPolicy === "allowlist" &&
        Array.isArray(record.groupAllowFrom) &&
        record.groupAllowFrom.includes("+15550007777")
      );
    };
    const usesAdmittedReplyContext = (params: unknown) =>
      usesAdmittedContextVisibility(params) &&
      (params as { authDir?: unknown }).authDir === "/admitted/auth";
    resolveVisibleWhatsAppGroupHistoryMock.mockImplementationOnce((params: unknown) =>
      usesAdmittedContextVisibility(params) ? visibleHistory : [],
    );
    resolveVisibleWhatsAppReplyContextMock.mockImplementationOnce((params: unknown) =>
      usesAdmittedReplyContext(params) ? visibleReplyTo : null,
    );

    await callProcessMessage({
      cfg: {
        channels: {
          whatsapp: {
            groupPolicy: "open",
            groupAllowFrom: ["+15550009999"],
          },
        },
      } as ProcessMessageConfig,
      groupHistory: [
        {
          sender: "Admitted Sender",
          body: "visible from admission policy",
          senderJid: "15550007777@s.whatsapp.net",
        },
        {
          sender: "Config Sender",
          body: "would be visible only if current config won",
          senderJid: "15550009999@s.whatsapp.net",
        },
      ],
      msg: createTestWebInboundMessage({
        admissionOverrides: {
          chatType: "group",
          conversationId: GROUP_JID,
          groupPolicy: "open",
          groupAllowFrom: ["+15550009999"],
          resolvedPolicy: {
            contextVisibility: {
              groupPolicy: "allowlist",
              groupAllowFrom: ["+15550007777"],
              requireMention: false,
              groupAllowlist: {
                allowlistEnabled: true,
                allowed: true,
              },
            },
          },
          account: {
            authDir: "/admitted/auth",
            replyToMode: "batched",
          },
        },
        event: {
          isBatched: true,
        },
        quote: {
          id: "raw-quote",
          body: "raw quote",
          sender: {
            jid: "15550009999@s.whatsapp.net",
            e164: "+15550009999",
          },
        },
        platform: {
          recipientJid: baseMsg.platform.recipientJid,
          sendComposing: baseMsg.platform.sendComposing,
          reply: baseMsg.platform.reply,
          sendMedia: baseMsg.platform.sendMedia,
        },
      }),
    });

    expect(buildContextMock.mock.calls[0][0]).toMatchObject({
      groupHistory: visibleHistory,
      replyThreading: {
        implicitCurrentMessage: "allow",
      },
      visibleReplyTo,
    });
  });

  it("translates processing mention facts into context WasMentioned", async () => {
    await callProcessMessage({
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
    });

    expect(buildContextMock.mock.calls[0][0]).toMatchObject({
      wasMentioned: true,
    });
  });

  it("marks detected WhatsApp slash messages as text command turns", async () => {
    isControlCommandMessageMock.mockReturnValue(true);
    shouldComputeCommandAuthorizedMock.mockReturnValue(true);

    await callProcessMessage({
      msg: {
        ...baseMsg,
        payload: {
          ...baseMsg.payload,
          body: "/status",
        },
      },
    });

    expect(shouldComputeCommandAuthorizedMock).toHaveBeenCalledWith("/status", {});
    expect(isControlCommandMessageMock).toHaveBeenCalledWith("/status", {});
    expect(buildContextMock.mock.calls[0][0]).toMatchObject({
      commandBody: "/status",
      commandAuthorized: true,
      commandTurn: {
        kind: "text-slash",
        source: "text",
        authorized: true,
        body: "/status",
      },
      rawBody: "/status",
    });
    expect(resolveWhatsAppCommandAccessMock).toHaveBeenCalledWith({
      admission: expect.objectContaining({
        accountId: "default",
      }),
      commandBody: "/status",
    });
  });

  it("checks auth for inline command tokens without marking them as command-source turns", async () => {
    isControlCommandMessageMock.mockReturnValue(false);
    shouldComputeCommandAuthorizedMock.mockReturnValue(true);

    await callProcessMessage({
      msg: {
        ...baseMsg,
        payload: {
          ...baseMsg.payload,
          body: "please inspect `/tmp/foo`",
        },
      },
    });

    expect(buildContextMock.mock.calls[0][0]).toMatchObject({
      commandBody: "please inspect `/tmp/foo`",
      commandAuthorized: true,
      commandTurn: {
        kind: "normal",
        source: "message",
        authorized: false,
        body: "please inspect `/tmp/foo`",
      },
      rawBody: "please inspect `/tmp/foo`",
    });
    expect(buildContextMock.mock.calls[0][0].commandSource).toBeUndefined();
  });

  it("uses admission-time command access when current config and platform sender disagree", async () => {
    isControlCommandMessageMock.mockReturnValue(true);
    shouldComputeCommandAuthorizedMock.mockReturnValue(true);

    const msg = withResolvedPolicy(
      createTestWebInboundMessage({
        admissionOverrides: {
          chatType: "direct",
          conversationId: "+15550001111",
          senderId: "+15550001111",
          dmSenderId: "+15550001111",
        },
        payload: {
          body: "/status",
        },
        platform: {
          sender: { e164: "+15550009999" },
          selfE164: "+15550009998",
          recipientJid: "+15550009998",
        },
      }),
      {
        commandAuthorization: {
          evaluated: true,
          authorized: false,
          reasonCode: "control_command_unauthorized",
        },
      },
    );

    await callProcessMessage({
      cfg: {
        commands: { useAccessGroups: false },
      } as ProcessMessageConfig,
      msg,
    });

    const commandCall = resolveWhatsAppCommandAccessMock.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(commandCall).toEqual({
      admission: msg.admission,
      commandBody: "/status",
    });
    expect(commandCall).not.toHaveProperty("cfg");
    expect(commandCall).not.toHaveProperty("msg");
    expect(buildContextMock.mock.calls[0][0]).toMatchObject({
      commandAuthorized: false,
      commandTurn: {
        kind: "text-slash",
        source: "text",
        authorized: false,
        body: "/status",
      },
    });
  });

  it("keeps group command authorization on admission facts when platform sender is an operator", async () => {
    isControlCommandMessageMock.mockReturnValue(true);
    shouldComputeCommandAuthorizedMock.mockReturnValue(true);

    const msg = withResolvedPolicy(
      createTestWebInboundMessage({
        admissionOverrides: {
          chatType: "group",
          conversationId: GROUP_JID,
          senderId: "+15550001111",
          dmSenderId: GROUP_JID,
        },
        payload: {
          body: "/status",
        },
        platform: {
          sender: { e164: "+15550009999" },
          senderJid: "15550009999@s.whatsapp.net",
          recipientJid: "+15550009998",
        },
      }),
      {
        commandAuthorization: {
          evaluated: true,
          authorized: false,
          reasonCode: "control_command_unauthorized",
        },
      },
    );

    await callProcessMessage({
      cfg: {
        commands: { useAccessGroups: false },
      } as ProcessMessageConfig,
      msg,
    });

    expect(resolveWhatsAppCommandAccessMock).toHaveBeenCalledWith({
      admission: msg.admission,
      commandBody: "/status",
    });
    expect(buildContextMock.mock.calls[0][0]).toMatchObject({
      commandAuthorized: false,
      commandTurn: {
        kind: "text-slash",
        authorized: false,
      },
    });
  });

  it("fires message_received hooks with canonical WhatsApp correlation fields", async () => {
    const internalReceived = vi.fn();
    registerInternalHook("message:received", internalReceived);
    buildContextMock.mockImplementationOnce(() => ({
      Body: "hi",
      BodyForCommands: "hi",
      RawBody: "hi",
      CommandBody: "hi",
      From: GROUP_JID,
      To: "+15550001111",
      SessionKey: baseRoute.sessionKey,
      AccountId: "default",
      MessageSid: "msg1",
      SenderId: "+15550002222",
      SenderName: "Alice",
      SenderE164: "+15550002222",
      Timestamp: 1710000000,
      Provider: "whatsapp",
      Surface: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: GROUP_JID,
      GroupSubject: "Test Group",
    }));

    const cfg = {
      channels: {
        whatsapp: {
          enabled: true,
          pluginHooks: {
            messageReceived: true,
          },
        },
      },
    } satisfies ProcessMessageConfigWithWhatsAppPluginHooks;

    await callProcessMessage({
      cfg,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(runMessageReceivedMock).toHaveBeenCalledTimes(1);
    expect(runMessageReceivedMock).toHaveBeenCalledWith(
      {
        from: GROUP_JID,
        content: "hi",
        timestamp: 1710000000,
        threadId: undefined,
        messageId: "msg1",
        senderId: "+15550002222",
        sessionKey: baseRoute.sessionKey,
        runId: undefined,
        metadata: {
          to: "+15550001111",
          provider: "whatsapp",
          surface: "whatsapp",
          threadId: undefined,
          originatingChannel: "whatsapp",
          originatingTo: GROUP_JID,
          messageId: "msg1",
          senderId: "+15550002222",
          senderName: "Alice",
          senderUsername: undefined,
          senderE164: "+15550002222",
          guildId: undefined,
          channelName: undefined,
          topicName: undefined,
        },
      },
      {
        channelId: "whatsapp",
        accountId: "default",
        conversationId: GROUP_JID,
        sessionKey: baseRoute.sessionKey,
        messageId: "msg1",
        senderId: "+15550002222",
      },
    );
    expect(internalReceived).toHaveBeenCalledTimes(1);
    const internalEvent = mockCallArg(internalReceived, "internal message received") as Record<
      string,
      unknown
    >;
    expect(internalEvent.timestamp).toBeInstanceOf(Date);
    expect({ ...internalEvent, timestamp: undefined }).toEqual({
      type: "message",
      action: "received",
      sessionKey: baseRoute.sessionKey,
      context: {
        from: GROUP_JID,
        content: "hi",
        timestamp: 1710000000,
        channelId: "whatsapp",
        accountId: "default",
        conversationId: GROUP_JID,
        messageId: "msg1",
        metadata: {
          to: "+15550001111",
          provider: "whatsapp",
          surface: "whatsapp",
          threadId: undefined,
          senderId: "+15550002222",
          senderName: "Alice",
          senderUsername: undefined,
          senderE164: "+15550002222",
          guildId: undefined,
          channelName: undefined,
          topicName: undefined,
        },
      },
      timestamp: undefined,
      messages: [],
    });
  });

  it("does not fire WhatsApp message_received hooks without explicit opt-in", async () => {
    const internalReceived = vi.fn();
    registerInternalHook("message:received", internalReceived);
    await callProcessMessage();

    expect(runMessageReceivedMock).not.toHaveBeenCalled();
    expect(internalReceived).not.toHaveBeenCalled();
  });

  it("tracks session metadata writes as connection background tasks", async () => {
    buildContextMock.mockImplementationOnce(() => ({
      Body: "hi",
      RawBody: "hi",
      CommandBody: "hi",
      SessionKey: baseRoute.sessionKey,
      Provider: "whatsapp",
      Surface: "whatsapp",
    }));

    await callProcessMessage();

    expect(trackBackgroundTaskMock).toHaveBeenCalledTimes(1);
    expect(mockCallArg(trackBackgroundTaskMock, "trackBackgroundTask")).toBeInstanceOf(Set);
    expect(mockCallArg(trackBackgroundTaskMock, "trackBackgroundTask", 0, 1)).toBeInstanceOf(
      Promise,
    );
  });
});
