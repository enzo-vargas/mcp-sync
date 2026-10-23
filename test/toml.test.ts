import { test } from "node:test";
import assert from "node:assert/strict";
import * as T from "../src/toml.js";

const SAMPLE = `# codex config
model = "gpt-5"

[mcp_servers.supabase]
url = "https://mcp.supabase.com/mcp?project_ref=abc"

[mcp_servers.supabase.tools.execute_sql]
approval_mode = "approve"

[projects."/tmp/proj"]
trust_level = "trusted"
`;

test("parseSections finds nested and quoted headers", () => {
  const sections = T.parseSections(SAMPLE);
  const paths = sections.map((s) => s.path.join("."));
  assert.deepEqual(paths, [
    "mcp_servers.supabase",
    "mcp_servers.supabase.tools.execute_sql",
    "projects./tmp/proj",
  ]);
});

test("setServer preserves sibling subtables and comments", () => {
  const block = T.renderHttpBlock(["mcp_servers"], "supabase", "https://new.example/mcp");
  const out = T.setServer(SAMPLE, ["mcp_servers"], "supabase", block);
  assert.match(out, /# codex config/);
  assert.match(out, /\[mcp_servers\.supabase\.tools\.execute_sql\]/);
  assert.match(out, /approval_mode = "approve"/);
  assert.match(out, /url = "https:\/\/new\.example\/mcp"/);
  assert.match(out, /\[projects\."\/tmp\/proj"\]/);
});

test("setServer inserts a new server without touching others", () => {
  const block = T.renderStdioBlock(["mcp_servers"], "nekt", "nekt", ["--serve"], ["NEKT_TOKEN"]);
  const out = T.setServer(SAMPLE, ["mcp_servers"], "nekt", block);
  assert.match(out, /\[mcp_servers\.nekt\]/);
  assert.match(out, /command = "nekt"/);
  assert.match(out, /env_vars = \["NEKT_TOKEN"\]/);
  assert.match(out, /\[mcp_servers\.supabase\.tools\.execute_sql\]/);
  assert.match(out, /\[projects\."\/tmp\/proj"\]/);
});

test("removeServer removes server and its subtables", () => {
  const out = T.removeServer(SAMPLE, ["mcp_servers"], "supabase");
  assert.doesNotMatch(out, /mcp_servers\.supabase/);
  assert.match(out, /\[projects\."\/tmp\/proj"\]/);
  assert.match(out, /# codex config/);
});

test("setServer is idempotent", () => {
  const block = T.renderHttpBlock(["mcp_servers"], "supabase", "https://mcp.supabase.com/mcp?project_ref=abc");
  const once = T.setServer(SAMPLE, ["mcp_servers"], "supabase", block);
  const twice = T.setServer(once, ["mcp_servers"], "supabase", block);
  assert.equal(once, twice);
});

test("header inside a multiline string is not treated as a section", () => {
  const doc = `note = """
[mcp_servers.fake]
"""

[mcp_servers.real]
url = "https://real"
`;
  const paths = T.parseSections(doc).map((s) => s.path.join("."));
  assert.deepEqual(paths, ["mcp_servers.real"]);
});
