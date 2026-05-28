import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = chromium.executablePath();
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object value");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Expected non-empty ${label}`);
  }
  return value;
}

describeControlUiE2e("Control UI mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("sends a chat turn through the GUI and renders the final Gateway event", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          content: [{ text: "Ready for an end-to-end GUI check.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.getByText("Ready for an end-to-end GUI check.").waitFor({ timeout: 10_000 });

      const prompt = "verify the control UI e2e harness";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      expect(params.sessionKey).toBe("main");
      expect(params.message).toBe(prompt);
      expect(params.deliver).toBe(false);

      const runId = requireString(params.idempotencyKey, "chat send idempotency key");
      await gateway.emitChatFinal({ runId, text: "Harness verified." });

      await page.getByText("Harness verified.").waitFor({ timeout: 10_000 });
    } finally {
      await context.close();
    }
  });

  it("loads older chat history through the GUI", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      historyMessages: [],
      methodResponses: {
        "chat.history": {
          cases: [
            {
              match: { beforeSeq: 10 },
              response: {
                messages: [
                  {
                    __openclaw: { seq: 1 },
                    content: [
                      { text: "Older user turn from before the tool-heavy tail.", type: "text" },
                    ],
                    role: "user",
                    timestamp: 1,
                  },
                ],
                hasMore: false,
                nextBeforeSeq: null,
                oldestSeq: 1,
                newestSeq: 1,
                sessionId: "control-ui-e2e-session",
                thinkingLevel: null,
              },
            },
            {
              response: {
                messages: [
                  {
                    __openclaw: { seq: 10 },
                    content: [{ text: "Recent visible assistant turn.", type: "text" }],
                    role: "assistant",
                    timestamp: 10,
                  },
                ],
                hasMore: true,
                nextBeforeSeq: 10,
                oldestSeq: 10,
                newestSeq: 10,
                sessionId: "control-ui-e2e-session",
                thinkingLevel: null,
              },
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.getByText("Recent visible assistant turn.").waitFor({ timeout: 10_000 });

      await page.getByRole("button", { name: "Load older messages" }).click();

      const requests = await gateway.getRequests("chat.history");
      expect(requests.map((request) => requireRecord(request.params))).toContainEqual(
        expect.objectContaining({ beforeSeq: 10 }),
      );
      await page
        .getByText("Older user turn from before the tool-heavy tail.")
        .waitFor({ timeout: 10_000 });
    } finally {
      await context.close();
    }
  });
});
