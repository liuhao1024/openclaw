// Provides model selection, usage, and thinking-level utility helpers.
import type { Api, Model, ModelThinkingLevel, Usage } from "./types.js";

/** Calculates and stores model cost fields from token usage and per-million pricing. */
export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
  usage.cost.input = (model.cost.input / 1000000) * usage.input;
  usage.cost.output = (model.cost.output / 1000000) * usage.output;
  usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
  usage.cost.cacheWrite = (model.cost.cacheWrite / 1000000) * usage.cacheWrite;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  return usage.cost;
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function readObjectField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return undefined;
  }
  try {
    return descriptor && "value" in descriptor ? descriptor.value : descriptor?.get?.call(value);
  } catch {
    return undefined;
  }
}

function readModelField<TApi extends Api>(model: Model<TApi>, key: string): unknown {
  return readObjectField(model, key);
}

function readModelStringField<TApi extends Api>(model: Model<TApi>, key: string): string {
  const value = readModelField(model, key);
  return typeof value === "string" ? value : "";
}

function readThinkingLevelMapValue<TApi extends Api>(
  model: Model<TApi>,
  level: ModelThinkingLevel,
): unknown {
  return readObjectField(readModelField(model, "thinkingLevelMap"), level);
}

/** Returns thinking levels exposed by a reasoning-capable model. */
export function getSupportedThinkingLevels<TApi extends Api>(
  model: Model<TApi>,
): ModelThinkingLevel[] {
  if (readModelField(model, "reasoning") !== true) {
    return ["off"];
  }

  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = readThinkingLevelMapValue(model, level);
    if (mapped === null) {
      return false;
    }
    if (level === "xhigh" || level === "max") {
      return mapped !== undefined;
    }
    return true;
  });
}

/** Clamps a requested thinking level to the closest supported level for a model. */
export function clampThinkingLevel<TApi extends Api>(
  model: Model<TApi>,
  level: ModelThinkingLevel,
): ModelThinkingLevel {
  const availableLevels = getSupportedThinkingLevels(model);
  if (availableLevels.includes(level)) {
    return level;
  }

  const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
  if (requestedIndex === -1) {
    return availableLevels[0] ?? "off";
  }

  // Prefer the next stronger available level, then walk down if the request was above the model cap.
  for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
    const candidate = EXTENDED_THINKING_LEVELS[i];
    if (availableLevels.includes(candidate)) {
      return candidate;
    }
  }
  for (let i = requestedIndex - 1; i >= 0; i--) {
    const candidate = EXTENDED_THINKING_LEVELS[i];
    if (availableLevels.includes(candidate)) {
      return candidate;
    }
  }
  return availableLevels[0] ?? "off";
}

/** Compares model identity by provider and id. */
export function modelsAreEqual<TApi extends Api>(
  a: Model<TApi> | null | undefined,
  b: Model<TApi> | null | undefined,
): boolean {
  if (!a || !b) {
    return false;
  }
  const aId = readModelStringField(a, "id");
  const bId = readModelStringField(b, "id");
  const aProvider = readModelStringField(a, "provider");
  const bProvider = readModelStringField(b, "provider");
  return aId !== "" && aProvider !== "" && aId === bId && aProvider === bProvider;
}
