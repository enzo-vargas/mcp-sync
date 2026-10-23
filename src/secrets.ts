import type { AgentId } from "./types.js";

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}|\{env:([A-Za-z_][A-Za-z0-9_]*)\}/;

export function extractEnvRef(value: string): string | null {
  const m = value.match(ENV_REF);
  if (!m) return null;
  return m[1] ?? m[2] ?? null;
}

export function extractBearerVar(value: string): string | null {
  const trimmed = value.trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(trimmed);
  const target = bearer ? bearer[1]! : trimmed;
  return extractEnvRef(target);
}

export function isAuthorization(headerName: string): boolean {
  return headerName.trim().toLowerCase() === "authorization";
}

export function envRef(agent: AgentId, key: string): string {
  switch (agent) {
    case "opencode":
      return `{env:${key}}`;
    case "claude":
      return `\${${key}}`;
    case "codex":
      return key;
  }
}

export function headerValue(agent: AgentId, key: string): string {
  switch (agent) {
    case "opencode":
      return `Bearer {env:${key}}`;
    case "claude":
      return `Bearer \${${key}}`;
    case "codex":
      return key;
  }
}

export function derivedHeaderEnv(headerName: string): string {
  return (
    headerName
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") + "_TOKEN"
  );
}

const SECRET_PATTERNS: RegExp[] = [
  /\bAuthorization\s*[:=]\s*["']?Bearer\s+[A-Za-z0-9._\-]{16,}/i,
  /\b(?:sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9]{16,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

export interface Leak {
  line: number;
  text: string;
  reason: string;
}

export function scanForSecrets(content: string): Leak[] {
  const leaks: Leak[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const re of SECRET_PATTERNS) {
      if (re.test(line)) {
        leaks.push({ line: i + 1, text: line.trim(), reason: re.source });
        break;
      }
    }
    if (highEntropyValue(line)) {
      leaks.push({ line: i + 1, text: line.trim(), reason: "high-entropy value" });
    }
  }
  return leaks;
}

function highEntropyValue(line: string): boolean {
  const m = /[:=]\s*["']([A-Za-z0-9+/=_-]{28,})["']/.exec(line);
  if (!m) return false;
  const v = m[1]!;
  if (ENV_REF.test(v)) return false;
  if (/^https?:\/\//.test(v)) return false;
  return entropy(v) > 3.5;
}

function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}
