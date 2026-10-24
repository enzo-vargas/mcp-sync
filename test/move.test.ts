import { test } from "node:test";
import assert from "node:assert/strict";
import { sandbox, claudeGlobal, emptyOpencode } from "./helpers.js";
import { planAll, planWith, applyPlan, moveServer } from "../src/engine.js";
import { saveProjects } from "../src/state.js";
import type { Plan } from "../src/merge.js";
import type { ScopeKey } from "../src/types.js";
import { keyId, scopeFromId } from "../src/types.js";
import { join } from "node:path";

async function resolveGlobal(plan: Plan): Promise<Plan> {
  const overrides = new Map<string, ScopeKey>();
  for (const a of plan.actions) if (a.needsScope) overrides.set(a.key, { kind: "global" });
  return overrides.size ? await planAll(overrides) : plan;
}

async function setupGlobalFoo() {
  const sb = sandbox();
  sb.write(".claude.json", claudeGlobal({}));
  sb.write(".config/opencode/opencode.json", emptyOpencode());
  sb.write(".codex/config.toml", `[mcp_servers.foo]\nurl = "https://foo.example/mcp"\n`);
  const plan = await resolveGlobal(await planAll());
  await applyPlan(plan, { yes: true, allowMassDelete: false });
  return sb;
}

test("move relocates an already-synced server from global to a project", async () => {
  const sb = await setupGlobalFoo();
  const repo = join(sb.dir, "repo");
  try {
    sb.write("repo/opencode.json", emptyOpencode());
    await saveProjects([repo]);

    const plan = await moveServer("foo", { kind: "project", path: repo });
    assert.equal(plan.conflicts.length, 0);
    const remove = plan.actions.find((a) => a.action === "remove" && a.name === "foo");
    const add = plan.actions.find((a) => a.action === "add" && a.name === "foo");
    assert.ok(remove, "should remove from global");
    assert.ok(add, "should add to project");
    await applyPlan(plan, { yes: true, allowMassDelete: false });

    const globalOpencode = JSON.parse(sb.read(".config/opencode/opencode.json"));
    assert.equal(globalOpencode.mcp?.foo, undefined);
    const projOpencode = JSON.parse(sb.read("repo/opencode.json"));
    assert.ok(projOpencode.mcp.foo);

    const after = await planAll();
    assert.equal(after.actions.length, 0);
  } finally {
    sb.cleanup();
  }
});

test("keep-both lets the same name exist in global and project", async () => {
  const sb = await setupGlobalFoo();
  const repo = join(sb.dir, "repo");
  try {
    sb.write("repo/opencode.json", emptyOpencode());
    await saveProjects([repo]);

    // declare foo in the project too
    const proj = JSON.parse(sb.read("repo/opencode.json"));
    proj.mcp = { foo: { type: "remote", url: "https://foo.example/mcp" } };
    sb.write("repo/opencode.json", JSON.stringify(proj, null, 2));

    const plan = await planAll();
    const pending = plan.actions.find((a) => a.name === "foo" && a.needsScope);
    assert.ok(pending, "project foo is new and needs scope");
    assert.deepEqual(pending!.otherScopes, ["global"]);

    // keep-both = resolve the pending to its observed (project) scope
    const resolved = await planWith({
      scopeOverrides: new Map([[pending!.key, { kind: "project" as const, path: repo }]]),
    });
    await applyPlan(resolved, { yes: true, allowMassDelete: false });

    const globalOpencode = JSON.parse(sb.read(".config/opencode/opencode.json"));
    const projOpencode = JSON.parse(sb.read("repo/opencode.json"));
    assert.ok(globalOpencode.mcp.foo, "global keeps foo");
    assert.ok(projOpencode.mcp.foo, "project has foo");
  } finally {
    sb.cleanup();
  }
});

test("move collapses when the target already has an identical server", async () => {
  const sb = await setupGlobalFoo();
  const repo = join(sb.dir, "repo");
  try {
    sb.write(
      "repo/opencode.json",
      JSON.stringify({ mcp: { foo: { type: "remote", url: "https://foo.example/mcp" } } }, null, 2),
    );
    await saveProjects([repo]);

    const plan = await moveServer("foo", { kind: "project", path: repo });
    assert.equal(plan.conflicts.length, 0);
    assert.ok(plan.actions.some((a) => a.action === "remove" && a.name === "foo"));
    assert.equal(
      plan.actions.some((a) => a.action === "add" && a.scope.kind === "global"),
      false,
      "must not re-add globally",
    );
    await applyPlan(plan, { yes: true, allowMassDelete: false });

    const globalOpencode = JSON.parse(sb.read(".config/opencode/opencode.json"));
    assert.equal(globalOpencode.mcp?.foo, undefined);
    const projOpencode = JSON.parse(sb.read("repo/opencode.json"));
    assert.ok(projOpencode.mcp.foo);
  } finally {
    sb.cleanup();
  }
});

test("move to a scope with a different same-name server is a conflict", async () => {
  const sb = await setupGlobalFoo();
  const repo = join(sb.dir, "repo");
  try {
    sb.write(
      "repo/opencode.json",
      JSON.stringify({ mcp: { foo: { type: "remote", url: "https://OTHER.example/mcp" } } }, null, 2),
    );
    await saveProjects([repo]);
    const plan = await moveServer("foo", { kind: "project", path: repo });
    assert.equal(plan.conflicts.length, 1);
  } finally {
    sb.cleanup();
  }
});

test("move errors when the server does not exist or is already there", async () => {
  const sb = await setupGlobalFoo();
  try {
    await assert.rejects(() => moveServer("nope", { kind: "global" }), /no server named/);
    await assert.rejects(
      () => moveServer("foo", { kind: "global" }),
      /already in global/,
    );
  } finally {
    sb.cleanup();
  }
});

test("apply --scope only affects new servers, not existing ones", async () => {
  const sb = await setupGlobalFoo();
  const repo = join(sb.dir, "repo");
  try {
    sb.write("repo/opencode.json", emptyOpencode());
    await saveProjects([repo]);
    // foo is already global; asking new-server scope=project must NOT move it
    const plan = await planAll(new Map());
    const resolved = await planWith({ scopeOverrides: new Map() });
    await applyPlan(resolved, { yes: true, allowMassDelete: false });
    assert.equal(plan.actions.length, 0);
    const globalOpencode = JSON.parse(sb.read(".config/opencode/opencode.json"));
    assert.ok(globalOpencode.mcp.foo, "foo stays global");
  } finally {
    sb.cleanup();
  }
});

void keyId;
void scopeFromId;
