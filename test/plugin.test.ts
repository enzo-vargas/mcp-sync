import { test } from "node:test";
import assert from "node:assert/strict";
import { sandbox, claudeGlobal } from "./helpers.js";
import { planAll, applyPlan } from "../src/engine.js";
import { loadState, saveState } from "../src/state.js";
import type { Plan } from "../src/merge.js";
import type { ScopeKey } from "../src/types.js";

const PLUGIN_TOML = `[plugins."ai-memory@ai-memory".mcp_servers.ai-memory]
command = "ai-memory"
args = ["mcp-bridge"]
`;

async function resolveGlobal(plan: Plan): Promise<Plan> {
  const overrides = new Map<string, ScopeKey>();
  for (const a of plan.actions) if (a.needsScope) overrides.set(a.key, { kind: "global" });
  return overrides.size ? await planAll(overrides) : plan;
}

function setup() {
  const sb = sandbox();
  sb.write(
    ".claude.json",
    claudeGlobal({ "ai-memory": { type: "stdio", command: "ai-memory", args: ["mcp-bridge"] } }),
  );
  sb.write(
    ".config/opencode/opencode.json",
    JSON.stringify(
      { mcp: { "ai-memory": { type: "local", command: ["ai-memory", "mcp-bridge"] } } },
      null,
      2,
    ),
  );
  // Codex provides ai-memory via a plugin, not via [mcp_servers]
  sb.write(".codex/config.toml", PLUGIN_TOML);
  return sb;
}

test("a plugin-provided MCP is not written into [mcp_servers] on that agent", async () => {
  const sb = setup();
  try {
    const plan = await planAll();
    const add = plan.actions.find((a) => a.name === "ai-memory" && a.action === "add")!;
    assert.ok(add, "ai-memory should be synced to the other agents");
    assert.equal(add.agents.includes("codex"), false, "codex must be skipped");
    assert.deepEqual([...add.agents].sort(), ["claude", "opencode"]);
    assert.ok(plan.notes.some((n) => /provided by a plugin in codex/.test(n)));

    await applyPlan(await resolveGlobal(plan), { yes: true, allowMassDelete: false });

    assert.doesNotMatch(sb.read(".codex/config.toml"), /\[mcp_servers\.ai-memory\]/);
    assert.match(sb.read(".codex/config.toml"), /plugins\."ai-memory@ai-memory"/);

    const state = await loadState();
    const entry = Object.values(state.servers).find((s) => s.name === "ai-memory")!;
    assert.deepEqual([...entry.agents].sort(), ["claude", "opencode"], "codex excluded from snapshot");
  } finally {
    sb.cleanup();
  }
});

test("a plugin-provided MCP is not mistaken for a removal", async () => {
  const sb = setup();
  try {
    // first sync opencode + claude
    await applyPlan(await resolveGlobal(await planAll()), { yes: true, allowMassDelete: false });

    // simulate the pre-fix snapshot that wrongly included codex
    const state = await loadState();
    const key = Object.keys(state.servers).find((k) => state.servers[k]!.name === "ai-memory")!;
    state.servers[key]!.agents = ["opencode", "claude", "codex"];
    await saveState(state);

    const plan = await planAll();
    assert.equal(
      plan.actions.filter((a) => a.action === "remove" && a.name === "ai-memory").length,
      0,
      "must not propagate a removal for a plugin-provided server",
    );
  } finally {
    sb.cleanup();
  }
});
