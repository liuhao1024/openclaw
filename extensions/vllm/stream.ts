// Vllm plugin module implements stream behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import {
  createPayloadPatchStreamWrapper,
  isOpenAICompatibleThinkingEnabled,
} from "openclaw/plugin-sdk/provider-stream-shared";
import {
  resolveVllmQwenThinkingFormatFromCompat,
  type VllmQwenThinkingFormat,
} from "./thinking-policy.js";

type VllmThinkingLevel = ProviderWrapStreamFnContext["thinkingLevel"];

function isVllmProviderId(providerId: string): boolean {
  return normalizeProviderId(providerId) === "vllm";
}

function resolveVllmQwenThinkingFormat(
  ctx: Pick<ProviderWrapStreamFnContext, "model">,
): VllmQwenThinkingFormat | undefined {
  return resolveVllmQwenThinkingFormatFromCompat(ctx.model?.compat);
}

type PayloadFieldRead = { ok: true; value: unknown } | { ok: false };

function readPayloadField(record: Record<string, unknown>, key: string): PayloadFieldRead {
  try {
    return { ok: true, value: record[key] };
  } catch {
    return { ok: false };
  }
}

function forcePayloadField(record: Record<string, unknown>, key: string, value: unknown): boolean {
  try {
    Object.defineProperty(record, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
    const next = readPayloadField(record, key);
    return next.ok && next.value === value;
  } catch {
    return false;
  }
}

function deletePayloadField(record: Record<string, unknown>, key: string): boolean {
  try {
    delete record[key];
    return !Object.hasOwn(record, key);
  } catch {
    return false;
  }
}

function removeVllmPayloadField(payload: Record<string, unknown>, key: string): void {
  if (!deletePayloadField(payload, key)) {
    throw new Error(`vLLM payload field could not be removed: ${key}`);
  }
}

function copyPlainDataFields(value: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.enumerable && "value" in descriptor) {
      Object.defineProperty(copy, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true,
      });
    }
  }
  return copy;
}

function setQwenChatTemplateThinking(payload: Record<string, unknown>, enabled: boolean): void {
  const existing = readPayloadField(payload, "chat_template_kwargs");
  let next: Record<string, unknown>;
  if (
    existing.ok &&
    existing.value &&
    typeof existing.value === "object" &&
    !Array.isArray(existing.value)
  ) {
    next = copyPlainDataFields(existing.value as Record<string, unknown>);
  } else {
    next = {};
  }
  next.enable_thinking = enabled;
  if (!Object.hasOwn(next, "preserve_thinking")) {
    next.preserve_thinking = true;
  }
  if (!forcePayloadField(payload, "chat_template_kwargs", next)) {
    throw new Error("vLLM Qwen chat template payload patch failed");
  }
}

function isVllmNemotronModel(model: { api?: unknown; provider?: unknown; id?: unknown }): boolean {
  return (
    model.api === "openai-completions" &&
    typeof model.provider === "string" &&
    normalizeProviderId(model.provider) === "vllm" &&
    typeof model.id === "string" &&
    /\bnemotron-3(?:[-_](?:nano|super|ultra))?\b/i.test(model.id)
  );
}

function setNemotronThinkingOffChatTemplateKwargs(payload: Record<string, unknown>): void {
  const defaults = {
    enable_thinking: false,
    force_nonempty_content: true,
  };
  const existing = readPayloadField(payload, "chat_template_kwargs");
  const next =
    existing.ok &&
    existing.value &&
    typeof existing.value === "object" &&
    !Array.isArray(existing.value)
      ? {
          ...defaults,
          ...copyPlainDataFields(existing.value as Record<string, unknown>),
        }
      : defaults;
  if (!forcePayloadField(payload, "chat_template_kwargs", next)) {
    throw new Error("vLLM Nemotron chat template payload patch failed");
  }
}

export function createVllmQwenThinkingWrapper(params: {
  baseStreamFn: StreamFn | undefined;
  format: VllmQwenThinkingFormat;
  thinkingLevel: VllmThinkingLevel;
}): StreamFn {
  return createPayloadPatchStreamWrapper(
    params.baseStreamFn,
    ({ payload: payloadObj, options }) => {
      const enableThinking = isOpenAICompatibleThinkingEnabled({
        thinkingLevel: params.thinkingLevel,
        options,
      });
      if (params.format === "chat-template") {
        setQwenChatTemplateThinking(payloadObj, enableThinking);
        removeVllmPayloadField(payloadObj, "enable_thinking");
      } else if (!forcePayloadField(payloadObj, "enable_thinking", enableThinking)) {
        throw new Error("vLLM enable_thinking payload patch failed");
      }
      removeVllmPayloadField(payloadObj, "reasoning_effort");
      removeVllmPayloadField(payloadObj, "reasoningEffort");
      removeVllmPayloadField(payloadObj, "reasoning");
    },
    {
      shouldPatch: ({ model }) => model.api === "openai-completions" && (model.reasoning ?? true),
    },
  );
}

export function createVllmProviderThinkingWrapper(params: {
  baseStreamFn: StreamFn | undefined;
  qwenFormat?: VllmQwenThinkingFormat;
  thinkingLevel: VllmThinkingLevel;
}): StreamFn {
  const qwenWrapped = params.qwenFormat
    ? createVllmQwenThinkingWrapper({
        baseStreamFn: params.baseStreamFn,
        format: params.qwenFormat,
        thinkingLevel: params.thinkingLevel,
      })
    : params.baseStreamFn;
  return createPayloadPatchStreamWrapper(
    qwenWrapped,
    ({ payload: payloadObj }) => {
      setNemotronThinkingOffChatTemplateKwargs(payloadObj);
    },
    {
      shouldPatch: ({ model }) =>
        model.api === "openai-completions" &&
        params.thinkingLevel === "off" &&
        isVllmNemotronModel(model),
    },
  );
}

export function wrapVllmProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  if (!isVllmProviderId(ctx.provider) || (ctx.model && ctx.model.api !== "openai-completions")) {
    return undefined;
  }
  const qwenFormat = resolveVllmQwenThinkingFormat(ctx);
  const shouldHandleNemotron =
    ctx.thinkingLevel === "off" &&
    isVllmNemotronModel({
      api: "openai-completions",
      provider: ctx.provider,
      id: ctx.modelId,
    });
  if (!qwenFormat && !shouldHandleNemotron) {
    return undefined;
  }
  return createVllmProviderThinkingWrapper({
    baseStreamFn: ctx.streamFn,
    qwenFormat,
    thinkingLevel: ctx.thinkingLevel,
  });
}
