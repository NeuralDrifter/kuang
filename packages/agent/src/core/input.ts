// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * Turns a stream of input lines into messages, losing none of them.
 *
 * `readline.question()` resolves with one line and drops everything else that
 * arrived in the same chunk, because nothing is listening between questions.
 * Paste a stack trace and the agent sees its first line; the rest vanish with
 * no indication that anything was lost. So this listens continuously and
 * queues instead.
 *
 * Queueing alone would trade one bug for another: a twenty-line paste would
 * become twenty separate turns, which is twenty requests billed for what the
 * user meant as one. Lines that arrive together are therefore joined into a
 * single message. A person pressing Enter pauses for hundreds of milliseconds;
 * a paste or a pipe delivers its lines in one tick. `coalesceMs` sits between
 * those, far enough below human rhythm to be invisible while typing.
 *
 * Lives in `core/` with no terminal dependency, so the behaviour that decides
 * what counts as one message is testable without a TTY.
 */

/** The part of `readline.Interface` this needs. */
export interface LineSource {
  on(event: "line", listener: (line: string) => void): unknown;
  on(event: "close", listener: () => void): unknown;
}

/** Reads the next message, or `undefined` once input has ended. */
export type MessageReader = () => Promise<string | undefined>;

export interface ReaderOptions {
  coalesceMs?: number;
  /**
   * Offered every message the moment it is complete, whatever else is
   * happening. Return true to consume it, and it is never queued.
   *
   * This is what lets a slash command run while the model is mid-turn. Those
   * are the user talking to the program rather than to the model, so making
   * them wait for a reply is backwards — `/pii off` matters most exactly when
   * a turn is in flight and you have seen something you would rather it did
   * not send next.
   */
  intercept?: (message: string) => boolean;
}

const DEFAULT_COALESCE_MS = 25;

export function createMessageReader(
  source: LineSource,
  options: ReaderOptions = {},
): MessageReader {
  const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
  /** Messages already complete and not yet taken. */
  const ready: string[] = [];
  /** Lines of the message still being assembled. */
  let pending: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  /** A `next()` call parked because there was nothing to give it. */
  let waiting: ((message: string | undefined) => void) | undefined;

  const deliver = (message: string | undefined): void => {
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(message);
      return;
    }
    if (message !== undefined) ready.push(message);
  };

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pending.length === 0) return;
    const message = pending.join("\n");
    pending = [];

    // Handled here and now, or handed on to whoever is reading.
    if (options.intercept?.(message)) return;
    deliver(message);
  };

  source.on("line", (line) => {
    pending.push(line);
    if (timer) clearTimeout(timer);
    // `unref` so a pending coalesce window never holds the process open.
    timer = setTimeout(flush, coalesceMs);
    timer.unref?.();
  });

  source.on("close", () => {
    ended = true;
    // Whatever was still being assembled is a real message; EOF is not a
    // reason to discard the last line of a piped file that lacks a newline.
    flush();
    if (waiting) deliver(undefined);
  });

  return () => {
    const queued = ready.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (ended) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      waiting = resolve;
    });
  };
}
