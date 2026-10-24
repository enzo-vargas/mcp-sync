import { promises as fs } from "node:fs";
import * as path from "node:path";
import { configDir, ensureDir, readText, writeAtomic } from "./util.js";

export type NewServerScope = "ask" | "global" | "project";
export type OnScopeConflict = "ask" | "move" | "keep-both";

export interface Prefs {
  newServerScope: NewServerScope;
  onScopeConflict: OnScopeConflict;
  requireApplyConfirmation: boolean;
  secretLeakCheck: boolean;
  massDeleteThreshold: number;
  skillTargets: string[];
  rulesEnabled: boolean;
  ignoredServers: string[];
}

export interface PrefsFile {
  version: number;
  setupComplete: boolean;
  prefs: Prefs;
  [key: string]: unknown;
}

export const DEFAULT_PREFS: Prefs = {
  newServerScope: "ask",
  onScopeConflict: "ask",
  requireApplyConfirmation: true,
  secretLeakCheck: true,
  massDeleteThreshold: 5,
  skillTargets: ["agents"],
  rulesEnabled: true,
  ignoredServers: [],
};

export const PREF_KEYS: (keyof Prefs)[] = [
  "newServerScope",
  "onScopeConflict",
  "requireApplyConfirmation",
  "secretLeakCheck",
  "massDeleteThreshold",
  "skillTargets",
  "rulesEnabled",
  "ignoredServers",
];

export function prefsPath(): string {
  return path.join(configDir(), "config.json");
}

export async function loadPrefsFile(): Promise<PrefsFile> {
  const text = await readText(prefsPath());
  if (text == null || text.trim() === "") {
    return { version: 1, setupComplete: false, prefs: { ...DEFAULT_PREFS } };
  }
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    return {
      ...raw,
      version: typeof raw.version === "number" ? raw.version : 1,
      setupComplete: raw.setupComplete === true,
      prefs: { ...DEFAULT_PREFS, ...((raw.prefs as Partial<Prefs>) ?? {}) },
    };
  } catch {
    return { version: 1, setupComplete: false, prefs: { ...DEFAULT_PREFS } };
  }
}

export async function savePrefsFile(file: PrefsFile): Promise<void> {
  await ensureDir(configDir());
  await writeAtomic(prefsPath(), JSON.stringify(file, null, 2) + "\n");
}

export function isConfigured(file: PrefsFile): boolean {
  return file.setupComplete === true;
}

export function coercePref(key: string, value: string): Prefs[keyof Prefs] {
  if (!PREF_KEYS.includes(key as keyof Prefs)) {
    throw new Error(`unknown preference "${key}" (known: ${PREF_KEYS.join(", ")})`);
  }
  switch (key) {
    case "newServerScope": {
      if (value !== "ask" && value !== "global" && value !== "project") {
        throw new Error(`newServerScope must be ask|global|project`);
      }
      return value;
    }
    case "onScopeConflict": {
      if (value !== "ask" && value !== "move" && value !== "keep-both") {
        throw new Error(`onScopeConflict must be ask|move|keep-both`);
      }
      return value;
    }
    case "requireApplyConfirmation":
    case "secretLeakCheck":
    case "rulesEnabled": {
      if (value !== "true" && value !== "false") {
        throw new Error(`${key} must be true|false`);
      }
      return value === "true";
    }
    case "massDeleteThreshold": {
      const n = Number.parseInt(value, 10);
      if (!Number.isInteger(n) || n < 0) throw new Error(`massDeleteThreshold must be a non-negative integer`);
      return n;
    }
    case "skillTargets":
      return value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    case "ignoredServers":
      return value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    default:
      throw new Error(`unknown preference "${key}"`);
  }
}

export async function setPref(key: string, value: string): Promise<PrefsFile> {
  const file = await loadPrefsFile();
  (file.prefs as unknown as Record<string, unknown>)[key] = coercePref(key, value);
  await savePrefsFile(file);
  return file;
}

export async function resetPrefsDir(): Promise<void> {
  await fs.rm(configDir(), { recursive: true, force: true });
}

export async function ignoredServers(): Promise<Set<string>> {
  const file = await loadPrefsFile();
  return new Set(file.prefs.ignoredServers ?? []);
}

export async function addIgnored(name: string): Promise<string[]> {
  const file = await loadPrefsFile();
  const list = new Set(file.prefs.ignoredServers ?? []);
  list.add(name);
  file.prefs.ignoredServers = [...list];
  await savePrefsFile(file);
  return file.prefs.ignoredServers;
}

export async function removeIgnored(name: string): Promise<string[]> {
  const file = await loadPrefsFile();
  file.prefs.ignoredServers = (file.prefs.ignoredServers ?? []).filter((n) => n !== name);
  await savePrefsFile(file);
  return file.prefs.ignoredServers;
}
