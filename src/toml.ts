export interface TomlSection {
  path: string[];
  start: number;
  end: number;
}

interface ScanState {
  ml: false | '"""' | "'''";
  depth: number;
}

function quoteKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key)
    ? key
    : `"${key.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function renderHeader(path: string[]): string {
  return `[${path.map(quoteKey).join(".")}]`;
}

function splitDottedKey(s: string): string[] {
  const keys: string[] = [];
  let cur = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '"') {
      let j = i + 1;
      let val = "";
      while (j < s.length) {
        if (s[j] === "\\") {
          val += s[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (s[j] === '"') break;
        val += s[j];
        j++;
      }
      cur += val;
      i = j + 1;
      continue;
    }
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j === -1) {
        cur += s.slice(i + 1);
        i = s.length;
        continue;
      }
      cur += s.slice(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === ".") {
      keys.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  keys.push(cur.trim());
  return keys;
}

function parseHeaderLine(line: string): string[] | null {
  const trimmed = line.trim();
  const isArray = trimmed.startsWith("[[");
  if (!trimmed.startsWith("[")) return null;
  const close = isArray ? "]]" : "]";
  const inner = trimmed.slice(isArray ? 2 : 1);
  const end = inner.lastIndexOf(close);
  if (end === -1) return null;
  const after = inner.slice(end + close.length).trim();
  if (after !== "" && !after.startsWith("#")) return null;
  return splitDottedKey(inner.slice(0, end));
}

function advance(line: string, state: ScanState): ScanState {
  let { ml, depth } = state;
  let i = 0;
  while (i < line.length) {
    if (ml) {
      if (line.startsWith(ml, i)) {
        ml = false;
        i += 3;
        continue;
      }
      i++;
      continue;
    }
    const c = line[i]!;
    if (c === "#") break;
    if (line.startsWith('"""', i)) {
      ml = '"""';
      i += 3;
      continue;
    }
    if (line.startsWith("'''", i)) {
      ml = "'''";
      i += 3;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < line.length) {
        if (line[i] === "\\") {
          i += 2;
          continue;
        }
        if (line[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "'") {
      i++;
      while (i < line.length && line[i] !== "'") i++;
      i++;
      continue;
    }
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    i++;
  }
  return { ml, depth };
}

export function parseSections(text: string): TomlSection[] {
  const lines = text.split("\n");
  const sections: TomlSection[] = [];
  let state: ScanState = { ml: false, depth: 0 };
  let current: TomlSection | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!state.ml && state.depth === 0) {
      const path = parseHeaderLine(line);
      if (path) {
        if (current) current.end = i;
        current = { path, start: i, end: lines.length };
        sections.push(current);
        continue;
      }
    }
    state = advance(line, state);
  }
  return sections;
}

function isUnder(path: string[], base: string[]): boolean {
  if (path.length < base.length) return false;
  return base.every((seg, i) => path[i] === seg);
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

export function renderServerBlock(
  base: string[],
  name: string,
  lines: string[],
): string[] {
  const header = renderHeader([...base, name]);
  return [header, ...lines];
}

export function renderStdioBlock(
  base: string[],
  name: string,
  command: string,
  args: string[],
  envVars: string[],
): string[] {
  const body: string[] = [`command = ${tomlString(command)}`];
  if (args.length) body.push(`args = ${tomlArray(args)}`);
  if (envVars.length) body.push(`env_vars = ${tomlArray(envVars)}`);
  return renderServerBlock(base, name, body);
}

export function renderHttpBlock(
  base: string[],
  name: string,
  url: string,
  bearerEnvVar?: string,
  envHttpHeaders: [string, string][] = [],
): string[] {
  const body: string[] = [`url = ${tomlString(url)}`];
  if (bearerEnvVar) body.push(`bearer_token_env_var = ${tomlString(bearerEnvVar)}`);
  if (envHttpHeaders.length) {
    const entries = envHttpHeaders
      .map(([k, v]) => `${quoteKey(k)} = ${tomlString(v)}`)
      .join(", ");
    body.push(`env_http_headers = { ${entries} }`);
  }
  return renderServerBlock(base, name, body);
}

export function removeServer(text: string, base: string[], name: string): string {
  const lines = text.split("\n");
  const sections = parseSections(text).filter((s) =>
    isUnder(s.path, [...base, name]),
  );
  if (!sections.length) return text;
  const remove = new Set<number>();
  for (const s of sections) {
    for (let i = s.start; i < s.end; i++) remove.add(i);
  }
  const kept = lines.filter((_, i) => !remove.has(i));
  return collapseBlankRuns(kept).join("\n");
}

export function setServer(
  text: string,
  base: string[],
  name: string,
  block: string[],
): string {
  const lines = text.split("\n");
  const exact = parseSections(text).find(
    (s) =>
      s.path.length === base.length + 1 &&
      isUnder(s.path, base) &&
      s.path[base.length] === name,
  );
  if (!exact) return insertBlock(lines, base, block);
  const before = lines.slice(0, exact.start);
  const after = lines.slice(exact.end);
  while (before.length && before[before.length - 1]!.trim() === "") before.pop();
  while (after.length && after[0]!.trim() === "") after.shift();
  const out = [...before, "", ...block, ...(after.length ? ["", ...after] : [])];
  return out.join("\n");
}

function insertBlock(lines: string[], base: string[], block: string[]): string {
  const sections = parseSections(lines.join("\n"));
  const last = [...sections].reverse().find((s) => isUnder(s.path, base));
  if (last) {
    let insertAt = last.end;
    while (insertAt > last.start && lines[insertAt - 1]?.trim() === "") insertAt--;
    const out = lines.slice();
    out.splice(insertAt, 0, "", ...block);
    return out.join("\n");
  }
  const trimmed = lines.slice();
  while (trimmed.length && trimmed[trimmed.length - 1]!.trim() === "")
    trimmed.pop();
  return [...trimmed, "", ...block, ""].join("\n");
}

function collapseBlankRuns(lines: string[]): string[] {
  const out: string[] = [];
  let blank = 0;
  for (const l of lines) {
    if (l.trim() === "") {
      blank++;
      if (blank > 2) continue;
    } else {
      blank = 0;
    }
    out.push(l);
  }
  return out;
}
