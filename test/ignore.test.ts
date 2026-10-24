import { test } from "node:test";
import assert from "node:assert/strict";
import { sandbox, claudeGlobal, emptyOpencode } from "./helpers.js";
import { planAll, applyPlan } from "../src/engine.js";
import { addIgnored, removeIgnored, loadPrefsFile } from "../src/prefs.js";
import { loadState, saveState } from "../src/state.js";

function setup() {
  const sb = sandbox();
  sb.write(
    ".claude.json",
    claudeGlobal({ foo: { type: "http", url: "https://a.example/mcp" } }),
  );
  sb.write(
    ".config/opencode/opencode.json",
    JSON.stringify({ mcp: { foo: { type: "remote", url: "https://b.example/mcp" } } }, null, 2),
  );
  sb.write(".codex/config.toml", "");
  return sb;
}

test("addIgnored / removeIgnored persist in config.json", async () => {
  const sb = sandbox();
  try {
    assert.deepEqual(await addIgnored("ai-memory"), ["ai-memory"]);
    await addIgnored("nekt");
    assert.deepEqual((await loadPrefsFile()).prefs.ignoredServers, ["ai-memory", "nekt"]);
    assert.deepEqual(await removeIgnored("ai-memory"), ["nekt"]);
  } finally {
    sb.cleanup();
  }
});

test("an ignored server is not synced and never conflicts", async () => {
  const sb = setup();
  try {
    // without ignore: two different defs -> conflict
    const before = await planAll();
    assert.ok(before.conflicts.some((c) => c.name === "foo"), "should conflict when not ignored");

    await addIgnored("foo");
    const plan = await planAll();
    assert.equal(plan.actions.find((a) => a.name === "foo"), undefined);
    assert.equal(plan.conflicts.find((c) => c.name === "foo"), undefined);
    assert.equal(plan.duplicates.find((d) => d.name === "foo"), undefined);
  } finally {
    sb.cleanup();
  }
});

test("an ignored server already in the snapshot is dropped, not removed", async () => {
  const sb = setup();
  try {
    // seed a snapshot entry for foo
    const state = await loadState();
    state.servers["global\u0000foo"] = {
      scope: { kind: "global" },
      name: "foo",
      def: { transport: "http", url: "https://a.example/mcp", envKeys: [], headerKeys: [] },
      agents: ["opencode", "claude", "codex"],
      private: false,
    };
    await saveState(state);

    await addIgnored("foo");
    const plan = await planAll();
    assert.equal(plan.actions.length, 0, "ignored server must not produce a removal");
    await applyPlan(plan, { yes: true, allowMassDelete: false });

    const after = await loadState();
    assert.equal(
      Object.keys(after.servers).some((k) => after.servers[k]!.name === "foo"),
      false,
      "ignored server is dropped from the snapshot",
    );
  } finally {
    sb.cleanup();
  }
});
