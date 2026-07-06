// Tool result cap advice helpers format doctor guidance for capped outputs.
import {
  calculateMaxToolResultCharsWithCap,
  resolveAutoLiveToolResultMaxChars,
} from "../agents/embedded-agent-runner/tool-result-truncation.js";
import type { HealthFinding } from "./health-checks.js";

export const TOOL_RESULT_CAP_CHECK_ID = "core/doctor/tool-result-cap";

export type ToolResultCapDoctorIssue = {
  kind: "configured-above-runtime-ceiling" | "configured-below-auto-cap";
  contextWindowTokens: number;
  modelKey: string;
  configuredCap: number;
  runtimeCeiling?: number;
  autoEffectiveCap?: number;
  path?: string;
  scopeLabel?: string;
  target?: string;
};

export const COMPACTION_CONFIG_CHECK_ID = "core/doctor/compaction-config";

export type CompactionConfigDoctorIssue = {
  kind: "byte-guard-without-truncate";
  maxActiveTranscriptBytes: number | string;
  path?: string;
  scopeLabel?: string;
};

// Doctor advice for explicit live tool-result caps that fight model-window defaults.
export type ToolResultCapDoctorAdviceParams = {
  contextWindowTokens: number;
  modelKey: string;
  configuredCap?: number;
  deep?: boolean;
  path?: string;
  scopeLabel?: string;
  target?: string;
};

function formatNumber(value: number): string {
  return String(Math.max(0, Math.floor(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatIssueMessage(issue: ToolResultCapDoctorIssue): string {
  const prefix = issue.scopeLabel ? `${issue.scopeLabel}: ` : "";
  if (issue.kind === "configured-above-runtime-ceiling") {
    return `${prefix}configured toolResultMaxChars is ${formatNumber(
      issue.configuredCap,
    )} chars, but this model can use at most ${formatNumber(
      issue.runtimeCeiling ?? 0,
    )} chars per live tool result; lower it or unset it.`;
  }
  return `${prefix}configured toolResultMaxChars is ${formatNumber(
    issue.configuredCap,
  )} chars; unset it to use the ${formatNumber(issue.autoEffectiveCap ?? 0)} char auto cap for "${
    issue.modelKey
  }".`;
}

export function collectToolResultCapDoctorIssues(
  params: ToolResultCapDoctorAdviceParams,
): ToolResultCapDoctorIssue[] {
  if (!Number.isFinite(params.contextWindowTokens) || params.contextWindowTokens <= 0) {
    return [];
  }

  const configuredCap =
    typeof params.configuredCap === "number" && Number.isFinite(params.configuredCap)
      ? Math.floor(params.configuredCap)
      : undefined;
  if (configuredCap === undefined) {
    return [];
  }

  const autoCap = resolveAutoLiveToolResultMaxChars(params.contextWindowTokens);
  const runtimeCeiling = calculateMaxToolResultCharsWithCap(
    params.contextWindowTokens,
    Number.MAX_SAFE_INTEGER,
  );
  const effectiveCap = calculateMaxToolResultCharsWithCap(
    params.contextWindowTokens,
    configuredCap,
  );
  const autoEffectiveCap = calculateMaxToolResultCharsWithCap(params.contextWindowTokens, autoCap);

  if (configuredCap > runtimeCeiling) {
    return [
      {
        kind: "configured-above-runtime-ceiling",
        contextWindowTokens: params.contextWindowTokens,
        modelKey: params.modelKey,
        configuredCap,
        runtimeCeiling,
        path: params.path,
        scopeLabel: params.scopeLabel,
        target: params.target,
      },
    ];
  }

  if (effectiveCap < autoEffectiveCap) {
    return [
      {
        kind: "configured-below-auto-cap",
        contextWindowTokens: params.contextWindowTokens,
        modelKey: params.modelKey,
        configuredCap,
        autoEffectiveCap,
        path: params.path,
        scopeLabel: params.scopeLabel,
        target: params.target,
      },
    ];
  }

  return [];
}

export function toolResultCapDoctorIssueToHealthFinding(
  issue: ToolResultCapDoctorIssue,
): HealthFinding {
  return {
    checkId: TOOL_RESULT_CAP_CHECK_ID,
    severity: "warning",
    message: formatIssueMessage(issue),
    ...(issue.path ? { path: issue.path } : {}),
    ...(issue.target ? { target: issue.target } : {}),
    requirement: issue.kind,
    fixHint: issue.path ? `Lower or unset ${issue.path}.` : "Lower or unset toolResultMaxChars.",
  };
}

/** Builds human-readable doctor lines for stale or ineffective toolResultMaxChars settings. */
export function buildToolResultCapDoctorAdvice(params: ToolResultCapDoctorAdviceParams): string[] {
  if (!Number.isFinite(params.contextWindowTokens) || params.contextWindowTokens <= 0) {
    return [];
  }

  const autoCap = resolveAutoLiveToolResultMaxChars(params.contextWindowTokens);
  const configuredCap =
    typeof params.configuredCap === "number" && Number.isFinite(params.configuredCap)
      ? Math.floor(params.configuredCap)
      : undefined;
  const configuredSource = configuredCap !== undefined;
  const requestedCap = configuredCap ?? autoCap;
  const effectiveCap = calculateMaxToolResultCharsWithCap(params.contextWindowTokens, requestedCap);
  const lines: string[] = [];
  const prefix = params.scopeLabel ? `${params.scopeLabel}: ` : "";
  // Deep mode always shows the effective cap, even when no warning is needed.
  if (params.deep) {
    lines.push(
      `- ${prefix}primary model "${params.modelKey}" context window ${formatNumber(
        params.contextWindowTokens,
      )} tokens; live tool-result cap ${formatNumber(effectiveCap)} chars (${
        configuredSource ? "explicit" : "auto"
      })`,
    );
  }

  if (configuredCap === undefined) {
    return lines;
  }

  lines.push(
    ...collectToolResultCapDoctorIssues(params).map((issue) => `- ${formatIssueMessage(issue)}`),
  );

  return lines;
}

export type CompactionConfigDoctorAdviceParams = {
  maxActiveTranscriptBytes?: number | string;
  truncateAfterCompaction?: boolean;
  path?: string;
  scopeLabel?: string;
};

export function collectCompactionConfigDoctorIssues(
  params: CompactionConfigDoctorAdviceParams,
): CompactionConfigDoctorIssue[] {
  if (
    params.maxActiveTranscriptBytes !== undefined &&
    (params.truncateAfterCompaction === false || params.truncateAfterCompaction === undefined)
  ) {
    return [
      {
        kind: "byte-guard-without-truncate",
        maxActiveTranscriptBytes: params.maxActiveTranscriptBytes,
        path: params.path,
        scopeLabel: params.scopeLabel,
      },
    ];
  }
  return [];
}

export function compactionConfigDoctorIssueToHealthFinding(
  issue: CompactionConfigDoctorIssue,
): HealthFinding {
  const prefix = issue.scopeLabel ? `${issue.scopeLabel}: ` : "";
  return {
    checkId: COMPACTION_CONFIG_CHECK_ID,
    severity: "warning",
    message: `${prefix}maxActiveTranscriptBytes is set (${issue.maxActiveTranscriptBytes}) but truncateAfterCompaction is ${issue.kind === "byte-guard-without-truncate" ? "false" : "unset"}; this byte-guard will never trigger. Set truncateAfterCompaction to true or unset maxActiveTranscriptBytes.`,
    ...(issue.path ? { path: issue.path } : {}),
    requirement: issue.kind,
    fixHint: "Set truncateAfterCompaction to true or unset maxActiveTranscriptBytes.",
  };
}

export function buildCompactionConfigDoctorAdvice(
  params: CompactionConfigDoctorAdviceParams,
): string[] {
  return collectCompactionConfigDoctorIssues(params).map((issue) => {
    const prefix = issue.scopeLabel ? `${issue.scopeLabel}: ` : "";
    return `- ${prefix}maxActiveTranscriptBytes is set (${issue.maxActiveTranscriptBytes}) but truncateAfterCompaction is false or unset; this byte-guard will never trigger. Set truncateAfterCompaction to true or unset maxActiveTranscriptBytes.`;
  });
}
