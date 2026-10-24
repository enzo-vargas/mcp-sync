import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, exists, home, readText, writeAtomic } from "./util.js";

export type SkillTargetId = "agents" | "claude" | "opencode";

const SKILL_NAME = "mcp-sync";
const MANAGED_FILE = ".mcp-sync-managed";
const BLOCK_START = "<!-- mcp-sync:start -->";
const BLOCK_END = "<!-- mcp-sync:end -->";

export function repoRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "..");
}

export function skillSourceDir(): string {
  return path.join(repoRoot(), "skill", SKILL_NAME);
}

function skillRoots(): Record<SkillTargetId, string> {
  return {
    agents: path.join(home(), ".agents", "skills", SKILL_NAME),
    claude: path.join(home(), ".claude", "skills", SKILL_NAME),
    opencode: path.join(home(), ".config", "opencode", "skills", SKILL_NAME),
  };
}

interface RuleFile {
  agent: string;
  file: string;
  enabled: () => boolean;
}

function ruleFiles(): RuleFile[] {
  const h = home();
  return [
    {
      agent: "opencode",
      file: path.join(h, ".config", "opencode", "AGENTS.md"),
      enabled: () => exists(path.join(h, ".config", "opencode")),
    },
    {
      agent: "claude",
      file: path.join(h, ".claude", "CLAUDE.md"),
      enabled: () => exists(path.join(h, ".claude")),
    },
    {
      agent: "codex",
      file: path.join(h, ".codex", "AGENTS.md"),
      enabled: () => exists(path.join(h, ".codex")),
    },
  ];
}

export const RULE_BLOCK = `${BLOCK_START}
## MCP sync (mcp-sync)

At the start of a session, load the \`mcp-sync\` Agent Skill and run its setup and health
checkup before other work whenever the user works with MCP servers. The checkup is
read-only. Never apply MCP changes without explicit confirmation.
${BLOCK_END}`;

function resolveTargets(target: string): SkillTargetId[] {
  if (target === "all") return ["agents", "claude", "opencode"];
  if (target === "agents" || target === "claude" || target === "opencode") {
    return [target];
  }
  throw new Error(`unknown target "${target}" (use agents|claude|opencode|all)`);
}

function ownedByUs(target: string): boolean {
  let st: fsSync.Stats;
  try {
    st = fsSync.lstatSync(target);
  } catch {
    return false;
  }
  if (st.isSymbolicLink()) {
    const resolved = path.resolve(path.dirname(target), fsSync.readlinkSync(target));
    const src = skillSourceDir();
    return resolved === src || resolved.startsWith(src + path.sep);
  }
  if (st.isDirectory()) {
    return exists(path.join(target, MANAGED_FILE));
  }
  return false;
}

export interface SkillInstallResult {
  installed: string[];
  rules: string[];
  skipped: string[];
}

export async function skillInstall(opts: {
  target: string;
  copy: boolean;
  withRules: boolean;
  force: boolean;
}): Promise<SkillInstallResult> {
  const src = skillSourceDir();
  if (!exists(path.join(src, "SKILL.md"))) {
    throw new Error(`skill source not found at ${src}`);
  }
  const roots = skillRoots();
  const result: SkillInstallResult = { installed: [], rules: [], skipped: [] };

  for (const id of resolveTargets(opts.target)) {
    const dest = roots[id];
    if (exists(dest) || isSymlink(dest)) {
      if (!ownedByUs(dest) && !opts.force) {
        result.skipped.push(`${dest} (exists and is not managed by mcp-sync; use --force)`);
        continue;
      }
      await removePath(dest);
    }
    await ensureDir(path.dirname(dest));
    if (opts.copy) {
      await copyDir(src, dest);
      await fs.writeFile(path.join(dest, MANAGED_FILE), "managed by mcp-sync\n");
    } else {
      await fs.symlink(src, dest, "dir");
    }
    result.installed.push(dest);
  }

  if (opts.withRules) {
    for (const rf of ruleFiles()) {
      if (!rf.enabled()) {
        result.skipped.push(`${rf.file} (${rf.agent} not installed)`);
        continue;
      }
      const current = (await readText(rf.file)) ?? "";
      const next = upsertBlock(current, RULE_BLOCK);
      if (next !== current) await writeAtomic(rf.file, next);
      result.rules.push(rf.file);
    }
  }

  return result;
}

export async function skillUninstall(opts: {
  target: string;
  withRules: boolean;
  force: boolean;
}): Promise<{ removed: string[]; rules: string[]; skipped: string[] }> {
  const roots = skillRoots();
  const removed: string[] = [];
  const skipped: string[] = [];
  const rules: string[] = [];

  for (const id of resolveTargets(opts.target)) {
    const dest = roots[id];
    if (!exists(dest) && !isSymlink(dest)) continue;
    if (!ownedByUs(dest) && !opts.force) {
      skipped.push(`${dest} (not managed by mcp-sync; use --force)`);
      continue;
    }
    await removePath(dest);
    removed.push(dest);
  }

  if (opts.withRules) {
    for (const rf of ruleFiles()) {
      const current = await readText(rf.file);
      if (current == null) continue;
      const next = removeBlock(current);
      if (next !== current) {
        await writeAtomic(rf.file, next);
        rules.push(rf.file);
      }
    }
  }

  return { removed, rules, skipped };
}

export interface SkillStatus {
  targets: { id: SkillTargetId; path: string; mode: string }[];
  rules: { agent: string; file: string; present: boolean; enabled: boolean }[];
}

export function skillStatus(): SkillStatus {
  const roots = skillRoots();
  const targets = (Object.keys(roots) as SkillTargetId[]).map((id) => {
    const p = roots[id];
    let mode = "absent";
    if (isSymlink(p)) mode = "symlink";
    else if (exists(p)) mode = exists(path.join(p, MANAGED_FILE)) ? "copy" : "unmanaged";
    return { id, path: p, mode };
  });
  const rules = ruleFiles().map((rf) => ({
    agent: rf.agent,
    file: rf.file,
    enabled: rf.enabled(),
    present: hasBlock(fsSync.existsSync(rf.file) ? fsSync.readFileSync(rf.file, "utf8") : ""),
  }));
  return { targets, rules };
}

function isSymlink(p: string): boolean {
  try {
    return fsSync.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

async function removePath(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true });
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.cp(src, dest, { recursive: true });
}

export function upsertBlock(content: string, block: string): string {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.trim() === BLOCK_START);
  if (start !== -1) {
    const end = lines.findIndex((l, i) => i > start && l.trim() === BLOCK_END);
    if (end !== -1) {
      const before = lines.slice(0, start);
      const after = lines.slice(end + 1);
      return [...before, ...block.split("\n"), ...after].join("\n");
    }
  }
  const base = content.trimEnd();
  return (base ? base + "\n\n" : "") + block + "\n";
}

export function removeBlock(content: string): string {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.trim() === BLOCK_START);
  if (start === -1) return content;
  const end = lines.findIndex((l, i) => i > start && l.trim() === BLOCK_END);
  if (end === -1) return content;
  const before = lines.slice(0, start);
  const after = lines.slice(end + 1);
  while (before.length && before[before.length - 1]!.trim() === "") before.pop();
  while (after.length && after[0]!.trim() === "") after.shift();
  const out = [...before, ...(before.length && after.length ? [""] : []), ...after];
  return out.join("\n");
}

export function hasBlock(content: string): boolean {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.trim() === BLOCK_START);
  if (start === -1) return false;
  return lines.some((l, i) => i > start && l.trim() === BLOCK_END);
}
