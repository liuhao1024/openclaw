import type { ExecCommandSegment } from "../infra/exec-approvals-analysis.js";
import type { SystemRunApprovalFileOperand } from "../infra/exec-approvals.js";
import { extractShellWrapperInlineCommand } from "../infra/exec-wrapper-resolution.js";
import { resolveMutableFileOperandSnapshotSync } from "../node-host/invoke-system-run-plan.js";

export type MutableScriptApprovalBinding = {
  argv: string[];
  snapshot: SystemRunApprovalFileOperand;
};

export function resolveMutableScriptApprovalBindings(params: {
  cwd: string | undefined;
  segments: Array<Pick<ExecCommandSegment, "argv" | "raw">>;
}): { ok: true; bindings: MutableScriptApprovalBinding[] } | { ok: false; message: string } {
  const bindings: MutableScriptApprovalBinding[] = [];
  for (const segment of params.segments) {
    const shellCommand = extractShellWrapperInlineCommand(segment.argv);
    const snapshot = resolveMutableFileOperandSnapshotSync({
      argv: segment.argv,
      cwd: params.cwd,
      shellCommand,
    });
    if (!snapshot.ok) {
      if (shellCommand !== null) {
        return snapshot;
      }
      continue;
    }
    if (snapshot.snapshot) {
      bindings.push({ argv: segment.argv, snapshot: snapshot.snapshot });
    }
  }
  return { ok: true, bindings };
}

export function commandRequiresMutableScriptApproval(params: {
  cwd: string | undefined;
  segments: Array<Pick<ExecCommandSegment, "argv" | "raw">>;
}): boolean {
  const bindings = resolveMutableScriptApprovalBindings(params);
  return !bindings.ok || bindings.bindings.length > 0;
}
