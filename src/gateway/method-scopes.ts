import { getPluginRegistryState } from "../plugins/runtime-state.js";
import { resolveReservedGatewayMethodScope } from "../shared/gateway-method-policy.js";
import { normalizeOptionalString as normalizeSessionActionParam } from "../shared/string-coerce.js";
import {
  isCoreGatewayMethodClassified,
  isCoreNodeGatewayMethod,
  isDynamicOperatorGatewayMethod,
  resolveCoreOperatorGatewayMethodScope,
} from "./methods/core-descriptors.js";
import {
  ADMIN_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
  READ_SCOPE,
  TALK_SECRETS_SCOPE,
  WRITE_SCOPE,
  isOperatorScope,
  type OperatorScope,
} from "./operator-scopes.js";

export {
  ADMIN_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
  READ_SCOPE,
  TALK_SECRETS_SCOPE,
  WRITE_SCOPE,
  type OperatorScope,
};

export const CLI_DEFAULT_OPERATOR_SCOPES: OperatorScope[] = [
  ADMIN_SCOPE,
  READ_SCOPE,
  WRITE_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
  TALK_SECRETS_SCOPE,
];

function readRecordField(
  value: unknown,
  field: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) {
      return { ok: false };
    }
    return { ok: true, value: (value as Record<string, unknown>)[field] };
  } catch {
    return { ok: false };
  }
}

function readNormalizedStringField(value: unknown, field: string): string | undefined {
  const read = readRecordField(value, field);
  if (!read.ok) {
    return undefined;
  }
  return normalizeSessionActionParam(read.value);
}

function resolveRegisteredGatewayMethodScope(method: string): OperatorScope | undefined {
  const registry = getPluginRegistryState()?.activeRegistry;
  const descriptors = readRecordField(registry, "gatewayMethodDescriptors");
  if (!descriptors.ok || !Array.isArray(descriptors.value)) {
    return undefined;
  }
  for (const descriptor of descriptors.value) {
    if (readNormalizedStringField(descriptor, "name") !== method) {
      continue;
    }
    const scope = readRecordField(descriptor, "scope");
    if (!scope.ok) {
      return ADMIN_SCOPE;
    }
    if (scope.value === "node" || scope.value === "dynamic") {
      return undefined;
    }
    return isOperatorScope(scope.value) ? scope.value : ADMIN_SCOPE;
  }
  return undefined;
}

function resolveScopedMethod(method: string): OperatorScope | undefined {
  const explicitScope = resolveCoreOperatorGatewayMethodScope(method);
  if (explicitScope) {
    return explicitScope;
  }
  const reservedScope = resolveReservedGatewayMethodScope(method);
  if (reservedScope) {
    return reservedScope;
  }
  return resolveRegisteredGatewayMethodScope(method);
}

export function isApprovalMethod(method: string): boolean {
  return resolveScopedMethod(method) === APPROVALS_SCOPE;
}

export function isPairingMethod(method: string): boolean {
  return resolveScopedMethod(method) === PAIRING_SCOPE;
}

export function isReadMethod(method: string): boolean {
  return resolveScopedMethod(method) === READ_SCOPE;
}

export function isWriteMethod(method: string): boolean {
  return resolveScopedMethod(method) === WRITE_SCOPE;
}

export function isNodeRoleMethod(method: string): boolean {
  return isCoreNodeGatewayMethod(method);
}

export function isAdminOnlyMethod(method: string): boolean {
  return resolveScopedMethod(method) === ADMIN_SCOPE;
}

export function resolveRequiredOperatorScopeForMethod(method: string): OperatorScope | undefined {
  return resolveScopedMethod(method);
}

function readSessionActionOperatorScopes(action: unknown): OperatorScope[] | undefined | null {
  const read = readRecordField(action, "requiredScopes");
  if (!read.ok) {
    return null;
  }
  if (read.value === undefined) {
    return undefined;
  }
  if (!Array.isArray(read.value)) {
    return null;
  }
  const scopes: OperatorScope[] = [];
  for (const scope of read.value) {
    if (typeof scope !== "string") {
      return null;
    }
    const trimmed = scope.trim();
    if (!isOperatorScope(trimmed)) {
      return null;
    }
    scopes.push(trimmed);
  }
  return scopes.length > 0 ? scopes : undefined;
}

function readSessionActionParams(
  params: unknown,
): { pluginId: string; actionId: string } | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const pluginId = readNormalizedStringField(params, "pluginId");
  const actionId = readNormalizedStringField(params, "actionId");
  if (!pluginId || !actionId) {
    return undefined;
  }
  return { pluginId, actionId };
}

type SessionActionScopeLookup =
  | { status: "missing" }
  | { status: "malformed" }
  | { status: "found"; scopes: OperatorScope[] };

function resolveSessionActionScopeLookup(params: unknown): SessionActionScopeLookup {
  const actionParams = readSessionActionParams(params);
  if (!actionParams) {
    return { status: "missing" };
  }
  const registry = getPluginRegistryState()?.activeRegistry;
  const sessionActions = readRecordField(registry, "sessionActions");
  if (!sessionActions.ok || !Array.isArray(sessionActions.value)) {
    return { status: "missing" };
  }
  let sawMalformedPluginAction = false;
  for (const entry of sessionActions.value) {
    if (readNormalizedStringField(entry, "pluginId") !== actionParams.pluginId) {
      continue;
    }
    const action = readRecordField(entry, "action");
    if (!action.ok) {
      sawMalformedPluginAction = true;
      continue;
    }
    const registeredActionId = readNormalizedStringField(action.value, "id");
    if (!registeredActionId) {
      sawMalformedPluginAction = true;
      continue;
    }
    if (registeredActionId !== actionParams.actionId) {
      continue;
    }
    const scopes = readSessionActionOperatorScopes(action.value);
    if (scopes === null) {
      return { status: "malformed" };
    }
    return { status: "found", scopes: scopes ?? [WRITE_SCOPE] };
  }
  return sawMalformedPluginAction ? { status: "malformed" } : { status: "missing" };
}

function resolveSessionActionLeastPrivilegeScopes(params: unknown): OperatorScope[] {
  const registeredScopes = resolveSessionActionScopeLookup(params);
  if (registeredScopes.status === "found") {
    return registeredScopes.scopes;
  }
  if (registeredScopes.status === "malformed") {
    return [ADMIN_SCOPE];
  }
  if (readSessionActionParams(params)) {
    // A standalone CLI/tool caller may be talking to a gateway whose live
    // plugin registry is not present in this local process. Avoid under-scoping
    // valid dynamic actions when we cannot determine the exact requirement
    // locally.
    return [...CLI_DEFAULT_OPERATOR_SCOPES];
  }
  return [WRITE_SCOPE];
}

function resolveDynamicLeastPrivilegeOperatorScopesForMethod(
  method: string,
  params: unknown,
): OperatorScope[] {
  if (method === "plugins.sessionAction") {
    return resolveSessionActionLeastPrivilegeScopes(params);
  }
  return [WRITE_SCOPE];
}

export function resolveLeastPrivilegeOperatorScopesForMethod(
  method: string,
  params?: unknown,
): OperatorScope[] {
  if (isDynamicOperatorGatewayMethod(method)) {
    return resolveDynamicLeastPrivilegeOperatorScopesForMethod(method, params);
  }
  const requiredScope = resolveRequiredOperatorScopeForMethod(method);
  if (requiredScope) {
    return [requiredScope];
  }
  // Default-deny for unclassified methods.
  return [];
}

export function authorizeOperatorScopesForMethod(
  method: string,
  scopes: readonly string[],
  params?: unknown,
): { allowed: true } | { allowed: false; missingScope: OperatorScope } {
  if (scopes.includes(ADMIN_SCOPE)) {
    return { allowed: true };
  }
  if (isDynamicOperatorGatewayMethod(method)) {
    const registeredScopes = resolveSessionActionScopeLookup(params);
    if (registeredScopes.status === "malformed") {
      return { allowed: false, missingScope: ADMIN_SCOPE };
    }
    if (
      registeredScopes.status === "missing" &&
      params &&
      typeof params === "object" &&
      !Array.isArray(params)
    ) {
      if (!readSessionActionParams(params)) {
        return scopes.some((scope) => isOperatorScope(scope))
          ? { allowed: true }
          : { allowed: false, missingScope: WRITE_SCOPE };
      }
    }
    const requiredScopes =
      registeredScopes.status === "found" ? registeredScopes.scopes : [WRITE_SCOPE];
    const missingScope = requiredScopes.find((scope) => {
      return !scopes.includes(scope) && !(scope === READ_SCOPE && scopes.includes(WRITE_SCOPE));
    });
    return missingScope ? { allowed: false, missingScope } : { allowed: true };
  }
  const requiredScope = resolveRequiredOperatorScopeForMethod(method) ?? ADMIN_SCOPE;
  if (requiredScope === READ_SCOPE) {
    if (scopes.includes(READ_SCOPE) || scopes.includes(WRITE_SCOPE)) {
      return { allowed: true };
    }
    return { allowed: false, missingScope: READ_SCOPE };
  }
  if (scopes.includes(requiredScope)) {
    return { allowed: true };
  }
  return { allowed: false, missingScope: requiredScope };
}

export function isGatewayMethodClassified(method: string): boolean {
  if (isNodeRoleMethod(method)) {
    return true;
  }
  if (isDynamicOperatorGatewayMethod(method)) {
    return true;
  }
  return (
    isCoreGatewayMethodClassified(method) ||
    resolveRequiredOperatorScopeForMethod(method) !== undefined
  );
}
