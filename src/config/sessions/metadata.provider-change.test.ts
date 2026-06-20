import { describe, expect, it } from "vitest";
import { deriveSessionMetaPatch } from "./metadata.js";
import type { SessionEntry } from "./types.js";

// Minimal MsgContext stub for deriveSessionMetaPatch.
function ctx(overrides: Record<string, unknown>) {
  return {
    Provider: overrides.Provider ?? "telegram",
    Surface: overrides.Surface ?? "telegram",
    ChatType: overrides.ChatType ?? "dm",
    From: overrides.From ?? "user123",
    To: overrides.To ?? "agent456",
    NativeChannelId: overrides.NativeChannelId,
    NativeDirectUserId: overrides.NativeDirectUserId,
    AccountId: overrides.AccountId,
    MessageThreadId: overrides.MessageThreadId,
    OriginatingChannel: overrides.OriginatingChannel,
    GroupSubject: overrides.GroupSubject,
    GroupSpace: overrides.GroupSpace,
    GroupChannel: overrides.GroupChannel,
  } as any;
}

describe("mergeOrigin — provider change clears per-channel fields", () => {
  it("clears nativeChannelId when provider changes from slack to telegram", () => {
    const existing: SessionEntry = {
      sessionId: "test-session",
      updatedAt: Date.now(),
      channel: "slack",
      origin: {
        provider: "slack",
        nativeChannelId: "Dxxxxxxxx",
        nativeDirectUserId: "U12345",
        from: "alice",
        to: "agent",
      },
    };

    // Telegram DM does not supply nativeChannelId
    const patch = deriveSessionMetaPatch({
      ctx: ctx({
        Provider: "telegram",
        From: "alice",
        To: "agent",
        NativeChannelId: undefined,
      }),
      sessionKey: "test-key",
      existing,
    });

    expect(patch?.origin?.provider).toBe("telegram");
    expect(patch?.origin?.nativeChannelId).toBeUndefined();
    expect(patch?.origin?.nativeDirectUserId).toBeUndefined();
    // Cross-platform fields survive
    expect(patch?.origin?.from).toBe("alice");
    expect(patch?.origin?.to).toBe("agent");
  });

  it("preserves nativeChannelId when provider stays the same", () => {
    const existing: SessionEntry = {
      sessionId: "test-session",
      updatedAt: Date.now(),
      channel: "slack",
      origin: {
        provider: "slack",
        nativeChannelId: "Dxxxxxxxx",
        from: "alice",
      },
    };

    const patch = deriveSessionMetaPatch({
      ctx: ctx({
        Provider: "slack",
        NativeChannelId: "Dxxxxxxxx",
      }),
      sessionKey: "test-key",
      existing,
    });

    expect(patch?.origin?.nativeChannelId).toBe("Dxxxxxxxx");
  });

  it("sets nativeChannelId when new provider supplies it", () => {
    const existing: SessionEntry = {
      sessionId: "test-session",
      updatedAt: Date.now(),
      channel: "slack",
      origin: {
        provider: "slack",
        nativeChannelId: "Dxxxxxxxx",
      },
    };

    const patch = deriveSessionMetaPatch({
      ctx: ctx({
        Provider: "telegram",
        NativeChannelId: "-100123456",
      }),
      sessionKey: "test-key",
      existing,
    });

    expect(patch?.origin?.provider).toBe("telegram");
    expect(patch?.origin?.nativeChannelId).toBe("-100123456");
  });

  it("clears threadId on provider change", () => {
    const existing: SessionEntry = {
      sessionId: "test-session",
      updatedAt: Date.now(),
      channel: "slack",
      origin: {
        provider: "slack",
        nativeChannelId: "Dxxxxxxxx",
        threadId: "1234567890.123456",
      },
    };

    const patch = deriveSessionMetaPatch({
      ctx: ctx({ Provider: "telegram", MessageThreadId: undefined }),
      sessionKey: "test-key",
      existing,
    });

    expect(patch?.origin?.provider).toBe("telegram");
    expect(patch?.origin?.threadId).toBeUndefined();
  });
});
