import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { AgentId, ScopeKey, ServerDef, Transport } from "./types.js";
import { expandHome, exists } from "./util.js";
import * as T from "./toml.js";
import {
  derivedHeaderEnv,
  envRef,
  extractBearerVar,
  headerValue,
  isAuthorization,
} from "./secrets.js";

export interface Target {
  agent: AgentId;
  scope: ScopeKey;
  private: boolean;
  file: string;
  available(): boolean;
  read(): ReadResult;
  render(
    current: string | null,
    ops: { set: Map<string, ServerDef>; remove: string[] },
  ): string;
}

export interface ReadResult {
  servers: Map<string, ServerDef>;
  provided?: Set<string>;
  error?: string;
}

function navigate(obj: any, path: string[], create: boolean): any {
  let cur = obj;
  for (const seg of path) {
    if (cur[seg] == null) {
      if (!create) return undefined;
      cur[seg] = {};
    }
    cur = cur[seg];
  }
  return cur;
}

function jsonTarget(
  agent: AgentId,
  scope: ScopeKey,
  isPrivate: boolean,
  file: string,
  pointer: string[],
  toDef: (raw: any) => ServerDef | null,
  toRaw: (def: ServerDef) => any,
  available: () => boolean = () => true,
): Target {
  return {
    agent,
    scope,
    private: isPrivate,
    file,
    available,
    read() {
      const text = exists(file) ? readFileSync(file, "utf8") : null;
      if (text == null) return { servers: new Map() };
      let doc: any;
      try {
        doc = JSON.parse(text);
      } catch (e) {
        return { servers: new Map(), error: `invalid JSON: ${(e as Error).message}` };
      }
      const container = navigate(doc, pointer, false) ?? {};
      const servers = new Map<string, ServerDef>();
      for (const [name, raw] of Object.entries(container)) {
        const def = toDef(raw);
        if (def) servers.set(name, def);
      }
      return { servers };
    },
    render(current, ops) {
      let doc: any = {};
      if (current != null && current.trim() !== "") {
        doc = JSON.parse(current);
      }
      const container = navigate(doc, pointer, true);
      for (const name of ops.remove) delete container[name];
      for (const [name, def] of ops.set) container[name] = toRaw(def);
      return JSON.stringify(doc, null, 2) + "\n";
    },
  };
}

export function agentTargets(projects: string[]): Target[] {
  const targets: Target[] = [];

  const opencodeGlobal = expandHome("~/.config/opencode/opencode.json");
  const claudeGlobal = expandHome("~/.claude.json");
  const codexGlobal = expandHome("~/.codex/config.toml");

  targets.push(
    jsonTarget("opencode", { kind: "global" }, false, opencodeGlobal, ["mcp"], opencodeToDef, opencodeToRaw),
    jsonTarget("claude", { kind: "global" }, false, claudeGlobal, ["mcpServers"], claudeToDef, claudeToRaw),
    codexTarget("codex", { kind: "global" }, false, codexGlobal),
  );

  for (const p of projects) {
    const scope: ScopeKey = { kind: "project", path: p };
    targets.push(
      jsonTarget("opencode", scope, false, join(p, "opencode.json"), ["mcp"], opencodeToDef, opencodeToRaw),
      jsonTarget("claude", scope, false, join(p, ".mcp.json"), ["mcpServers"], claudeToDef, claudeToRaw),
      jsonTarget(
        "claude",
        scope,
        true,
        claudeGlobal,
        ["projects", p, "mcpServers"],
        claudeToDef,
        claudeToRaw,
      ),
      codexTarget("codex", scope, false, join(p, ".codex", "config.toml"), () =>
        exists(join(p, ".codex", "config.toml")),
      ),
    );
  }

  return targets;
}

function normalizeTransport(t: unknown, hasUrl: boolean): Transport {
  if (t === "sse") return "sse";
  if (t === "http" || t === "streamable_http" || t === "streamable-http") return "http";
  if (t === "stdio" || t === "local") return "stdio";
  return hasUrl ? "http" : "stdio";
}

function opencodeToDef(raw: any): ServerDef | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.type === "remote" || raw.url) {
    const headerKeys: string[] = [];
    let bearerEnvVar: string | undefined;
    for (const [k, v] of Object.entries(raw.headers ?? {})) {
      if (isAuthorization(k)) {
        const ref = extractBearerVar(String(v));
        if (ref) bearerEnvVar = ref;
        else headerKeys.push(k);
      } else {
        headerKeys.push(k);
      }
    }
    return { transport: "http", url: String(raw.url ?? ""), envKeys: [], headerKeys, bearerEnvVar };
  }
  const cmd: string[] = Array.isArray(raw.command) ? raw.command.map(String) : [];
  return {
    transport: "stdio",
    command: cmd[0],
    args: cmd.slice(1),
    envKeys: Object.keys(raw.environment ?? {}),
    headerKeys: [],
  };
}

function opencodeToRaw(def: ServerDef): any {
  if (def.transport === "stdio") {
    const environment: Record<string, string> = {};
    for (const k of def.envKeys) environment[k] = envRef("opencode", k);
    return {
      type: "local",
      command: [def.command, ...(def.args ?? [])].filter((x) => x != null),
      ...(def.envKeys.length ? { environment } : {}),
    };
  }
  const headers: Record<string, string> = {};
  if (def.bearerEnvVar) headers["Authorization"] = headerValue("opencode", def.bearerEnvVar);
  for (const k of def.headerKeys) headers[k] = envRef("opencode", derivedHeaderEnv(k));
  return {
    type: "remote",
    url: def.url,
    ...(Object.keys(headers).length ? { headers } : {}),
  };
}

function claudeToDef(raw: any): ServerDef | null {
  if (!raw || typeof raw !== "object") return null;
  const transport = normalizeTransport(raw.type, Boolean(raw.url));
  if (transport !== "stdio") {
    const headerKeys: string[] = [];
    let bearerEnvVar: string | undefined;
    for (const [k, v] of Object.entries(raw.headers ?? {})) {
      if (isAuthorization(k)) {
        const ref = extractBearerVar(String(v));
        if (ref) bearerEnvVar = ref;
        else headerKeys.push(k);
      } else {
        headerKeys.push(k);
      }
    }
    return { transport, url: String(raw.url ?? ""), envKeys: [], headerKeys, bearerEnvVar };
  }
  return {
    transport: "stdio",
    command: raw.command != null ? String(raw.command) : undefined,
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    envKeys: Object.keys(raw.env ?? {}),
    headerKeys: [],
  };
}

function claudeToRaw(def: ServerDef): any {
  if (def.transport === "stdio") {
    const env: Record<string, string> = {};
    for (const k of def.envKeys) env[k] = envRef("claude", k);
    return {
      type: "stdio",
      command: def.command,
      args: def.args ?? [],
      ...(def.envKeys.length ? { env } : {}),
    };
  }
  const headers: Record<string, string> = {};
  if (def.bearerEnvVar) headers["Authorization"] = headerValue("claude", def.bearerEnvVar);
  for (const k of def.headerKeys) headers[k] = envRef("claude", derivedHeaderEnv(k));
  return {
    type: def.transport,
    url: def.url,
    ...(Object.keys(headers).length ? { headers } : {}),
  };
}

function codexTarget(
  agent: AgentId,
  scope: ScopeKey,
  isPrivate: boolean,
  file: string,
  available: () => boolean = () => true,
): Target {
  const base = ["mcp_servers"];
  return {
    agent,
    scope,
    private: isPrivate,
    file,
    available,
    read() {
      const text = exists(file) ? readFileSync(file, "utf8") : null;
      if (text == null) return { servers: new Map() };
      let doc: any;
      try {
        doc = parseToml(text);
      } catch (e) {
        return { servers: new Map(), error: `invalid TOML: ${(e as Error).message}` };
      }
      const servers = new Map<string, ServerDef>();
      const container = doc.mcp_servers ?? {};
      for (const [name, raw] of Object.entries(container as Record<string, any>)) {
        const def = codexToDef(raw);
        if (def) servers.set(name, def);
      }
      return { servers, provided: codexProvidedNames(doc) };
    },
    render(current, ops) {
      let text = current ?? "";
      for (const name of ops.remove) text = T.removeServer(text, base, name);
      for (const [name, def] of ops.set) {
        const block =
          def.transport === "stdio"
            ? T.renderStdioBlock(base, name, def.command ?? "", def.args ?? [], def.envKeys)
            : T.renderHttpBlock(
                base,
                name,
                def.url ?? "",
                def.bearerEnvVar,
                def.headerKeys.map((k) => [k, derivedHeaderEnv(k)] as [string, string]),
              );
        text = T.setServer(text, base, name, block);
      }
      if (text !== "" && !text.endsWith("\n")) text += "\n";
      return text;
    },
  };
}

function codexToDef(raw: any): ServerDef | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.url) {
    const headerKeys = Object.keys(raw.env_http_headers ?? {});
    return {
      transport: "http",
      url: String(raw.url),
      envKeys: [],
      headerKeys,
      bearerEnvVar: raw.bearer_token_env_var ?? undefined,
    };
  }
  const envKeys = new Set<string>([
    ...Object.keys(raw.env ?? {}),
    ...(Array.isArray(raw.env_vars) ? raw.env_vars.map(String) : []),
  ]);
  return {
    transport: "stdio",
    command: raw.command != null ? String(raw.command) : undefined,
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    envKeys: [...envKeys],
    headerKeys: [],
  };
}

// MCP names Codex already provides through plugins (e.g.
// [plugins."ai-memory@ai-memory".mcp_servers.ai-memory]). These must never be
// written into [mcp_servers] — that creates a duplicate that Codex reports as failed.
function codexProvidedNames(doc: any): Set<string> {
  const names = new Set<string>();
  const plugins = doc?.plugins;
  if (!plugins || typeof plugins !== "object") return names;
  for (const plugin of Object.values(plugins as Record<string, any>)) {
    const provided = plugin?.mcp_servers;
    if (provided && typeof provided === "object") {
      for (const name of Object.keys(provided)) names.add(name);
    }
  }
  return names;
}

