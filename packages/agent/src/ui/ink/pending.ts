// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * A question the loop is waiting on, held where a component can answer it.
 *
 * The turn loop asks for approval by awaiting a promise. A React component
 * cannot be awaited, so something has to sit between them: the loop's request
 * becomes a value the UI can render, and the user's keystroke resolves the
 * promise the loop is parked on.
 *
 * Kept out of the components because the part worth getting right — that
 * exactly one answer is ever delivered, and that a request is never left
 * unanswered when the UI goes away — is not a rendering question.
 */

export interface Question<T> {
  /** What the UI should draw while this is outstanding. */
  readonly prompt: string;
  /** Extra detail worth showing, such as a diff. */
  readonly detail?: string;
  /** Deliver the answer. Calls after the first are ignored. */
  answer: (value: T) => void;
}

export interface Asked<T> {
  question: Question<T>;
  answered: Promise<T>;
}

/**
 * Create a question and the promise that settles when it is answered.
 *
 * `answer` is guarded because a component can re-render, and a stale handler
 * firing a second time would resolve a promise the loop had already moved past
 * — the second answer would silently apply to the *next* question instead.
 */
export function ask<T>(prompt: string, detail?: string): Asked<T> {
  let deliver: ((value: T) => void) | undefined;
  const answered = new Promise<T>((resolve) => {
    deliver = resolve;
  });

  const question: Question<T> = {
    prompt,
    detail,
    answer: (value: T) => {
      if (!deliver) return;
      const resolve = deliver;
      deliver = undefined;
      resolve(value);
    },
  };

  return { question, answered };
}
