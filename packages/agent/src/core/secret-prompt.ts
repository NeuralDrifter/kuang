// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading a passphrase without putting it on the screen.
 *
 * readline echoes what is typed by writing it to its `output` stream. Giving
 * it a stream that can be told to swallow writes therefore suppresses the
 * echo, without readline needing to know. The prompt itself is written
 * straight to stdout, which bypasses the muted stream, so the question is
 * visible while the answer is not.
 *
 * A passphrase left in terminal scrollback — and then in whatever records that
 * terminal keeps — would defeat the point of asking for one.
 */
import { Writable } from "node:stream";

/** A stdout proxy that can be silenced for the duration of one read. */
export class MutableOutput extends Writable {
  private muted = false;

  constructor(private readonly target: NodeJS.WritableStream) {
    super();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ): void {
    if (!this.muted) this.target.write(chunk);
    done();
  }
}

/** Reads one line; the caller supplies whatever is already reading input. */
export type ReadOneLine = () => Promise<string | undefined>;

export interface PassphraseAsker {
  (prompt: string): Promise<string | undefined>;
}

/**
 * Ask for a passphrase with the echo suppressed.
 *
 * `KUANG_PASSPHRASE` is honoured first so the feature can be driven without a
 * terminal — by a test, or by someone who would rather keep it in their own
 * secret manager than type it each time.
 */
export function passphraseAsker(
  output: MutableOutput,
  readLine: ReadOneLine,
  write: (s: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): PassphraseAsker {
  return async (prompt) => {
    const fromEnv = env.KUANG_PASSPHRASE;
    if (fromEnv) return fromEnv;

    write(prompt);
    output.setMuted(true);
    try {
      return await readLine();
    } finally {
      // Always unmute, or a thrown read leaves the terminal silent for good.
      output.setMuted(false);
      // The newline the user's Enter would have echoed, so the next line does
      // not begin on the prompt.
      write("\n");
    }
  };
}
