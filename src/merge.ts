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

  const byScope = new Map<string, Target[]>();
  for (const t of targets) {
    const id = scopeId(t.scope);
    if (!byScope.has(id)) byScope.set(id, []);
    byScope.get(id)!.push(t);
  }

  const keys = new Map<string, { scope: ScopeKey; name: string; occ: Occ[] }>();
  for (const [t, r] of reads) {
    for (const [name, def] of r.servers) {
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
    notes: [],
    knownKeys: 0,
    newSnapshot: { version: 1, servers: {}, tombstones: {} },
  };

  for (const [key, t] of Object.entries(state.tombstones)) {
    if (isTombstoned(state, key)) plan.newSnapshot.tombstones[key] = t;
  }

  const allKeys = new Set<string>([...keys.keys(), ...Object.keys(state.servers)]);
  plan.knownKeys = allKeys.size;

  for (const key of allKeys) {
    const entry = keys.get(key);
    const base = state.servers[key];
    const scope = entry?.scope ?? base!.scope;
    const name = entry?.name ?? base!.name;
    const scopeTargets = (byScope.get(scopeId(scope)) ?? []).filter(
      (t) => !offline.has(t),
    );
    const activeAgents = new Set(scopeTargets.map((t) => t.agent));
    const occ = entry?.occ ?? [];
    const isPrivate = occ.length > 0 && occ.every((o) => o.target.private);

    const defsByHash = new Map<string, ServerDef>();
    for (const o of occ) defsByHash.set(defHash(o.def), o.def);
    const defs = [...defsByHash.values()];

    const tracked = base?.agents ?? [];
    const removedBy = tracked.filter((a) => activeAgents.has(a) && !occ.some((o) => o.agent === a));

    if (base) {
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
    }
  }

  return plan;
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
  const entry: SnapshotEntry = {
    scope,
    name,
    def,
    agents: [...new Set(scopeTargets.map((t) => t.agent))],
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
