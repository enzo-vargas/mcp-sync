export type AgentId = "opencode" | "claude" | "codex";

export const AGENTS: AgentId[] = ["opencode", "claude", "codex"];

export type Transport = "stdio" | "http" | "sse";

export interface ServerDef {
  transport: Transport;
  url?: string;
  command?: string;
  args?: string[];
  envKeys: string[];
  headerKeys: string[];
  bearerEnvVar?: string;
}

export type ScopeKey =
  | { kind: "global" }
  | { kind: "project"; path: string };

export function scopeId(scope: ScopeKey): string {
  return scope.kind === "global" ? "global" : `project:${scope.path}`;
}

export function scopeFromId(id: string): ScopeKey {
  if (id === "global") return { kind: "global" };
  if (id.startsWith("project:")) return { kind: "project", path: id.slice("project:".length) };
  throw new Error(`invalid scope id "${id}"`);
}

export function sameScope(a: ScopeKey, b: ScopeKey): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "project" && b.kind === "project") return a.path === b.path;
  return true;
}

export interface Occurrence {
  agent: AgentId;
  scope: ScopeKey;
  name: string;
  def: ServerDef;
  private: boolean;
  file: string;
}

export function defHash(def: ServerDef): string {
  const normalized = {
    transport: def.transport,
    url: def.url ?? null,
    command: def.command ?? null,
    args: def.args ?? [],
    envKeys: [...def.envKeys].sort(),
    headerKeys: [...def.headerKeys].sort(),
    bearerEnvVar: def.bearerEnvVar ?? null,
  };
  return JSON.stringify(normalized);
}

export function defsEqual(a: ServerDef, b: ServerDef): boolean {
  return defHash(a) === defHash(b);
}

export function keyId(scope: ScopeKey, name: string): string {
  return `${scopeId(scope)}\u0000${name}`;
}
