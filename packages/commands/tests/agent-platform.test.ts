// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end verification of the media path, without spending credits.
 *
 * Media generation credits are finite and do not renew, so the live response
 * handling cannot be exercised. Everything before it can: `--dry-run` makes the
 * CLI construct and print the exact request it would send, and perform no API
 * call. These tests drive the real subprocess invoker, so they cover argv
 * construction, the CLI's own parsing, and the request body — the whole chain
 * except the network.
 *
 * They spawn a process each, so they are slower than the unit tests. That is
 * the point: nothing here is mocked.
 */
import { expect, test } from "vite-plus/test";
import { fileURLToPath } from "node:url";
import { buildArgv } from "kuang-agent";
import { makeCliInvoker } from "../src/commands/agent/index.ts";

/** The product entry, resolved from this file rather than from argv. */
const CLI_ENTRY = fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url));
// The test runner does not use tsx, so its own execArgv cannot load a `.ts`
// entry. Give the child the loader explicitly.
const invoke = makeCliInvoker(CLI_ENTRY, ["--import", "tsx"]);

const TIMEOUT = 120_000;

test(
  "generate_image's argv reaches the API request with the prompt intact",
  async () => {
    const argv = buildArgv("image generate", { prompt: "a cat on mars", n: 2 });
    const result = await invoke(argv, { dryRun: true });

    expect(result.ok).toBe(true);
    const body = JSON.parse(result.stdout);

    // The prompt survives argv construction, the CLI's parser, and request
    // assembly — the only untested step is the API call itself.
    expect(JSON.stringify(body.request)).toContain("a cat on mars");
    expect(body.request.parameters.n).toBe(2);
    expect(body.path).toMatch(/generation/);
  },
  TIMEOUT,
);

test(
  "generate_video's --download path is accepted by the real command",
  async () => {
    // The hot-set tool forces this flag; if the CLI rejected it, every video
    // generation would fail at the point of spending credits.
    const argv = buildArgv("video generate", { prompt: "a cat walking", download: "./out.mp4" });
    const result = await invoke(argv, { dryRun: true });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(JSON.parse(result.stdout))).toContain("a cat walking");
  },
  TIMEOUT,
);

test(
  "text_to_speech's argv is accepted by the real command",
  async () => {
    const argv = buildArgv("speech synthesize", { text: "hello there", voice: "longxiaochun" });
    const result = await invoke(argv, { dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("hello there");
  },
  TIMEOUT,
);

test(
  "a prompt containing shell syntax survives the subprocess unchanged",
  async () => {
    // The real proof that argv arrays never become a shell string: if they did,
    // this would truncate at the semicolon or execute the substitution.
    const nasty = "a cat; echo pwned; $(whoami) && rm -rf /";
    const result = await invoke(buildArgv("image generate", { prompt: nasty }), { dryRun: true });

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.stdout).request.input.messages[0].content[0].text).toBe(nasty);
    expect(result.stdout).not.toContain("pwned\n");
  },
  TIMEOUT,
);

test(
  "an invalid flag fails as a result rather than throwing",
  async () => {
    const result = await invoke(["image", "generate", "--definitely-not-a-flag", "x"], {
      dryRun: true,
    });

    // The model must be able to read the error and correct itself.
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.stdout + result.stderr).toMatch(/flag|unknown|usage/i);
  },
  TIMEOUT,
);
