// Command registration tests cover plugin-owned command definition snapshotting.
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  getPluginCommandEntrySpecsFromRegistrations,
  getPluginCommandSpecsFromRegistrations,
} from "../command-specs.js";
import { clearPluginCommands } from "../commands.js";
import { resetPluginRuntimeStateForTest } from "../runtime.js";
import { createPluginRecord } from "../status.test-helpers.js";
import type { OpenClawPluginCommandDefinition } from "../types.js";

describe("plugin command registration", () => {
  afterEach(() => {
    clearPluginCommands();
    resetPluginRuntimeStateForTest();
  });

  it("snapshots command fields before registry command projection", () => {
    let nameReads = 0;
    let descriptionReads = 0;
    let nativeNamesReads = 0;
    let descriptionLocalizationsReads = 0;
    let acceptsArgsReads = 0;
    let handlerReads = 0;
    const handler: OpenClawPluginCommandDefinition["handler"] = async () => ({
      text: "ok",
    });
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "volatile-command-plugin",
        name: "Volatile Command Plugin",
      }),
      register(api) {
        api.registerCommand({
          get name() {
            nameReads += 1;
            if (nameReads > 1) {
              throw new Error("command name getter re-read");
            }
            return " volatile ";
          },
          get description() {
            descriptionReads += 1;
            if (descriptionReads > 1) {
              throw new Error("command description getter re-read");
            }
            return " Stable command description. ";
          },
          get nativeNames() {
            nativeNamesReads += 1;
            if (nativeNamesReads > 1) {
              throw new Error("command nativeNames getter re-read");
            }
            return { default: "volatile-native" };
          },
          get descriptionLocalizations() {
            descriptionLocalizationsReads += 1;
            if (descriptionLocalizationsReads > 1) {
              throw new Error("command descriptionLocalizations getter re-read");
            }
            return { fr: "Commande stable" };
          },
          get acceptsArgs() {
            acceptsArgsReads += 1;
            if (acceptsArgsReads > 1) {
              throw new Error("command acceptsArgs getter re-read");
            }
            return true;
          },
          get handler() {
            handlerReads += 1;
            if (handlerReads > 1) {
              throw new Error("command handler getter re-read");
            }
            return handler;
          },
        } as OpenClawPluginCommandDefinition);
      },
    });

    expect(registry.registry.commands[0]?.command.name).toBe(" volatile ");
    expect(getPluginCommandEntrySpecsFromRegistrations(registry.registry.commands)).toEqual([
      {
        name: "volatile",
        description: "Stable command description.",
        acceptsArgs: true,
        nativeName: "volatile-native",
      },
    ]);
    expect(getPluginCommandSpecsFromRegistrations(registry.registry.commands)).toEqual([
      {
        name: "volatile-native",
        description: "Stable command description.",
        descriptionLocalizations: { fr: "Commande stable" },
        acceptsArgs: true,
      },
    ]);
    expect(nameReads).toBe(1);
    expect(descriptionReads).toBe(1);
    expect(nativeNamesReads).toBe(1);
    expect(descriptionLocalizationsReads).toBe(1);
    expect(acceptsArgsReads).toBe(1);
    expect(handlerReads).toBe(1);
  });
});
