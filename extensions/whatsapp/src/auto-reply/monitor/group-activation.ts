import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { updateSessionStore } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveWhatsAppLegacyGroupSessionKey } from "../../group-session-key.js";
import type { WebInboundMessage } from "../../inbound/types.js";
import { loadSessionStore, resolveStorePath } from "../config.runtime.js";
import { normalizeGroupActivation } from "./group-activation.runtime.js";

function hasNamedWhatsAppAccounts(cfg: OpenClawConfig) {
  const accountIds = Object.keys(cfg.channels?.whatsapp?.accounts ?? {});
  return accountIds.some((accountId) => normalizeAccountId(accountId) !== DEFAULT_ACCOUNT_ID);
}

function isActivationOnlyEntry(
  entry:
    | {
        groupActivation?: unknown;
        sessionId?: unknown;
        updatedAt?: unknown;
      }
    | undefined,
) {
  return (
    entry?.groupActivation !== undefined &&
    typeof entry?.sessionId !== "string" &&
    typeof entry?.updatedAt !== "number"
  );
}

export async function resolveGroupActivationFor(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  agentId: string;
  sessionKey: string;
  conversationId: string;
  requireMentionDefault: boolean;
}) {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const store = loadSessionStore(storePath);
  const legacySessionKey = resolveWhatsAppLegacyGroupSessionKey({
    sessionKey: params.sessionKey,
    accountId: params.accountId,
  });
  const legacyEntry = legacySessionKey ? store[legacySessionKey] : undefined;
  const scopedEntry = store[params.sessionKey];
  const normalizedAccountId = normalizeAccountId(params.accountId);
  const ignoreScopedActivation =
    normalizedAccountId === DEFAULT_ACCOUNT_ID &&
    hasNamedWhatsAppAccounts(params.cfg) &&
    isActivationOnlyEntry(scopedEntry);
  const activation =
    (ignoreScopedActivation ? undefined : scopedEntry?.groupActivation) ??
    legacyEntry?.groupActivation;
  if (activation !== undefined && scopedEntry?.groupActivation === undefined) {
    await updateSessionStore(storePath, (nextStore) => {
      const nextScopedEntry = nextStore[params.sessionKey];
      if (nextScopedEntry?.groupActivation !== undefined) {
        return;
      }
      nextStore[params.sessionKey] = {
        ...nextScopedEntry,
        groupActivation: activation,
      };
    });
  }
  const defaultActivation = !params.requireMentionDefault ? "always" : "mention";
  return normalizeGroupActivation(activation) ?? defaultActivation;
}

export async function resolveAcceptedGroupActivationFor(params: {
  cfg: OpenClawConfig;
  msg: WebInboundMessage;
  agentId: string;
  sessionKey: string;
}) {
  const admission = params.msg.admission;
  return resolveGroupActivationFor({
    cfg: params.cfg,
    accountId: admission.accountId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    conversationId: admission.conversation.id,
    requireMentionDefault: admission.conversation.requireMention,
  });
}
