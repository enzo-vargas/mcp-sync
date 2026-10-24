#!/usr/bin/env node
import process from "node:process";
import { execFileSync } from "node:child_process";
import { ask, askChoice } from "./prompt.js";
import type { ServerDef, ScopeKey } from "./types.js";
import { keyId, scopeFromId, scopeId } from "./types.js";
import type { KeyAction } from "./merge.js";
import { planAll, planWith, applyPlan, rollback, collectTargets, moveServer } from "./engine.js";
import type { Plan } from "./merge.js";
import { summarize } from "./merge.js";
import { authChecklist, authStatus } from "./auth.js";
import { loadProjects, saveProjects, loadState, saveState } from "./state.js";
import { skillInstall, skillUninstall, skillStatus, repoRoot } from "./skill.js";
import {
  DEFAULT_PREFS,
  PREF_KEYS,
  loadPrefsFile,
  savePrefsFile,
  setPref,
  prefsPath,
} from "./prefs.js";
import { expandHome, rel, stateDir, configDir } from "./util.js";
import { readFileSync, readdirSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";

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

type ConflictStrategy = "keep-both" | "move" | "cancel";

async function resolveScopes(
  pending: KeyAction[],
  flags: Record<string, string | boolean>,
): Promise<{ overrides: Map<string, ScopeKey>; skip: Set<string> }> {
  const file = await loadPrefsFile();
  const prefs = file.prefs;
  const overrides = new Map<string, ScopeKey>();
  const skip = new Set<string>();
  const tty = process.stdin.isTTY;

  const flagScope = typeof flags.scope === "string" ? parseScopeFlag(flags.scope) : null;
  const flagConflict: ConflictStrategy | null = flags["keep-both"]
    ? "keep-both"
    : flags.move
      ? "move"
      : flags.cancel
        ? "cancel"
        : null;

  const root = currentProjectRoot();
  const projects = await loadProjects();
  const choices: { label: string; scope: ScopeKey }[] = [
    { label: "global (every project)", scope: { kind: "global" } },
  ];
  for (const p of [...new Set([root, ...projects])]) {
    choices.push({ label: `project ${p}`, scope: { kind: "project", path: p } });
  }

  for (const a of pending) {
    let chosen: ScopeKey | null = flagScope;
    if (!chosen) {
      if (prefs.newServerScope === "global") chosen = { kind: "global" };
      else if (prefs.newServerScope === "project") chosen = { kind: "project", path: root };
    }

    const conflict = (a.otherScopes?.length ?? 0) > 0;
    let strategy: ConflictStrategy | null = conflict ? flagConflict : null;
    if (conflict && !strategy && prefs.onScopeConflict === "keep-both") strategy = "keep-both";
    if (conflict && !strategy && prefs.onScopeConflict === "move") strategy = "move";

    if (tty && (!chosen || (conflict && !strategy))) {
      console.log(`\nNew MCP "${a.name}" (found in ${scopeId(a.observedScope ?? a.scope)}).`);
      if (conflict) {
        strategy = await askChoice<ConflictStrategy>(
          `  It already exists in: ${a.otherScopes!.join(", ")}. What should happen?`,
          [
            { label: "keep both (leave the other one in place)", value: "keep-both", recommended: true },
            { label: "move it (remove the other, this becomes the only copy)", value: "move" },
            { label: "cancel", value: "cancel" },
          ],
        );
        if (!chosen) {
          if (strategy === "keep-both") {
            chosen = a.observedScope ?? a.scope;
          } else {
            const recScope = a.observedScope ?? a.scope;
            chosen = await askChoice<ScopeKey>(
              "  Where should it live?",
              choices.map((c) => ({
                label: c.label,
                value: c.scope,
                recommended: scopeId(c.scope) === scopeId(recScope),
              })),
            );
          }
        }
      } else {
        const recScope = a.observedScope ?? a.scope;
        const pick = await askChoice<string>(
          "  Where should it live?",
          [
            ...choices.map((c, i) => ({
              label: c.label,
              value: String(i),
              recommended: scopeId(c.scope) === scopeId(recScope),
            })),
            { label: "skip for now", value: "skip" },
          ],
        );
        if (pick === "skip") {
          skip.add(a.key);
          continue;
        }
        chosen = choices[Number.parseInt(pick, 10)]?.scope ?? null;
        if (!chosen) {
          skip.add(a.key);
          continue;
        }
      }
    }

    if (!chosen) {
      throw new Error(
        `new server "${a.name}" needs an explicit scope. ` +
          `Pass --scope global|project[:path]${conflict ? " and --keep-both|--move" : ""}.`,
      );
    }

    if (conflict && !strategy) {
      throw new Error(
        `"${a.name}" already exists in ${a.otherScopes!.join(", ")}. ` +
          `Pass --keep-both or --move (or run interactively).`,
      );
    }

    if (strategy === "cancel") {
      skip.add(a.key);
      continue;
    }
    if (strategy === "move") {
      overrides.set(a.key, chosen);
      for (const other of a.otherScopes ?? []) {
        overrides.set(keyId(scopeFromId(other), a.name), chosen);
      }
      continue;
    }
    overrides.set(a.key, chosen);
  }

  return { overrides, skip };
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
    const { overrides, skip } = await resolveScopes(pending, flags);
    plan = await planWith({ scopeOverrides: overrides, skipKeys: skip });
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
  const prefsFile = await loadPrefsFile();
  const prefs = prefsFile.prefs;
  if (!flags.yes && prefs.requireApplyConfirmation) {
    console.log("\n(dry run — re-run with --yes to apply)");
    return;
  }
  const result = await applyPlan(plan, {
    yes: true,
    allowMassDelete: Boolean(flags["allow-mass-delete"]),
    secretLeakCheck: prefs.secretLeakCheck,
    massDeleteThreshold: prefs.massDeleteThreshold,
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

async function cmdSetup(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  const file = await loadPrefsFile();

  const explicit = PREF_KEYS.some((k) => typeof flags[k] === "string");
  if (file.setupComplete && !explicit && !flags.force) {
    console.log(`already configured — ${rel(prefsPath())}`);
    console.log("use `mcp-sync config` to read, `mcp-sync config set <k> <v>` to change.");
    return;
  }

  const prefs = { ...file.prefs };
  if (explicit) {
    for (const k of PREF_KEYS) {
      const v = flags[k];
      if (typeof v === "string") {
        const { coercePref } = await import("./prefs.js");
        (prefs as unknown as Record<string, unknown>)[k] = coercePref(k, v);
      }
    }
  } else if (flags.defaults || !process.stdin.isTTY) {
    console.log("accepting recommended defaults");
  } else {
    const mode = await askChoice<"fast" | "walk">(
      "mcp-sync setup — how do you want to configure?",
      [
        { label: "accept the recommended defaults (fast)", value: "fast", recommended: true },
        { label: "walk through the preferences", value: "walk" },
      ],
    );
    if (mode === "walk") {
      prefs.newServerScope = await askChoice(
        "\nWhen you add a new MCP, what should the scope be?",
        [
          { label: "ask me every time (no default)", value: "ask", recommended: true },
          { label: "always global", value: "global" },
          { label: "always the current project", value: "project" },
        ],
      );
      prefs.requireApplyConfirmation = await askChoice(
        "\nRequire confirmation (`--yes`) before apply writes?",
        [
          { label: "yes, always confirm", value: true, recommended: true },
          { label: "no, apply directly", value: false },
        ],
      );
      prefs.secretLeakCheck = await askChoice(
        "\nScan for leaked secrets after writing?",
        [
          { label: "yes", value: true, recommended: true },
          { label: "no", value: false },
        ],
      );
      prefs.massDeleteThreshold = await askChoice(
        "\nHow many removals before requiring --allow-mass-delete?",
        [
          { label: "5 (recommended)", value: 5, recommended: true },
          { label: "3", value: 3 },
          { label: "10", value: 10 },
        ],
      );
      prefs.rulesEnabled = await askChoice(
        "\nInstall the rule snippet (session-start checkup + scope question)?",
        [
          { label: "yes", value: true, recommended: true },
          { label: "no", value: false },
        ],
      );
    }
  }

  const next = { ...file, version: 1, setupComplete: true, prefs };
  await savePrefsFile(next);
  console.log(`\nwrote ${rel(prefsPath())}`);
  for (const k of PREF_KEYS) console.log(`  ${k} = ${JSON.stringify(prefs[k])}`);

  if (prefs.rulesEnabled) {
    const target = prefs.skillTargets.join(",") || "agents";
    console.log(`\ninstalling skill (target=${target})...`);
    try {
      const res = await skillInstall({
        target,
        copy: false,
        withRules: true,
        force: false,
      });
      for (const p of res.installed) console.log(`  skill: ${rel(p)}`);
      for (const p of res.rules) console.log(`  rule: ${rel(p)}`);
    } catch (e) {
      console.log(`  skipped: ${(e as Error).message}`);
    }
  }
}

async function cmdConfig(argv: string[]): Promise<void> {
  const { positional } = parseArgs(argv);
  const sub = positional[0];
  if (sub === "path") {
    console.log(prefsPath());
    return;
  }
  if (sub === "get" && positional[1]) {
    const file = await loadPrefsFile();
    const key = positional[1];
    if (!PREF_KEYS.includes(key as keyof typeof file.prefs)) {
      throw new Error(`unknown preference "${key}"`);
    }
    console.log(JSON.stringify((file.prefs as unknown as Record<string, unknown>)[key]));
    return;
  }
  if (sub === "set" && positional[1] && positional[2] !== undefined) {
    const file = await setPref(positional[1], positional.slice(2).join(" "));
    console.log(`${positional[1]} = ${JSON.stringify((file.prefs as unknown as Record<string, unknown>)[positional[1]])}`);
    return;
  }
  const file = await loadPrefsFile();
  console.log(`# ${prefsPath()}`);
  console.log(`setupComplete = ${file.setupComplete}`);
  const defaults = DEFAULT_PREFS as unknown as Record<string, unknown>;
  for (const k of PREF_KEYS) {
    const cur = (file.prefs as unknown as Record<string, unknown>)[k];
    const changed = JSON.stringify(cur) !== JSON.stringify(defaults[k]) ? "  (changed)" : "";
    console.log(`  ${k} = ${JSON.stringify(cur)}${changed}`);
  }
}

async function cmdMove(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const name = positional[0];
  if (!name) throw new Error("usage: mcp-sync move <name> --to global|project[:path]");
  const to = typeof flags.to === "string" ? parseScopeFlag(flags.to) : null;
  if (!to) throw new Error("move requires --to global|project[:path]");

  const plan = await moveServer(name, to, typeof flags.from === "string" ? flags.from : undefined);
  if (!hasDrift(plan)) {
    console.log(`"${name}" is already in ${scopeId(to)}`);
    return;
  }
  renderPlan(plan);
  const prefs = (await loadPrefsFile()).prefs;
  const result = await applyPlan(plan, {
    yes: true,
    allowMassDelete: Boolean(flags["allow-mass-delete"]),
    secretLeakCheck: prefs.secretLeakCheck,
    massDeleteThreshold: prefs.massDeleteThreshold,
  });
  console.log(`\nmoved "${name}" to ${scopeId(to)}`);
  for (const f of result.written) console.log(`  wrote ${rel(f)}`);
  if (result.errors.length) for (const e of result.errors) console.log(`  ! ${e}`);
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

function mcpSyncVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot(), "package.json"), "utf8"));
    return String(pkg.version ?? "unknown");
  } catch {
    return "unknown";
  }
}

async function cmdDoctor(): Promise<void> {
  const problems: string[] = [];
  const ok = (s: string) => console.log(`  ${s}`);

  console.log(`mcp-sync doctor  (v${mcpSyncVersion()})`);

  console.log("\nbinary");
  ok(`path: ${process.argv[1] ?? "mcp-sync"}`);
  ok(`version: ${mcpSyncVersion()}`);

  console.log("\nconfig");
  const prefsFile = await loadPrefsFile();
  ok(`file: ${rel(prefsPath())}`);
  if (prefsFile.setupComplete) {
    ok(`setup: complete`);
    ok(`newServerScope=${prefsFile.prefs.newServerScope} onScopeConflict=${prefsFile.prefs.onScopeConflict}`);
  } else {
    ok(`setup: NOT configured — run 'mcp-sync setup'`);
    problems.push("needs-setup");
  }
  ok(`config dir: ${rel(configDir())}`);
  ok(`state dir: ${rel(stateDir())}`);
  try {
    const backups = readdirSync(join(stateDir(), "backups")).length;
    ok(`backups: ${backups}`);
  } catch {
    ok(`backups: 0`);
  }

  console.log("\nagents");
  const { targets } = await collectTargets();
  const agentStates = new Map<string, boolean>();
  for (const t of targets) {
    if (t.scope.kind === "global") agentStates.set(t.agent, t.available());
  }
  for (const [agent, on] of agentStates) ok(`${agent}: ${on ? "installed" : "not detected"}`);

  console.log("\nprojects");
  const projects = await loadProjects();
  const root = currentProjectRoot();
  ok(`registered: ${projects.length}`);
  ok(`current root: ${root}`);
  ok(`current root registered: ${projects.includes(root) ? "yes" : "no"}`);

  console.log("\nskill");
  const st = skillStatus();
  const wanted = prefsFile.prefs.skillTargets ?? ["agents"];
  let anySkill = false;
  for (const t of st.targets) {
    const label = wanted.includes(t.id) ? "" : " (not configured target)";
    ok(`[${t.id}] ${t.mode}${label}  ${rel(t.path)}`);
    if (wanted.includes(t.id) && t.mode !== "absent") anySkill = true;
  }
  if (prefsFile.setupComplete && prefsFile.prefs.rulesEnabled && !anySkill) {
    problems.push("skill-missing");
  }
  for (const r of st.rules) {
    const state = r.present ? "present" : r.enabled ? "absent" : "n/a";
    ok(`rule [${r.agent}] ${state}  ${rel(r.file)}`);
    if (prefsFile.setupComplete && prefsFile.prefs.rulesEnabled && r.enabled && !r.present) {
      problems.push(`rule-missing:${r.agent}`);
    }
  }

  console.log("\nreconcile");
  const plan = await planAll();
  const { adds, updates, removes } = summarize(plan);
  ok(`drift: +${adds} ~${updates} -${removes}`);
  ok(`conflicts: ${plan.conflicts.length}`);
  ok(`blocked: ${plan.blocked.length}`);
  if (plan.conflicts.length) problems.push("conflicts");
  if (plan.blocked.length) problems.push("blocked");
  for (const a of plan.actions.filter((a) => a.needsScope)) {
    ok(`needs scope: ${a.name} (found in ${scopeId(a.observedScope ?? a.scope)})`);
  }

  const healthy = problems.length === 0;
  console.log(`\n${healthy ? "HEALTH: ok" : `HEALTH: ${[...new Set(problems)].join(", ")}`}`);
  if (!healthy) process.exit(1);
}

async function cmdRefresh(): Promise<void> {
  const prefsFile = await loadPrefsFile();
  if (!prefsFile.setupComplete) {
    throw new Error("not set up yet — run 'mcp-sync setup' first");
  }
  const prefs = prefsFile.prefs;
  if (prefs.rulesEnabled) {
    const res = await skillInstall({
      target: prefs.skillTargets.join(",") || "agents",
      copy: false,
      withRules: true,
      force: false,
    });
    for (const p of res.installed) console.log(`skill: ${rel(p)}`);
    for (const p of res.rules) console.log(`rule: ${rel(p)}`);
    for (const s of res.skipped) console.log(`skipped: ${rel(s)}`);
  } else {
    console.log("rulesEnabled=false — skipping skill/rule refresh");
  }
  console.log("");
  await cmdDoctor();
}

function usage(): void {
  console.log(`mcp-sync — reconcile MCP servers across opencode, Claude Code and Codex

Usage:
  mcp-sync setup [--defaults] [--<pref> <value>]   onboarding (first run)
  mcp-sync config [get <k> | set <k> <v> | path]   read/change preferences
  mcp-sync plan                       show the reconcile plan (no writes)
  mcp-sync apply [--yes] [--scope global|project[:path]] [--keep-both|--move] [--allow-mass-delete]
  mcp-sync move <name> --to global|project[:path] [--from <scope>]
  mcp-sync status                     auth status per agent
  mcp-sync rollback [timestamp]
  mcp-sync projects add|rm|ls|suggest [path]
  mcp-sync forget <name>
  mcp-sync skill install|uninstall|status [--target agents|claude|opencode|all] [--copy] [--no-rules]
  mcp-sync doctor                     full read-only health report (this repo + plugin)
  mcp-sync refresh                    re-install skill/rules from prefs, then doctor
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
    case "setup":
      await cmdSetup(rest);
      break;
    case "config":
      await cmdConfig(rest);
      break;
    case "move":
      await cmdMove(rest);
      break;
    case "check":
      await cmdCheck();
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "refresh":
      await cmdRefresh();
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