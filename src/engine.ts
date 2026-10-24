import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Target } from "./agents.js";
import { agentTargets } from "./agents.js";
import type { Plan } from "./merge.js";
import { buildPlan } from "./merge.js";
import type { BuildOptions } from "./merge.js";
import type { ScopeKey } from "./types.js";
import { scopeId } from "./types.js";
import type { State } from "./state.js";
import { loadState, saveState, loadProjects } from "./state.js";
import { ignoredServers } from "./prefs.js";
import { scanForSecrets } from "./secrets.js";
import {
  ensureDir,
  exists,
  Lock,
  readText,
  rel,
  stateDir,
  timestamp,
  writeAtomic,
} from "./util.js";

export interface ApplyOptions {
  yes: boolean;
  allowMassDelete: boolean;
  secretLeakCheck?: boolean;
  massDeleteThreshold?: number;
}

export interface ApplyResult {
  written: string[];
  backedUp: string[];
  leaks: string[];
  errors: string[];
  backupTs: string | null;
}

export async function collectTargets(): Promise<{ targets: Target[]; projects: string[] }> {
  const projects = await loadProjects();
  return { targets: agentTargets(projects), projects };
}

export async function planWith(opts: BuildOptions): Promise<Plan> {
  const { targets } = await collectTargets();
  const state = await loadState();
  const ignored = opts.ignored ?? (await ignoredServers());
  return buildPlan(targets, state, { ...opts, ignored });
}

function candidateKeys(plan: Plan, state: State, name: string): Set<string> {
  const candidates = new Set<string>();
  for (const [k, v] of Object.entries(state.servers)) {
    if (v.name === name) candidates.add(k);
  }
  for (const a of plan.actions) {
    if (a.name === name) candidates.add(a.key);
  }
  return candidates;
}

export async function removeServer(
  name: string,
  fromScopeId?: string,
): Promise<Plan> {
  const { targets } = await collectTargets();
  const state = await loadState();
  const ignored = await ignoredServers();
  const base = buildPlan(targets, state, { ignored });
  let filtered = [...candidateKeys(base, state, name)];
  if (fromScopeId) filtered = filtered.filter((k) => decodeKey(k).scopeId === fromScopeId);
  if (filtered.length === 0) {
    throw new Error(`no server named "${name}" found${fromScopeId ? ` in ${fromScopeId}` : ""}`);
  }
  if (filtered.length > 1) {
    throw new Error(
      `"${name}" exists in multiple scopes: ${filtered.map((k) => decodeKey(k).scopeId).join(", ")}; pass --scope`,
    );
  }
  return buildPlan(targets, state, { forceRemoveKeys: new Set(filtered), ignored });
}

export async function planAll(
  scopeOverrides?: Map<string, ScopeKey>,
): Promise<Plan> {
  return planWith({ scopeOverrides });
}

export async function repairPlan(opts: {
  forceRemoveKeys?: Set<string>;
  dropManaged?: { file: string; name: string }[];
}): Promise<Plan> {
  const { targets } = await collectTargets();
  const state = await loadState();
  const ignored = await ignoredServers();
  const base = buildPlan(targets, state, { ...opts, ignored });
  const overrides = new Map<string, ScopeKey>();
  for (const a of base.actions) {
    if (a.needsScope) overrides.set(a.key, a.observedScope ?? a.scope);
  }
  if (overrides.size === 0) return base;
  return buildPlan(targets, state, { ...opts, ignored, scopeOverrides: overrides });
}

function decodeKey(key: string): { scopeId: string; name: string } {
  const idx = key.indexOf("\u0000");
  return { scopeId: key.slice(0, idx), name: key.slice(idx + 1) };
}

export async function moveServer(
  name: string,
  to: ScopeKey,
  fromScopeId?: string,
): Promise<Plan> {
  const { targets } = await collectTargets();
  const state = await loadState();
  const ignored = await ignoredServers();
  const base = buildPlan(targets, state, { ignored });

  let filtered = [...candidateKeys(base, state, name)];
  if (fromScopeId) filtered = filtered.filter((k) => decodeKey(k).scopeId === fromScopeId);
  if (filtered.length === 0) {
    throw new Error(`no server named "${name}" found${fromScopeId ? ` in ${fromScopeId}` : ""}`);
  }

  const others = filtered.filter((k) => decodeKey(k).scopeId !== scopeId(to));
  if (others.length === 0) {
    throw new Error(`"${name}" is already in ${scopeId(to)}`);
  }
  if (others.length > 1) {
    throw new Error(
      `"${name}" exists in multiple scopes: ${others.map((k) => decodeKey(k).scopeId).join(", ")}; pass --from`,
    );
  }

  const overrides = new Map<string, ScopeKey>();
  for (const k of filtered) overrides.set(k, to);
  return buildPlan(targets, state, { scopeOverrides: overrides, ignored });
}

function backupsRoot(): string {
  return path.join(stateDir(), "backups");
}

function mangle(p: string): string {
  return p.replace(/^\/+/, "").replace(/[^A-Za-z0-9._-]/g, "_");
}

function addedLines(before: string | null, after: string): string {
  const prev = new Set((before ?? "").split("\n"));
  return after
    .split("\n")
    .filter((l) => !prev.has(l))
    .join("\n");
}

export async function applyPlan(
  plan: Plan,
  opts: ApplyOptions,
): Promise<ApplyResult> {
  const result: ApplyResult = {
    written: [],
    backedUp: [],
    leaks: [],
    errors: [],
    backupTs: null,
  };

  const pendingScope = plan.actions.filter((a) => a.needsScope);
  if (pendingScope.length > 0) {
    throw new Error(
      `new server(s) need an explicit scope: ${pendingScope.map((a) => a.name).join(", ")}. ` +
        `Pass --scope global|project[:path] (there is no default).`,
    );
  }

  const distinctRemoves = plan.actions.filter((a) => a.action === "remove").length;
  const threshold = opts.massDeleteThreshold ?? 5;
  if (
    distinctRemoves > threshold ||
    (plan.knownKeys > 0 && distinctRemoves / plan.knownKeys > 0.5 && distinctRemoves > 1)
  ) {
    if (!opts.allowMassDelete) {
      throw new Error(
        `refusing to remove ${distinctRemoves} server(s) without --allow-mass-delete`,
      );
    }
  }

  const lock = new Lock(path.join(stateDir(), "lock"));
  await ensureDir(stateDir());
  lock.acquire();
  try {
    const ts = timestamp();
    const backupDir = path.join(backupsRoot(), ts);
    const manifest: { file: string; backup: string | null }[] = [];

    for (const ops of plan.ops.values()) {
      const current = exists(ops.target.file) ? await readText(ops.target.file) : null;
      let next: string;
      try {
        next = ops.target.render(current, {
          set: ops.set,
          remove: [...ops.remove],
        });
      } catch (e) {
        result.errors.push(`${rel(ops.target.file)}: ${(e as Error).message}`);
        continue;
      }
      const leaks = opts.secretLeakCheck === false ? [] : scanForSecrets(addedLines(current, next));
      if (leaks.length) {
        result.leaks.push(
          `${rel(ops.target.file)}:${leaks[0]!.line} (${leaks[0]!.reason})`,
        );
        continue;
      }
      await ensureDir(backupDir);
      let backupPath: string | null = null;
      if (current != null) {
        backupPath = path.join(backupDir, mangle(ops.target.file));
        await fs.writeFile(backupPath, current, "utf8");
        result.backedUp.push(ops.target.file);
      }
      await writeAtomic(ops.target.file, next);
      result.written.push(ops.target.file);
      manifest.push({ file: ops.target.file, backup: backupPath });
    }

    if (result.leaks.length === 0 && result.errors.length === 0) {
      await saveState(plan.newSnapshot);
    }

    result.backupTs = ts;
    await ensureDir(backupDir);
    await writeAtomic(
      path.join(backupDir, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
  } finally {
    lock.release();
  }
  return result;
}

export async function rollback(ts?: string): Promise<string[]> {
  const root = backupsRoot();
  if (!exists(root)) throw new Error("no backups found");
  let dir = ts;
  if (!dir) {
    const entries = (await fs.readdir(root)).sort();
    dir = entries[entries.length - 1];
  }
  if (!dir) throw new Error("no backups found");
  const dirPath = path.join(root, dir);
  const manifestText = await readText(path.join(dirPath, "manifest.json"));
  if (!manifestText) throw new Error(`backup ${dir} has no manifest`);
  const manifest = JSON.parse(manifestText) as { file: string; backup: string | null }[];
  const restored: string[] = [];
  for (const entry of manifest) {
    if (entry.backup == null) {
      await fs.rm(entry.file, { force: true });
      restored.push(entry.file);
      continue;
    }
    const content = await readText(entry.backup);
    if (content == null) continue;
    await writeAtomic(entry.file, content);
    restored.push(entry.file);
  }
  return restored;
}
