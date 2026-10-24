import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { sandbox, emptyOpencode, claudeGlobal } from "./helpers.js";

const TSX = join(process.cwd(), "node_modules", ".bin", "tsx");
const CLI = join(process.cwd(), "src", "cli.ts");

interface RunResult {
  code: number;
  out: string;
}

function run(args: string[], env: NodeJS.ProcessEnv): RunResult {
  try {
    const out = execFileSync(TSX, [CLI, ...args], { env, encoding: "utf8" });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function envFor(sb: { dir: string }): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MCP_SYNC_HOME: sb.dir,
    MCP_SYNC_STATE_DIR: join(sb.dir, "state"),
    MCP_SYNC_CONFIG_DIR: join(sb.dir, "cfg"),
  };
}

test("doctor exits 1 with needs-setup before setup, 0 after", () => {
  const sb = sandbox();
  try {
    sb.write(".claude.json", claudeGlobal({}));
    sb.write(".config/opencode/opencode.json", emptyOpencode());
    const env = envFor(sb);

    const before = run(["doctor"], env);
    assert.equal(before.code, 1);
    assert.match(before.out, /HEALTH: needs-setup/);

    const setup = run(["setup", "--defaults"], env);
    assert.equal(setup.code, 0);

    const after = run(["doctor"], env);
    assert.equal(after.code, 0);
    assert.match(after.out, /HEALTH: ok/);
    assert.match(after.out, /setup: complete/);
  } finally {
    sb.cleanup();
  }
});

test("refresh reinstalls the skill and then reports health", () => {
  const sb = sandbox();
  try {
    sb.write(".claude.json", claudeGlobal({}));
    sb.write(".config/opencode/opencode.json", emptyOpencode());
    const env = envFor(sb);
    run(["setup", "--defaults"], env);

    const refreshed = run(["refresh"], env);
    assert.equal(refreshed.code, 0);
    assert.match(refreshed.out, /skill: /);
    assert.match(refreshed.out, /mcp-sync doctor/);
  } finally {
    sb.cleanup();
  }
});
