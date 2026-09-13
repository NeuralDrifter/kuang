// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * One place to resolve a `LocalizedText` against the active language.
 *
 * Lives in `core/` so both the tool layer and the renderers can use it —
 * `ui/` may import `core/`, never the reverse.
 */
import { DEFAULT_LANGUAGE, type Language, type LocalizedText } from "bailian-cli-core";

/** Resolve bilingual text, falling back to English if a variant is missing. */
export function localize(text: LocalizedText, language: Language): string {
  return typeof text === "string" ? text : (text[language] ?? text[DEFAULT_LANGUAGE]);
}
