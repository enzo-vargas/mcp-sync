import { execFileSync, spawnSync } from "node:child_process";
import type { Plan } from "./merge.js";
import type { AgentId, ServerDef } from "./types.js";
import type { Target } from "./agents.js";
import { derivedHeaderEnv } from "./secrets.js";

export interface AuthStep {
  agent: AgentId;
  name: string;
  command: string;
}

export function authChecklist(plan: Plan): AuthStep[] {
  const steps: AuthStep[] = [];
  for (const action of plan.actions) {
    if (action.action === "remove" || !action.to) continue;
    const def = action.to;
    for (const agent of action.agents) {
      steps.push({ agent, name: action.name, command: authCommand(agent, action.name, def) });
    }
  }
  return dedupe(steps);
}

function authCommand(agent: AgentId, name: string, def: ServerDef): string {
  const envVars = requiredEnv(def);
  if (envVars.length) {
    return envVars.map((v) => `export ${v}=...`).join(" && ");
  }
  if (def.transport === "stdio") return `(stdio: no auth)`;
  switch (agent) {
    case "opencode":
      return `opencode mcp auth ${name}`;
    case "codex":
      return `codex mcp login ${name}`;
    case "claude":
      return `Claude Code: open /mcp and authenticate ${name}`;
  }
}

export function requiredEnv(def: ServerDef): string[] {
  const vars = new Set<string>(def.envKeys);
  if (def.bearerEnvVar) vars.add(def.bearerEnvVar);
  for (const h of def.headerKeys) vars.add(derivedHeaderEnv(h));
  return [...vars];
}

function dedupe(steps: AuthStep[]): AuthStep[] {
  const seen = new Set<string>();
  const out: AuthStep[] = [];
  for (const s of steps) {
    const k = `${s.agent}\u0000${s.name}\u0000${s.command}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

export type AuthKind = "oauth-cli" | "browser-manual" | "env" | "none";

export interface AuthEntry {
  agent: AgentId;
  name: string;
  kind: AuthKind;
  command: string;
  run?: { cmd: string; args: string[] };
}

export function authEntries(targets: Target[], name: string, noBrowser = false): AuthEntry[] {
  const out: AuthEntry[] = [];
  const seen = new Set<string>();
  for (const t of targets) {
    if (!t.available()) continue;
    const r = t.read();
    if (r.error) continue;
    const def = r.servers.get(name);
    if (!def) continue;
    const key = `${t.agent}\u0000${t.scope.kind === "global" ? "global" : "project"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const env = requiredEnv(def);
    if (env.length) {
      out.push({
        agent: t.agent,
        name,
        kind: "env",
        command: env.map((v) => `export ${v}=...`).join(" && "),
      });
      continue;
    }
    if (def.transport === "stdio") {
      out.push({ agent: t.agent, name, kind: "none", command: "(stdio: no auth)" });
      continue;
    }
    if (t.agent === "opencode") {
      out.push({
        agent: t.agent,
        name,
        kind: "oauth-cli",
        command: `opencode mcp auth ${name}`,
        run: { cmd: "opencode", args: ["mcp", "auth", name] },
      });
    } else if (t.agent === "codex") {
      const args = ["mcp", "login", name, ...(noBrowser ? ["--no-browser"] : [])];
      out.push({
        agent: t.agent,
        name,
        kind: "oauth-cli",
        command: `codex ${args.join(" ")}`,
        run: { cmd: "codex", args },
      });
    } else {
      out.push({
        agent: t.agent,
        name,
        kind: "browser-manual",
        command: `Claude Code: open /mcp and authenticate ${name}`,
      });
    }
  }
  return out;
}

export function runAuth(entry: AuthEntry): number {
  if (!entry.run) return -1;
  const res = spawnSync(entry.run.cmd, entry.run.args, { stdio: "inherit" });
  return res.status ?? 1;
}

export interface AuthStatus {
  agent: AgentId;
  name: string;
  status: string;
}

export function authStatus(): { statuses: AuthStatus[]; notes: string[] } {
  const statuses: AuthStatus[] = [];
  const notes: string[] = [];

  try {
    const out = execFileSync("codex", ["mcp", "list", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(out) as { name: string; auth_status?: string }[];
    for (const s of parsed) {
      statuses.push({ agent: "codex", name: s.name, status: s.auth_status ?? "unknown" });
    }
  } catch {
    notes.push("codex: not available");
  }

  try {
    const out = execFileSync("opencode", ["mcp", "auth", "list"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) statuses.push({ agent: "opencode", name: trimmed, status: "see output" });
    }
  } catch {
    notes.push("opencode: not available");
  }

  notes.push("claude: auth status is not exposed by CLI (unknown)");
  return { statuses, notes };
}
