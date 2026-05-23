import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ExecApprovalFollowupTarget } from "./bash-tools.exec-host-shared.js";
import type { ExecApprovalFollowupFactory } from "./bash-tools.exec-types.js";

type StrictInlineEvalBoundary =
  typeof import("./bash-tools.exec-host-shared.js").enforceStrictInlineEvalApprovalBoundary;
type SendExecApprovalFollowupResult =
  typeof import("./bash-tools.exec-host-shared.js").sendExecApprovalFollowupResult;
type ExecAutoReviewer = typeof import("../infra/exec-auto-review.js").defaultExecAutoReviewer;
type BuildExecApprovalFollowupTargetMock = (
  value: ExecApprovalFollowupTarget,
) => ExecApprovalFollowupTarget | null;

const INLINE_EVAL_HIT = {
  executable: "python3",
  normalizedExecutable: "python3",
  flag: "-c",
  argv: ["python3", "-c", "print(1)"],
};

const createAndRegisterDefaultExecApprovalRequestMock = vi.hoisted(() => vi.fn());
const buildExecApprovalPendingToolResultMock = vi.hoisted(() => vi.fn());
const buildExecApprovalFollowupTargetMock = vi.hoisted(() =>
  vi.fn<BuildExecApprovalFollowupTargetMock>(() => null),
);
const createExecApprovalDecisionStateMock = vi.hoisted(() =>
  vi.fn(
    (): {
      baseDecision: { timedOut: boolean };
      approvedByAsk: boolean;
      deniedReason: string | null;
    } => ({
      baseDecision: { timedOut: false },
      approvedByAsk: false,
      deniedReason: "approval-required",
    }),
  ),
);
const evaluateShellAllowlistMock = vi.hoisted(() =>
  vi.fn(() => ({
    allowlistMatches: [],
    analysisOk: true,
    allowlistSatisfied: true,
    segments: [{ resolution: null, argv: ["echo", "ok"] }],
    segmentAllowlistEntries: [{ pattern: "/usr/bin/echo", source: "allow-always" }],
  })),
);
const analyzeShellCommandMock = vi.hoisted(() =>
  vi.fn((params: { command: string }) => ({
    ok: true,
    segments: params.command
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => ({
        raw: part,
        resolution: null,
        argv: part.split(/\s+/).map((token) => token.replace(/^['"]|['"]$/g, "")),
      })),
  })),
);
const hasDurableExecApprovalMock = vi.hoisted(() => vi.fn(() => true));
const requiresExecApprovalMock = vi.hoisted(() => vi.fn(() => false));
const buildEnforcedShellCommandMock = vi.hoisted(() =>
  vi.fn((): { ok: boolean; reason?: string; command?: string } => ({
    ok: false,
    reason: "segment execution plan unavailable",
  })),
);
const defaultExecAutoReviewerMock = vi.hoisted(() =>
  vi.fn<ExecAutoReviewer>(async () => ({
    decision: "allow-once",
    risk: "low",
    rationale: "allowed",
  })),
);
const recordAllowlistMatchesUseMock = vi.hoisted(() => vi.fn());
const resolveApprovalDecisionOrUndefinedMock = vi.hoisted(() =>
  vi.fn(async (): Promise<string | null | undefined> => undefined),
);
const resolveExecHostApprovalContextMock = vi.hoisted(() =>
  vi.fn(() => ({
    approvals: { allowlist: [], file: { version: 1, agents: {} } },
    hostSecurity: "allowlist",
    hostAsk: "off",
    askFallback: "deny",
  })),
);
const runExecProcessMock = vi.hoisted(() => vi.fn());
const sendExecApprovalFollowupResultMock = vi.hoisted(() =>
  vi.fn<SendExecApprovalFollowupResult>(async () => undefined),
);
const enforceStrictInlineEvalApprovalBoundaryMock = vi.hoisted(() =>
  vi.fn<StrictInlineEvalBoundary>((value) => ({
    approvedByAsk:
      value.baseDecision.timedOut &&
      value.approvedByAsk &&
      (value.requiresInlineEvalApproval || value.requiresExplicitApproval === true)
        ? false
        : value.approvedByAsk,
    deniedReason:
      value.baseDecision.timedOut &&
      value.approvedByAsk &&
      (value.requiresInlineEvalApproval || value.requiresExplicitApproval === true)
        ? (value.deniedReason ?? "approval-timeout")
        : value.deniedReason,
  })),
);
const detectInterpreterInlineEvalArgvMock = vi.hoisted(() =>
  vi.fn(
    (): {
      executable: string;
      normalizedExecutable: string;
      flag: string;
      argv: string[];
    } | null => null,
  ),
);

vi.mock("../infra/exec-approvals.js", () => ({
  evaluateShellAllowlist: evaluateShellAllowlistMock,
  analyzeShellCommand: analyzeShellCommandMock,
  hasDurableExecApproval: hasDurableExecApprovalMock,
  buildEnforcedShellCommand: buildEnforcedShellCommandMock,
  requiresExecApproval: requiresExecApprovalMock,
  recordAllowlistUse: vi.fn(),
  recordAllowlistMatchesUse: recordAllowlistMatchesUseMock,
  resolveApprovalAuditTrustPath: vi.fn(() => null),
  resolveAllowAlwaysPatterns: vi.fn(() => []),
  resolveExecApprovalAllowedDecisions: vi.fn(() => ["allow-once", "allow-always", "deny"]),
  addAllowlistEntry: vi.fn(),
  addDurableCommandApproval: vi.fn(),
}));

vi.mock("./bash-tools.exec-approval-request.js", () => ({
  buildExecApprovalRequesterContext: vi.fn(() => ({})),
  buildExecApprovalTurnSourceContext: vi.fn(() => ({})),
  registerExecApprovalRequestForHostOrThrow: vi.fn(async () => undefined),
}));

vi.mock("../infra/exec-auto-review.js", () => ({
  defaultExecAutoReviewer: defaultExecAutoReviewerMock,
}));

vi.mock("./bash-tools.exec-host-shared.js", () => ({
  resolveExecHostApprovalContext: resolveExecHostApprovalContextMock,
  buildDefaultExecApprovalRequestArgs: vi.fn(() => ({})),
  buildHeadlessExecApprovalDeniedMessage: vi.fn(() => "denied"),
  buildExecApprovalFollowupTarget: buildExecApprovalFollowupTargetMock,
  buildExecApprovalPendingToolResult: buildExecApprovalPendingToolResultMock,
  createExecApprovalDecisionState: createExecApprovalDecisionStateMock,
  createAndRegisterDefaultExecApprovalRequest: createAndRegisterDefaultExecApprovalRequestMock,
  enforceStrictInlineEvalApprovalBoundary: enforceStrictInlineEvalApprovalBoundaryMock,
  resolveApprovalDecisionOrUndefined: resolveApprovalDecisionOrUndefinedMock,
  sendExecApprovalFollowupResult: sendExecApprovalFollowupResultMock,
  shouldResolveExecApprovalUnavailableInline: vi.fn(() => false),
}));

vi.mock("./bash-tools.exec-runtime.js", () => ({
  DEFAULT_NOTIFY_TAIL_CHARS: 1000,
  createApprovalSlug: vi.fn(() => "slug"),
  normalizeNotifyOutput: vi.fn((value) => value),
  runExecProcess: runExecProcessMock,
}));

vi.mock("./bash-process-registry.js", () => ({
  markBackgrounded: vi.fn(),
  tail: vi.fn((value) => value),
}));

vi.mock("../infra/command-analysis/inline-eval.js", () => ({
  describeInterpreterInlineEval: vi.fn(() => "python -c"),
  detectInterpreterInlineEvalArgv: detectInterpreterInlineEvalArgvMock,
}));

let processGatewayAllowlist: typeof import("./bash-tools.exec-host-gateway.js").processGatewayAllowlist;
type GatewayAllowlistParams = Parameters<typeof processGatewayAllowlist>[0];

function requireBuildFollowupTargetInput(callIndex: number): ExecApprovalFollowupTarget {
  const call = buildExecApprovalFollowupTargetMock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected build followup target call ${callIndex}`);
  }
  return call[0];
}

function requireSentFollowupTarget(
  callIndex: number,
): Parameters<SendExecApprovalFollowupResult>[0] {
  const call = sendExecApprovalFollowupResultMock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected sent followup call ${callIndex}`);
  }
  return call[0];
}

function requireSentFollowupText(callIndex: number): string {
  const call = sendExecApprovalFollowupResultMock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected sent followup call ${callIndex}`);
  }
  return call[1] ?? "";
}

function requireApprovalFollowupInput(
  mock: Mock<ExecApprovalFollowupFactory>,
  callIndex: number,
): Parameters<ExecApprovalFollowupFactory>[0] {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected approval followup call ${callIndex}`);
  }
  return call[0];
}

describe("processGatewayAllowlist", () => {
  beforeAll(async () => {
    ({ processGatewayAllowlist } = await import("./bash-tools.exec-host-gateway.js"));
  });

  beforeEach(() => {
    buildExecApprovalPendingToolResultMock.mockReset();
    buildExecApprovalFollowupTargetMock.mockReset();
    buildExecApprovalFollowupTargetMock.mockReturnValue(null);
    createExecApprovalDecisionStateMock.mockReset();
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: false },
      approvedByAsk: false,
      deniedReason: "approval-required",
    });
    evaluateShellAllowlistMock.mockReset();
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: true,
      segments: [{ resolution: null, argv: ["echo", "ok"] }],
      segmentAllowlistEntries: [{ pattern: "/usr/bin/echo", source: "allow-always" }],
    });
    analyzeShellCommandMock.mockReset();
    analyzeShellCommandMock.mockImplementation((params: { command: string }) => ({
      ok: true,
      segments: params.command
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => ({
          raw: part,
          resolution: null,
          argv: part.split(/\s+/).map((token) => token.replace(/^['"]|['"]$/g, "")),
        })),
    }));
    hasDurableExecApprovalMock.mockReset();
    hasDurableExecApprovalMock.mockReturnValue(true);
    requiresExecApprovalMock.mockReset();
    requiresExecApprovalMock.mockReturnValue(false);
    buildEnforcedShellCommandMock.mockReset();
    buildEnforcedShellCommandMock.mockReturnValue({
      ok: false,
      reason: "segment execution plan unavailable",
    });
    defaultExecAutoReviewerMock.mockReset();
    defaultExecAutoReviewerMock.mockResolvedValue({
      decision: "allow-once",
      risk: "low",
      rationale: "allowed",
    });
    recordAllowlistMatchesUseMock.mockReset();
    resolveApprovalDecisionOrUndefinedMock.mockReset();
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(undefined);
    resolveExecHostApprovalContextMock.mockReset();
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "off",
      askFallback: "deny",
    });
    runExecProcessMock.mockReset();
    sendExecApprovalFollowupResultMock.mockReset();
    enforceStrictInlineEvalApprovalBoundaryMock.mockReset();
    enforceStrictInlineEvalApprovalBoundaryMock.mockImplementation((value) => ({
      approvedByAsk:
        value.baseDecision.timedOut &&
        value.approvedByAsk &&
        (value.requiresInlineEvalApproval || value.requiresExplicitApproval === true)
          ? false
          : value.approvedByAsk,
      deniedReason:
        value.baseDecision.timedOut &&
        value.approvedByAsk &&
        (value.requiresInlineEvalApproval || value.requiresExplicitApproval === true)
          ? (value.deniedReason ?? "approval-timeout")
          : value.deniedReason,
    }));
    detectInterpreterInlineEvalArgvMock.mockReset();
    detectInterpreterInlineEvalArgvMock.mockReturnValue(null);
    buildExecApprovalPendingToolResultMock.mockReturnValue({
      details: { status: "approval-pending" },
      content: [],
    });
    createAndRegisterDefaultExecApprovalRequestMock.mockReset();
    createAndRegisterDefaultExecApprovalRequestMock.mockResolvedValue({
      approvalId: "req-1",
      approvalSlug: "slug-1",
      warningText: "",
      expiresAtMs: Date.now() + 60_000,
      preResolvedDecision: null,
      initiatingSurface: "origin",
      sentApproverDms: false,
      unavailableReason: null,
    });
  });

  function runGatewayAllowlist(
    overrides: Partial<GatewayAllowlistParams> & Pick<GatewayAllowlistParams, "command">,
  ) {
    const { command, ...rest } = overrides;
    return processGatewayAllowlist({
      command,
      workdir: process.cwd(),
      env: process.env as Record<string, string>,
      pty: false,
      defaultTimeoutSec: 30,
      security: "allowlist",
      ask: "off",
      safeBins: new Set(),
      safeBinProfiles: {},
      warnings: [],
      approvalRunningNoticeMs: 0,
      maxOutput: 1000,
      pendingMaxOutput: 1000,
      ...rest,
    });
  }

  async function runTimedOutStrictInlineEval(params: {
    security: "full" | "allowlist";
    askFallback: "full" | "allowlist";
    approvedByAsk: boolean;
  }) {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: params.security,
      hostAsk: "always",
      askFallback: params.askFallback,
    });
    detectInterpreterInlineEvalArgvMock.mockReturnValue(INLINE_EVAL_HIT);
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(null);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: params.approvedByAsk,
      deniedReason: null,
    });
    enforceStrictInlineEvalApprovalBoundaryMock.mockReturnValue({
      approvedByAsk: false,
      deniedReason: "approval-timeout",
    });

    return runGatewayAllowlist({
      command: "python3 -c 'print(1)'",
      security: params.security,
      ask: "always",
      strictInlineEval: true,
    });
  }

  it("still requires approval when allowlist execution plan is unavailable despite durable trust", async () => {
    const result = await runGatewayAllowlist({
      command: "echo ok",
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(result.pendingResult?.details.status).toBe("approval-pending");
  });

  it("allows durable exact-command trust to bypass the synchronous allowlist miss", async () => {
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [{ resolution: null, argv: ["node", "--version"] }],
      segmentAllowlistEntries: [],
    });
    hasDurableExecApprovalMock.mockReturnValue(true);
    buildEnforcedShellCommandMock.mockReturnValue({
      ok: true,
      command: "node --version",
    });

    const result = await runGatewayAllowlist({
      command: "node --version",
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expect(result).toEqual({ execCommandOverride: undefined });
  });

  it("requires approval for security audit suppression edits unless yolo mode is active", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await runGatewayAllowlist({
      command: "openclaw config set security.audit.suppressions '[]'",
      security: "full",
      ask: "on-miss",
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(result.pendingResult?.details.status).toBe("approval-pending");
  });

  it("does not require approval for security audit suppression edits in yolo mode", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "off",
      askFallback: "deny",
    });

    await runGatewayAllowlist({
      command: "openclaw config set security.audit.suppressions '[]'",
      security: "full",
      ask: "off",
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
  });

  it("does not require suppression edit approval for read-only suppression inspection", async () => {
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: true,
      segments: [
        { resolution: null, argv: ["openclaw", "config", "get", "security.audit.suppressions"] },
      ],
      segmentAllowlistEntries: [],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    await runGatewayAllowlist({
      command: "openclaw config get security.audit.suppressions",
      security: "full",
      ask: "on-miss",
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
  });

  it("does not require suppression edit approval for profile-scoped read-only inspection", async () => {
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: true,
      segments: [
        {
          resolution: null,
          argv: ["openclaw", "--profile", "rescue", "config", "get", "security.audit.suppressions"],
        },
      ],
      segmentAllowlistEntries: [],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    await runGatewayAllowlist({
      command: "openclaw --profile rescue config get security.audit.suppressions",
      security: "full",
      ask: "on-miss",
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
  });

  it("requires suppression edit approval when a mutating segment follows read-only inspection", async () => {
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: true,
      segments: [
        { resolution: null, argv: ["openclaw", "config", "get", "security.audit.suppressions"] },
        {
          resolution: null,
          argv: ["openclaw", "config", "set", "security.audit.suppressions", "[]"],
        },
      ],
      segmentAllowlistEntries: [],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await runGatewayAllowlist({
      command:
        "openclaw config get security.audit.suppressions; openclaw config set security.audit.suppressions '[]'",
      security: "full",
      ask: "on-miss",
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(result.pendingResult?.details.status).toBe("approval-pending");
  });

  it("requires suppression edit approval when allowlist analysis only returns a read-only prefix", async () => {
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [
        { resolution: null, argv: ["openclaw", "config", "get", "security.audit.suppressions"] },
      ],
      segmentAllowlistEntries: [],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await runGatewayAllowlist({
      command:
        "openclaw config get security.audit.suppressions; openclaw config set security.audit.suppressions '[]'",
      security: "full",
      ask: "on-miss",
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(result.pendingResult?.details.status).toBe("approval-pending");
  });

  it("requires suppression edit approval when a heredoc patch follows read-only inspection", async () => {
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [
        {
          resolution: null,
          argv: ["openclaw", "config", "get", "security.audit.suppressions"],
        },
      ],
      segmentAllowlistEntries: [],
    });
    analyzeShellCommandMock.mockReturnValueOnce({
      ok: true,
      segments: [
        {
          raw: "openclaw config get security.audit.suppressions",
          resolution: null,
          argv: ["openclaw", "config", "get", "security.audit.suppressions"],
        },
        {
          raw: "openclaw config patch --stdin <<'EOF'",
          resolution: null,
          argv: ["openclaw", "config", "patch", "--stdin"],
        },
      ],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await runGatewayAllowlist({
      command: `openclaw config get security.audit.suppressions; openclaw config patch --stdin <<'EOF'
{"security":{"audit":{"suppressions":[]}}}
EOF`,
      security: "full",
      ask: "on-miss",
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(result.pendingResult?.details.status).toBe("approval-pending");
  });

  it("keeps denying allowlist misses when durable trust does not match", async () => {
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [{ resolution: null, argv: ["node", "--version"] }],
      segmentAllowlistEntries: [],
    });
    hasDurableExecApprovalMock.mockReturnValue(false);

    await expect(
      runGatewayAllowlist({
        command: "node --version",
      }),
    ).rejects.toThrow("exec denied: allowlist miss");
  });

  it("auto-reviews simple read-only approval misses without prompting", async () => {
    const warnings: string[] = [];
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [{ resolution: null, argv: ["pwd"] }],
      segmentAllowlistEntries: [],
    });
    hasDurableExecApprovalMock.mockReturnValue(false);
    requiresExecApprovalMock.mockReturnValue(true);

    const result = await runGatewayAllowlist({
      command: "pwd",
      ask: "on-miss",
      autoReview: true,
      warnings,
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expect(result).toEqual({ execCommandOverride: undefined, allowWithoutEnforcedCommand: true });
    expect(warnings).toEqual(["Exec auto-review allowed once (risk=low): allowed"]);
  });

  it("keeps unparsable gateway commands on explicit approval in auto-review mode", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: false,
      allowlistSatisfied: false,
      segments: [],
      segmentAllowlistEntries: [],
    });
    requiresExecApprovalMock.mockReturnValue(true);

    const result = await runGatewayAllowlist({
      command: "cat <<EOF\n$SECRET\nEOF",
      security: "allowlist",
      ask: "on-miss",
      autoReview: true,
    });

    expect(defaultExecAutoReviewerMock).not.toHaveBeenCalled();
    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(result.pendingResult?.details.status).toBe("approval-pending");
  });

  it("does not send first-segment argv for compound auto-review commands", async () => {
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [
        { resolution: null, argv: ["pwd"] },
        { resolution: null, argv: ["rm", "-rf", "dist"] },
      ],
      segmentAllowlistEntries: [],
    });
    hasDurableExecApprovalMock.mockReturnValue(false);
    requiresExecApprovalMock.mockReturnValue(true);

    await runGatewayAllowlist({
      command: "pwd; rm -rf dist",
      ask: "on-miss",
      autoReview: true,
    });

    expect(defaultExecAutoReviewerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "pwd; rm -rf dist",
        argv: undefined,
        host: "gateway",
      }),
    );
  });

  it("keeps mutable script operands on explicit approval in auto-review mode", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-auto-script-"));
    try {
      const scriptPath = path.join(tmp, "script.js");
      fs.writeFileSync(scriptPath, 'console.log("reviewed");\n');
      evaluateShellAllowlistMock.mockReturnValue({
        allowlistMatches: [],
        analysisOk: true,
        allowlistSatisfied: false,
        segments: [{ resolution: null, argv: ["node", scriptPath] }],
        segmentAllowlistEntries: [],
      });
      hasDurableExecApprovalMock.mockReturnValue(false);
      requiresExecApprovalMock.mockReturnValue(true);

      const result = await runGatewayAllowlist({
        command: `node ${scriptPath}`,
        ask: "on-miss",
        autoReview: true,
      });

      expect(defaultExecAutoReviewerMock).not.toHaveBeenCalled();
      expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
      expect(result.pendingResult?.details.status).toBe("approval-pending");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("requires approval for allowlisted mutable script operands", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-allowlisted-script-"));
    try {
      const scriptPath = path.join(tmp, "script.js");
      fs.writeFileSync(scriptPath, 'console.log("reviewed");\n');
      evaluateShellAllowlistMock.mockReturnValue({
        allowlistMatches: [],
        analysisOk: true,
        allowlistSatisfied: true,
        segments: [{ resolution: null, argv: ["node", scriptPath] }],
        segmentAllowlistEntries: [{ pattern: "node *", source: "allow-always" }],
      });
      buildEnforcedShellCommandMock.mockReturnValue({
        ok: true,
        command: `node ${scriptPath}`,
      });
      hasDurableExecApprovalMock.mockReturnValue(true);
      requiresExecApprovalMock.mockReturnValue(false);

      const result = await runGatewayAllowlist({
        command: `node ${scriptPath}`,
        ask: "on-miss",
        autoReview: true,
      });

      expect(defaultExecAutoReviewerMock).not.toHaveBeenCalled();
      expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
      expect(result.pendingResult?.details.status).toBe("approval-pending");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("denies approved gateway mutable script execution when the script changes before run", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-script-drift-"));
    try {
      const scriptPath = path.join(tmp, "script.js");
      const command = `node ${scriptPath}`;
      fs.writeFileSync(scriptPath, 'console.log("reviewed");\n');
      resolveExecHostApprovalContextMock.mockReturnValue({
        approvals: { allowlist: [], file: { version: 1, agents: {} } },
        hostSecurity: "allowlist",
        hostAsk: "on-miss",
        askFallback: "deny",
      });
      evaluateShellAllowlistMock.mockReturnValue({
        allowlistMatches: [],
        analysisOk: true,
        allowlistSatisfied: true,
        segments: [{ resolution: null, argv: ["node", scriptPath] }],
        segmentAllowlistEntries: [{ pattern: "node *", source: "allow-always" }],
      });
      buildEnforcedShellCommandMock.mockReturnValue({
        ok: true,
        command,
      });
      hasDurableExecApprovalMock.mockReturnValue(true);
      requiresExecApprovalMock.mockReturnValue(false);
      resolveApprovalDecisionOrUndefinedMock.mockImplementation(async () => {
        fs.writeFileSync(scriptPath, 'console.log("changed");\n');
        return "allow-once";
      });
      createExecApprovalDecisionStateMock.mockReturnValue({
        baseDecision: { timedOut: false },
        approvedByAsk: false,
        deniedReason: null,
      });

      const result = await runGatewayAllowlist({
        command,
        workdir: tmp,
        ask: "on-miss",
      });

      expect(result.pendingResult?.details.status).toBe("approval-pending");
      await vi.waitFor(() => {
        expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
          null,
          `Exec denied (gateway id=req-1, approval script operand changed before execution): ${command}`,
        );
      });
      expect(runExecProcessMock).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("denies unbindable shell-wrapped mutable script operands in auto-review mode", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-auto-unbindable-"));
    try {
      const scriptPath = path.join(tmp, "script.js");
      fs.writeFileSync(scriptPath, 'console.log("reviewed");\n');
      const command = `/bin/sh -lc "node ${scriptPath}"`;
      evaluateShellAllowlistMock.mockReturnValue({
        allowlistMatches: [],
        analysisOk: true,
        allowlistSatisfied: false,
        segments: [{ resolution: null, argv: ["/bin/sh", "-lc", `node ${scriptPath}`] }],
        segmentAllowlistEntries: [],
      });
      hasDurableExecApprovalMock.mockReturnValue(false);
      requiresExecApprovalMock.mockReturnValue(true);

      const result = await runGatewayAllowlist({
        command,
        ask: "on-miss",
        autoReview: true,
      });

      expect(defaultExecAutoReviewerMock).not.toHaveBeenCalled();
      expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
      expect(result.pendingResult?.details.status).toBe("failed");
      expect(JSON.stringify(result.pendingResult)).toContain(
        "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("shows reviewer rationale when auto-review defers to human approval", async () => {
    const warnings: string[] = [];
    defaultExecAutoReviewerMock.mockResolvedValueOnce({
      decision: "ask-human",
      risk: "unknown",
      rationale: "command intent is unclear",
    });
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [{ resolution: null, argv: ["./script"] }],
      segmentAllowlistEntries: [],
    });
    hasDurableExecApprovalMock.mockReturnValue(false);
    requiresExecApprovalMock.mockReturnValue(true);

    const result = await runGatewayAllowlist({
      command: "./script",
      ask: "on-miss",
      autoReview: true,
      warnings,
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(result.pendingResult?.details.status).toBe("approval-pending");
    expect(warnings).toEqual([
      "Exec auto-review deferred to human approval (risk=unknown): command intent is unclear",
    ]);
  });

  it("returns a failed result when auto-review denies an approval miss", async () => {
    defaultExecAutoReviewerMock.mockResolvedValueOnce({
      decision: "deny",
      risk: "high",
      rationale: "command mutates files",
    });
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [{ resolution: null, argv: ["rm", "-rf", "dist"] }],
      segmentAllowlistEntries: [],
    });
    hasDurableExecApprovalMock.mockReturnValue(false);
    requiresExecApprovalMock.mockReturnValue(true);

    const result = await runGatewayAllowlist({
      command: "rm -rf dist",
      ask: "on-miss",
      autoReview: true,
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expect(result.pendingResult?.details.status).toBe("failed");
    const firstContent = result.pendingResult?.content[0];
    expect(firstContent?.type).toBe("text");
    expect(firstContent?.type === "text" ? firstContent.text : "").toContain(
      "exec auto-review denied command: command mutates files",
    );
  });

  it("does not run ssh-keygen when auto-review denies SSH key generation", async () => {
    defaultExecAutoReviewerMock.mockResolvedValueOnce({
      decision: "deny",
      risk: "high",
      rationale: "command creates SSH key material",
    });
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [
        {
          resolution: null,
          argv: [
            "ssh-keygen",
            "-t",
            "ed25519",
            "-N",
            "",
            "-f",
            "~/.ssh/openclaw-pr70543-guard-test",
          ],
        },
      ],
      segmentAllowlistEntries: [],
    });
    hasDurableExecApprovalMock.mockReturnValue(false);
    requiresExecApprovalMock.mockReturnValue(true);

    const result = await runGatewayAllowlist({
      command: "ssh-keygen -t ed25519 -N '' -f ~/.ssh/openclaw-pr70543-guard-test",
      ask: "on-miss",
      autoReview: true,
    });

    expect(defaultExecAutoReviewerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: ["ssh-keygen", "-t", "ed25519", "-N", "", "-f", "~/.ssh/openclaw-pr70543-guard-test"],
        host: "gateway",
        reason: "approval-required",
      }),
    );
    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expect(runExecProcessMock).not.toHaveBeenCalled();
    expect(result.pendingResult?.details.status).toBe("failed");
    const firstContent = result.pendingResult?.content[0];
    expect(firstContent?.type).toBe("text");
    expect(firstContent?.type === "text" ? firstContent.text : "").toContain(
      "exec auto-review denied command: command creates SSH key material",
    );
  });

  it("keeps security audit suppression edits on explicit approval in auto-review mode", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await runGatewayAllowlist({
      command: "openclaw config set security.audit.suppressions '[]'",
      security: "full",
      ask: "on-miss",
      autoReview: true,
    });

    expect(defaultExecAutoReviewerMock).not.toHaveBeenCalled();
    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(result.pendingResult?.details.status).toBe("approval-pending");
  });

  it("does not auto-review when host policy requires every command to ask", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "always",
      askFallback: "deny",
    });
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [{ resolution: null, argv: ["pwd"] }],
      segmentAllowlistEntries: [],
    });
    hasDurableExecApprovalMock.mockReturnValue(false);
    requiresExecApprovalMock.mockReturnValue(true);

    const result = await runGatewayAllowlist({
      command: "pwd",
      ask: "on-miss",
      autoReview: true,
    });

    expect(defaultExecAutoReviewerMock).not.toHaveBeenCalled();
    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(result.pendingResult?.details.status).toBe("approval-pending");
  });

  it("keeps strict inline-eval gateway commands on explicit approval", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });
    detectInterpreterInlineEvalArgvMock.mockReturnValue(INLINE_EVAL_HIT);
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [{ resolution: null, argv: ["python3", "-c", "print(1)"] }],
      segmentAllowlistEntries: [],
    });
    hasDurableExecApprovalMock.mockReturnValue(false);
    requiresExecApprovalMock.mockReturnValue(true);

    const result = await runGatewayAllowlist({
      command: "python3 -c 'print(1)'",
      ask: "on-miss",
      autoReview: true,
      strictInlineEval: true,
    });

    expect(defaultExecAutoReviewerMock).not.toHaveBeenCalled();
    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(result.pendingResult?.details.status).toBe("approval-pending");
  });

  it("uses sessionKey for followups when notifySessionKey is absent", async () => {
    await runGatewayAllowlist({
      command: "echo ok",
      sessionKey: "agent:main:telegram:direct:123",
    });

    expect(requireBuildFollowupTargetInput(0).sessionKey).toBe("agent:main:telegram:direct:123");
  });

  it("keeps webchat diagnostics approvals as direct pasteable followups", async () => {
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue("allow-once");
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: false },
      approvedByAsk: false,
      deniedReason: null,
    });
    const outcome = {
      status: "completed" as const,
      exitCode: 0,
      exitSignal: null,
      durationMs: 12,
      timedOut: false,
      aggregated: JSON.stringify({
        path: "/tmp/openclaw-diagnostics.zip",
        bytes: 1234,
        manifest: {
          generatedAt: "2026-04-28T20:58:29.311Z",
          openclawVersion: "2026.4.27",
          contents: [
            { path: "diagnostics.json", bytes: 100 },
            { path: "summary.md", bytes: 200 },
          ],
          privacy: {
            payloadFree: true,
            rawLogsIncluded: false,
            notes: ["Logs keep operational summaries."],
          },
        },
      }),
    };
    runExecProcessMock.mockResolvedValue({
      session: { id: "sess-1" },
      promise: Promise.resolve(outcome),
    });
    buildExecApprovalFollowupTargetMock.mockImplementation((value) => value);

    const approvalFollowup = vi.fn<ExecApprovalFollowupFactory>(async () =>
      [
        "OpenAI Codex harness:",
        "Codex diagnostics sent to OpenAI servers:",
        "Session 1",
        "Channel: telegram",
        "OpenClaw session id: `session-1`",
        "Codex thread id: `thread-1`",
      ].join("\n"),
    );

    const result = await runGatewayAllowlist({
      command: "openclaw gateway diagnostics export --json",
      trigger: "diagnostics",
      approvalFollowupMode: "direct",
      approvalFollowup,
      turnSourceChannel: "webchat",
    });

    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(1);
    });
    expect(requireBuildFollowupTargetInput(0).direct).toBe(true);

    const followupTarget = requireSentFollowupTarget(0);
    expect(followupTarget?.direct).toBe(true);
    const followupText = requireSentFollowupText(0);
    expect(followupText).toContain("Diagnostics export created.");
    expect(followupText).toContain("Path: /tmp/openclaw-diagnostics.zip");
    expect(followupText).toContain("Contents (2 files):");
    expect(followupText).toContain("OpenAI Codex harness:");
    expect(followupText).toContain("Codex diagnostics sent to OpenAI servers:");
    expect(followupText).toContain("Codex thread id: `thread-1`");
    const approvalInput = requireApprovalFollowupInput(approvalFollowup, 0);
    expect(approvalInput?.approvalId).toBe("req-1");
    expect(approvalInput?.sessionId).toBe("sess-1");
    expect(approvalInput?.trigger).toBe("diagnostics");
    expect(approvalInput?.outcome?.status).toBe("completed");
    expect(approvalInput?.outcome?.exitCode).toBe(0);
  });

  it("waits inline for webchat approval so the exec tool can return real output to the model", async () => {
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue("allow-once");
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: false },
      approvedByAsk: true,
      deniedReason: null,
    });

    const result = await runGatewayAllowlist({
      command: "pwd && df -h",
      turnSourceChannel: "webchat",
    });

    expect(result.pendingResult).toBeUndefined();
    expect(result.deniedResult).toBeUndefined();
    expect(result.allowWithoutEnforcedCommand).toBe(true);
    expect(runExecProcessMock).not.toHaveBeenCalled();
    expect(buildExecApprovalFollowupTargetMock).not.toHaveBeenCalled();
    expect(sendExecApprovalFollowupResultMock).not.toHaveBeenCalled();
  });

  it("returns webchat approval denials as the foreground tool result", async () => {
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue("deny");
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: false },
      approvedByAsk: false,
      deniedReason: "user-denied",
    });

    const result = await runGatewayAllowlist({
      command: "pwd && df -h",
      turnSourceChannel: "webchat",
    });

    expect(result.pendingResult).toBeUndefined();
    expect(result.deniedResult?.details.status).toBe("failed");
    expect(result.deniedResult?.content[0]).toEqual(
      expect.objectContaining({
        text: "Exec denied (gateway id=req-1, user-denied): pwd && df -h",
      }),
    );
    expect(runExecProcessMock).not.toHaveBeenCalled();
    expect(sendExecApprovalFollowupResultMock).not.toHaveBeenCalled();
  });

  it("denies timed-out inline-eval requests instead of auto-running them", async () => {
    const result = await runTimedOutStrictInlineEval({
      security: "full",
      askFallback: "full",
      approvedByAsk: true,
    });

    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        null,
        "Exec denied (gateway id=req-1, approval-timeout): python3 -c 'print(1)'",
      );
    });
    expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(1);
    expect(runExecProcessMock).not.toHaveBeenCalled();
  });

  it("denies allowlist timeout fallback for strict inline-eval commands", async () => {
    const result = await runTimedOutStrictInlineEval({
      security: "allowlist",
      askFallback: "allowlist",
      approvedByAsk: false,
    });

    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        null,
        "Exec denied (gateway id=req-1, approval-timeout): python3 -c 'print(1)'",
      );
    });
    expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(1);
    expect(runExecProcessMock).not.toHaveBeenCalled();
  });

  it("denies timed-out mutable script approvals instead of auto-running them", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-timeout-script-"));
    try {
      const scriptPath = path.join(tmp, "script.js");
      const command = `node ${scriptPath}`;
      fs.writeFileSync(scriptPath, 'console.log("reviewed");\n');
      resolveExecHostApprovalContextMock.mockReturnValue({
        approvals: { allowlist: [], file: { version: 1, agents: {} } },
        hostSecurity: "full",
        hostAsk: "on-miss",
        askFallback: "full",
      });
      evaluateShellAllowlistMock.mockReturnValue({
        allowlistMatches: [],
        analysisOk: true,
        allowlistSatisfied: true,
        segments: [{ resolution: null, argv: ["node", scriptPath] }],
        segmentAllowlistEntries: [],
      });
      resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(null);
      createExecApprovalDecisionStateMock.mockReturnValue({
        baseDecision: { timedOut: true },
        approvedByAsk: true,
        deniedReason: null,
      });

      const result = await runGatewayAllowlist({
        command,
        ask: "on-miss",
      });

      expect(result.pendingResult?.details.status).toBe("approval-pending");
      await vi.waitFor(() => {
        expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
          null,
          `Exec denied (gateway id=req-1, approval-timeout): ${command}`,
        );
      });
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(1);
      expect(runExecProcessMock).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
