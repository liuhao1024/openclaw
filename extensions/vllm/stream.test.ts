// Vllm tests cover stream plugin behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import {
  createVllmProviderThinkingWrapper,
  createVllmQwenThinkingWrapper,
  wrapVllmProviderStream,
} from "./stream.js";

function capturePayload(params: {
  format: "chat-template" | "top-level";
  thinkingLevel?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
  reasoning?: unknown;
  initialPayload?: Record<string, unknown>;
  model?: Partial<Model<"openai-completions">>;
}): Record<string, unknown> {
  let captured: Record<string, unknown> = {};
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    const payload = { ...params.initialPayload };
    options?.onPayload?.(payload, _model);
    captured = payload;
    return {} as ReturnType<StreamFn>;
  };

  const wrapped = createVllmQwenThinkingWrapper({
    baseStreamFn,
    format: params.format,
    thinkingLevel: params.thinkingLevel ?? "high",
  });
  void wrapped(
    {
      api: "openai-completions",
      provider: "vllm",
      id: "Qwen/Qwen3-8B",
      reasoning: true,
      ...params.model,
    } as Model<"openai-completions">,
    { messages: [] } as Context,
    params.reasoning === undefined ? {} : ({ reasoning: params.reasoning } as never),
  );

  return captured;
}

function patchQwenPayload(params: {
  format: "chat-template" | "top-level";
  payload: Record<string, unknown>;
  thinkingLevel?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
  reasoning?: unknown;
}): Record<string, unknown> {
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    options?.onPayload?.(params.payload, _model);
    return {} as ReturnType<StreamFn>;
  };

  const wrapped = createVllmQwenThinkingWrapper({
    baseStreamFn,
    format: params.format,
    thinkingLevel: params.thinkingLevel ?? "high",
  });
  void wrapped(
    {
      api: "openai-completions",
      provider: "vllm",
      id: "Qwen/Qwen3-8B",
      reasoning: true,
    } as Model<"openai-completions">,
    { messages: [] } as Context,
    params.reasoning === undefined ? {} : ({ reasoning: params.reasoning } as never),
  );

  return params.payload;
}

describe("createVllmQwenThinkingWrapper", () => {
  it("maps Qwen chat-template thinking off to chat_template_kwargs", () => {
    const payload = capturePayload({
      format: "chat-template",
      reasoning: "none",
      initialPayload: {
        reasoning_effort: "high",
        reasoning: { effort: "high" },
        reasoningEffort: "high",
      },
    });

    expect(payload).toEqual({
      chat_template_kwargs: {
        enable_thinking: false,
        preserve_thinking: true,
      },
    });
  });

  it("replaces unreadable Qwen chat-template kwargs without crashing", () => {
    const payload: Record<string, unknown> = {
      enable_thinking: true,
      reasoning_effort: "high",
    };
    Object.defineProperty(payload, "chat_template_kwargs", {
      configurable: true,
      get() {
        throw new Error("chat_template_kwargs getter failed");
      },
    });

    expect(() =>
      patchQwenPayload({
        format: "chat-template",
        payload,
        thinkingLevel: "off",
      }),
    ).not.toThrow();

    expect(payload).toEqual({
      chat_template_kwargs: {
        enable_thinking: false,
        preserve_thinking: true,
      },
    });
  });

  it("maps Qwen chat-template thinking on to chat_template_kwargs", () => {
    expect(capturePayload({ format: "chat-template", reasoning: "medium" })).toEqual({
      chat_template_kwargs: {
        enable_thinking: true,
        preserve_thinking: true,
      },
    });
  });

  it("preserves explicit chat-template kwargs while setting enable_thinking", () => {
    expect(
      capturePayload({
        format: "chat-template",
        thinkingLevel: "off",
        initialPayload: {
          chat_template_kwargs: {
            preserve_thinking: false,
            force_nonempty_content: true,
          },
        },
      }),
    ).toEqual({
      chat_template_kwargs: {
        enable_thinking: false,
        preserve_thinking: false,
        force_nonempty_content: true,
      },
    });
  });

  it("copies only enumerable chat-template kwargs data fields", () => {
    const existing: Record<string, unknown> = {
      preserve_thinking: false,
    };
    Object.defineProperty(existing, "hidden", {
      enumerable: false,
      value: "not serialized",
    });
    Object.defineProperty(existing, "__proto__", {
      configurable: true,
      enumerable: true,
      value: "literal proto key",
      writable: true,
    });

    const payload = patchQwenPayload({
      format: "chat-template",
      payload: {
        chat_template_kwargs: existing,
      },
      thinkingLevel: "off",
    });
    const next = payload.chat_template_kwargs as Record<string, unknown>;

    expect(Object.hasOwn(next, "hidden")).toBe(false);
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(next, "__proto__")).toMatchObject({
      enumerable: true,
      value: "literal proto key",
    });
    expect(next).toMatchObject({
      enable_thinking: false,
      preserve_thinking: false,
    });
  });

  it("maps Qwen top-level thinking format to enable_thinking", () => {
    expect(capturePayload({ format: "top-level", thinkingLevel: "off" })).toEqual({
      enable_thinking: false,
    });
    expect(capturePayload({ format: "top-level", thinkingLevel: "high" })).toEqual({
      enable_thinking: true,
    });
  });

  it("overwrites hostile configurable top-level enable_thinking fields", () => {
    const payload: Record<string, unknown> = {
      reasoning_effort: "high",
      reasoning: { effort: "high" },
      reasoningEffort: "high",
    };
    Object.defineProperty(payload, "enable_thinking", {
      configurable: true,
      get() {
        throw new Error("enable_thinking getter failed");
      },
    });

    expect(() =>
      patchQwenPayload({
        format: "top-level",
        payload,
        thinkingLevel: "off",
      }),
    ).not.toThrow();

    expect(payload).toEqual({ enable_thinking: false });
  });

  it("fails closed when unsupported vLLM payload fields cannot be removed", () => {
    const payload: Record<string, unknown> = { enable_thinking: true };
    Object.defineProperty(payload, "reasoning", {
      configurable: false,
      value: { effort: "high" },
    });

    expect(() =>
      patchQwenPayload({
        format: "top-level",
        payload,
        thinkingLevel: "off",
      }),
    ).toThrow("vLLM payload field could not be removed: reasoning");
  });

  it("patches configured Qwen models unless reasoning is explicitly disabled", () => {
    expect(capturePayload({ format: "chat-template", model: { reasoning: undefined } })).toEqual({
      chat_template_kwargs: {
        enable_thinking: true,
        preserve_thinking: true,
      },
    });
    expect(capturePayload({ format: "chat-template", model: { reasoning: false } })).toStrictEqual(
      {},
    );
  });

  it("skips non-completions models", () => {
    expect(
      capturePayload({ format: "chat-template", model: { api: "openai-responses" as never } }),
    ).toStrictEqual({});
  });
});

describe("createVllmProviderThinkingWrapper", () => {
  function captureProviderPayload(params: {
    thinkingLevel?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
    initialPayload?: Record<string, unknown>;
    model?: Partial<Model<"openai-completions">>;
  }): Record<string, unknown> {
    let captured: Record<string, unknown> = {};
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload = { ...params.initialPayload };
      options?.onPayload?.(payload, _model);
      captured = payload;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createVllmProviderThinkingWrapper({
      baseStreamFn,
      thinkingLevel: params.thinkingLevel ?? "high",
    });
    void wrapped(
      {
        api: "openai-completions",
        provider: "vllm",
        id: "nemotron-3-super",
        reasoning: true,
        ...params.model,
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {},
    );

    return captured;
  }

  it("injects Nemotron 3 chat-template kwargs when thinking is off", () => {
    expect(captureProviderPayload({ thinkingLevel: "off" })).toEqual({
      chat_template_kwargs: {
        enable_thinking: false,
        force_nonempty_content: true,
      },
    });
  });

  it("does not inject Nemotron 3 chat-template kwargs when thinking is enabled", () => {
    expect(captureProviderPayload({ thinkingLevel: "low" })).toStrictEqual({});
  });

  it("preserves existing Nemotron 3 chat-template kwargs over defaults", () => {
    expect(
      captureProviderPayload({
        thinkingLevel: "off",
        initialPayload: {
          chat_template_kwargs: {
            enable_thinking: true,
          },
        },
      }),
    ).toEqual({
      chat_template_kwargs: {
        enable_thinking: true,
        force_nonempty_content: true,
      },
    });
  });

  it("replaces unreadable Nemotron 3 chat-template kwargs without crashing", () => {
    const payload: Record<string, unknown> = {};
    Object.defineProperty(payload, "chat_template_kwargs", {
      configurable: true,
      get() {
        throw new Error("chat_template_kwargs getter failed");
      },
    });
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      options?.onPayload?.(payload, _model);
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createVllmProviderThinkingWrapper({
      baseStreamFn,
      thinkingLevel: "off",
    });

    expect(() =>
      wrapped(
        {
          api: "openai-completions",
          provider: "vllm",
          id: "nemotron-3-super",
          reasoning: true,
        } as Model<"openai-completions">,
        { messages: [] } as Context,
        {},
      ),
    ).not.toThrow();

    expect(payload).toEqual({
      chat_template_kwargs: {
        enable_thinking: false,
        force_nonempty_content: true,
      },
    });
  });

  it("skips non-Nemotron vLLM models", () => {
    expect(
      captureProviderPayload({
        thinkingLevel: "off",
        model: { id: "Qwen/Qwen3-8B" },
      }),
    ).toStrictEqual({});
  });
});

describe("wrapVllmProviderStream", () => {
  it("registers when vLLM Qwen thinking format compat is configured", () => {
    expect(
      wrapVllmProviderStream({
        provider: "vllm",
        modelId: "Qwen/Qwen3-8B",
        extraParams: {},
        model: {
          api: "openai-completions",
          provider: "vllm",
          id: "Qwen/Qwen3-8B",
          reasoning: true,
          compat: { thinkingFormat: "qwen-chat-template" },
        } as Model<"openai-completions">,
        streamFn: undefined,
      } as never),
    ).toBeTypeOf("function");
  });

  it("ignores request params when Qwen thinking format compat is not configured", () => {
    expect(
      wrapVllmProviderStream({
        provider: "vllm",
        modelId: "Qwen/Qwen3-8B",
        extraParams: { qwenThinkingFormat: "chat-template" },
        model: {
          api: "openai-completions",
          provider: "vllm",
          id: "Qwen/Qwen3-8B",
          reasoning: true,
        } as Model<"openai-completions">,
        streamFn: undefined,
      } as never),
    ).toBeUndefined();
  });

  it("uses model compat for Qwen thinking format", () => {
    let captured: Record<string, unknown> = {};
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload = {};
      options?.onPayload?.(payload, _model);
      captured = payload;
      return {} as ReturnType<StreamFn>;
    };
    const model = {
      api: "openai-completions",
      provider: "vllm",
      id: "Qwen/Qwen3-8B",
      reasoning: true,
      compat: { thinkingFormat: "qwen-chat-template" },
    } as unknown as Model<"openai-completions">;
    const wrapped = wrapVllmProviderStream({
      provider: "vllm",
      modelId: "Qwen/Qwen3-8B",
      extraParams: {},
      thinkingLevel: "off",
      model,
      streamFn: baseStreamFn,
    } as never);

    expect(wrapped).toBeTypeOf("function");
    void wrapped?.(model, { messages: [] } as Context, {});

    expect(captured).toEqual({
      chat_template_kwargs: {
        enable_thinking: false,
        preserve_thinking: true,
      },
    });
  });

  it("skips unconfigured vLLM and non-vLLM providers", () => {
    expect(
      wrapVllmProviderStream({
        provider: "vllm",
        modelId: "Qwen/Qwen3-8B",
        extraParams: {},
        model: {
          api: "openai-completions",
          provider: "vllm",
          id: "Qwen/Qwen3-8B",
        } as Model<"openai-completions">,
        streamFn: undefined,
      } as never),
    ).toBeUndefined();

    expect(
      wrapVllmProviderStream({
        provider: "openai",
        modelId: "gpt-5.4",
        extraParams: {},
        model: {
          api: "openai-completions",
          provider: "openai",
          id: "gpt-5.4",
        } as Model<"openai-completions">,
        streamFn: undefined,
      } as never),
    ).toBeUndefined();
  });

  it("registers for vLLM Nemotron when thinking is off", () => {
    expect(
      wrapVllmProviderStream({
        provider: "vllm",
        modelId: "nemotron-3-super",
        extraParams: {},
        thinkingLevel: "off",
        model: {
          api: "openai-completions",
          provider: "vllm",
          id: "nemotron-3-super",
        } as Model<"openai-completions">,
        streamFn: undefined,
      } as never),
    ).toBeTypeOf("function");

    expect(
      wrapVllmProviderStream({
        provider: "vllm",
        modelId: "nemotron-3-super",
        extraParams: {},
        thinkingLevel: "low",
        model: {
          api: "openai-completions",
          provider: "vllm",
          id: "nemotron-3-super",
        } as Model<"openai-completions">,
        streamFn: undefined,
      } as never),
    ).toBeUndefined();
  });
});
