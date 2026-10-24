import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./helpers.js";
import {
  skillInstall,
  skillUninstall,
  skillStatus,
  upsertBlock,
  removeBlock,
  hasBlock,
  RULE_BLOCK,
  skillSourceDir,
} from "../src/skill.js";

test("upsertBlock inserts then refreshes without duplicating", () => {
  const once = upsertBlock("# Rules\n\nkeep me\n", RULE_BLOCK);
  assert.equal(hasBlock(once), true);
  const twice = upsertBlock(once, RULE_BLOCK);
  assert.equal(twice, once);
  assert.match(twice, /keep me/);
  const updated = upsertBlock(once, RULE_BLOCK.replace("read-only", "READONLY"));
  assert.match(updated, /READONLY/);
  assert.equal(updated.split("<!-- mcp-sync:start -->").length - 1, 1);
});

test("removeBlock leaves surrounding content intact", () => {
  const withBlock = upsertBlock("# Rules\n\nkeep me\n", RULE_BLOCK);
  const removed = removeBlock(withBlock);
  assert.equal(hasBlock(removed), false);
  assert.match(removed, /keep me/);
  assert.doesNotMatch(removed, /mcp-sync:start/);
});

test("install symlinks the skill and writes the rule block", async () => {
  const sb = sandbox();
  try {
    const res = await skillInstall({ target: "agents", copy: false, withRules: true, force: false });
    const dest = join(sb.dir, ".agents/skills/mcp-sync");
    assert.ok(res.installed.includes(dest));
    assert.ok(lstatSync(dest).isSymbolicLink());
    assert.equal(existsSync(join(dest, "SKILL.md")), true);

    const agentsMd = readFileSync(join(sb.dir, ".config/opencode/AGENTS.md"), "utf8");
    assert.ok(hasBlock(agentsMd));

    const status = skillStatus();
    assert.equal(status.targets.find((t) => t.id === "agents")?.mode, "symlink");
    assert.equal(status.rules.find((r) => r.agent === "opencode")?.present, true);
  } finally {
    sb.cleanup();
  }
});

test("install --copy writes a managed copy and is idempotent", async () => {
  const sb = sandbox();
  try {
    await skillInstall({ target: "agents", copy: true, withRules: false, force: false });
    const dest = join(sb.dir, ".agents/skills/mcp-sync");
    assert.ok(!lstatSync(dest).isSymbolicLink());
    assert.equal(existsSync(join(dest, ".mcp-sync-managed")), true);
    const first = readFileSync(join(dest, "SKILL.md"), "utf8");
    await skillInstall({ target: "agents", copy: true, withRules: false, force: false });
    assert.equal(readFileSync(join(dest, "SKILL.md"), "utf8"), first);
  } finally {
    sb.cleanup();
  }
});

test("uninstall removes the skill and the rule block", async () => {
  const sb = sandbox();
  try {
    await skillInstall({ target: "agents", copy: false, withRules: true, force: false });
    const res = await skillUninstall({ target: "agents", withRules: true, force: false });
    assert.ok(res.removed.length >= 1);
    assert.equal(existsSync(join(sb.dir, ".agents/skills/mcp-sync")), false);
    const agentsMd = readFileSync(join(sb.dir, ".config/opencode/AGENTS.md"), "utf8");
    assert.equal(hasBlock(agentsMd), false);
  } finally {
    sb.cleanup();
  }
});

test("uninstall refuses to touch an unmanaged skill without --force", async () => {
  const sb = sandbox();
  try {
    const foreign = join(sb.dir, ".agents/skills/mcp-sync");
    mkdirSync(foreign, { recursive: true });
    const res = await skillUninstall({ target: "agents", withRules: false, force: false });
    assert.equal(res.removed.length, 0);
    assert.ok(res.skipped.some((s) => s.includes("not managed")));
    assert.equal(existsSync(foreign), true);

    const forced = await skillUninstall({ target: "agents", withRules: false, force: true });
    assert.equal(forced.removed.length, 1);
    assert.equal(existsSync(foreign), false);
  } finally {
    sb.cleanup();
  }
});

test("skill source ships SKILL.md and checkup script", () => {
  assert.equal(existsSync(join(skillSourceDir(), "SKILL.md")), true);
  assert.equal(existsSync(join(skillSourceDir(), "scripts/checkup.sh")), true);
});
