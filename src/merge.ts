import type { AgentId, ScopeKey, ServerDef } from "./types.js";
import { defHash, defsEqual, keyId, scopeId } from "./types.js";
import type { Target, ReadResult } from "./agents.js";
import type { State, SnapshotEntry } from "./state.js";
import { isTombstoned, makeTombstone } from "./state.js";
import { isGitTracked, rel } from "./util.js";

export interface Conflict {
  key: string;
  scope: ScopeKey;
  name: string;
  reason: string;
  details: string[];
}

export interface Blocked {
  key: string;
  scope: ScopeKey;
  name: string;
  file: string;
  reason: string;
}

export interface Duplicate {
  kind: "name-cross-scope" | "same-def-different-name" | "plugin-managed";
  name: string;
  detail: string;
  agents?: string[];
  files?: string[];
  scopes?: string[];
  names?: string[];
}

export interface KeyAction {
  key: string;
  scope: ScopeKey;
  name: string;
  action: "add" | "update" | "remove" | "none";
  private: boolean;
  from?: ServerDef;
  to?: ServerDef;
  agents: AgentId[];
  files: string[];
  needsScope?: boolean;
  observedScope?: ScopeKey;
  otherScopes?: string[];
}

export interface TargetOps {
  target: Target;
  set: Map<string, ServerDef>;
  remove: Set<string>;
}

export interface Plan {
  ops: Map<string, TargetOps>;
  actions: KeyAction[];
  conflicts: Conflict[];
  blocked: Blocked[];
  duplicates: Duplicate[];
  notes: string[];
  knownKeys: number;
  newSnapshot: State;
}

interface Occ {
  agent: AgentId;
  target: Target;
  def: ServerDef;
}

export interface BuildOptions {
  scopeOverrides?: Map<string, ScopeKey>;
  skipKeys?: Set<string>;
  forceRemoveKeys?: Set<string>;
  dropManaged?: { file: string; name: string }[];
  ignored?: Set<string>;
}

export function buildPlan(
  targets: Target[],
  state: State,
  opts?: BuildOptions,
): Plan {
  const reads = new Map<Target, ReadResult>();
  const offline = new Set<Target>();

  for (const t of targets) {
    if (!t.available()) {
      offline.add(t);
      continue;
    }
    const r = t.read();
    if (r.error) {
      offline.add(t);
      continue;
    }
    reads.set(t, r);
  }

  const providedByTarget = new Map<Target, Set<string>>();
  for (const [t, r] of reads) {
    if (r.provided && r.provided.size) providedByTarget.set(t, r.provided);
  }

  const byScope = new Map<string, Target[]>();
  for (const t of targets) {
    const id = scopeId(t.scope);
    if (!byScope.has(id)) byScope.set(id, []);
    byScope.get(id)!.push(t);
  }

  const keys = new Map<string, { scope: ScopeKey; name: string; occ: Occ[] }>();
  for (const [t, r] of reads) {
    for (const [name, def] of r.servers) {
      if (opts?.ignored?.has(name)) continue;
      const key = keyId(t.scope, name);
      if (!keys.has(key)) keys.set(key, { scope: t.scope, name, occ: [] });
      keys.get(key)!.occ.push({ agent: t.agent, target: t, def });
    }
  }

  const plan: Plan = {
    ops: new Map(),
    actions: [],
    conflicts: [],
    blocked: [],
    duplicates: [],
    notes: [],
    knownKeys: 0,
    newSnapshot: { version: 1, servers: {}, tombstones: {} },
  };

  for (const [key, t] of Object.entries(state.tombstones)) {
    if (isTombstoned(state, key)) plan.newSnapshot.tombstones[key] = t;
  }

  const allKeys = new Set<string>([...keys.keys(), ...Object.keys(state.servers)]);
  plan.knownKeys = allKeys.size;

  const nameByKey = new Map<string, string>();
  const scopeByKey = new Map<string, string>();
  const defByKey = new Map<string, ServerDef>();
  const nameScopes = new Map<string, Set<string>>();
  for (const k of allKeys) {
    const e = keys.get(k);
    const b = state.servers[k];
    const sc = e?.scope ?? b!.scope;
    const nm = e?.name ?? b!.name;
    if (opts?.ignored?.has(nm)) continue;
    const def = e?.occ[0]?.def ?? b?.def;
    nameByKey.set(k, nm);
    scopeByKey.set(k, scopeId(sc));
    if (def) defByKey.set(k, def);
    if (!nameScopes.has(nm)) nameScopes.set(nm, new Set());
    nameScopes.get(nm)!.add(scopeId(sc));
  }

  plan.duplicates = [
    ...findPluginManagedDuplicates(reads, providedByTarget),
    ...findDuplicates(allKeys, nameByKey, scopeByKey, defByKey, nameScopes),
  ];

  for (const key of allKeys) {
    if (opts?.skipKeys?.has(key)) continue;
    const entry = keys.get(key);
    const base = state.servers[key];
    const scope = entry?.scope ?? base!.scope;
    const name = entry?.name ?? base!.name;
    if (opts?.ignored?.has(name)) continue;
    const scopeTargetsAll = (byScope.get(scopeId(scope)) ?? []).filter(
      (t) => !offline.has(t),
    );
    const providedTargets = scopeTargetsAll.filter((t) => providedByTarget.get(t)?.has(name));
    const providedAgents = [...new Set(providedTargets.map((t) => t.agent))];
    if (
      providedAgents.length &&
      (!base || base.agents.some((a) => providedAgents.includes(a)))
    ) {
      plan.notes.push(
        `"${name}" is provided by a plugin in ${providedAgents.join(", ")} — not synced there`,
      );
    }
    const scopeTargets = scopeTargetsAll.filter(
      (t) => !providedByTarget.get(t)?.has(name),
    );
    const activeAgents = new Set(scopeTargets.map((t) => t.agent));

    const drops = opts?.dropManaged?.filter((d) => d.name === name) ?? [];
    if (drops.length) {
      const agents: AgentId[] = [];
      const files: string[] = [];
      for (const d of drops) {
        const t = scopeTargetsAll.find((tt) => tt.file === d.file);
        if (!t) continue;
        addOp(plan, t).remove.add(name);
        agents.push(t.agent);
        files.push(t.file);
      }
      plan.actions.push({
        key,
        scope,
        name,
        action: "remove",
        private: false,
        agents: [...new Set(agents)],
        files,
      });
    }
    const occ = entry?.occ ?? [];
    const isPrivate = occ.length > 0 && occ.every((o) => o.target.private);

    if (opts?.forceRemoveKeys?.has(key)) {
      emitRemove(plan, key, scope, name, scopeTargets, base?.private ?? false, isPrivate);
      continue;
    }

    const defsByHash = new Map<string, ServerDef>();
    for (const o of occ) defsByHash.set(defHash(o.def), o.def);
    const defs = [...defsByHash.values()];

    const tracked = base?.agents ?? [];
    const removedBy = tracked.filter((a) => activeAgents.has(a) && !occ.some((o) => o.agent === a));

    if (base) {
      const override = opts?.scopeOverrides?.get(key);
      if (override && scopeId(override) !== scopeId(scope)) {
        const destKey = keyId(override, name);
        const destExisting = keys.get(destKey) ?? state.servers[destKey];
        if (destExisting) {
          const destDef = keys.get(destKey)?.occ[0]?.def ?? state.servers[destKey]?.def;
          if (destDef && defsEqual(destDef, base.def)) {
            emitRemove(plan, key, scope, name, scopeTargets, base.private, isPrivate);
            continue;
          }
          plan.conflicts.push({
            key,
            scope,
            name,
            reason: `cannot move to ${scopeId(override)}: a different server named "${name}" already exists there`,
            details: [],
          });
          continue;
        }
        const destTargets = (byScope.get(scopeId(override)) ?? []).filter((t) => !offline.has(t));
        const destAgents = new Set(destTargets.map((t) => t.agent));
        emitRemove(plan, key, scope, name, scopeTargets, base.private, isPrivate);
        emitWrite(plan, destKey, override, name, base.def, undefined, false, destTargets, destAgents);
        continue;
      }
      const changedDefs = defs.filter((d) => !defsEqual(d, base.def));
      const presentAgents = [...new Set(occ.map((o) => o.agent))];
      if (removedBy.length > 0) {
        if (changedDefs.length > 0) {
          plan.conflicts.push({
            key,
            scope,
            name,
            reason: "changed in one agent, removed in another",
            details: [
              `removed by: ${removedBy.join(", ")}`,
              `present in: ${presentAgents.join(", ")}`,
            ],
          });
          continue;
        }
        emitRemove(plan, key, scope, name, scopeTargets, base.private, isPrivate);
        continue;
      }
      if (changedDefs.length === 0) {
        if (defs.length === 0) continue;
        recordSnapshot(plan, key, scope, name, base.def, base.private, scopeTargets);
        continue;
      }
      if (changedDefs.length > 1) {
        plan.conflicts.push({
          key,
          scope,
          name,
          reason: "two agents changed it differently",
          details: changedDefs.map((d) => defHash(d)),
        });
        continue;
      }
      const desired = changedDefs[0]!;
      emitWrite(plan, key, scope, name, desired, base.def, isPrivate, scopeTargets, activeAgents);
      continue;
    }

    if (isTombstoned(state, key)) {
      plan.notes.push(`skipped ${name} (${scopeId(scope)}): tombstoned`);
      continue;
    }
    if (defs.length === 0) continue;
    if (defs.length > 1) {
      plan.conflicts.push({
        key,
        scope,
        name,
        reason: "new in multiple agents with different definitions",
        details: [...defsByHash.keys()],
      });
      continue;
    }
    const desired = defs[0]!;
    const override = opts?.scopeOverrides?.get(key);
    if (override && scopeId(override) !== scopeId(scope)) {
      const destTargets = (byScope.get(scopeId(override)) ?? []).filter(
        (t) => !offline.has(t),
      );
      const destAgents = new Set(destTargets.map((t) => t.agent));
      emitRemove(plan, key, scope, name, scopeTargets, false, isPrivate);
      emitWrite(plan, keyId(override, name), override, name, desired, undefined, false, destTargets, destAgents);
      continue;
    }
    emitWrite(plan, key, scope, name, desired, undefined, isPrivate, scopeTargets, activeAgents);
    if (!override) {
      const action = plan.actions[plan.actions.length - 1]!;
      action.needsScope = true;
      action.observedScope = scope;
      const others = [...(nameScopes.get(name) ?? [])].filter((id) => id !== scopeId(scope));
      if (others.length) {
        action.otherScopes = others;
        plan.notes.push(
          `"${name}" already exists in ${others.join(", ")} — keep both, move, or cancel`,
        );
      }
    }
  }

  return plan;
}

function findPluginManagedDuplicates(
  reads: Map<Target, ReadResult>,
  providedByTarget: Map<Target, Set<string>>,
): Duplicate[] {
  const byName = new Map<string, { agents: Set<string>; files: Set<string> }>();
  for (const [t, r] of reads) {
    const prov = providedByTarget.get(t);
    if (!prov) continue;
    for (const name of r.servers.keys()) {
      if (!prov.has(name)) continue;
      if (!byName.has(name)) byName.set(name, { agents: new Set(), files: new Set() });
      byName.get(name)!.agents.add(t.agent);
      byName.get(name)!.files.add(t.file);
    }
  }
  return [...byName.entries()].map(([name, v]) => ({
    kind: "plugin-managed" as const,
    name,
    detail: `${[...v.agents].join(", ")} provides "${name}" via a plugin AND has a managed entry`,
    agents: [...v.agents],
    files: [...v.files],
  }));
}

function findDuplicates(
  allKeys: Set<string>,
  nameByKey: Map<string, string>,
  scopeByKey: Map<string, string>,
  defByKey: Map<string, ServerDef>,
  nameScopes: Map<string, Set<string>>,
): Duplicate[] {
  const out: Duplicate[] = [];

  for (const [nm, scopes] of nameScopes) {
    if (scopes.size > 1) {
      out.push({
        kind: "name-cross-scope",
        name: nm,
        detail: `declared in ${[...scopes].join(" and ")}`,
        scopes: [...scopes],
      });
    }
  }

  const byScopeDef = new Map<string, Map<string, Set<string>>>();
  for (const k of allKeys) {
    const def = defByKey.get(k);
    if (!def) continue;
    const sid = scopeByKey.get(k)!;
    const nm = nameByKey.get(k)!;
    if (!byScopeDef.has(sid)) byScopeDef.set(sid, new Map());
    const m = byScopeDef.get(sid)!;
    const h = defHash(def);
    if (!m.has(h)) m.set(h, new Set());
    m.get(h)!.add(nm);
  }
  for (const [sid, m] of byScopeDef) {
    for (const names of m.values()) {
      if (names.size > 1) {
        const sorted = [...names].sort();
        out.push({
          kind: "same-def-different-name",
          name: sorted.join(", "),
          detail: `same definition in ${sid}: ${sorted.join(", ")}`,
          scopes: [sid],
          names: sorted,
        });
      }
    }
  }

  return out;
}

function destTarget(
  scopeTargets: Target[],
  agent: AgentId,
  isPrivate: boolean,
): Target | undefined {
  const mine = scopeTargets.filter((t) => t.agent === agent);
  if (mine.length === 0) return undefined;
  if (mine.length === 1) return mine[0];
  const priv = mine.find((t) => t.private);
  const shared = mine.find((t) => !t.private);
  return isPrivate ? priv ?? shared : shared ?? priv;
}

function addOp(plan: Plan, target: Target) {
  let ops = plan.ops.get(target.file);
  if (!ops) {
    ops = { target, set: new Map(), remove: new Set() };
    plan.ops.set(target.file, ops);
  }
  return ops;
}

function emitWrite(
  plan: Plan,
  key: string,
  scope: ScopeKey,
  name: string,
  desired: ServerDef,
  from: ServerDef | undefined,
  isPrivate: boolean,
  scopeTargets: Target[],
  activeAgents: Set<AgentId>,
) {
  const files: string[] = [];
  const agents: AgentId[] = [];
  for (const agent of activeAgents) {
    const dest = destTarget(scopeTargets, agent, isPrivate);
    if (!dest) continue;
    if (isPrivate && isGitTracked(dest.file)) {
      plan.blocked.push({
        key,
        scope,
        name,
        file: dest.file,
        reason: "private server would be written to a git-tracked file",
      });
      continue;
    }
    for (const t of scopeTargets.filter((t) => t.agent === agent && t !== dest)) {
      addOp(plan, t).remove.add(name);
    }
    addOp(plan, dest).set.set(name, desired);
    files.push(dest.file);
    agents.push(agent);
  }
  plan.actions.push({
    key,
    scope,
    name,
    action: from ? "update" : "add",
    private: isPrivate,
    from,
    to: desired,
    agents,
    files,
  });
  recordSnapshot(plan, key, scope, name, desired, isPrivate, scopeTargets);
}

function emitRemove(
  plan: Plan,
  key: string,
  scope: ScopeKey,
  name: string,
  scopeTargets: Target[],
  wasPrivate: boolean,
  isPrivate: boolean,
) {
  const files: string[] = [];
  const agents: AgentId[] = [];
  for (const t of scopeTargets) {
    addOp(plan, t).remove.add(name);
    files.push(t.file);
  }
  for (const t of scopeTargets) agents.push(t.agent);
  plan.actions.push({
    key,
    scope,
    name,
    action: "remove",
    private: isPrivate || wasPrivate,
    agents: [...new Set(agents)],
    files,
  });
  makeTombstone(plan.newSnapshot, scope, name, key);
}

function recordSnapshot(
  plan: Plan,
  key: string,
  scope: ScopeKey,
  name: string,
  def: ServerDef,
  isPrivate: boolean,
  scopeTargets: Target[],
) {
  const agents = [...new Set(scopeTargets.map((t) => t.agent))];
  if (agents.length === 0) {
    delete plan.newSnapshot.servers[key];
    return;
  }
  const entry: SnapshotEntry = {
    scope,
    name,
    def,
    agents,
    private: isPrivate,
  };
  plan.newSnapshot.servers[key] = entry;
}

export function summarize(plan: Plan): { adds: number; updates: number; removes: number } {
  let adds = 0;
  let updates = 0;
  let removes = 0;
  for (const a of plan.actions) {
    if (a.action === "add") adds++;
    else if (a.action === "update") updates++;
    else if (a.action === "remove") removes++;
  }
  return { adds, updates, removes };
}

export { rel };
