import { test } from "node:test";
import assert from "node:assert/strict";
import { sandbox, claudeGlobal, emptyOpencode } from "./helpers.js";
import { agentTargets } from "../src/agents.js";
import { authEntries } from "../src/auth.js";

function withServer() {
  const sb = sandbox();
  sb.write(
    ".claude.json",
    claudeGlobal({
      foo: { type: "http", url: "https://foo.example/mcp" },
    }),
  );
  sb.write(
    ".config/opencode/opencode.json",
    JSON.stringify({ mcp: { foo: { type: "remote", url: "https://foo.example/mcp" } } }, null, 2),
  );
  sb.write(".codex/config.toml", `[mcp_servers.foo]\nurl = "https://foo.example/mcp"\n`);
  return sb;
}

test("authEntries returns a runnable command per agent for an oauth http server", () => {
  const sb = withServer();
  try {
    const entries = authEntries(agentTargets([]), "foo");
    const byAgent = Object.fromEntries(entries.map((e) => [e.agent, e]));

    assert.equal(byAgent.opencode?.kind, "oauth-cli");
    assert.deepEqual(byAgent.opencode?.run, { cmd: "opencode", args: ["mcp", "auth", "foo"] });

    assert.equal(byAgent.codex?.kind, "oauth-cli");
    assert.deepEqual(byAgent.codex?.run, { cmd: "codex", args: ["mcp", "login", "foo"] });

    assert.equal(byAgent.claude?.kind, "browser-manual");
    assert.equal(byAgent.claude?.run, undefined);
  } finally {
    sb.cleanup();
  }
});

test("authEntries adds --no-browser to codex when requested", () => {
  const sb = withServer();
  try {
    const entries = authEntries(agentTargets([]), "foo", true);
    const codex = entries.find((e) => e.agent === "codex");
    assert.deepEqual(codex?.run?.args, ["mcp", "login", "foo", "--no-browser"]);
  } finally {
    sb.cleanup();
  }
});

test("authEntries reports env vars for a secret-bearing server", () => {
  const sb = sandbox();
  try {
    sb.write(
      ".claude.json",
      claudeGlobal({
        ga4: {
          type: "http",
          url: "https://ga4.example/mcp",
          headers: { Authorization: "Bearer ${GA4_TOKEN}" },
        },
      }),
    );
    sb.write(".config/opencode/opencode.json", emptyOpencode());
    sb.write(".codex/config.toml", "");
    const entries = authEntries(agentTargets([]), "ga4");
    const claude = entries.find((e) => e.agent === "claude");
    assert.equal(claude?.kind, "env");
    assert.match(claude!.command, /GA4_TOKEN/);
  } finally {
    sb.cleanup();
  }
});

test("authEntries is empty for an unknown server", () => {
  const sb = withServer();
  try {
    assert.deepEqual(authEntries(agentTargets([]), "nope"), []);
  } finally {
    sb.cleanup();
  }
});
