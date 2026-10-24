#!/usr/bin/env node
import process from "node:process";
import { execFileSync } from "node:child_process";
import * as readline from "node:readline/promises";
import type { ServerDef, ScopeKey } from "./types.js";
import { scopeId } from "./types.js";
import type { KeyAction } from "./merge.js";
import { planAll, applyPlan, rollback, collectTargets } from "./engine.js";
import type { Plan } from "./merge.js";
import { summarize } from "./merge.js";
import { authChecklist, authStatus } from "./auth.js";
import { loadProjects, saveProjects, loadState, saveState } from "./state.js";
import { skillInstall, skillUninstall, skillStatus } from "./skill.js";
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
      const q = a.needsScope ? " ?" : "";
      console.log(`  ${mark} ${a.name}${priv}${q}`);
      if (a.to) console.log(`      ${describeDef(a.to)}`);
      if (a.action === "update" && a.from)
        console.log(`      was: ${describeDef(a.from)}`);
      console.log(`      agents: ${a.agents.join(", ") || "(blocked)"}`);
      if (a.needsScope)
        console.log(`      scope: not chosen yet (found in ${scopeId(a.observedScope ?? a.scope)})`);
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

function currentProjectRoot(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.cwd();
  }
}

function parseScopeFlag(value: string): ScopeKey {
  if (value === "global") return { kind: "global" };
  if (value === "project") return { kind: "project", path: currentProjectRoot() };
  if (value.startsWith("project:")) {
    const p = value.slice("project:".length);
    return { kind: "project", path: expandHome(p || currentProjectRoot()) };
  }
  throw new Error(`invalid --scope "${value}" (use global | project | project:<path>)`);
}

async function resolveScopes(
  pending: KeyAction[],
  flags: Record<string, string | boolean>,
): Promise<Map<string, ScopeKey>> {
  const overrides = new Map<string, ScopeKey>();
  if (typeof flags.scope === "string") {
    const scope = parseScopeFlag(flags.scope);
    for (const a of pending) overrides.set(a.key, scope);
    return overrides;
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      `new server(s) need an explicit scope: ${pending.map((a) => a.name).join(", ")}. ` +
        `Pass --scope global|project[:path] (there is no default).`,
    );
  }
  const projects = await loadProjects();
  const root = currentProjectRoot();
  const choices: { label: string; scope: ScopeKey }[] = [
    { label: "global (every project)", scope: { kind: "global" } },
  ];
  for (const p of [...new Set([root, ...projects])]) {
    choices.push({ label: `project ${p}`, scope: { kind: "project", path: p } });
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const a of pending) {
      console.log(`\nNew MCP "${a.name}" (found in ${scopeId(a.observedScope ?? a.scope)}).`);
      console.log("Where should it live? There is no default — choose:");
      choices.forEach((c, i) => console.log(`  [${i + 1}] ${c.label}`));
      console.log(`  [s] skip`);
      const answer = (await rl.question("> ")).trim().toLowerCase();
      if (answer === "s" || answer === "") continue;
      const idx = Number.parseInt(answer, 10) - 1;
      const chosen = choices[idx];
      if (!chosen) {
        console.log("  invalid choice, skipping");
        continue;
      }
      overrides.set(a.key, chosen.scope);
    }
  } finally {
    rl.close();
  }
  return overrides;
}

async function cmdPlan(): Promise<void> {
  const plan = await planAll();
  renderPlan(plan);
}

async function cmdApply(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  let plan = await planAll();

  const pending = plan.actions.filter((a) => a.needsScope);
  if (flags.yes && pending.length > 0) {
    const overrides = await resolveScopes(pending, flags);
    if (overrides.size > 0) plan = await planAll(overrides);
    const still = plan.actions.filter((a) => a.needsScope);
    if (still.length > 0) {
      throw new Error(
        `new server(s) still need a scope: ${still.map((a) => a.name).join(", ")}. ` +
          `Pass --scope global|project[:path] (there is no default).`,
      );
    }
  }

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

async function cmdSkill(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const sub = positional[0];
  const target = typeof flags.target === "string" ? flags.target : "agents";
  const withRules = flags["no-rules"] ? false : true;
  const force = Boolean(flags.force);

  if (sub === "install") {
    const res = await skillInstall({
      target,
      copy: Boolean(flags.copy),
      withRules,
      force,
    });
    for (const p of res.installed) console.log(`installed skill: ${rel(p)}`);
    for (const p of res.rules) console.log(`installed rule block: ${rel(p)}`);
    for (const s of res.skipped) console.log(`skipped: ${rel(s)}`);
    if (!res.installed.length) console.log("nothing installed");
    return;
  }
  if (sub === "uninstall") {
    const res = await skillUninstall({ target, withRules, force });
    for (const p of res.removed) console.log(`removed skill: ${rel(p)}`);
    for (const p of res.rules) console.log(`removed rule block: ${rel(p)}`);
    for (const s of res.skipped) console.log(`skipped: ${rel(s)}`);
    if (!res.removed.length && !res.rules.length) console.log("nothing removed");
    return;
  }
  if (sub === "status" || sub === undefined) {
    const st = skillStatus();
    console.log("skill targets:");
    for (const t of st.targets) console.log(`  [${t.id}] ${t.mode}  ${rel(t.path)}`);
    console.log("rule blocks:");
    for (const r of st.rules) {
      const state = r.present ? "present" : r.enabled ? "absent" : "n/a (agent absent)";
      console.log(`  [${r.agent}] ${state}  ${rel(r.file)}`);
    }
    return;
  }
  throw new Error("usage: mcp-sync skill install|uninstall|status [--target agents|claude|opencode|all] [--copy] [--no-rules] [--force]");
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
  mcp-sync apply [--yes] [--scope global|project[:path]] [--allow-mass-delete]
  mcp-sync status                     auth status per agent
  mcp-sync rollback [timestamp]
  mcp-sync projects add|rm|ls|suggest [path]
  mcp-sync forget <name>
  mcp-sync skill install|uninstall|status [--target agents|claude|opencode|all] [--copy] [--no-rules]
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
    case "skill":
      await cmdSkill(rest);
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