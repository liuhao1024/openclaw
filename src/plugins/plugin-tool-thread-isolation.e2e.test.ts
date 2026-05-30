import { afterEach, beforeEach, describe, expect, it } from "vitest";
import diffsPluginEntry from "../../extensions/diffs/index.js";
import llmTaskPluginEntry from "../../extensions/llm-task/index.js";
import memoryCorePluginEntry from "../../extensions/memory-core/index.js";
import { jsonResult, type AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRecord } from "./loader-records.js";
import { clearMemoryEmbeddingProviders } from "./memory-embedding-providers.js";
import { clearMemoryPluginState } from "./memory-state.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRecord } from "./registry-types.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";

const TEST_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

function createTestRegistry(runtime: Partial<PluginRuntime> = {}) {
  return createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime: runtime as PluginRuntime,
    activateGlobalSideEffects: false,
  });
}

type RecordOptions = {
  contracts?: NonNullable<Parameters<typeof createPluginRecord>[0]["contracts"]>;
  kind?: PluginRecord["kind"];
  memorySlotSelected?: boolean;
  origin?: PluginRecord["origin"];
  trustedOfficialInstall?: boolean;
};

function createRecord(
  pluginId: string,
  toolNames: string[] = [`${pluginId}_tool`],
  options: RecordOptions = {},
) {
  const record = createPluginRecord({
    id: pluginId,
    name: pluginId,
    source: `/plugins/${pluginId}/index.js`,
    rootDir: `/plugins/${pluginId}`,
    origin: options.origin ?? "global",
    trustedOfficialInstall: options.trustedOfficialInstall,
    enabled: true,
    configSchema: false,
    contracts: options.contracts ?? {
      tools: toolNames,
    },
  });
  record.kind = options.kind;
  record.memorySlotSelected = options.memorySlotSelected;
  return record;
}

function requireTool(value: ReturnType<typeof createTestRegistry>["registry"]["tools"][number]) {
  const resolved = value.factory({});
  if (!resolved || Array.isArray(resolved)) {
    throw new Error("expected one plugin tool");
  }
  return resolved;
}

function requireToolByName(
  registry: ReturnType<typeof createTestRegistry>["registry"],
  name: string,
  ctx: Record<string, unknown> = {},
) {
  const registration = registry.tools.find((tool) => tool.names.includes(name));
  if (!registration) {
    throw new Error(`expected registered tool: ${name}`);
  }
  const resolved = registration.factory(ctx);
  if (!resolved || Array.isArray(resolved)) {
    throw new Error(`expected one plugin tool: ${name}`);
  }
  return resolved;
}

function asConfig(config: Partial<OpenClawConfig>): OpenClawConfig {
  return config as OpenClawConfig;
}

function expectCurrentPluginScope(pluginId: string, phase: string) {
  const scope = getPluginRuntimeGatewayRequestScope();
  expect(scope, phase).toMatchObject({ pluginId });
  return scope;
}

describe("plugin tool thread isolation", () => {
  beforeEach(() => {
    clearMemoryEmbeddingProviders();
    clearMemoryPluginState();
  });

  afterEach(() => {
    clearMemoryEmbeddingProviders();
    clearMemoryPluginState();
  });

  it("runs plugin tool factories, prepare callbacks, and execute callbacks under the owning plugin scope", async () => {
    const pluginRegistry = createTestRegistry();
    const observed: Array<{
      phase: "factory" | "prepare" | "execute";
      pluginId?: string;
      pluginSource?: string;
    }> = [];

    for (const pluginId of ["alpha", "beta"]) {
      const record = createRecord(pluginId);
      const api = pluginRegistry.createApi(record, { config: {} as OpenClawConfig });
      api.registerTool(
        () => {
          const factoryScope = getPluginRuntimeGatewayRequestScope();
          observed.push({
            phase: "factory",
            pluginId: factoryScope?.pluginId,
            pluginSource: factoryScope?.pluginSource,
          });
          return {
            name: `${pluginId}_tool`,
            label: `${pluginId} tool`,
            description: `${pluginId} tool`,
            parameters: TEST_PARAMETERS,
            prepareArguments(args) {
              const prepareScope = getPluginRuntimeGatewayRequestScope();
              observed.push({
                phase: "prepare",
                pluginId: prepareScope?.pluginId,
                pluginSource: prepareScope?.pluginSource,
              });
              return args as never;
            },
            async execute() {
              const executeScope = getPluginRuntimeGatewayRequestScope();
              observed.push({
                phase: "execute",
                pluginId: executeScope?.pluginId,
                pluginSource: executeScope?.pluginSource,
              });
              return jsonResult({ pluginId });
            },
          };
        },
        { name: `${pluginId}_tool` },
      );
    }

    await withPluginRuntimeGatewayRequestScope(
      {
        pluginId: "outer",
        pluginSource: "/plugins/outer/index.js",
        isWebchatConnect: () => false,
      },
      async () => {
        const tools = pluginRegistry.registry.tools.map(requireTool);
        await Promise.all(
          tools.map((tool) =>
            tool.execute(`call-${tool.name}`, tool.prepareArguments?.({}) ?? {}, undefined),
          ),
        );
        expect(getPluginRuntimeGatewayRequestScope()).toMatchObject({
          pluginId: "outer",
          pluginSource: "/plugins/outer/index.js",
        });
      },
    );

    expect(getPluginRuntimeGatewayRequestScope()).toBeUndefined();
    expect(observed).toEqual([
      {
        phase: "factory",
        pluginId: "alpha",
        pluginSource: "/plugins/alpha/index.js",
      },
      {
        phase: "factory",
        pluginId: "beta",
        pluginSource: "/plugins/beta/index.js",
      },
      {
        phase: "prepare",
        pluginId: "alpha",
        pluginSource: "/plugins/alpha/index.js",
      },
      {
        phase: "execute",
        pluginId: "alpha",
        pluginSource: "/plugins/alpha/index.js",
      },
      {
        phase: "prepare",
        pluginId: "beta",
        pluginSource: "/plugins/beta/index.js",
      },
      {
        phase: "execute",
        pluginId: "beta",
        pluginSource: "/plugins/beta/index.js",
      },
    ]);
  });

  it("wraps static tool prepare callbacks and restores the caller scope after errors", async () => {
    const pluginRegistry = createTestRegistry();
    const record = createRecord("static");
    const api = pluginRegistry.createApi(record, { config: {} as OpenClawConfig });
    const observed: Array<{
      phase: "prepare" | "execute";
      pluginId?: string;
      pluginSource?: string;
    }> = [];

    api.registerTool({
      name: "static_tool",
      label: "static tool",
      description: "static tool",
      parameters: TEST_PARAMETERS,
      prepareArguments() {
        const prepareScope = getPluginRuntimeGatewayRequestScope();
        observed.push({
          phase: "prepare",
          pluginId: prepareScope?.pluginId,
          pluginSource: prepareScope?.pluginSource,
        });
        throw new Error("invalid static tool args");
      },
      async execute() {
        const executeScope = getPluginRuntimeGatewayRequestScope();
        observed.push({
          phase: "execute",
          pluginId: executeScope?.pluginId,
          pluginSource: executeScope?.pluginSource,
        });
        return jsonResult({ pluginId: "static" });
      },
    });

    await withPluginRuntimeGatewayRequestScope(
      {
        pluginId: "outer",
        pluginSource: "/plugins/outer/index.js",
        isWebchatConnect: () => false,
      },
      async () => {
        const tool = requireTool(pluginRegistry.registry.tools[0]);
        expect(() => tool.prepareArguments?.({})).toThrow("invalid static tool args");
        expect(getPluginRuntimeGatewayRequestScope()).toMatchObject({
          pluginId: "outer",
          pluginSource: "/plugins/outer/index.js",
        });
        await tool.execute("call-static", {}, undefined);
        expect(getPluginRuntimeGatewayRequestScope()).toMatchObject({
          pluginId: "outer",
          pluginSource: "/plugins/outer/index.js",
        });
      },
    );

    expect(getPluginRuntimeGatewayRequestScope()).toBeUndefined();
    expect(observed).toEqual([
      {
        phase: "prepare",
        pluginId: "static",
        pluginSource: "/plugins/static/index.js",
      },
      {
        phase: "execute",
        pluginId: "static",
        pluginSource: "/plugins/static/index.js",
      },
    ]);
  });

  it("wraps every tool returned by an array factory", async () => {
    const pluginRegistry = createTestRegistry();
    const toolNames = ["array_first", "array_second"];
    const record = createRecord("array", toolNames);
    const api = pluginRegistry.createApi(record, { config: {} as OpenClawConfig });
    const observed: Array<{
      name: string;
      pluginId?: string;
      pluginSource?: string;
    }> = [];

    api.registerTool(
      () =>
        toolNames.map(
          (name): AnyAgentTool => ({
            name,
            label: name,
            description: name,
            parameters: TEST_PARAMETERS,
            async execute() {
              const executeScope = getPluginRuntimeGatewayRequestScope();
              observed.push({
                name,
                pluginId: executeScope?.pluginId,
                pluginSource: executeScope?.pluginSource,
              });
              return jsonResult({ name });
            },
          }),
        ),
      { names: toolNames },
    );

    await withPluginRuntimeGatewayRequestScope(
      {
        pluginId: "outer",
        pluginSource: "/plugins/outer/index.js",
        isWebchatConnect: () => false,
      },
      async () => {
        const resolved = pluginRegistry.registry.tools[0].factory({});
        if (!Array.isArray(resolved)) {
          throw new Error("expected array plugin tools");
        }
        await Promise.all(resolved.map((tool) => tool.execute(`call-${tool.name}`, {}, undefined)));
        expect(getPluginRuntimeGatewayRequestScope()).toMatchObject({
          pluginId: "outer",
          pluginSource: "/plugins/outer/index.js",
        });
      },
    );

    expect(observed).toEqual([
      {
        name: "array_first",
        pluginId: "array",
        pluginSource: "/plugins/array/index.js",
      },
      {
        name: "array_second",
        pluginId: "array",
        pluginSource: "/plugins/array/index.js",
      },
    ]);
  });

  it("keeps the bundled diffs tool factory on the diffs plugin scope", async () => {
    const observed: Array<{ phase: "config"; pluginId?: string; pluginSource?: string }> = [];
    const pluginRegistry = createTestRegistry({
      config: {
        current() {
          const scope = expectCurrentPluginScope("diffs", "diffs runtime config");
          observed.push({
            phase: "config",
            pluginId: scope?.pluginId,
            pluginSource: scope?.pluginSource,
          });
          return asConfig({
            plugins: {
              entries: {
                diffs: {
                  config: {
                    viewerBaseUrl: "http://127.0.0.1:3987",
                    defaults: {
                      mode: "view",
                    },
                  },
                },
              },
            },
          });
        },
      } as PluginRuntime["config"],
    });
    const record = createRecord("diffs", ["diffs"], {
      contracts: { tools: ["diffs"] },
      origin: "bundled",
    });
    const api = pluginRegistry.createApi(record, { config: asConfig({}) });

    diffsPluginEntry.register(api);

    await withPluginRuntimeGatewayRequestScope(
      {
        pluginId: "outer",
        pluginSource: "/plugins/outer/index.js",
        isWebchatConnect: () => false,
      },
      async () => {
        const tool = requireToolByName(pluginRegistry.registry, "diffs", {});
        const result = await tool.execute(
          "call-diffs",
          { before: "alpha\n", after: "beta\n" },
          undefined,
        );
        expect(result.details).toMatchObject({
          mode: "view",
          viewerUrl: expect.stringContaining("http://127.0.0.1:3987"),
        });
        expect(getPluginRuntimeGatewayRequestScope()).toMatchObject({
          pluginId: "outer",
          pluginSource: "/plugins/outer/index.js",
        });
      },
    );

    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((entry) => entry.pluginId === "diffs")).toBe(true);
    expect(getPluginRuntimeGatewayRequestScope()).toBeUndefined();
  });

  it("keeps memory-core lazy factory and execute config reads on the memory-core plugin scope", async () => {
    const pluginRegistry = createTestRegistry();
    const record = createRecord("memory-core", ["memory_search", "memory_get"], {
      contracts: {
        tools: ["memory_search", "memory_get"],
        memoryEmbeddingProviders: ["local"],
      },
      kind: "memory",
      memorySlotSelected: true,
      origin: "bundled",
      trustedOfficialInstall: true,
    });
    const api = pluginRegistry.createApi(record, {
      config: asConfig({ agents: { list: [{ id: "main", default: true }] } }),
    });
    const observed: Array<{ phase: "factory" | "execute"; pluginId?: string }> = [];
    let phase: "factory" | "execute" = "factory";
    const ctx = {
      agentId: "main",
      getRuntimeConfig() {
        const scope = getPluginRuntimeGatewayRequestScope();
        observed.push({ phase, pluginId: scope?.pluginId });
        return scope?.pluginId === "memory-core"
          ? asConfig({ agents: { list: [{ id: "main", default: true }] } })
          : asConfig({ agents: { defaults: { memorySearch: { enabled: false } } } });
      },
    };

    memoryCorePluginEntry.register(api);

    await withPluginRuntimeGatewayRequestScope(
      {
        pluginId: "outer",
        pluginSource: "/plugins/outer/index.js",
        isWebchatConnect: () => false,
      },
      async () => {
        const tool = requireToolByName(pluginRegistry.registry, "memory_get", ctx);
        phase = "execute";
        await expect(
          tool.execute("call-memory-get", { path: "MEMORY.md", from: 1.5 }, undefined),
        ).rejects.toThrow("from must be a positive integer");
        expect(getPluginRuntimeGatewayRequestScope()).toMatchObject({
          pluginId: "outer",
          pluginSource: "/plugins/outer/index.js",
        });
      },
    );

    expect(observed.some((entry) => entry.phase === "factory")).toBe(true);
    expect(observed.some((entry) => entry.phase === "execute")).toBe(true);
    expect(observed.every((entry) => entry.pluginId === "memory-core")).toBe(true);
    expect(getPluginRuntimeGatewayRequestScope()).toBeUndefined();
  });

  it("keeps llm-task execute callbacks on the llm-task plugin scope", async () => {
    const observed: Array<{
      phase: "thinking-policy" | "thinking-normalize" | "embedded-agent";
      pluginId?: string;
    }> = [];
    const pluginRegistry = createTestRegistry({
      agent: {
        defaults: { provider: "openai", model: "gpt-5.5" },
        resolveThinkingPolicy() {
          const scope = expectCurrentPluginScope("llm-task", "llm-task thinking policy");
          observed.push({ phase: "thinking-policy", pluginId: scope?.pluginId });
          return {
            levels: [{ id: "low", label: "low" }],
          };
        },
        normalizeThinkingLevel(raw?: string | null) {
          const scope = expectCurrentPluginScope("llm-task", "llm-task thinking normalize");
          observed.push({ phase: "thinking-normalize", pluginId: scope?.pluginId });
          return raw === "low" ? "low" : undefined;
        },
        async runEmbeddedAgent() {
          const scope = expectCurrentPluginScope("llm-task", "llm-task embedded agent");
          observed.push({ phase: "embedded-agent", pluginId: scope?.pluginId });
          return {
            meta: { durationMs: 0 },
            payloads: [{ text: JSON.stringify({ ok: true }) }],
          };
        },
      } as unknown as PluginRuntime["agent"],
    });
    const record = createRecord("llm-task", ["llm-task"], {
      contracts: { tools: ["llm-task"] },
      origin: "bundled",
    });
    const api = pluginRegistry.createApi(record, {
      config: asConfig({
        agents: {
          defaults: {
            workspace: "/tmp",
            model: { primary: "openai/gpt-5.5" },
          },
        },
      }),
    });

    llmTaskPluginEntry.register(api);

    await withPluginRuntimeGatewayRequestScope(
      {
        pluginId: "outer",
        pluginSource: "/plugins/outer/index.js",
        isWebchatConnect: () => false,
      },
      async () => {
        const tool = requireToolByName(pluginRegistry.registry, "llm-task", {});
        const result = await tool.execute(
          "call-llm-task",
          { prompt: "return ok", thinking: "low" },
          undefined,
        );
        expect(result.details).toMatchObject({
          json: { ok: true },
          provider: "openai",
          model: "gpt-5.5",
        });
        expect(getPluginRuntimeGatewayRequestScope()).toMatchObject({
          pluginId: "outer",
          pluginSource: "/plugins/outer/index.js",
        });
      },
    );

    expect(observed).toEqual([
      { phase: "thinking-policy", pluginId: "llm-task" },
      { phase: "thinking-normalize", pluginId: "llm-task" },
      { phase: "embedded-agent", pluginId: "llm-task" },
    ]);
    expect(getPluginRuntimeGatewayRequestScope()).toBeUndefined();
  });
});
