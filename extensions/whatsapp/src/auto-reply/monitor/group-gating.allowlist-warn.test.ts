import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./group-activation.js", () => ({
  resolveAcceptedGroupActivationFor: vi.fn(async () => "mention"),
}));

import { createTestWebInboundMessage } from "../../inbound/admission.test-support.js";
import type { WebInboundMessage } from "../../inbound/types.js";
import type { MentionConfig } from "../mentions.js";
import {
  resetGroupDropWarningsForTests,
  applyGroupGating,
  type GroupHistoryEntry,
} from "./group-gating.js";

function makeUnregisteredGroupMsg(
  conversationId: string,
  accountId: string = "default",
): WebInboundMessage {
  return createTestWebInboundMessage({
    admissionOverrides: {
      accountId,
      chatType: "group",
      conversationId,
      groupPolicy: "allowlist",
      groupAllowlistEnabled: true,
      groupAllowed: conversationId === "registered@g.us",
    },
    event: {
      id: `msg-${conversationId}`,
    },
    payload: {
      body: "@openclaw hello",
    },
  });
}

type WarnLogger = (obj: unknown, msg: string) => void;
type ApplyGroupGatingParams = Parameters<typeof applyGroupGating>[0];

async function withTempAuthDir<T>(fn: (authDir: string) => Promise<T>): Promise<T> {
  const authDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-group-gating-"));
  try {
    return await fn(authDir);
  } finally {
    await fs.rm(authDir, { recursive: true, force: true });
  }
}

function makeParams(
  msg: WebInboundMessage,
  warn: WarnLogger,
  cfg: ApplyGroupGatingParams["cfg"] = {
    channels: {
      whatsapp: {
        groupPolicy: "allowlist",
        groups: {
          "registered@g.us": {},
        },
        accounts: {
          work: {
            groupPolicy: "allowlist",
            groups: {
              "registered@g.us": {},
            },
          },
        },
      },
    },
    messages: {
      groupChat: {
        mentionPatterns: ["\\bopenclaw\\b"],
      },
    },
  } as never,
) {
  const conversationId = msg.admission.conversation.id;
  return {
    cfg,
    msg,
    conversationId,
    groupHistoryKey: `whatsapp:group:${conversationId}`,
    agentId: "main",
    sessionKey: `agent:main:whatsapp:group:${conversationId}`,
    baseMentionConfig: { mentionRegexes: [/\bopenclaw\b/i] } satisfies MentionConfig,
    groupHistories: new Map<string, GroupHistoryEntry[]>(),
    groupHistoryLimit: 20,
    groupMemberNames: new Map<string, Map<string, string>>(),
    logVerbose: vi.fn(),
    replyLogger: { debug: vi.fn(), warn },
  };
}

describe("applyGroupGating allowlist drop warning", () => {
  beforeEach(() => {
    resetGroupDropWarningsForTests();
  });

  it("emits a warn log naming the root groups path for the default account", async () => {
    const warn = vi.fn<WarnLogger>();
    const msg = makeUnregisteredGroupMsg("unregistered@g.us");
    const params = makeParams(msg, warn);

    const result = await applyGroupGating(params);

    expect(result).toEqual({
      shouldProcess: false,
      mention: {
        effectiveWasMentioned: false,
        shouldBypassMention: false,
      },
      activation: {
        kind: "absent",
        reason: "not_reached",
      },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(params.logVerbose).toHaveBeenCalledWith(
      'Dropping message from unregistered WhatsApp group unregistered@g.us. Add the group JID to channels.whatsapp.groups, or add "*" there to admit all groups. Sender authorization still applies.',
    );
    const [context, message] = warn.mock.calls[0] ?? [];
    expect(context).toMatchObject({
      conversationId: "unregistered@g.us",
      accountId: "default",
      groupsPath: "channels.whatsapp.groups",
    });
    expect(message).toContain("unregistered@g.us");
    expect(message).toContain("channels.whatsapp.groups");
  });

  it("names the account-scoped groups path for non-default accounts", async () => {
    const warn = vi.fn<WarnLogger>();
    const msg = makeUnregisteredGroupMsg("unregistered@g.us", "work");

    await applyGroupGating(makeParams(msg, warn));

    expect(warn).toHaveBeenCalledTimes(1);
    const [context, message] = warn.mock.calls[0] ?? [];
    expect(context).toMatchObject({
      conversationId: "unregistered@g.us",
      accountId: "work",
      groupsPath: "channels.whatsapp.accounts.work.groups",
    });
    expect(message).toContain("channels.whatsapp.accounts.work.groups");
  });

  it("names the root groups path for non-default accounts inheriting root groups", async () => {
    const warn = vi.fn<WarnLogger>();
    const msg = makeUnregisteredGroupMsg("unregistered@g.us", "work");
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
          groups: {
            "registered@g.us": {},
          },
          accounts: {
            work: {
              groupPolicy: "allowlist",
            },
          },
        },
      },
      messages: {
        groupChat: {
          mentionPatterns: ["\\bopenclaw\\b"],
        },
      },
    } as ApplyGroupGatingParams["cfg"];

    await applyGroupGating(makeParams(msg, warn, cfg));

    expect(warn).toHaveBeenCalledTimes(1);
    const [context, message] = warn.mock.calls[0] ?? [];
    expect(context).toMatchObject({
      conversationId: "unregistered@g.us",
      accountId: "work",
      groupsPath: "channels.whatsapp.groups",
    });
    expect(message).toContain("channels.whatsapp.groups");
  });

  it("warns once but keeps verbose diagnostics per dropped message", async () => {
    const warn = vi.fn<WarnLogger>();
    const first = makeParams(makeUnregisteredGroupMsg("loud@g.us"), warn);
    const second = makeParams(makeUnregisteredGroupMsg("loud@g.us"), warn);
    const third = makeParams(makeUnregisteredGroupMsg("loud@g.us"), warn);

    await applyGroupGating(first);
    await applyGroupGating(second);
    await applyGroupGating(third);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toContain("loud@g.us");
    expect(first.logVerbose).toHaveBeenCalledTimes(1);
    expect(second.logVerbose).toHaveBeenCalledTimes(1);
    expect(third.logVerbose).toHaveBeenCalledTimes(1);
  });

  it("warns separately for distinct conversations", async () => {
    const warn = vi.fn<WarnLogger>();

    await applyGroupGating(makeParams(makeUnregisteredGroupMsg("a@g.us"), warn));
    await applyGroupGating(makeParams(makeUnregisteredGroupMsg("b@g.us"), warn));

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[1]).toContain("a@g.us");
    expect(warn.mock.calls[1]?.[1]).toContain("b@g.us");
  });

  it("evicts old warning keys instead of growing without bound", async () => {
    const warn = vi.fn<WarnLogger>();

    await applyGroupGating(makeParams(makeUnregisteredGroupMsg("evicted@g.us"), warn));
    for (let index = 0; index < 100; index += 1) {
      await applyGroupGating(makeParams(makeUnregisteredGroupMsg(`overflow-${index}@g.us`), warn));
    }
    await applyGroupGating(makeParams(makeUnregisteredGroupMsg("evicted@g.us"), warn));

    expect(warn).toHaveBeenCalledTimes(102);
    expect(warn.mock.calls[0]?.[1]).toContain("evicted@g.us");
    expect(warn.mock.calls[101]?.[1]).toContain("evicted@g.us");
  });

  it("does not warn when the group is registered", async () => {
    const warn = vi.fn<WarnLogger>();
    const msg = makeUnregisteredGroupMsg("registered@g.us");

    await applyGroupGating(makeParams(msg, warn));

    expect(warn).not.toHaveBeenCalled();
  });

  it("does not let mutable sender fields override admitted owner identity", async () => {
    const warn = vi.fn<WarnLogger>();
    const msg = createTestWebInboundMessage({
      admissionOverrides: {
        chatType: "group",
        conversationId: "registered@g.us",
        senderId: "+222",
        dmSenderId: "registered@g.us",
        configuredAllowFrom: ["+111"],
      },
      payload: {
        body: "/new",
      },
      platform: {
        sender: { e164: "+111" },
      },
    });

    const result = await applyGroupGating(makeParams(msg, warn));

    expect(result).toEqual({
      shouldProcess: false,
      mention: {
        effectiveWasMentioned: false,
        shouldBypassMention: false,
      },
      activation: {
        kind: "absent",
        reason: "not_reached",
      },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("uses admitted account authDir when owner checks normalize LID senders", async () => {
    await withTempAuthDir(async (authDir) => {
      await fs.writeFile(
        path.join(authDir, "lid-mapping-777_reverse.json"),
        JSON.stringify("+1777"),
      );
      const warn = vi.fn<WarnLogger>();
      const msg = createTestWebInboundMessage({
        admissionOverrides: {
          chatType: "group",
          conversationId: "registered@g.us",
          senderId: "777@lid",
          dmSenderId: "registered@g.us",
          configuredAllowFrom: ["+1777"],
          account: {
            authDir,
          },
        },
        payload: {
          body: "/status",
        },
      });

      const result = await applyGroupGating(makeParams(msg, warn));

      expect(result.shouldProcess).toBe(true);
      expect(result.mention).toMatchObject({
        effectiveWasMentioned: true,
        shouldBypassMention: true,
      });
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
