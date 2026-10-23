#!/usr/bin/env node
import process from "node:process";
import type { ServerDef, ScopeKey } from "./types.js";
import { scopeId } from "./types.js";
import { planAll, applyPlan, rollback, collectTargets } from "./engine.js";
import type { Plan } from "./merge.js";
import { summarize } from "./merge.js";
import { authChecklist, authStatus } from "./auth.js";
import { loadProjects, saveProjects, loadState, saveState } from "./state.js";
import { expandHome, rel } from "./util.js";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function scopeLabel(scope: ScopeKey): string {
  return scope.kind === "global" ? "global" : `project ${scope.path}`;
}

function describeDef(def: ServerDef): string {
  if (def.transport === "stdio") {
    const cmd = [def.command, ...(def.args ?? [])].filter(Boolean).join(" ");
    const env = def.envKeys.length ? ` env:${def.envKeys.join(",")}` : "";
    return `stdio: ${cmd}${env}`;
  }
  const auth = def.bearerEnvVar ? ` bearer:${def.bearerEnvVar}` : "";
  const hdr = def.headerKeys.length ? ` headers:${def.headerKeys.join(",")}` : "";
  return `${def.transport}: ${def.url}${auth}${hdr}`;
}

function renderPlan(plan: Plan): void {
  const { adds, updates, removes } = summarize(plan);
  const byScope = new Map<string, typeof plan.actions>();
  for (const a of plan.actions) {
    const id = scopeId(a.scope);
    if (!byScope.has(id)) byScope.set(id, []);
    byScope.get(id)!.push(a);
  }

  if (plan.actions.length === 0 && !plan.conflicts.length && !plan.blocked.length) {
    console.log("in sync — nothing to do");
    return;
  }

  for (const [id, actions] of byScope) {
    console.log(`\n[${id}]`);
    for (const a of actions) {
      const mark =
        a.action === "add" ? "+" : a.action === "update" ? "~" : a.action === "remove" ? "-" : " ";
      const priv = a.private ? " (private)" : "";
      console.log(`  ${mark} ${a.name}${priv}`);
      if (a.to) console.log(`      ${describeDef(a.to)}`);
      if (a.action === "update" && a.from)
        console.log(`      was: ${describeDef(a.from)}`);
      console.log(`      agents: ${a.agents.join(", ") || "(blocked)"}`);
    }
  }

  if (plan.conflicts.length) {
    console.log("\nconflicts (not applied, resolve with --prefer):");
    for (const c of plan.conflicts) {
      console.log(`  ! ${c.name} [${scopeId(c.scope)}] — ${c.reason}`);
      for (const d of c.details) console.log(`      ${d}`);
    }
  }

  if (plan.blocked.length) {
    console.log("\nblocked:");
    for (const b of plan.blocked) {
      console.log(`  x ${b.name} [${scopeId(b.scope)}] — ${b.reason} (${rel(b.file)})`);
    }
  }

  if (plan.notes.length) {
    console.log("\nnotes:");
    for (const n of plan.notes) console.log(`  - ${n}`);
  }

  console.log(`\nplan: +${adds} ~${updates} -${removes}`);
}

function hasDrift(plan: Plan): boolean {
  return plan.actions.length > 0 || plan.conflicts.length > 0 || plan.blocked.length > 0;
}

async function cmdPlan(): Promise<void> {
  const plan = await planAll();
  renderPlan(plan);
}

async function cmdApply(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  const plan = await planAll();
  const { adds, updates, removes } = summarize(plan);
  if (!hasDrift(plan)) {
    console.log("in sync — nothing to do");
    return;
  }
  renderPlan(plan);
  if (!flags.yes) {
    console.log("\n(dry run — re-run with --yes to apply)");
    return;
  }
  const result = await applyPlan(plan, {
    yes: true,
    allowMassDelete: Boolean(flags["allow-mass-delete"]),
  });
  console.log(`\napplied: +${adds} ~${updates} -${removes}`);
  for (const f of result.written) console.log(`  wrote ${rel(f)}`);
  if (result.backupTs) console.log(`  backup: ${rel(expandHome("~/.local/state/mcp-sync"))}/backups/${result.backupTs}`);
  if (result.leaks.length) {
    console.log("\nLEAK CHECK FAILED (nothing written for those files):");
    for (const l of result.leaks) console.log(`  ! ${l}`);
  }
  if (result.errors.length) {
    console.log("\nerrors:");
    for (const e of result.errors) console.log(`  ! ${e}`);
  }
  const steps = authChecklist(plan);
  if (steps.length) {
    console.log("\nnext: authenticate each server natively");
    for (const s of steps) console.log(`  [${s.agent}] ${s.name}: ${s.command}`);
  }
}

async function cmdStatus(): Promise<void> {
  const { statuses, notes } = authStatus();
  for (const s of statuses) console.log(`[${s.agent}] ${s.name}: ${s.status}`);
  for (const n of notes) console.log(`note: ${n}`);
}

async function cmdRollback(argv: string[]): Promise<void> {
  const { positional } = parseArgs(argv);
  const restored = await rollback(positional[0]);
  for (const f of restored) console.log(`restored ${rel(f)}`);
}

async function cmdProjects(argv: string[]): Promise<void> {
  const { positional } = parseArgs(argv);
  const sub = positional[0];
  const projects = await loadProjects();
  if (sub === "add" && positional[1]) {
    const p = expandHome(positional[1]);
    await saveProjects([...projects, p]);
    console.log(`added ${p}`);
    return;
  }
  if (sub === "rm" && positional[1]) {
    const p = expandHome(positional[1]);
    await saveProjects(projects.filter((x) => x !== p));
    console.log(`removed ${p}`);
    return;
  }
  if (sub === "suggest") {
    const suggested = suggestProjects();
    if (!suggested.length) {
      console.log("no projects found in ~/.claude.json");
      return;
    }
    for (const s of suggested) {
      if (!projects.includes(s)) console.log(`  ${s}`);
    }
    console.log("register with: mcp-sync projects add <path>");
    return;
  }
  if (projects.length === 0) {
    console.log("no projects registered (use `mcp-sync projects add <path>`)");
    return;
  }
  for (const p of projects) console.log(p);
}

function suggestProjects(): string[] {
  const file = expandHome("~/.claude.json");
  if (!existsSync(file)) return [];
  try {
    const doc = JSON.parse(readFileSync(file, "utf8"));
    return Object.keys(doc.projects ?? {});
  } catch {
    return [];
  }
}

async function cmdForget(argv: string[]): Promise<void> {
  const { positional } = parseArgs(argv);
  const name = positional[0];
  if (!name) throw new Error("usage: mcp-sync forget <name>");
  const state = await loadState();
  let removed = 0;
  for (const [key, t] of Object.entries(state.tombstones)) {
    if (t.name === name) {
      delete state.tombstones[key];
      removed++;
    }
  }
  await saveState(state);
  console.log(`cleared ${removed} tombstone(s) for "${name}"`);
}

async function cmdCheck(): Promise<void> {
  const plan = await planAll();
  if (hasDrift(plan)) {
    const { adds, updates, removes } = summarize(plan);
    console.error(`drift: +${adds} ~${updates} -${removes} (conflicts:${plan.conflicts.length}, blocked:${plan.blocked.length})`);
    process.exit(1);
  }
  console.log("in sync");
}

function usage(): void {
  console.log(`mcp-sync — reconcile MCP servers across opencode, Claude Code and Codex

Usage:
  mcp-sync plan                       show the reconcile plan (no writes)
  mcp-sync apply [--yes] [--allow-mass-delete]
  mcp-sync status                     auth status per agent
  mcp-sync rollback [timestamp]
  mcp-sync projects add|rm|ls|suggest [path]
  mcp-sync forget <name>
  mcp-sync check                      exit 1 if drift (for periodic notification)
`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "plan":
      await cmdPlan();
      break;
    case "apply":
      await cmdApply(rest);
      break;
    case "status":
      await cmdStatus();
      break;
    case "rollback":
      await cmdRollback(rest);
      break;
    case "projects":
      await cmdProjects(rest);
      break;
    case "forget":
      await cmdForget(rest);
      break;
    case "check":
      await cmdCheck();
      break;
    case "targets": {
      const { targets } = await collectTargets();
      for (const t of targets) {
        console.log(`${t.agent}\t${scopeId(t.scope)}\t${t.available() ? "on" : "off"}\t${rel(t.file)}`);
      }
      break;
    }
    default:
      usage();
      if (cmd) process.exit(1);
  }
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});