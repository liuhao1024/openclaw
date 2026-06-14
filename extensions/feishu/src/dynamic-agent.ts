// Feishu plugin module implements dynamic agent behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveChannelConfigWrites } from "openclaw/plugin-sdk/channel-config-writes";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import type { DynamicAgentCreationConfig } from "./types.js";

type MaybeCreateDynamicAgentResult = {
  created: boolean;
  updatedCfg: OpenClawConfig;
  agentId?: string;
};

type DynamicAgentMutationResult = {
  created: boolean;
  agentId?: string;
};

function hasDirectBinding(cfg: OpenClawConfig, accountId: string, senderOpenId: string): boolean {
  const normalizedAccountId = normalizeAccountId(accountId);
  return (cfg.bindings ?? []).some(
    (binding) =>
      binding.match?.channel === "feishu" &&
      normalizeAccountId(binding.match?.accountId) === normalizedAccountId &&
      binding.match?.peer?.kind === "direct" &&
      binding.match?.peer?.id === senderOpenId,
  );
}

function resolveDynamicAgentConfig(
  cfg: OpenClawConfig,
  accountId: string,
): DynamicAgentCreationConfig | undefined {
  return resolveFeishuAccount({ cfg, accountId }).config.dynamicAgentCreation as
    | DynamicAgentCreationConfig
    | undefined;
}

function isAtDynamicAgentLimit(
  cfg: OpenClawConfig,
  dynamicCfg: DynamicAgentCreationConfig,
): boolean {
  if (dynamicCfg.maxAgents === undefined) {
    return false;
  }
  const feishuAgentCount = (cfg.agents?.list ?? []).filter((agent) =>
    agent.id.startsWith("feishu-"),
  ).length;
  return feishuAgentCount >= dynamicCfg.maxAgents;
}

/**
 * Refresh an existing DM binding or create its dynamic agent when current
 * account policy permits config writes.
 */
export async function maybeCreateDynamicAgent(params: {
  cfg: OpenClawConfig;
  runtime: PluginRuntime;
  accountId: string;
  senderOpenId: string;
  canCreateForConfig: (cfg: OpenClawConfig) => Promise<boolean>;
  log: (msg: string) => void;
}): Promise<MaybeCreateDynamicAgentResult> {
  const { cfg, runtime, senderOpenId, canCreateForConfig, log } = params;
  const accountId = normalizeAccountId(params.accountId);

  if (hasDirectBinding(cfg, accountId, senderOpenId)) {
    return { created: false, updatedCfg: cfg };
  }

  const currentCfg = runtime.config.current() as OpenClawConfig;
  if (hasDirectBinding(currentCfg, accountId, senderOpenId)) {
    return { created: false, updatedCfg: currentCfg };
  }

  const currentDynamicCfg = resolveDynamicAgentConfig(currentCfg, accountId);
  if (!currentDynamicCfg?.enabled) {
    return { created: false, updatedCfg: currentCfg };
  }
  if (!resolveChannelConfigWrites({ cfg: currentCfg, channelId: "feishu", accountId })) {
    log(`feishu: config writes disabled, not creating agent for ${senderOpenId}`);
    return { created: false, updatedCfg: currentCfg };
  }
  if (isAtDynamicAgentLimit(currentCfg, currentDynamicCfg)) {
    log(
      `feishu: maxAgents limit (${currentDynamicCfg.maxAgents}) reached, not creating agent for ${senderOpenId}`,
    );
    return { created: false, updatedCfg: currentCfg };
  }
  if (!(await canCreateForConfig(currentCfg))) {
    return { created: false, updatedCfg: currentCfg };
  }

  const agentId = `feishu-${senderOpenId}`;

  // The config mutation lock owns the final duplicate/limit checks. This keeps
  // simultaneous DM creations and policy updates from producing stale writes.
  const committed = await runtime.config.mutateConfigFile<DynamicAgentMutationResult>({
    base: "runtime",
    afterWrite: { mode: "auto" },
    mutate: async (draft) => {
      if (hasDirectBinding(draft, accountId, senderOpenId)) {
        return { created: false };
      }

      const dynamicCfg = resolveDynamicAgentConfig(draft, accountId);
      if (
        !dynamicCfg?.enabled ||
        !resolveChannelConfigWrites({ cfg: draft, channelId: "feishu", accountId })
      ) {
        return { created: false };
      }
      if (isAtDynamicAgentLimit(draft, dynamicCfg)) {
        log(
          `feishu: maxAgents limit (${dynamicCfg.maxAgents}) reached, not creating agent for ${senderOpenId}`,
        );
        return { created: false };
      }
      if (!(await canCreateForConfig(draft))) {
        return { created: false };
      }

      if (!(draft.agents?.list ?? []).some((agent) => agent.id === agentId)) {
        const workspaceTemplate = dynamicCfg.workspaceTemplate ?? "~/.openclaw/workspace-{agentId}";
        const agentDirTemplate =
          dynamicCfg.agentDirTemplate ?? "~/.openclaw/agents/{agentId}/agent";
        const workspace = resolveUserPath(
          workspaceTemplate.replace("{userId}", senderOpenId).replace("{agentId}", agentId),
        );
        const agentDir = resolveUserPath(
          agentDirTemplate.replace("{userId}", senderOpenId).replace("{agentId}", agentId),
        );
        log(`feishu: creating dynamic agent "${agentId}" for user ${senderOpenId}`);
        log(`  workspace: ${workspace}`);
        log(`  agentDir: ${agentDir}`);
        await fs.promises.mkdir(workspace, { recursive: true });
        await fs.promises.mkdir(agentDir, { recursive: true });
        draft.agents = {
          ...draft.agents,
          list: [...(draft.agents?.list ?? []), { id: agentId, workspace, agentDir }],
        };
      } else {
        log(`feishu: agent "${agentId}" exists, adding missing binding for ${senderOpenId}`);
      }

      draft.bindings = [
        ...(draft.bindings ?? []),
        {
          agentId,
          match: {
            channel: "feishu",
            accountId,
            peer: { kind: "direct", id: senderOpenId },
          },
        },
      ];
      return { created: true, agentId };
    },
  });

  return {
    created: committed.result?.created ?? false,
    updatedCfg: runtime.config.current() as OpenClawConfig,
    agentId: committed.result?.agentId,
  };
}

/**
 * Resolve a path that may start with ~ to the user's home directory.
 */
function resolveUserPath(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}
