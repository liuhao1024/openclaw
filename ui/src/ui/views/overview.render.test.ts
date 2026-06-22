/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { renderOverview, type OverviewProps } from "./overview.ts";

function createOverviewProps(overrides: Partial<OverviewProps> = {}): OverviewProps {
  return {
    warnQueryToken: false,
    connected: false,
    hello: null,
    settings: {
      gatewayUrl: "",
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
      borderRadius: 50,
      locale: "en",
    },
    password: "",
    lastError: null,
    lastErrorCode: null,
    presenceCount: 0,
    sessionsCount: null,
    cronEnabled: null,
    cronNext: null,
    lastChannelsRefresh: null,
    modelAuthStatus: null,
    usageResult: null,
    sessionsResult: null,
    skillsReport: null,
    cronJobs: [],
    cronStatus: null,
    attentionItems: [],
    eventLog: [],
    overviewLogLines: [],
    showGatewayToken: false,
    showGatewayPassword: false,
    onSettingsChange: () => undefined,
    onPasswordChange: () => undefined,
    onSessionKeyChange: () => undefined,
    onToggleGatewayTokenVisibility: () => undefined,
    onToggleGatewayPasswordVisibility: () => undefined,
    onConnect: () => undefined,
    onRefresh: () => undefined,
    onNavigate: () => undefined,
    onRefreshLogs: () => undefined,
    ...overrides,
  };
}

function compactText(node: Element | null): string | undefined {
  return node?.textContent?.trim().replace(/\s+/g, " ");
}

describe("overview view rendering", () => {
  it("keeps the persisted overview locale selected before i18n hydration finishes", async () => {
    const container = document.createElement("div");
    const props = createOverviewProps({
      settings: {
        ...createOverviewProps().settings,
        locale: "zh-CN",
      },
    });

    getSafeLocalStorage()?.clear();
    await i18n.setLocale("en");

    render(renderOverview(props), container);
    await Promise.resolve();

    let select = container.querySelector<HTMLSelectElement>("select");
    expect(i18n.getLocale()).toBe("en");
    expect(select?.value).toBe("zh-CN");
    expect(select?.selectedOptions[0]?.textContent?.trim()).toBe("简体中文 (Simplified Chinese)");

    await i18n.setLocale("zh-CN");
    render(renderOverview(props), container);
    await Promise.resolve();

    select = container.querySelector<HTMLSelectElement>("select");
    expect(select?.value).toBe("zh-CN");
    expect(select?.selectedOptions[0]?.textContent?.trim()).toBe("简体中文 (简体中文)");

    await i18n.setLocale("en");
  });

  it("renders a dedicated scope-upgrade approval hint with the exact approve command", async () => {
    const container = document.createElement("div");
    const props = createOverviewProps({
      lastError: "scope upgrade pending approval (requestId: req-123)",
      lastErrorCode: "PAIRING_REQUIRED",
    });

    render(renderOverview(props), container);
    await Promise.resolve();

    const hint = container.querySelector(".mono")?.closest(".muted") ?? null;
    expect(compactText(hint)).toBe(
      "Scope upgrade pending approval. This device is already paired, but the requested wider scope is waiting for approval. openclaw devices approve req-123 openclaw devices list On mobile? Copy the full URL (including #token=...) from openclaw dashboard --no-open on your desktop. Docs: Device pairing",
    );
    expect([...container.querySelectorAll(".mono")].map((node) => node.textContent)).toEqual([
      "openclaw devices approve req-123",
      "openclaw devices list",
    ]);
  });

  it("does not suggest preview-only latest approval when the request id is absent", async () => {
    const container = document.createElement("div");
    const props = createOverviewProps({
      lastError: "scope upgrade pending approval",
      lastErrorCode: "PAIRING_REQUIRED",
    });

    render(renderOverview(props), container);
    await Promise.resolve();

    const hint = container.querySelector(".mono")?.closest(".muted") ?? null;
    expect(compactText(hint)).toBe(
      "Scope upgrade pending approval. This device is already paired, but the requested wider scope is waiting for approval. openclaw devices list On mobile? Copy the full URL (including #token=...) from openclaw dashboard --no-open on your desktop. Docs: Device pairing",
    );
    expect([...container.querySelectorAll(".mono")].map((node) => node.textContent)).toEqual([
      "openclaw devices list",
    ]);
  });

  it("renders recent session names through the shared display resolver", async () => {
    const container = document.createElement("div");
    const props = createOverviewProps({
      sessionsResult: {
        ts: 0,
        path: "",
        count: 3,
        defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
        sessions: [
          {
            key: "discord:123:456",
            kind: "direct",
            label: "   ",
            displayName: "Ops Room",
            model: "gpt-5",
            updatedAt: null,
          },
          {
            key: "telegram:123:456",
            kind: "direct",
            label: "telegram:123:456",
            model: "gpt-5",
            updatedAt: null,
          },
          {
            key: "agent:main:main",
            kind: "direct",
            label: "Main Project",
            displayName: "agent:main:main",
            model: "gpt-5",
            updatedAt: null,
          },
        ],
      },
    });

    render(renderOverview(props), container);
    await Promise.resolve();

    const recentNames = [...container.querySelectorAll(".ov-recent__key")].map(
      (node) => node.textContent?.trim() ?? "",
    );
    expect(recentNames).toEqual(["Ops Room", "Telegram Session", "Main Project"]);
    expect(recentNames).not.toContain("telegram:123:456");
  });

  it("promotes provider quota into a dedicated overview card", async () => {
    const container = document.createElement("div");
    const props = createOverviewProps({
      usageResult: {
        totals: { totalCost: 0, totalTokens: 0 },
        aggregates: { messages: { total: 0 } },
      } as OverviewProps["usageResult"],
      modelAuthStatus: {
        ts: Date.now(),
        providers: [
          {
            provider: "openai",
            displayName: "Codex",
            status: "ok",
            profiles: [{ profileId: "codex", type: "oauth", status: "ok" }],
            usage: {
              windows: [
                { label: "3h", usedPercent: 18 },
                { label: "Week", usedPercent: 72 },
              ],
            },
          },
          {
            provider: "anthropic",
            displayName: "Claude",
            status: "ok",
            profiles: [{ profileId: "anthropic", type: "token", status: "ok" }],
            usage: {
              windows: [{ label: "5h", usedPercent: 60 }],
            },
          },
        ],
      },
    });

    render(renderOverview(props), container);
    await Promise.resolve();

    const quota = container.querySelector('[data-kind="quota"]');
    expect(compactText(quota)).toBe("Usage 28% left Codex · Week · Claude · 5h 40% left");
  });

  it("does not count disabled cron jobs with error status as failed", async () => {
    const container = document.createElement("div");
    const baseJob = {
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron" as const, expr: "0 * * * *" },
      sessionTarget: "isolated" as const,
      wakeMode: "next-heartbeat" as const,
      payload: { kind: "agentTurn" as const, message: "test" },
    };
    const props = createOverviewProps({
      cronJobs: [
        {
          ...baseJob,
          id: "job-enabled-error",
          name: "Enabled Failed Job",
          enabled: true,
          state: { lastRunStatus: "error" as const },
        },
        {
          ...baseJob,
          id: "job-disabled-error",
          name: "Disabled Failed Job",
          enabled: false,
          state: { lastRunStatus: "error" as const },
        },
        {
          ...baseJob,
          id: "job-enabled-ok",
          name: "Enabled OK Job",
          enabled: true,
          state: { lastRunStatus: "ok" as const },
        },
      ],
      cronStatus: { enabled: true, nextWakeAtMs: null },
      usageResult: {
        totals: { totalCost: 0, totalTokens: 0 },
        aggregates: { messages: { total: 0 } },
      } as OverviewProps["usageResult"],
    });

    render(renderOverview(props), container);
    await Promise.resolve();

    const cronCard = container.querySelector('[data-kind="cron"]');
    expect(cronCard).not.toBeNull();
    // Only the enabled error job should be counted; the disabled error job must be excluded.
    expect(compactText(cronCard)).toContain("1 failed");
    expect(compactText(cronCard)).not.toContain("2 failed");
  });
});
