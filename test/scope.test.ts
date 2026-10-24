import { test } from "node:test";
import assert from "node:assert/strict";
import { sandbox, claudeGlobal, emptyOpencode } from "./helpers.js";
import { planAll, applyPlan } from "../src/engine.js";
import { saveProjects } from "../src/state.js";
import { join } from "node:path";

async function setup() {
  const sb = sandbox();
  sb.write(".claude.json", claudeGlobal({}));
  sb.write(".config/opencode/opencode.json", emptyOpencode());
  sb.write(
    ".codex/config.toml",
    `[mcp_servers.foo]\nurl = "https://foo.example/mcp"\n`,
  );
  return sb;
}

test("a new server is flagged as needing an explicit scope", async () => {
  const sb = await setup();
  try {
    const plan = await planAll();
    const foo = plan.actions.find((a) => a.name === "foo");
    assert.equal(foo?.action, "add");
    assert.equal(foo?.needsScope, true);
    assert.equal(foo?.observedScope?.kind, "global");
  } finally {
    sb.cleanup();
  }
});

test("apply refuses a new server with no chosen scope", async () => {
  const sb = await setup();
  try {
    const plan = await planAll();
    await assert.rejects(
      () => applyPlan(plan, { yes: true, allowMassDelete: false }),
      /need an explicit scope/,
    );
  } finally {
    sb.cleanup();
  }
});

test("--scope global resolves a new server in place", async () => {
  const sb = await setup();
  try {
    const plan = await planAll();
    const foo = plan.actions.find((a) => a.name === "foo")!;
    const overrides = new Map([[foo.key, { kind: "global" } as const]]);
    const resolved = await planAll(overrides as Map<string, { kind: "global" }>);
    const action = resolved.actions.find((a) => a.name === "foo")!;
    assert.equal(action.needsScope, undefined);
    await applyPlan(resolved, { yes: true, allowMassDelete: false });
    const opencode = JSON.parse(sb.read(".config/opencode/opencode.json"));
    assert.ok(opencode.mcp.foo);
  } finally {
    sb.cleanup();
  }
});

test("--scope project relocates a new server from global to the project", async () => {
  const sb = await setup();
  const repo = join(sb.dir, "repo");
  try {
    sb.write("repo/opencode.json", emptyOpencode());
    await saveProjects([repo]);
    const plan = await planAll();
    const foo = plan.actions.find((a) => a.name === "foo")!;
    const overrides = new Map([[foo.key, { kind: "project" as const, path: repo }]]);
    const resolved = await planAll(overrides as Map<string, { kind: "project"; path: string }>);
    await applyPlan(resolved, { yes: true, allowMassDelete: false });

    const projOpencode = JSON.parse(sb.read("repo/opencode.json"));
    assert.ok(projOpencode.mcp.foo, "project file should have foo");
    const globalOpencode = JSON.parse(sb.read(".config/opencode/opencode.json"));
    assert.equal(globalOpencode.mcp?.foo, undefined, "global should not have foo");
  } finally {
    sb.cleanup();
  }
});

test("second run after resolution is in sync", async () => {
  const sb = await setup();
  try {
    const plan = await planAll();
    const foo = plan.actions.find((a) => a.name === "foo")!;
    const resolved = await planAll(new Map([[foo.key, { kind: "global" as const }]]));
    await applyPlan(resolved, { yes: true, allowMassDelete: false });
    const again = await planAll();
    assert.equal(again.actions.length, 0);
  } finally {
    sb.cleanup();
  }
});
