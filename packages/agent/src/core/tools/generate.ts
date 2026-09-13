// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * Turns a command's `FlagsDef` into a JSON Schema the model can call.
 *
 * This is why the platform surface is cheap to build: every command already
 * declares its flags with a type, a bilingual description, a value hint and an
 * optional `choices` list. That is a JSON Schema in all but name, so the
 * conversion is mechanical — and because it reads the CLI's own metadata, a
 * generated tool cannot drift from the command it calls.
 */
import { GLOBAL_FLAGS, type FlagDef, type FlagsDef, type Language } from "bailian-cli-core";
import { localize } from "../i18n.ts";

/** A generated property. Narrow on purpose — only what the models need. */
export interface JsonSchemaProperty {
  type: "string" | "number" | "boolean" | "array";
  description: string;
  enum?: readonly string[];
  items?: { type: "string" };
}

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  /** Absent rather than empty when nothing is required. */
  required?: string[];
}

/**
 * Flags every command accepts. Excluded from generated schemas: the agent
 * decides output format, timeouts and dry-run itself, and offering them to the
 * model invites it to set `--output text` and break result parsing.
 */
const GLOBAL_FLAG_NAMES = new Set(Object.keys(GLOBAL_FLAGS));

/** `maxTokens` -> `--max-tokens`. The flag key IS the parsed name upstream. */
export function toCliFlag(name: string): string {
  return "--" + name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
}

/** A switch takes no value, so the model expresses it as a boolean. */
function propertyType(flag: FlagDef): JsonSchemaProperty["type"] {
  if (flag.type === "switch") return "boolean";
  if (flag.type === "array") return "array";
  return flag.type;
}

/**
 * Keep the value hint in the description. `--size <size>` tells the model the
 * expected shape in a way the bare type cannot, and it costs a few tokens.
 */
function propertyDescription(flag: FlagDef, language: Language): string {
  const text = localize(flag.description, language);
  return flag.type === "switch" ? text : `${text} (${flag.valueHint})`;
}

/** Build the arguments schema for one command's flags. */
export function flagsToJsonSchema(flags: FlagsDef, language: Language): JsonSchemaObject {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];

  for (const [name, flag] of Object.entries(flags)) {
    if (GLOBAL_FLAG_NAMES.has(name)) continue;

    const property: JsonSchemaProperty = {
      type: propertyType(flag),
      description: propertyDescription(flag, language),
    };
    if (flag.type !== "switch" && flag.choices) property.enum = flag.choices;
    if (property.type === "array") property.items = { type: "string" };

    properties[name] = property;
    // A switch is never required: absent simply means false.
    if (flag.type !== "switch" && flag.required) required.push(name);
  }

  return required.length > 0
    ? { type: "object", properties, required }
    : { type: "object", properties };
}
