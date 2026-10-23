import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentId, ScopeKey, ServerDef } from "./types.js";
import { ensureDir, exists, readText, stateDir, writeAtomic } from "./util.js";

export interface SnapshotEntry {
  scope: ScopeKey;
  name: string;
  def: ServerDef;
  agents: AgentId[];
  private: boolean;
}

export interface Tombstone {
  scope: ScopeKey;
  name: string;
  until: string;
}

export interface State {
  version: number;
  servers: Record<string, SnapshotEntry>;
  tombstones: Record<string, Tombstone>;
}

const TOMBSTONE_DAYS = 30;

export function emptyState(): State {
  return { version: 1, servers: {}, tombstones: {} };
}

function stateFile(): string {
  return path.join(stateDir(), "state.json");
}

function projectsFile(): string {
  return path.join(stateDir(), "projects.json");
}

export async function loadState(): Promise<State> {
  const text = await readText(stateFile());
  if (!text) return emptyState();
  try {
    const parsed = JSON.parse(text) as State;
    return {
      version: parsed.version ?? 1,
      servers: parsed.servers ?? {},
      tombstones: parsed.tombstones ?? {},
    };
  } catch {
    return emptyState();
  }
}

export async function saveState(state: State): Promise<void> {
  await ensureDir(stateDir());
  await writeAtomic(stateFile(), JSON.stringify(state, null, 2) + "\n");
}

export function isTombstoned(state: State, key: string): boolean {
  const t = state.tombstones[key];
  if (!t) return false;
  if (new Date(t.until).getTime() < Date.now()) return false;
  return true;
}

export function makeTombstone(
  state: State,
  scope: ScopeKey,
  name: string,
  key: string,
): void {
  const until = new Date(Date.now() + TOMBSTONE_DAYS * 86400000).toISOString();
  state.tombstones[key] = { scope, name, until };
}

export async function loadProjects(): Promise<string[]> {
  const text = await readText(projectsFile());
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as { projects?: string[] };
    return parsed.projects ?? [];
  } catch {
    return [];
  }
}

export async function saveProjects(projects: string[]): Promise<void> {
  await ensureDir(stateDir());
  const unique = [...new Set(projects.map((p) => path.resolve(p)))].sort();
  await writeAtomic(projectsFile(), JSON.stringify({ version: 1, projects: unique }, null, 2) + "\n");
}

export function projectExists(p: string): boolean {
  return exists(p);
}
