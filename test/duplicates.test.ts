import { test } from "node:test";
import assert from "node:assert/strict";
import { sandbox, claudeGlobal, emptyOpencode } from "./helpers.js";
import { planAll, applyPlan, removeServer } from "../src/engine.js";
import { saveProjects } from "../src/state.js";
import type { Plan } from "../src/merge.js";
import type { ScopeKey } from "../src/types.js";
import { join } from "node:path";

async function resolveGlobal(plan: Plan): Promise<Plan> {
  const overrides = new Map<string, ScopeKey>();
  for (const a of plan.actions) if (a.needsScope) overrides.set(a.key, { kind: "global" });
  return overrides.size ? await planAll(overrides) : plan;
}

test("same name in global and project is reported as a duplicate", async () => {
  const sb = sandbox();
  const repo = join(sb.dir, "repo");
  try {
    sb.write(".claude.json", claudeGlobal({}));
    sb.write(".config/opencode/opencode.json", emptyOpencode());
    sb.write(".codex/config.toml", `[mcp_servers.supabase]\nurl = "https://global.example/mcp"\n`);
    await applyPlan(await resolveGlobal(await planAll()), { yes: true, allowMassDelete: false });

    sb.write("repo/opencode.json", emptyOpencode());
    await saveProjects([repo]);
    const proj = JSON.parse(sb.read("repo/opencode.json"));
    proj.mcp = { supabase: { type: "remote", url: "https://project.example/mcp" } };
    sb.write("repo/opencode.json", JSON.stringify(proj, null, 2));

    // keep-both: resolve the project copy to its own scope
    const base = await planAll();
    const pending = base.actions.find((a) => a.name === "supabase" && a.needsScope)!;
    const kept = await planAll(new Map([[pending.key, { kind: "project" as const, path: repo }]]));
    await applyPlan(kept, { yes: true, allowMassDelete: false });

    const plan = await planAll();
    const dup = plan.duplicates.find((d) => d.kind === "name-cross-scope" && d.name === "supabase");
    assert.ok(dup, "should report the cross-scope duplicate");
  } finally {
    sb.cleanup();
  }
});

test("same definition under different names is reported as a duplicate", async () => {
  const sb = sandbox();
  try {
    sb.write(
      ".claude.json",
      claudeGlobal({
        alpha: { type: "http", url: "https://same.example/mcp" },
        beta: { type: "http", url: "https://same.example/mcp" },
      }),
    );
    sb.write(".config/opencode/opencode.json", emptyOpencode());
    sb.write(".codex/config.toml", "");
    const plan = await planAll();
    const dup = plan.duplicates.find((d) => d.kind === "same-def-different-name");
    assert.ok(dup, "should report same-def duplicate");
    assert.match(dup!.name, /alpha/);
    assert.match(dup!.name, /beta/);
  } finally {
    sb.cleanup();
  }
});

test("removeServer drops one scoped copy of a duplicate", async () => {
  const sb = sandbox();
  const repo = join(sb.dir, "repo");
  try {
    sb.write(".claude.json", claudeGlobal({}));
    sb.write(".config/opencode/opencode.json", emptyOpencode());
    sb.write(".codex/config.toml", `[mcp_servers.supabase]\nurl = "https://global.example/mcp"\n`);
    await applyPlan(await resolveGlobal(await planAll()), { yes: true, allowMassDelete: false });

    sb.write("repo/opencode.json", emptyOpencode());
    await saveProjects([repo]);
    const proj = JSON.parse(sb.read("repo/opencode.json"));
    proj.mcp = { supabase: { type: "remote", url: "https://project.example/mcp" } };
    sb.write("repo/opencode.json", JSON.stringify(proj, null, 2));
    const base = await planAll();
    const pending = base.actions.find((a) => a.name === "supabase" && a.needsScope)!;
    await applyPlan(
      await planAll(new Map([[pending.key, { kind: "project" as const, path: repo }]])),
      { yes: true, allowMassDelete: false },
    );

    const plan = await removeServer("supabase", "global");
    await applyPlan(plan, { yes: true, allowMassDelete: false });

    const globalOpencode = JSON.parse(sb.read(".config/opencode/opencode.json"));
    assert.equal(globalOpencode.mcp?.supabase, undefined, "global copy removed");
    const projOpencode = JSON.parse(sb.read("repo/opencode.json"));
    assert.ok(projOpencode.mcp.supabase, "project copy kept");
  } finally {
    sb.cleanup();
  }
});
