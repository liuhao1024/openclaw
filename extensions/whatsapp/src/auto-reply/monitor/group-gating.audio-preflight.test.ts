import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  resolveAcceptedGroupActivationFor: vi.fn(async () => "mention"),
}));

vi.mock("./group-activation.js", () => ({
  resolveAcceptedGroupActivationFor: hoisted.resolveAcceptedGroupActivationFor,
}));

import { createTestWebInboundMessage } from "../../inbound/admission.test-support.js";
import type { WebInboundMessage } from "../../inbound/types.js";
import type { MentionConfig } from "../mentions.js";
import { applyGroupGating, type GroupHistoryEntry } from "./group-gating.js";

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

function makeParams(msg: WebInboundMessage, groupHistories: Map<string, GroupHistoryEntry[]>) {
  return {
    cfg: {
      channels: {
        whatsapp: {
          groupPolicy: "open",
        },
      },
      messages: {
        groupChat: {
          mentionPatterns: ["\\bopenclaw\\b"],
        },
      },
    } as never,
    msg,
    conversationId: "1203630@g.us",
    groupHistoryKey: "whatsapp:group:1203630",
    agentId: "main",
    sessionKey: "agent:main:whatsapp:group:1203630",
    baseMentionConfig: { mentionRegexes: [/\bopenclaw\b/i] } satisfies MentionConfig,
    groupHistories,
    groupHistoryLimit: 20,
    groupMemberNames: new Map<string, Map<string, string>>(),
    logVerbose: vi.fn(),
    replyLogger: { debug: vi.fn(), warn: vi.fn() },
  };
}

describe("applyGroupGating audio preflight mention text", () => {
  let groupHistories: Map<string, GroupHistoryEntry[]>;

  beforeEach(() => {
    groupHistories = new Map();
    hoisted.resolveAcceptedGroupActivationFor.mockReset();
    hoisted.resolveAcceptedGroupActivationFor.mockResolvedValue("mention");
  });

  it("defers a missing mention without storing placeholder history", async () => {
    const msg = makeGroupAudioMsg();

    const result = await applyGroupGating({
      ...makeParams(msg, groupHistories),
      deferMissingMention: true,
    });

    expect(result).toEqual({
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
    });
    expect(groupHistories.get("whatsapp:group:1203630")).toBeUndefined();
  });

  it("accepts voice transcript text that satisfies mention gating", async () => {
    const msg = makeGroupAudioMsg();

    const result = await applyGroupGating({
      ...makeParams(msg, groupHistories),
      mentionText: "openclaw please summarize the thread",
    });

    expect(result).toEqual({
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
    });
    expect(msg).not.toHaveProperty("wasMentioned");
    expect(msg.payload.body).toBe("<media:audio>");
    expect(groupHistories.get("whatsapp:group:1203630")).toBeUndefined();
  });

  it("stores transcript text instead of the audio placeholder when mention is still missing", async () => {
    const msg = makeGroupAudioMsg();

    const result = await applyGroupGating({
      ...makeParams(msg, groupHistories),
      mentionText: "please summarize the thread",
    });

    expect(result).toEqual({
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
    expect(groupHistories.get("whatsapp:group:1203630")).toEqual([
      {
        sender: "Alice (+15550000002)",
        body: "please summarize the thread",
        timestamp: 1700000000,
        id: "msg-1",
        senderJid: undefined,
      },
    ]);
    expect(msg).not.toHaveProperty("wasMentioned");
    expect(msg.payload.body).toBe("<media:audio>");
  });

  it("returns activation facts when activation bypasses mention requirements", async () => {
    hoisted.resolveAcceptedGroupActivationFor.mockResolvedValue("always");
    const msg = makeGroupAudioMsg();

    const result = await applyGroupGating({
      ...makeParams(msg, groupHistories),
      mentionText: "please summarize the thread",
    });

    expect(result).toEqual({
      shouldProcess: true,
      mention: {
        effectiveWasMentioned: false,
        shouldBypassMention: false,
      },
      activation: {
        kind: "known",
        active: true,
        defaultRequiresMention: true,
      },
    });
    expect(groupHistories.get("whatsapp:group:1203630")).toBeUndefined();
  });
});
