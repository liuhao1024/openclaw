/** Validates and registers plugin command definitions into the global command registry. */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { isOperatorScope } from "../gateway/operator-scopes.js";
import { logVerbose } from "../globals.js";
import { isRecord } from "../utils.js";
import { normalizeAgentPromptSurfaceKind } from "./agent-prompt-surface-kind.js";
import {
  clearPluginCommands,
  clearPluginCommandsForPlugin,
  isPluginCommandRegistryLocked,
  pluginCommands,
  type RegisteredPluginCommand,
} from "./command-registry-state.js";
import {
  AGENT_PROMPT_SURFACE_KINDS,
  type AgentPromptGuidance,
  type AgentPromptGuidanceEntry,
  type AgentPromptSurfaceKind,
  type OpenClawPluginCommandDefinition,
} from "./types.js";

type CommandField = keyof OpenClawPluginCommandDefinition;

type CommandSnapshotResult =
  | { ok: true; command: OpenClawPluginCommandDefinition }
  | { ok: false; error: string };

/**
 * Reserved command names that plugins cannot override (built-in commands).
 *
 * Constructed lazily inside validateCommandName to avoid TDZ errors: the
 * bundler can place this module's body after call sites within the same
 * output chunk, so any module-level const/let would be uninitialized when
 * first accessed during plugin registration.
 */
let reservedCommands: Set<string> | undefined;
let agentPromptSurfaces: Set<string> | undefined;

function getReservedCommands(): Set<string> {
  reservedCommands ??= new Set([
    "help",
    "commands",
    "status",
    "diagnostics",
    "codex",
    "whoami",
    "context",
    "btw",
    "stop",
    "restart",
    "reset",
    "new",
    "compact",
    "config",
    "debug",
    "allowlist",
    "activation",
    "skill",
    "subagents",
    "kill",
    "steer",
    "tell",
    "model",
    "models",
    "queue",
    "send",
    "bash",
    "exec",
    "think",
    "verbose",
    "reasoning",
    "elevated",
    "usage",
  ]);
  return reservedCommands;
}

function getAgentPromptSurfaces(): Set<string> {
  agentPromptSurfaces ??= new Set(AGENT_PROMPT_SURFACE_KINDS);
  return agentPromptSurfaces;
}

/** Result returned when a plugin command registration succeeds or fails validation. */
export type CommandRegistrationResult = {
  ok: boolean;
  error?: string;
};

/** Returns true when a command name is owned by built-in OpenClaw command handling. */
export function isReservedCommandName(name: string): boolean {
  const trimmed = normalizeOptionalLowercaseString(name) ?? "";
  return Boolean(trimmed && getReservedCommands().has(trimmed));
}

/** Validates user-visible command names before plugin registration accepts them. */
export function validateCommandName(
  name: string,
  opts?: { allowReservedCommandNames?: boolean },
): string | null {
  const trimmed = normalizeOptionalLowercaseString(name) ?? "";

  if (!trimmed) {
    return "Command name cannot be empty";
  }

  // Must start with a letter, contain only letters, numbers, hyphens, underscores
  // Note: trimmed is already lowercased, so no need for /i flag
  if (!/^[a-z][a-z0-9_-]*$/.test(trimmed)) {
    return "Command name must start with a letter and contain only letters, numbers, hyphens, and underscores";
  }

  if (!opts?.allowReservedCommandNames && getReservedCommands().has(trimmed)) {
    return `Command name "${trimmed}" is reserved by a built-in command`;
  }

  return null;
}

/**
 * Validate a plugin command definition without registering it.
 * Returns an error message if invalid, or null if valid.
 * Shared by both the global registration path and snapshot (non-activating) loads.
 */
export function validatePluginCommandDefinition(
  command: OpenClawPluginCommandDefinition,
  opts?: { allowReservedCommandNames?: boolean },
): string | null {
  const snapshot = snapshotPluginCommandDefinition(command);
  if (!snapshot.ok) {
    return snapshot.error;
  }
  return validatePluginCommandSnapshot(snapshot.command, opts);
}

function validatePluginCommandSnapshot(
  command: OpenClawPluginCommandDefinition,
  opts?: { allowReservedCommandNames?: boolean },
): string | null {
  if (typeof command.handler !== "function") {
    return "Command handler must be a function";
  }
  if (typeof command.name !== "string") {
    return "Command name must be a string";
  }
  if (typeof command.description !== "string") {
    return "Command description must be a string";
  }
  if (!command.description.trim()) {
    return "Command description cannot be empty";
  }
  if (command.ownership === "reserved") {
    if (!opts?.allowReservedCommandNames) {
      return "Reserved command ownership is only available to bundled reserved commands";
    }
    if (!isReservedCommandName(command.name)) {
      return `Reserved command ownership requires a reserved command name: ${normalizeOptionalLowercaseString(command.name) ?? ""}`;
    }
  }
  if (command.agentPromptGuidance !== undefined && !Array.isArray(command.agentPromptGuidance)) {
    return "Agent prompt guidance must be an array of strings or objects";
  }
  for (const [index, guidance] of (command.agentPromptGuidance ?? []).entries()) {
    const guidanceError = validateAgentPromptGuidance(index, guidance);
    if (guidanceError) {
      return guidanceError;
    }
  }
  if (command.requiredScopes !== undefined) {
    if (!Array.isArray(command.requiredScopes)) {
      return "Command requiredScopes must be an array of operator scopes";
    }
    const unknownScope = (command.requiredScopes as readonly unknown[]).find(
      (scope) => !isOperatorScope(scope),
    );
    if (unknownScope) {
      return typeof unknownScope === "string"
        ? `Command requiredScopes contains unknown operator scope: ${unknownScope}`
        : "Command requiredScopes contains unknown operator scope";
    }
  }
  if (
    command.exposeSenderIsOwner !== undefined &&
    typeof command.exposeSenderIsOwner !== "boolean"
  ) {
    return "Command exposeSenderIsOwner must be a boolean";
  }
  if (command.channels !== undefined) {
    if (!Array.isArray(command.channels)) {
      return "Command channels must be an array of channel ids";
    }
    for (const [index, channel] of (command.channels as readonly unknown[]).entries()) {
      if (typeof channel !== "string") {
        return `Command channel ${index + 1} must be a string`;
      }
      if (!channel.trim()) {
        return `Command channel ${index + 1} cannot be empty`;
      }
    }
  }
  const nameError = validateCommandName(command.name.trim(), opts);
  if (nameError) {
    return nameError;
  }
  if (command.nativeNames !== undefined && !isRecord(command.nativeNames)) {
    return "Command nativeNames must be an object";
  }
  for (const [label, alias] of Object.entries(command.nativeNames ?? {})) {
    if (typeof alias !== "string") {
      continue;
    }
    const aliasError = validateCommandName(alias.trim());
    if (aliasError) {
      return `Native command alias "${label}" invalid: ${aliasError}`;
    }
  }
  if (command.nativeProgressMessages !== undefined && !isRecord(command.nativeProgressMessages)) {
    return "Command nativeProgressMessages must be an object";
  }
  for (const [label, message] of Object.entries(command.nativeProgressMessages ?? {})) {
    if (typeof message !== "string") {
      return `Native progress message "${label}" must be a string`;
    }
    if (!message.trim()) {
      return `Native progress message "${label}" cannot be empty`;
    }
  }
  if (
    command.descriptionLocalizations !== undefined &&
    !isRecord(command.descriptionLocalizations)
  ) {
    return "Command descriptionLocalizations must be an object";
  }
  for (const [locale, description] of Object.entries(command.descriptionLocalizations ?? {})) {
    if (typeof description !== "string") {
      return `Description localization "${locale}" must be a string`;
    }
    if (!description.trim()) {
      return `Description localization "${locale}" cannot be empty`;
    }
  }
  return null;
}

function readCommandField(
  command: OpenClawPluginCommandDefinition,
  field: CommandField,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: command[field] };
  } catch {
    return { ok: false, error: `Command ${field} is unreadable` };
  }
}

function copyArrayEntries(
  value: unknown,
  field: string,
): { ok: true; value: unknown[] } | { ok: false; error: string } {
  let length: number;
  try {
    if (!Array.isArray(value)) {
      return { ok: false, error: `${field} must be an array` };
    }
    length = value.length;
  } catch {
    return { ok: false, error: `${field} is unreadable` };
  }
  const entries: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    try {
      entries.push(value[index]);
    } catch {
      return { ok: false, error: `${field} entry ${index + 1} is unreadable` };
    }
  }
  return { ok: true, value: entries };
}

function copyOptionalArrayField(
  command: OpenClawPluginCommandDefinition,
  field: "channels" | "requiredScopes",
  label: string,
): { ok: true; value: unknown[] | undefined } | { ok: false; error: string } {
  const fieldValue = readCommandField(command, field);
  if (!fieldValue.ok) {
    return fieldValue;
  }
  if (fieldValue.value === undefined) {
    return { ok: true, value: undefined };
  }
  return copyArrayEntries(fieldValue.value, label);
}

function copyOptionalRecordField(
  command: OpenClawPluginCommandDefinition,
  field: "nativeNames" | "nativeProgressMessages" | "descriptionLocalizations",
  label: string,
): { ok: true; value: Record<string, unknown> | undefined } | { ok: false; error: string } {
  const fieldValue = readCommandField(command, field);
  if (!fieldValue.ok) {
    return fieldValue;
  }
  if (fieldValue.value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(fieldValue.value)) {
    return { ok: false, error: `${label} must be an object` };
  }
  try {
    return { ok: true, value: Object.fromEntries(Object.entries(fieldValue.value)) };
  } catch {
    return { ok: false, error: `${label} is unreadable` };
  }
}

function copyAgentPromptGuidance(
  command: OpenClawPluginCommandDefinition,
): { ok: true; value: AgentPromptGuidance[] | undefined } | { ok: false; error: string } {
  const fieldValue = readCommandField(command, "agentPromptGuidance");
  if (!fieldValue.ok) {
    return fieldValue;
  }
  if (fieldValue.value === undefined) {
    return { ok: true, value: undefined };
  }
  try {
    if (!Array.isArray(fieldValue.value)) {
      return {
        ok: false,
        error: "Agent prompt guidance must be an array of strings or objects",
      };
    }
  } catch {
    return { ok: false, error: "Agent prompt guidance is unreadable" };
  }
  const entries = copyArrayEntries(fieldValue.value, "Agent prompt guidance");
  if (!entries.ok) {
    return entries;
  }
  const guidance: AgentPromptGuidance[] = [];
  for (let index = 0; index < entries.value.length; index += 1) {
    const entry = entries.value[index];
    if (typeof entry === "string") {
      guidance.push(entry);
      continue;
    }
    if (!isRecord(entry)) {
      guidance.push(entry as AgentPromptGuidance);
      continue;
    }
    let text: unknown;
    let surfaces: unknown;
    try {
      text = entry.text;
      surfaces = entry.surfaces;
    } catch {
      return { ok: false, error: `Agent prompt guidance ${index + 1} is unreadable` };
    }
    if (surfaces === undefined) {
      guidance.push({ text } as AgentPromptGuidanceEntry);
      continue;
    }
    const copiedSurfaces = copyArrayEntries(
      surfaces,
      `Agent prompt guidance ${index + 1} surfaces`,
    );
    if (!copiedSurfaces.ok) {
      return copiedSurfaces;
    }
    guidance.push({ text, surfaces: copiedSurfaces.value } as AgentPromptGuidanceEntry);
  }
  return { ok: true, value: guidance };
}

export function snapshotPluginCommandDefinition(
  command: OpenClawPluginCommandDefinition,
): CommandSnapshotResult {
  if (!isRecord(command)) {
    return { ok: false, error: "Command definition must be an object" };
  }

  const handler = readCommandField(command, "handler");
  if (!handler.ok) {
    return handler;
  }
  const name = readCommandField(command, "name");
  if (!name.ok) {
    return name;
  }
  const description = readCommandField(command, "description");
  if (!description.ok) {
    return description;
  }
  const ownership = readCommandField(command, "ownership");
  if (!ownership.ok) {
    return ownership;
  }

  const snapshot: OpenClawPluginCommandDefinition = {
    name: name.value as string,
    description: description.value as string,
    handler: handler.value as OpenClawPluginCommandDefinition["handler"],
  };
  const setKnownField = <K extends keyof OpenClawPluginCommandDefinition>(
    field: K,
    value: OpenClawPluginCommandDefinition[K] | undefined,
  ) => {
    if (value !== undefined) {
      snapshot[field] = value;
    }
  };
  for (const field of ["acceptsArgs", "requireAuth", "exposeSenderIsOwner"] as const) {
    const value = readCommandField(command, field);
    if (!value.ok) {
      return value;
    }
    setKnownField(field, value.value as OpenClawPluginCommandDefinition[typeof field]);
  }
  const arrayFields = [
    ["channels", "Command channels"],
    ["requiredScopes", "Command requiredScopes"],
  ] as const;
  for (const [field, label] of arrayFields) {
    const value = copyOptionalArrayField(command, field, label);
    if (!value.ok) {
      return value;
    }
    setKnownField(field, value.value as OpenClawPluginCommandDefinition[typeof field]);
  }
  const recordFields = [
    ["nativeNames", "Command nativeNames"],
    ["nativeProgressMessages", "Command nativeProgressMessages"],
    ["descriptionLocalizations", "Command descriptionLocalizations"],
  ] as const;
  for (const [field, label] of recordFields) {
    const value = copyOptionalRecordField(command, field, label);
    if (!value.ok) {
      return value;
    }
    setKnownField(field, value.value as OpenClawPluginCommandDefinition[typeof field]);
  }
  const agentPromptGuidance = copyAgentPromptGuidance(command);
  if (!agentPromptGuidance.ok) {
    return agentPromptGuidance;
  }
  setKnownField("agentPromptGuidance", agentPromptGuidance.value);
  setKnownField("ownership", ownership.value as OpenClawPluginCommandDefinition["ownership"]);
  return { ok: true, command: snapshot };
}

function validateAgentPromptGuidance(index: number, guidance: AgentPromptGuidance): string | null {
  const label = `Agent prompt guidance ${index + 1}`;
  if (typeof guidance === "string") {
    return guidance.trim() ? null : `${label} cannot be empty`;
  }
  if (!isRecord(guidance)) {
    return `${label} must be a string or object`;
  }
  if (typeof guidance.text !== "string") {
    return `${label} text must be a string`;
  }
  if (!guidance.text.trim()) {
    return `${label} text cannot be empty`;
  }
  if (guidance.surfaces === undefined) {
    return null;
  }
  if (!Array.isArray(guidance.surfaces)) {
    return `${label} surfaces must be an array of prompt surface ids`;
  }
  if (guidance.surfaces.length === 0) {
    return `${label} surfaces cannot be empty`;
  }
  for (const [surfaceIndex, surface] of guidance.surfaces.entries()) {
    const normalizedSurface = typeof surface === "string" ? surface.trim() : "";
    if (!getAgentPromptSurfaces().has(normalizedSurface)) {
      const surfaces = AGENT_PROMPT_SURFACE_KINDS.join(", ");
      return `${label} surface ${surfaceIndex + 1} must be one of: ${surfaces}`;
    }
  }
  return null;
}

function normalizeAgentPromptGuidance(
  guidance: readonly AgentPromptGuidance[] | undefined,
): AgentPromptGuidance[] | undefined {
  if (!guidance) {
    return undefined;
  }
  return guidance.map((entry) => {
    if (typeof entry === "string") {
      return entry.trim();
    }
    const normalized: AgentPromptGuidanceEntry = {
      text: entry.text.trim(),
    };
    if (entry.surfaces) {
      normalized.surfaces = entry.surfaces.map((surface) =>
        normalizeAgentPromptSurfaceKind(surface.trim() as AgentPromptSurfaceKind),
      );
    }
    return normalized;
  });
}

export function listPluginInvocationKeys(command: OpenClawPluginCommandDefinition): string[] {
  const keys = new Set<string>();
  const push = (value: string | undefined) => {
    const normalized = normalizeOptionalLowercaseString(value);
    if (!normalized) {
      return;
    }
    keys.add(`/${normalized}`);
  };

  const name = readCommandField(command, "name");
  if (name.ok && typeof name.value === "string") {
    push(name.value);
  }
  const nativeNames = copyOptionalRecordField(command, "nativeNames", "Command nativeNames");
  const aliases = nativeNames.ok ? nativeNames.value : undefined;
  for (const alias of Object.values(aliases ?? {})) {
    if (typeof alias === "string") {
      push(alias);
    }
  }

  return [...keys];
}

export function pluginCommandSupportsChannel(
  command: OpenClawPluginCommandDefinition,
  channel?: string,
): boolean {
  const channels = copyOptionalArrayField(command, "channels", "Command channels");
  if (!channels.ok || !channels.value || channels.value.length === 0 || !channel) {
    return true;
  }
  const normalizedChannel = normalizeLowercaseStringOrEmpty(channel);
  return channels.value.some(
    (entry) =>
      typeof entry === "string" && normalizeLowercaseStringOrEmpty(entry) === normalizedChannel,
  );
}

export function registerPluginCommand(
  pluginId: string,
  command: OpenClawPluginCommandDefinition,
  opts?: {
    pluginName?: string;
    pluginRoot?: string;
    allowReservedCommandNames?: boolean;
    allowOwnerStatusExposure?: boolean;
  },
): CommandRegistrationResult {
  // Prevent registration while commands are being processed
  if (isPluginCommandRegistryLocked()) {
    return { ok: false, error: "Cannot register commands while processing is in progress" };
  }
  const snapshot = snapshotPluginCommandDefinition(command);
  if (!snapshot.ok) {
    return { ok: false, error: snapshot.error };
  }
  if (snapshot.command.ownership === "reserved") {
    return {
      ok: false,
      error: "Reserved command ownership is only available to bundled reserved commands",
    };
  }

  const definitionError = validatePluginCommandSnapshot(snapshot.command, opts);
  if (definitionError) {
    return { ok: false, error: definitionError };
  }

  const name = snapshot.command.name.trim();
  const normalizedName = normalizeLowercaseStringOrEmpty(name);
  const description = snapshot.command.description.trim();
  const normalizedCommand: OpenClawPluginCommandDefinition = {
    name,
    description,
    handler: snapshot.command.handler,
    ...(snapshot.command.acceptsArgs !== undefined
      ? { acceptsArgs: snapshot.command.acceptsArgs }
      : {}),
    ...(snapshot.command.requireAuth !== undefined
      ? { requireAuth: snapshot.command.requireAuth }
      : {}),
    ...(snapshot.command.requiredScopes ? { requiredScopes: snapshot.command.requiredScopes } : {}),
    ...(snapshot.command.exposeSenderIsOwner !== undefined
      ? { exposeSenderIsOwner: snapshot.command.exposeSenderIsOwner }
      : {}),
    ...(snapshot.command.nativeNames ? { nativeNames: snapshot.command.nativeNames } : {}),
    ...(snapshot.command.nativeProgressMessages
      ? { nativeProgressMessages: snapshot.command.nativeProgressMessages }
      : {}),
    ...(snapshot.command.descriptionLocalizations
      ? { descriptionLocalizations: snapshot.command.descriptionLocalizations }
      : {}),
    ...(snapshot.command.channels
      ? {
          channels: snapshot.command.channels.map((channel) =>
            normalizeLowercaseStringOrEmpty(channel),
          ),
        }
      : {}),
    ...(snapshot.command.agentPromptGuidance
      ? { agentPromptGuidance: normalizeAgentPromptGuidance(snapshot.command.agentPromptGuidance) }
      : {}),
    ...(snapshot.command.ownership ? { ownership: snapshot.command.ownership } : {}),
  };
  const invocationKeys = listPluginInvocationKeys(normalizedCommand);
  const key = `/${normalizedName}`;

  // Check for duplicate registration
  for (const invocationKey of invocationKeys) {
    const existing =
      pluginCommands.get(invocationKey) ??
      Array.from(pluginCommands.values()).find((candidate) =>
        listPluginInvocationKeys(candidate).includes(invocationKey),
      );
    if (existing) {
      return {
        ok: false,
        error: `Command "${invocationKey.slice(1)}" already registered by plugin "${existing.pluginId}"`,
      };
    }
  }

  pluginCommands.set(key, {
    ...normalizedCommand,
    pluginId,
    pluginName: opts?.pluginName,
    pluginRoot: opts?.pluginRoot,
    ...(opts?.allowOwnerStatusExposure === true && normalizedCommand.exposeSenderIsOwner === true
      ? { trustedOwnerStatusExposure: true as const }
      : {}),
  });
  logVerbose(`Registered plugin command: ${key} (plugin: ${pluginId})`);
  return { ok: true };
}

export { clearPluginCommands, clearPluginCommandsForPlugin };
export type { RegisteredPluginCommand };
