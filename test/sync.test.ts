import { test } from "node:test";
import assert from "node:assert/strict";
import { sandbox, claudeGlobal, emptyOpencode, gitInit } from "./helpers.js";
import { planAll, applyPlan } from "../src/engine.js";
import { saveProjects, loadState } from "../src/state.js";
import { scanForSecrets } from "../src/secrets.js";
import type { Plan } from "../src/merge.js";
import type { ScopeKey } from "../src/types.js";
import { join } from "node:path";

async function resolveGlobal(plan: Plan): Promise<Plan> {
  const overrides = new Map<string, ScopeKey>();
  for (const a of plan.actions) if (a.needsScope) overrides.set(a.key, { kind: "global" });
  return overrides.size ? await planAll(overrides) : plan;
}

async function applyResolved(plan: Plan) {
  return applyPlan(await resolveGlobal(plan), { yes: true, allowMassDelete: false });
}

async function applyAllGlobal() {
  return applyResolved(await planAll());
}

function codexConfig(url: string): string {
  return `[mcp_servers.supabase]\nurl = "${url}"\n`;
}

async function setup(opts?: { claudeServers?: object; codexUrl?: string }) {
  const sb = sandbox();
  sb.write(
    ".claude.json",
    claudeGlobal(
      opts?.claudeServers ?? {
        "ai-memory": { type: "stdio", command: "ai-memory", args: ["mcp-bridge"] },
      },
    ),
  );
  sb.write(".config/opencode/opencode.json", emptyOpencode());
  sb.write(".codex/config.toml", codexConfig(opts?.codexUrl ?? "https://mcp.supabase.com/mcp"));
  return sb;
}

test("first run unions servers into all agents", async () => {
  const sb = await setup();
  try {
    const plan = await planAll();
    const result = await applyResolved(plan);
    assert.equal(result.errors.length, 0);
    assert.equal(result.leaks.length, 0);

    const opencode = JSON.parse(sb.read(".config/opencode/opencode.json"));
    assert.deepEqual(Object.keys(opencode.mcp).sort(), ["ai-memory", "supabase"]);

    const claude = JSON.parse(sb.read(".claude.json"));
    assert.deepEqual(Object.keys(claude.mcpServers).sort(), ["ai-memory", "supabase"]);

    const codex = sb.read(".codex/config.toml");
    assert.match(codex, /\[mcp_servers\.ai-memory\]/);
    assert.match(codex, /\[mcp_servers\.supabase\]/);
    sb.cleanup();
  } finally {
    sb.cleanup();
  }
});

test("second run is a no-op (idempotent)", async () => {
  const sb = await setup();
  try {
    await applyAllGlobal();
    const plan = await planAll();
    assert.equal(plan.actions.length, 0);
    assert.equal(plan.conflicts.length, 0);
  } finally {
    sb.cleanup();
  }
});

test("update in one agent propagates", async () => {
  const sb = await setup();
  try {
    await applyAllGlobal();
    sb.write(".codex/config.toml", codexConfig("https://mcp.supabase.com/mcp?new=1"));
    const plan = await planAll();
    const update = plan.actions.find((a) => a.name === "supabase");
    assert.equal(update?.action, "update");
    await applyResolved(plan);
    const opencode = JSON.parse(sb.read(".config/opencode/opencode.json"));
    assert.match(opencode.mcp.supabase.url, /new=1/);
  } finally {
    sb.cleanup();
  }
});

test("removal propagates to all and is tombstoned", async () => {
  const sb = await setup();
  try {
    await applyAllGlobal();
    const claude = JSON.parse(sb.read(".claude.json"));
    delete claude.mcpServers["ai-memory"];
    sb.write(".claude.json", JSON.stringify(claude, null, 2));

    const plan = await planAll();
    const remove = plan.actions.find((a) => a.name === "ai-memory");
    assert.equal(remove?.action, "remove");
    await applyResolved(plan);

    const opencode = JSON.parse(sb.read(".config/opencode/opencode.json"));
    assert.equal(opencode.mcp["ai-memory"], undefined);
    assert.doesNotMatch(sb.read(".codex/config.toml"), /ai-memory/);

    const state = await loadState();
    assert.ok(Object.values(state.tombstones).some((t) => t.name === "ai-memory"));

    const reAdded = JSON.parse(sb.read(".claude.json"));
    reAdded.mcpServers["ai-memory"] = { type: "stdio", command: "ai-memory" };
    sb.write(".claude.json", JSON.stringify(reAdded, null, 2));
    const plan2 = await planAll();
    assert.equal(plan2.actions.length, 0);
  } finally {
    sb.cleanup();
  }
});

test("conflict: changed in one, removed in another -> no action", async () => {
  const sb = await setup();
  try {
    await applyAllGlobal();
    sb.write(".codex/config.toml", codexConfig("https://changed.example/mcp"));
    const claude = JSON.parse(sb.read(".claude.json"));
    delete claude.mcpServers["supabase"];
    sb.write(".claude.json", JSON.stringify(claude, null, 2));

    const plan = await planAll();
    assert.equal(plan.conflicts.length, 1);
    assert.equal(plan.actions.find((a) => a.name === "supabase"), undefined);
  } finally {
    sb.cleanup();
  }
});

test("malformed config excludes the agent and does not remove", async () => {
  const sb = await setup();
  try {
    await applyAllGlobal();
    sb.write(".codex/config.toml", "this is = = not valid toml [[[");
    const plan = await planAll();
    assert.equal(plan.actions.filter((a) => a.action === "remove").length, 0);
    assert.match(sb.read(".codex/config.toml"), /not valid toml/);
  } finally {
    sb.cleanup();
  }
});

test("no secret is written to any target", async () => {
  const sb = await setup({
    claudeServers: {
      ga4: {
        type: "http",
        url: "https://ga4.example/mcp",
        headers: { Authorization: "Bearer ${GA4_TOKEN}" },
      },
    },
  });
  try {
    const plan = await planAll();
    await applyResolved(plan);
    for (const f of [
      ".config/opencode/opencode.json",
      ".claude.json",
      ".codex/config.toml",
    ]) {
      assert.equal(scanForSecrets(sb.read(f)).length, 0, f);
    }
    const opencode = JSON.parse(sb.read(".config/opencode/opencode.json"));
    assert.equal(opencode.mcp.ga4.headers.Authorization, "Bearer {env:GA4_TOKEN}");
    const codex = sb.read(".codex/config.toml");
    assert.match(codex, /bearer_token_env_var = "GA4_TOKEN"/);
  } finally {
    sb.cleanup();
  }
});

test("private server in a git-tracked file is blocked", async () => {
  const sb = await setup();
  const proj = join(sb.dir, "repo");
  gitInit(proj);
  try {
    sb.write("repo/opencode.json", emptyOpencode());
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["-C", proj, "add", "opencode.json"]);
    await saveProjects([proj]);

    const claude = JSON.parse(sb.read(".claude.json"));
    claude.projects[proj] = {
      mcpServers: { secret: { type: "http", url: "https://secret.example/mcp" } },
    };
    sb.write(".claude.json", JSON.stringify(claude, null, 2));

    const plan = await planAll();
    assert.ok(plan.blocked.some((b) => b.name === "secret"));
  } finally {
    sb.cleanup();
  }
});

test("pre-existing high-entropy values do not trip the leak check", async () => {
  const sb = sandbox();
  try {
    sb.write(
      ".claude.json",
      JSON.stringify(
        {
          userID: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef",
          mcpServers: { "ai-memory": { type: "stdio", command: "ai-memory" } },
          projects: {},
        },
        null,
        2,
      ),
    );
    sb.write(".config/opencode/opencode.json", emptyOpencode());
    sb.write(".codex/config.toml", "");
    const result = await applyAllGlobal();
    assert.deepEqual(result.leaks, []);
    assert.match(sb.read(".claude.json"), /a1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef/);
  } finally {
    sb.cleanup();
  }
});

test("rollback restores previous content", async () => {
  const sb = await setup();
  try {
    const before = sb.read(".claude.json");
    const plan = await planAll();
    const result = await applyResolved(plan);
    assert.notEqual(sb.read(".claude.json"), before);
    const { rollback } = await import("../src/engine.js");
    await rollback(result.backupTs ?? undefined);
    assert.equal(sb.read(".claude.json"), before);
  } finally {
    sb.cleanup();
  }
});
