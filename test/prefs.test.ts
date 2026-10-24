import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./helpers.js";
import {
  loadPrefsFile,
  savePrefsFile,
  setPref,
  coercePref,
  prefsPath,
  isConfigured,
  DEFAULT_PREFS,
} from "../src/prefs.js";

test("missing config -> not configured with defaults", async () => {
  const sb = sandbox();
  try {
    const file = await loadPrefsFile();
    assert.equal(file.setupComplete, false);
    assert.deepEqual(file.prefs, DEFAULT_PREFS);
    assert.equal(isConfigured(file), false);
  } finally {
    sb.cleanup();
  }
});

test("save + load roundtrip sets setupComplete", async () => {
  const sb = sandbox();
  try {
    const file = await loadPrefsFile();
    file.setupComplete = true;
    file.prefs.newServerScope = "global";
    await savePrefsFile(file);
    const again = await loadPrefsFile();
    assert.equal(isConfigured(again), true);
    assert.equal(again.prefs.newServerScope, "global");
  } finally {
    sb.cleanup();
  }
});

test("unknown keys are preserved across saves", async () => {
  const sb = sandbox();
  try {
    mkdirSync(join(sb.dir, ".config/mcp-sync"), { recursive: true });
    writeFileSync(
      prefsPath(),
      JSON.stringify({
        version: 1,
        setupComplete: false,
        customTop: "keepme",
        prefs: { newServerScope: "ask", customPref: 42 },
      }),
    );
    const file = await loadPrefsFile();
    assert.equal((file as Record<string, unknown>).customTop, "keepme");
    assert.equal((file.prefs as unknown as Record<string, unknown>).customPref, 42);
    file.setupComplete = true;
    await savePrefsFile(file);
    const raw = JSON.parse(readFileSync(prefsPath(), "utf8"));
    assert.equal(raw.customTop, "keepme");
    assert.equal(raw.prefs.customPref, 42);
  } finally {
    sb.cleanup();
  }
});

test("coercePref validates values", () => {
  assert.equal(coercePref("newServerScope", "global"), "global");
  assert.throws(() => coercePref("newServerScope", "nope"), /ask\|global\|project/);
  assert.equal(coercePref("onScopeConflict", "keep-both"), "keep-both");
  assert.throws(() => coercePref("onScopeConflict", "x"), /ask\|move\|keep-both/);
  assert.equal(coercePref("requireApplyConfirmation", "false"), false);
  assert.throws(() => coercePref("requireApplyConfirmation", "maybe"), /true\|false/);
  assert.equal(coercePref("massDeleteThreshold", "9"), 9);
  assert.throws(() => coercePref("massDeleteThreshold", "-1"), /non-negative/);
  assert.deepEqual(coercePref("skillTargets", "agents, claude"), ["agents", "claude"]);
  assert.throws(() => coercePref("bogus", "x"), /unknown preference/);
});

test("setPref persists a single preference", async () => {
  const sb = sandbox();
  try {
    await setPref("newServerScope", "project");
    const file = await loadPrefsFile();
    assert.equal(file.prefs.newServerScope, "project");
    assert.equal(file.setupComplete, false);
  } finally {
    sb.cleanup();
  }
});
