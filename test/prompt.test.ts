import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { askChoice } from "../src/prompt.js";

function io(input: string): { input: Readable; output: Writable; text: () => string } {
  let buf = "";
  const output = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return { input: Readable.from([input]), output, text: () => buf };
}

test("askChoice prints numbered options and marks the recommended one", async () => {
  const s = io("1\n");
  const value = await askChoice("Pick one:", [
    { label: "alpha", value: "a", recommended: true },
    { label: "beta", value: "b" },
  ], s);
  assert.equal(value, "a");
  assert.match(s.text(), /\[1\] alpha  \(recommended\)/);
  assert.match(s.text(), /\[2\] beta/);
  assert.match(s.text(), /Enter = 1/);
});

test("askChoice: pressing enter selects the recommended option", async () => {
  const s = io("\n");
  const value = await askChoice("Pick one:", [
    { label: "no", value: false },
    { label: "yes", value: true, recommended: true },
  ], s);
  assert.equal(value, true);
  assert.match(s.text(), /-> yes/);
});

test("askChoice: a typed number overrides the recommendation", async () => {
  const s = io("2\n");
  const value = await askChoice("Pick one:", [
    { label: "yes", value: true, recommended: true },
    { label: "no", value: false },
  ], s);
  assert.equal(value, false);
});

test("askChoice: invalid input falls back to the recommendation", async () => {
  const s = io("zzz\n");
  const value = await askChoice("Pick one:", [
    { label: "keep", value: "keep", recommended: true },
    { label: "drop", value: "drop" },
  ], s);
  assert.equal(value, "keep");
});
