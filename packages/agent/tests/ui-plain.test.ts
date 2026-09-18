// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vite-plus/test";
import { plainRenderer } from "../src/ui/plain.ts";

function capture(language: "en-US" | "zh-CN" = "en-US") {
  const out: string[] = [];
  return { render: plainRenderer((s) => out.push(s), language), text: () => out.join("") };
}

test("text deltas stream through unchanged", () => {
  const c = capture();
  c.render({ type: "text_delta", text: "Hello, " });
  c.render({ type: "text_delta", text: "world" });
  expect(c.text()).toContain("Hello, world");
});

test("tool calls and results are announced", () => {
  const c = capture();
  c.render({
    type: "tool_call",
    call: { id: "c1", name: "read_file", arguments: '{"path":"a.ts"}' },
  });
  c.render({ type: "tool_result", callId: "c1", ok: true, summary: "20 bytes" });
  expect(c.text()).toContain("read_file");
  expect(c.text()).toContain("20 bytes");
});

test("errors are labelled in the active language", () => {
  const en = capture("en-US");
  en.render({ type: "error", message: "network down" });
  expect(en.text()).toContain("Error");

  const zh = capture("zh-CN");
  zh.render({ type: "error", message: "network down" });
  expect(zh.text()).toContain("错误");
});

test("usage is reported at the end of a turn", () => {
  const c = capture();
  c.render({ type: "turn_end", usage: { promptTokens: 100, completionTokens: 20 } });
  expect(c.text()).toMatch(/120|100.*20/);
});

test("failed tool results render distinguishably from successes", () => {
  const failed = capture();
  failed.render({ type: "tool_result", callId: "c1", ok: false, summary: "tier refused" });

  const succeeded = capture();
  succeeded.render({ type: "tool_result", callId: "c2", ok: true, summary: "tier refused" });

  expect(failed.text()).toContain("tier refused");
  expect(succeeded.text()).toContain("tier refused");
  // Same summary text, but the ok:false rendering must not read the same as ok:true.
  expect(failed.text()).not.toBe(succeeded.text());
});

test("turn_start and tool_approval_required do not throw and produce output", () => {
  const c = capture();
  c.render({ type: "turn_start" });
  c.render({
    type: "tool_approval_required",
    call: { id: "c3", name: "write_file", arguments: '{"path":"b.ts"}' },
    preview: { summary: "write_file(b.ts)" },
  });
  expect(c.text()).toContain("write_file(b.ts)");
});

test("a file change is announced with its path and counts", () => {
  const c = capture();
  c.render({ type: "file_changed", path: "src/a.ts", diff: "+one", added: 1, removed: 0 });
  expect(c.text()).toContain("src/a.ts");
  expect(c.text()).toContain("+1");
  expect(c.text()).toContain("+one");
});
