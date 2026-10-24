import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { sandbox, claudeGlobal } from "./helpers.js";
import { planAll, repairPlan, applyPlan } from "../src/engine.js";

const CODEX_BOTH = `[plugins."ai-memory@ai-memory".mcp_servers.ai-memory]
command = "ai-memory"

[mcp_servers.ai-memory]
command = "ai-memory"
args = ["mcp-bridge"]
`;

function setup() {
  const sb = sandbox();
  sb.write(
    ".claude.json",
    claudeGlobal({ "ai-memory": { type: "stdio", command: "ai-memory", args: ["mcp-bridge"] } }),
  );
  sb.write(
    ".config/opencode/opencode.json",
    JSON.stringify({ mcp: { "ai-memory": { type: "local", command: ["ai-memory", "mcp-bridge"] } } }, null, 2),
  );
  sb.write(".codex/config.toml", CODEX_BOTH);
  return sb;
}

test("detects a plugin-managed duplicate (plugin + [mcp_servers] on the same agent)", async () => {
  const sb = setup();
  try {
    const plan = await planAll();
    const dup = plan.duplicates.find((d) => d.kind === "plugin-managed" && d.name === "ai-memory");
    assert.ok(dup, "should report the plugin-managed duplicate");
    assert.deepEqual(dup!.agents, ["codex"]);
    assert.equal(dup!.files?.[0], join(sb.dir, ".codex/config.toml"));
  } finally {
    sb.cleanup();
  }
});

test("repair removes the managed entry but keeps the plugin and the other agents", async () => {
  const sb = setup();
  try {
    const plan = await repairPlan({
      dropManaged: [{ file: join(sb.dir, ".codex/config.toml"), name: "ai-memory" }],
    });
    assert.ok(plan.actions.some((a) => a.action === "remove" && a.name === "ai-memory" && a.agents.includes("codex")));
    await applyPlan(plan, { yes: true, allowMassDelete: false });

    const codex = sb.read(".codex/config.toml");
    assert.doesNotMatch(codex, /\[mcp_servers\.ai-memory\]/);
    assert.match(codex, /plugins\."ai-memory@ai-memory"/);

    const opencode = JSON.parse(sb.read(".config/opencode/opencode.json"));
    assert.ok(opencode.mcp["ai-memory"], "opencode keeps ai-memory");
    const claude = JSON.parse(sb.read(".claude.json"));
    assert.ok(claude.mcpServers["ai-memory"], "claude keeps ai-memory");
  } finally {
    sb.cleanup();
  }
});

test("after repair the duplicate is gone and the plan is clean", async () => {
  const sb = setup();
  try {
    await applyPlan(
      await repairPlan({ dropManaged: [{ file: join(sb.dir, ".codex/config.toml"), name: "ai-memory" }] }),
      { yes: true, allowMassDelete: false },
    );
    const plan = await planAll();
    assert.equal(plan.duplicates.length, 0);
    assert.equal(plan.actions.length, 0);
  } finally {
    sb.cleanup();
  }
});
