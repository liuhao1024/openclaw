/** Tests resolveBackgroundTaskTerminalResult passthrough and edge cases. */
import { describe, expect, it } from "vitest";
import { resolveBackgroundTaskTerminalResult } from "./manager.background-task.js";

describe("resolveBackgroundTaskTerminalResult", () => {
  it("returns blocked outcome for empty progress summary", () => {
    const result = resolveBackgroundTaskTerminalResult("");
    expect(result.terminalOutcome).toBe("blocked");
    expect(result.terminalSummary).toBe(
      "Required completion did not produce a final deliverable.",
    );
  });

  it("returns blocked outcome for whitespace-only progress summary", () => {
    const result = resolveBackgroundTaskTerminalResult("   ");
    expect(result.terminalOutcome).toBe("blocked");
  });

  it("passes through non-empty progress as terminalSummary", () => {
    const result = resolveBackgroundTaskTerminalResult("Task completed successfully");
    expect(result).toEqual({ terminalSummary: "Task completed successfully" });
    expect(result.terminalOutcome).toBeUndefined();
  });

  it("normalizes multi-line progress into single-line terminalSummary", () => {
    const result = resolveBackgroundTaskTerminalResult("Line 1\nLine 2\nLine 3");
    expect(result.terminalSummary).toBe("Line 1 Line 2 Line 3");
  });

  it("detects permission denied as blocked outcome", () => {
    const result = resolveBackgroundTaskTerminalResult("permission denied");
    expect(result.terminalOutcome).toBe("blocked");
    expect(result.terminalSummary).toBe("Permission denied.");
  });

  it("detects permission denied with path as blocked outcome", () => {
    const result = resolveBackgroundTaskTerminalResult("permission denied for /tmp/foo.txt");
    expect(result.terminalOutcome).toBe("blocked");
    expect(result.terminalSummary).toBe("Permission denied for /tmp/foo.txt.");
  });

  it("detects writable session requirement as blocked outcome", () => {
    const result = resolveBackgroundTaskTerminalResult("need a writable session");
    expect(result.terminalOutcome).toBe("blocked");
    expect(result.terminalSummary).toBe(
      "Writable session or apply_patch authorization required.",
    );
  });

  it("detects apply_patch requirement as blocked outcome", () => {
    const result = resolveBackgroundTaskTerminalResult("Please use apply_patch to edit");
    expect(result.terminalOutcome).toBe("blocked");
    expect(result.terminalSummary).toBe(
      "Writable session or apply_patch authorization required.",
    );
  });
});
