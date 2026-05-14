import { detectInlineEvalArgv } from "../command-analysis/risks.js";
import { explainShellCommand } from "../command-explainer/extract.js";
import type {
  CommandExplanation,
  CommandRisk,
  CommandShape,
  CommandStep,
} from "../command-explainer/types.js";
import {
  analyzeArgvCommand,
  isWindowsPlatform,
  resolveCommandResolutionFromArgv,
  resolvePlannedSegmentArgv,
  windowsEscapeArg,
  type ExecCommandAnalysis,
  type ExecCommandSegment,
} from "../exec-approvals-analysis.js";
import {
  extractBindableShellWrapperInlineCommand,
  normalizeExecutableToken,
} from "../exec-wrapper-resolution.js";
import type {
  CommandAuthorizationChainOperator,
  CommandAuthorizationContext,
  CommandAuthorizationInput,
  CommandAuthorizationPlan,
  CommandAuthorizationRelationship,
  CommandAuthorizationTree,
  CommandAuthorizationUnit,
  CommandDialect,
  CommandPromptOnlyReason,
  CommandUnanalyzableReason,
} from "./types.js";

type RenderAuthorizationShellCommandMode = "enforced" | "safe-bins";

type SegmentSatisfiedBy =
  | "allowlist"
  | "safeBins"
  | "inlineChain"
  | "skills"
  | "skillPrelude"
  | null;

type PlannedTree = {
  tree: CommandAuthorizationTree;
  units: CommandAuthorizationUnit[];
  nextUnitIndex: number;
};

type UnsupportedWrapper = {
  dialect: "windows-cmd" | "powershell";
  reason: CommandPromptOnlyReason;
};

export async function planCommandForAuthorization(
  input: CommandAuthorizationInput,
  context: CommandAuthorizationContext = {},
): Promise<CommandAuthorizationPlan> {
  if (input.dialect === "argv") {
    return planArgvCommand(input.argv, input.command, context);
  }
  if (input.dialect === "windows-cmd" || input.dialect === "powershell") {
    return planUnsupportedShellDialect(input.command, input.dialect);
  }
  return planPosixShellCommand(input.command, context);
}

export function createExecCommandAnalysisFromAuthorizationPlan(params: {
  plan: CommandAuthorizationPlan;
  tree?: CommandAuthorizationTree;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): ExecCommandAnalysis | null {
  if (params.plan.kind === "unanalyzable") {
    return null;
  }
  const unitsById = new Map(params.plan.units.map((unit) => [unit.id, unit]));
  const units = collectAuthorizationTreeUnits(params.tree ?? params.plan.tree, unitsById);
  if (units.length === 0) {
    return null;
  }
  return {
    ok: true,
    segments: units.map(
      (unit): ExecCommandSegment => ({
        raw: unit.raw,
        argv: unit.argv,
        resolution: resolveCommandResolutionFromArgv(unit.argv, params.cwd, params.env),
      }),
    ),
  };
}

export function renderAuthorizationShellCommand(params: {
  plan: CommandAuthorizationPlan;
  segments: readonly ExecCommandSegment[];
  segmentSatisfiedBy?: readonly SegmentSatisfiedBy[];
  platform?: string | null;
  mode: RenderAuthorizationShellCommandMode;
}): { ok: boolean; command?: string; reason?: string } {
  if (params.plan.kind === "unanalyzable") {
    return { ok: false, reason: "unanalyzable command" };
  }
  if (
    params.mode === "safe-bins" &&
    params.segmentSatisfiedBy !== undefined &&
    params.segmentSatisfiedBy.length !== params.segments.length
  ) {
    return { ok: false, reason: "segment metadata mismatch" };
  }

  const unitsById = new Map(params.plan.units.map((unit) => [unit.id, unit]));
  const cursor = { index: 0 };
  const rendered = renderAuthorizationTree({
    tree: params.plan.tree,
    unitsById,
    segments: params.segments,
    segmentSatisfiedBy: params.segmentSatisfiedBy,
    platform: params.platform,
    mode: params.mode,
    cursor,
  });
  if (!rendered.ok) {
    return rendered;
  }
  if (cursor.index !== params.segments.length) {
    return { ok: false, reason: "segment count mismatch" };
  }
  return { ok: true, command: rendered.command };
}

function planArgvCommand(
  argvInput: readonly string[],
  command: string | undefined,
  context: CommandAuthorizationContext,
): CommandAuthorizationPlan {
  const source = command ?? argvInput.join(" ");
  const argv = [...argvInput];
  if (argv.length === 0 || (argv[0]?.trim() ?? "").length === 0) {
    return unanalyzablePlan(source, "argv", ["empty-argv"]);
  }

  const unsupportedWrapper = classifyUnsupportedWrapper(argv);
  if (unsupportedWrapper) {
    const unit = createUnit({
      id: "unit-0",
      raw: source,
      argv,
      relationship: "wrapper-inline",
      promptOnlyReasons: [unsupportedWrapper.reason],
    });
    return promptOnlyPlan(source, unsupportedWrapper.dialect, { kind: "unit", unitId: unit.id }, [
      unit,
    ]);
  }

  const analysis = analyzeArgvCommand({
    argv,
    cwd: context.cwd,
    env: context.env,
  });
  if (!analysis.ok) {
    return unanalyzablePlan(source, "argv", ["empty-argv"]);
  }
  return finalizePlannedTree(source, "argv", buildTreeFromSegments(analysis.segments, 0, "simple"));
}

function planUnsupportedShellDialect(
  command: string,
  dialect: "windows-cmd" | "powershell",
): CommandAuthorizationPlan {
  const source = command.trim();
  if (!source) {
    return unanalyzablePlan(command, dialect, ["empty-command"]);
  }
  const reason: CommandPromptOnlyReason =
    dialect === "powershell" ? "unsupported-powershell-wrapper" : "unsupported-cmd-wrapper";
  const unit = createUnit({
    id: "unit-0",
    raw: source,
    argv: [],
    relationship: "wrapper-inline",
    promptOnlyReasons: [reason],
  });
  return promptOnlyPlan(command, dialect, { kind: "unit", unitId: unit.id }, [unit]);
}

async function planPosixShellCommand(
  command: string,
  _context: CommandAuthorizationContext,
): Promise<CommandAuthorizationPlan> {
  const source = command.trim();
  if (!source) {
    return unanalyzablePlan(command, "posix-shell", ["empty-command"]);
  }

  const explanation = await explainShellCommand(source);
  if (!explanation.ok) {
    return unanalyzablePlan(source, "posix-shell", ["malformed-shell"]);
  }

  const selectedSteps = selectPlanningSteps(explanation);
  const sourcePromptOnlyReasons =
    selectedSteps.length === 0
      ? promptOnlyReasonsFromExplanation(explanation)
      : uniquePromptOnlyReasons([
          ...promptOnlyReasonsFromUnsupportedRender(explanation),
          ...promptOnlyReasonsFromRisksOutsideSelectedSteps(explanation.risks, selectedSteps),
        ]);
  if (selectedSteps.length === 0 && sourcePromptOnlyReasons.length > 0) {
    const unit = createUnit({
      id: "unit-0",
      raw: source,
      argv: [],
      relationship: "simple",
      promptOnlyReasons: sourcePromptOnlyReasons,
    });
    return promptOnlyPlan(source, "posix-shell", { kind: "unit", unitId: unit.id }, [unit]);
  }

  if (selectedSteps.length === 0) {
    return unanalyzablePlan(source, "posix-shell", ["empty-command"]);
  }

  const planned = buildTreeFromCommandSteps(source, selectedSteps, explanation.risks);
  return finalizePlannedTree(
    source,
    "posix-shell",
    sourcePromptOnlyReasons.length > 0
      ? applyPromptOnlyReasonsToPlannedTree(planned, sourcePromptOnlyReasons)
      : planned,
  );
}

function selectPlanningSteps(explanation: CommandExplanation): CommandStep[] {
  const selectedSteps: CommandStep[] = [];
  for (const step of explanation.topLevelCommands) {
    const wrapperPayloadSteps = explanation.nestedCommands.filter(
      (nestedStep) =>
        nestedStep.context === "wrapper-payload" &&
        stepContainsSpan(step, nestedStep.span.startIndex, nestedStep.span.endIndex),
    );
    if (shouldPlanWrapperPayload(step, wrapperPayloadSteps, explanation.risks)) {
      selectedSteps.push(...wrapperPayloadSteps);
      continue;
    }
    selectedSteps.push(step);
  }
  return selectedSteps;
}

function shouldPlanWrapperPayload(
  step: CommandStep,
  wrapperPayloadSteps: readonly CommandStep[],
  risks: readonly CommandRisk[],
): boolean {
  if (wrapperPayloadSteps.length === 0) {
    return false;
  }
  const hasShellWrapperRisk = risks.some(
    (risk) =>
      risk.kind === "shell-wrapper" && spansOverlap(step.span.startIndex, step.span.endIndex, risk),
  );
  if (!hasShellWrapperRisk) {
    return false;
  }
  const inlineCommand = extractBindableShellWrapperInlineCommand(step.argv);
  if (!inlineCommand || isDirectShellPositionalCarrierInvocation(inlineCommand)) {
    return false;
  }
  return !isRelativePathScopedExecutableToken(wrapperPayloadSteps[0]?.executable ?? "");
}

type StepGroup = {
  steps: CommandStep[];
  relationship: CommandAuthorizationRelationship;
};

function buildTreeFromCommandSteps(
  source: string,
  inputSteps: readonly CommandStep[],
  risks: readonly CommandRisk[],
): PlannedTree {
  const steps = inputSteps.toSorted((left, right) => left.span.startIndex - right.span.startIndex);
  const groups: StepGroup[] = [];
  const operators: CommandAuthorizationChainOperator[] = [];
  let currentSteps: CommandStep[] = [];
  let currentRelationship: CommandAuthorizationRelationship = "simple";

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!step) {
      continue;
    }
    currentSteps.push(step);
    const nextStep = steps[index + 1];
    if (!nextStep) {
      continue;
    }
    const separator = separatorBetweenSteps(source, step, nextStep);
    if (separator === "pipe") {
      continue;
    }
    groups.push({ steps: currentSteps, relationship: currentRelationship });
    currentSteps = [];
    if (separator) {
      operators.push(separator);
      currentRelationship = relationshipForOperator(separator);
    } else {
      operators.push(";");
      currentRelationship = "sequence";
    }
  }

  if (currentSteps.length > 0) {
    groups.push({
      steps: currentSteps,
      relationship:
        currentRelationship === "simple" && currentSteps.length > 1
          ? "pipeline"
          : currentRelationship,
    });
  }

  const units: CommandAuthorizationUnit[] = [];
  const children: CommandAuthorizationTree[] = [];
  let nextUnitIndex = 0;
  for (const group of groups) {
    const plannedGroup = buildTreeFromStepGroup(group, risks, nextUnitIndex);
    units.push(...plannedGroup.units);
    children.push(plannedGroup.tree);
    nextUnitIndex = plannedGroup.nextUnitIndex;
  }

  if (operators.length > 0) {
    return {
      tree: { kind: "chain", operators, children },
      units,
      nextUnitIndex,
    };
  }

  return {
    tree: children[0] ?? { kind: "pipeline", children: [] },
    units,
    nextUnitIndex,
  };
}

function applyPromptOnlyReasonsToPlannedTree(
  planned: PlannedTree,
  reasons: readonly CommandPromptOnlyReason[],
): PlannedTree {
  const promptOnlyReasons = uniquePromptOnlyReasons(reasons);
  return {
    ...planned,
    units: planned.units.map((unit) => ({
      ...unit,
      allowlistEligible: false,
      allowAlwaysEligible: false,
      promptOnlyReasons: uniquePromptOnlyReasons([...unit.promptOnlyReasons, ...promptOnlyReasons]),
    })),
  };
}

function buildTreeFromStepGroup(
  group: StepGroup,
  risks: readonly CommandRisk[],
  startUnitIndex: number,
): PlannedTree {
  const units = group.steps.map((step, offset) =>
    createUnitFromStep(step, `unit-${startUnitIndex + offset}`, group.relationship, risks),
  );
  const children = units.map(
    (unit): CommandAuthorizationTree => ({ kind: "unit", unitId: unit.id }),
  );
  return {
    tree: children.length === 1 ? children[0] : { kind: "pipeline", children },
    units,
    nextUnitIndex: startUnitIndex + units.length,
  };
}

type StepSeparator = "pipe" | CommandAuthorizationChainOperator;

function separatorBetweenSteps(
  source: string,
  left: CommandStep,
  right: CommandStep,
): StepSeparator | null {
  const separatorText = source.slice(left.span.endIndex, right.span.startIndex);
  for (let index = 0; index < separatorText.length; index += 1) {
    const current = separatorText[index];
    const next = separatorText[index + 1];
    if (current === "&" && next === "&") {
      return "&&";
    }
    if (current === "|" && next === "|") {
      return "||";
    }
    if (current === ";" || current === "\n") {
      return ";";
    }
    if (current === "|") {
      return "pipe";
    }
  }
  return null;
}

function buildTreeFromSegments(
  segments: readonly ExecCommandSegment[],
  startUnitIndex: number,
  relationship: CommandAuthorizationRelationship,
): PlannedTree {
  const units = segments.map((segment, offset) =>
    createUnitFromSegment(segment, `unit-${startUnitIndex + offset}`, relationship),
  );
  const children = units.map(
    (unit): CommandAuthorizationTree => ({ kind: "unit", unitId: unit.id }),
  );
  return {
    tree: children.length === 1 ? children[0] : { kind: "pipeline", children },
    units,
    nextUnitIndex: startUnitIndex + units.length,
  };
}

function collectAuthorizationTreeUnits(
  tree: CommandAuthorizationTree,
  unitsById: ReadonlyMap<string, CommandAuthorizationUnit>,
): CommandAuthorizationUnit[] {
  if (tree.kind === "unit") {
    const unit = unitsById.get(tree.unitId);
    return unit ? [unit] : [];
  }
  return tree.children.flatMap((child) => collectAuthorizationTreeUnits(child, unitsById));
}

type RenderedAuthorizationTree = { ok: true; command: string } | { ok: false; reason: string };

function renderAuthorizationTree(params: {
  tree: CommandAuthorizationTree;
  unitsById: ReadonlyMap<string, CommandAuthorizationUnit>;
  segments: readonly ExecCommandSegment[];
  segmentSatisfiedBy?: readonly SegmentSatisfiedBy[];
  platform?: string | null;
  mode: RenderAuthorizationShellCommandMode;
  cursor: { index: number };
}): RenderedAuthorizationTree {
  if (params.tree.kind === "unit") {
    return renderAuthorizationUnit({
      unitId: params.tree.unitId,
      unitsById: params.unitsById,
      segments: params.segments,
      segmentSatisfiedBy: params.segmentSatisfiedBy,
      platform: params.platform,
      mode: params.mode,
      cursor: params.cursor,
    });
  }
  const renderedChildren: string[] = [];
  for (const child of params.tree.children) {
    const rendered = renderAuthorizationTree({ ...params, tree: child });
    if (!rendered.ok) {
      return rendered;
    }
    renderedChildren.push(rendered.command);
  }
  if (params.tree.kind === "pipeline") {
    return { ok: true, command: renderedChildren.join(" | ") };
  }

  const parts: string[] = [];
  for (const [index, child] of renderedChildren.entries()) {
    parts.push(child);
    const operator = params.tree.operators[index];
    if (operator) {
      parts.push(operator);
    }
  }
  return { ok: true, command: parts.join(" ") };
}

function renderAuthorizationUnit(params: {
  unitId: string;
  unitsById: ReadonlyMap<string, CommandAuthorizationUnit>;
  segments: readonly ExecCommandSegment[];
  segmentSatisfiedBy?: readonly SegmentSatisfiedBy[];
  platform?: string | null;
  mode: RenderAuthorizationShellCommandMode;
  cursor: { index: number };
}): RenderedAuthorizationTree {
  const unit = params.unitsById.get(params.unitId);
  if (!unit) {
    return { ok: false, reason: "unit mapping failed" };
  }
  const segment = params.segments[params.cursor.index];
  const satisfiedBy = params.segmentSatisfiedBy?.[params.cursor.index];
  params.cursor.index += 1;
  if (!segment) {
    return { ok: false, reason: "segment mapping failed" };
  }
  if (params.mode === "safe-bins" && satisfiedBy !== "safeBins") {
    if (satisfiedBy === "inlineChain") {
      return { ok: false, reason: "inline chain planner render unavailable" };
    }
    return { ok: true, command: unit.raw.trim() };
  }

  const argv = resolvePlannedSegmentArgv(segment);
  if (!argv) {
    return { ok: false, reason: "segment execution plan unavailable" };
  }
  const rendered = renderQuotedArgv(argv, params.platform);
  if (!rendered) {
    return { ok: false, reason: "unsafe windows token in argv" };
  }
  return { ok: true, command: rendered };
}

function shellEscapeSingleArg(value: string): string {
  const singleQuoteEscape = `'"'"'`;
  return `'${value.replace(/'/g, singleQuoteEscape)}'`;
}

function renderQuotedArgv(argv: readonly string[], platform?: string | null): string | null {
  if (isWindowsPlatform(platform)) {
    const parts: string[] = [];
    for (const token of argv) {
      const result = windowsEscapeArg(token);
      if (!result.ok) {
        return null;
      }
      parts.push(result.escaped);
    }
    return parts.join(" ");
  }
  return argv.map((token) => shellEscapeSingleArg(token)).join(" ");
}

function createUnitFromSegment(
  segment: ExecCommandSegment,
  id: string,
  relationship: CommandAuthorizationRelationship,
): CommandAuthorizationUnit {
  const promptOnlyReasons: CommandPromptOnlyReason[] = [];
  if (detectInlineEvalArgv(segment.argv)) {
    promptOnlyReasons.push("interpreter-inline-eval");
  }
  return createUnit({
    id,
    raw: segment.raw,
    argv: segment.argv,
    relationship,
    promptOnlyReasons,
  });
}

function createUnitFromStep(
  step: CommandStep,
  id: string,
  relationship: CommandAuthorizationRelationship,
  risks: readonly CommandRisk[],
): CommandAuthorizationUnit {
  const promptOnlyReasons = promptOnlyReasonsForStep(step, risks);
  const unitRelationship =
    relationship === "simple" && step.context === "wrapper-payload"
      ? "wrapper-inline"
      : relationship;
  return createUnit({
    id,
    raw: step.text,
    argv: step.argv,
    relationship: unitRelationship,
    promptOnlyReasons,
  });
}

function createUnit(params: {
  id: string;
  raw: string;
  argv: string[];
  relationship: CommandAuthorizationRelationship;
  promptOnlyReasons: CommandPromptOnlyReason[];
}): CommandAuthorizationUnit {
  const executable = params.argv[0]?.trim() || null;
  const normalizedExecutable = executable ? normalizeExecutableToken(executable) : null;
  const allowAutomatically = params.promptOnlyReasons.length === 0;
  return {
    id: params.id,
    raw: params.raw,
    argv: params.argv,
    executable,
    normalizedExecutable,
    relationship: params.relationship,
    allowlistEligible: allowAutomatically,
    allowAlwaysEligible: allowAutomatically,
    promptOnlyReasons: params.promptOnlyReasons,
    blockReasons: [],
  };
}

function finalizePlannedTree(
  source: string,
  dialect: CommandDialect,
  planned: PlannedTree,
): CommandAuthorizationPlan {
  const promptOnlyReasons = uniquePromptOnlyReasons(
    planned.units.flatMap((unit) => unit.promptOnlyReasons),
  );
  if (promptOnlyReasons.length > 0) {
    return promptOnlyPlan(source, dialect, planned.tree, planned.units);
  }
  return {
    kind: "analyzable",
    source,
    dialect,
    tree: planned.tree,
    units: planned.units,
  };
}

function promptOnlyPlan(
  source: string,
  dialect: CommandDialect,
  tree: CommandAuthorizationTree,
  units: CommandAuthorizationUnit[],
): CommandAuthorizationPlan {
  return {
    kind: "prompt-only",
    source,
    dialect,
    tree,
    units,
    promptOnlyReasons: uniquePromptOnlyReasons(units.flatMap((unit) => unit.promptOnlyReasons)),
  };
}

function unanalyzablePlan(
  source: string,
  dialect: CommandDialect,
  reasons: CommandUnanalyzableReason[],
): CommandAuthorizationPlan {
  return {
    kind: "unanalyzable",
    source,
    dialect,
    reasons,
  };
}

function relationshipForOperator(
  operator: CommandAuthorizationChainOperator | null,
): CommandAuthorizationRelationship {
  if (operator === "&&") {
    return "and-conditional";
  }
  if (operator === "||") {
    return "or-conditional";
  }
  if (operator === ";") {
    return "sequence";
  }
  return "simple";
}

function uniquePromptOnlyReasons(
  reasons: readonly CommandPromptOnlyReason[],
): CommandPromptOnlyReason[] {
  return [...new Set(reasons)];
}

function classifyUnsupportedWrapper(argv: readonly string[]): UnsupportedWrapper | null {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  if (executable === "cmd" || executable === "cmd.exe") {
    return { dialect: "windows-cmd", reason: "unsupported-cmd-wrapper" };
  }
  if (executable === "powershell" || executable === "powershell.exe" || executable === "pwsh") {
    return { dialect: "powershell", reason: "unsupported-powershell-wrapper" };
  }
  return null;
}

function promptOnlyReasonsForStep(
  step: CommandStep,
  risks: readonly CommandRisk[],
): CommandPromptOnlyReason[] {
  const inlineCommand = extractBindableShellWrapperInlineCommand(step.argv);
  if (inlineCommand && isDirectShellPositionalCarrierInvocation(inlineCommand)) {
    return [];
  }
  const reasons = promptOnlyReasonsFromRisks(
    risks.filter((risk) => spansOverlap(step.span.startIndex, step.span.endIndex, risk)),
  );
  if (hasLeadingVariableAssignment(step)) {
    reasons.push("unsupported-shell-syntax");
  }
  return uniquePromptOnlyReasons(reasons);
}

function promptOnlyReasonsFromRisks(risks: readonly CommandRisk[]): CommandPromptOnlyReason[] {
  const reasonSet = new Set<CommandPromptOnlyReason>();
  for (const risk of risks) {
    if (risk.kind === "inline-eval") {
      reasonSet.add("interpreter-inline-eval");
    } else if (risk.kind === "command-substitution") {
      reasonSet.add("command-substitution");
    } else if (risk.kind === "dynamic-executable") {
      reasonSet.add("dynamic-executable");
    } else if (
      risk.kind === "alias" ||
      risk.kind === "eval" ||
      risk.kind === "source" ||
      risk.kind === "function-definition" ||
      risk.kind === "line-continuation" ||
      risk.kind === "process-substitution" ||
      risk.kind === "heredoc" ||
      risk.kind === "here-string" ||
      risk.kind === "redirect" ||
      risk.kind === "syntax-error"
    ) {
      reasonSet.add("unsupported-shell-syntax");
    }
  }
  return (
    [
      "command-substitution",
      "dynamic-executable",
      "interpreter-inline-eval",
      "unsupported-shell-syntax",
    ] as const
  ).filter((reason) => reasonSet.has(reason));
}

function promptOnlyReasonsFromRisksOutsideSelectedSteps(
  risks: readonly CommandRisk[],
  selectedSteps: readonly CommandStep[],
): CommandPromptOnlyReason[] {
  const skippedRisks = risks.filter(
    (risk) =>
      !selectedSteps.some((step) =>
        stepContainsSpan(step, risk.span.startIndex, risk.span.endIndex),
      ),
  );
  const reasons = promptOnlyReasonsFromRisks(skippedRisks);
  if (skippedRisks.some((risk) => risk.kind === "dynamic-argument")) {
    reasons.push("unsupported-shell-syntax");
  }
  return uniquePromptOnlyReasons(reasons);
}

const UNSUPPORTED_RENDER_SHAPES = new Set<CommandShape>([
  "stderr-pipeline",
  "negation",
  "if",
  "for",
  "while",
  "case",
  "subshell",
  "group",
  "background",
]);

function promptOnlyReasonsFromExplanation(
  explanation: CommandExplanation,
): CommandPromptOnlyReason[] {
  const reasons = promptOnlyReasonsFromRisks(explanation.risks);
  reasons.push(...promptOnlyReasonsFromUnsupportedRender(explanation));
  return uniquePromptOnlyReasons(reasons);
}

function promptOnlyReasonsFromUnsupportedRender(
  explanation: CommandExplanation,
): CommandPromptOnlyReason[] {
  const reasons: CommandPromptOnlyReason[] = [];
  if (
    explanation.risks.some(
      (risk) =>
        risk.kind === "heredoc" ||
        risk.kind === "here-string" ||
        risk.kind === "redirect" ||
        risk.kind === "alias" ||
        risk.kind === "eval" ||
        risk.kind === "source" ||
        risk.kind === "function-definition" ||
        risk.kind === "line-continuation" ||
        risk.kind === "process-substitution" ||
        risk.kind === "syntax-error",
    )
  ) {
    reasons.push("unsupported-shell-syntax");
  }
  if (explanation.shapes.some((shape) => UNSUPPORTED_RENDER_SHAPES.has(shape))) {
    reasons.push("unsupported-shell-syntax");
  }
  if (hasMixedWrapperPayloadGroupingRisk(explanation)) {
    reasons.push("unsupported-shell-syntax");
  }
  return uniquePromptOnlyReasons(reasons);
}

function hasMixedWrapperPayloadGroupingRisk(explanation: CommandExplanation): boolean {
  if (explanation.topLevelCommands.length < 2) {
    return false;
  }
  return explanation.topLevelCommands.some((step) => {
    const wrapperPayloadSteps = explanation.nestedCommands.filter(
      (nestedStep) =>
        nestedStep.context === "wrapper-payload" &&
        stepContainsSpan(step, nestedStep.span.startIndex, nestedStep.span.endIndex),
    );
    return (
      wrapperPayloadSteps.length > 1 &&
      shouldPlanWrapperPayload(step, wrapperPayloadSteps, explanation.risks)
    );
  });
}

function spansOverlap(startIndex: number, endIndex: number, risk: CommandRisk): boolean {
  return risk.span.startIndex < endIndex && risk.span.endIndex > startIndex;
}

function hasLeadingVariableAssignment(step: CommandStep): boolean {
  const relativeExecutableStart = step.executableSpan.startIndex - step.span.startIndex;
  if (relativeExecutableStart <= 0) {
    return false;
  }
  const prefix = step.text.slice(0, relativeExecutableStart).trim();
  if (!prefix) {
    return false;
  }
  return /(?:^|[\s])[_A-Za-z][_A-Za-z0-9]*=/u.test(prefix);
}

function stepContainsSpan(step: CommandStep, startIndex: number, endIndex: number): boolean {
  return step.span.startIndex <= startIndex && step.span.endIndex >= endIndex;
}

function isRelativePathScopedExecutableToken(token: string): boolean {
  if (!token.includes("/") && !token.includes("\\")) {
    return false;
  }
  const normalized = token.replace(/\\/g, "/");
  return (
    !normalized.startsWith("/") && !/^[A-Za-z]:\//u.test(normalized) && !normalized.startsWith("//")
  );
}

function isDirectShellPositionalCarrierInvocation(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return false;
  }

  const shellWhitespace = String.raw`[^\S\r\n]+`;
  const positionalZero = String.raw`(?:\$(?:0|\{0\})|"\$(?:0|\{0\})")`;
  const positionalArg = String.raw`(?:\$(?:[@*]|[1-9]|\{[@*1-9]\})|"\$(?:[@*]|[1-9]|\{[@*1-9]\})")`;
  return new RegExp(
    `^(?:exec${shellWhitespace}(?:--${shellWhitespace})?)?${positionalZero}(?:${shellWhitespace}${positionalArg})*$`,
    "u",
  ).test(trimmed);
}
