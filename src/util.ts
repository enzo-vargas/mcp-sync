import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export function home(): string {
  return process.env.MCP_SYNC_HOME || os.homedir();
}

export function stateDir(): string {
  return (
    process.env.MCP_SYNC_STATE_DIR ||
    path.join(home(), ".local", "state", "mcp-sync")
  );
}

export function exists(p: string): boolean {
  try {
    fsSync.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export async function readText(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

export async function writeAtomic(p: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = path.join(
    path.dirname(p),
    `.${path.basename(p)}.mcp-sync.tmp.${process.pid}`,
  );
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, p);
}

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

export function expandHome(p: string): string {
  if (p.startsWith("~")) return path.join(home(), p.slice(1));
  return p;
}

export function rel(p: string): string {
  const h = home();
  return p.startsWith(h) ? "~" + p.slice(h.length) : p;
}

export class Lock {
  constructor(private file: string) {}

  acquire(): void {
    try {
      fsSync.mkdirSync(this.file);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "EEXIST") {
        throw new Error(
          `another mcp-sync process holds the lock (${rel(this.file)}). ` +
            `Remove it if stale.`,
        );
      }
      throw e;
    }
    fsSync.writeFileSync(
      path.join(this.file, "pid"),
      String(process.pid),
      "utf8",
    );
  }

  release(): void {
    try {
      fsSync.rmSync(this.file, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function isGitTracked(file: string): boolean {
  const dir = path.dirname(file);
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], {
      stdio: "ignore",
    });
  } catch {
    return false;
  }
  try {
    execFileSync("git", ["-C", dir, "ls-files", "--error-unmatch", path.basename(file)], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}
