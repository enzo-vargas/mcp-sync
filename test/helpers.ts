import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export interface Sandbox {
  dir: string;
  write(rel: string, content: string): void;
  read(rel: string): string;
  exists(rel: string): boolean;
  cleanup(): void;
}

export function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "mcp-sync-test-"));
  process.env.MCP_SYNC_HOME = dir;
  process.env.MCP_SYNC_STATE_DIR = join(dir, "state");
  mkdirSync(join(dir, ".config", "opencode"), { recursive: true });
  mkdirSync(join(dir, ".codex"), { recursive: true });
  return {
    dir,
    write(rel, content) {
      const p = join(dir, rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, content);
    },
    read(rel) {
      return readFileSync(join(dir, rel), "utf8");
    },
    exists(rel) {
      return existsSync(join(dir, rel));
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function gitInit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.name", "t"], { stdio: "ignore" });
}

export function claudeGlobal(servers: object, projects: object = {}): string {
  return JSON.stringify({ mcpServers: servers, projects }, null, 2) + "\n";
}

export function emptyOpencode(): string {
  return JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2) + "\n";
}
