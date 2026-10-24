---
name: mcp-sync
description: >-
  Use this skill whenever the user works with MCP servers across opencode, Claude Code and
  Codex: inspect, add, update, remove or sync an MCP server, ask whether MCPs are in sync,
  authenticate an MCP, register a project for MCP sync, or roll back MCP config changes.
  Trigger by semantic intent (sync my MCPs, add this MCP everywhere, remove MCP X, are my
  MCPs in sync, log into the MCP) rather than exact wording. At the start of a session,
  load this skill and run its setup and health checkup before doing anything else.
---

# mcp-sync

Reconciles MCP server *declarations* across opencode, Claude Code and Codex, in any
direction. Adding, changing or removing an MCP in one agent is reflected in the others.
It never copies credentials: only the definition (name, transport, url, command, env/header
variable *names*) is propagated, and each agent authenticates on its own.

This skill does not replace the native `mcp add` commands — the user still introduces a
server with the agent's own command. mcp-sync then propagates it and keeps the agents
converged.

## How to ask the user (mandatory)

Every question you ask about mcp-sync must be a **multiple-choice question with exactly one
option marked as recommended**, so the user only has to pick one and press enter — never
make them type a free-form answer.

- Use your client's selectable/ask menu when it has one (e.g. opencode's `question` tool),
  with the recommended option first and labelled "(recommended)".
- Otherwise, print a short numbered list and mark exactly one `(recommended)`.
- Always include a recommended option; if a safe/canonical choice exists, recommend it.
- For a new MCP's scope, recommend the scope where it currently lives (the least
  surprising), but still require the user to confirm.

## Session checkup (do this first)

When this skill loads, run the read-only checkup and report a short summary:

```sh
mcp-sync doctor
```

(or `bash "<this skill's SKILL.md dir>/scripts/checkup.sh"`, which delegates to `doctor`).
It prints a `HEALTH:` verdict line and exits non-zero on problems:

- `not-installed` — the `mcp-sync` binary is not on PATH. Show the install steps below; do
  not try to sync.
- `needs-setup` — preferences are not configured. Run the onboarding below first.
- `drift` — there is a difference between agents. Run `mcp-sync plan` and offer to apply.
- `ok` — healthy.

`doctor` is read-only (it also reports config, agents, projects, skill/rule install state,
and reconcile drift). Never run `apply` as part of the checkup.

## First run: onboarding

If the checkup reports `HEALTH: needs-setup` (or `mcp-sync config` shows
`setupComplete = false`), run the onboarding **before** syncing anything:

```sh
mcp-sync setup          # interactively: accept recommended defaults, or walk through
mcp-sync setup --defaults
```

Preferences live in `~/.config/mcp-sync/config.json` and are written once. After setup,
never prompt for them again: read with `mcp-sync config`, change with
`mcp-sync config set <key> <value>`, or by asking the user to edit the file. Only re-run
onboarding if the user explicitly asks (or with `mcp-sync setup --force`).

Key preferences:

- `newServerScope` (`ask` | `global` | `project`) — default `ask`: always ask for a new MCP.
- `onScopeConflict` (`ask` | `move` | `keep-both`) — what to offer when a name already
  exists in another scope; `ask` presents the choice at conflict time.
- `requireApplyConfirmation` (default `true`) — `apply` is a dry run unless `--yes`.
- `secretLeakCheck`, `massDeleteThreshold`, `skillTargets`, `rulesEnabled`.

## Resolve the binary

Prefer `mcp-sync` from PATH. If missing, install it:

```sh
git clone https://github.com/enzo-vargas/mcp-sync && cd mcp-sync
npm install && npm link          # or: ln -s "$PWD/bin/mcp-sync" ~/.local/bin/mcp-sync
```

## Mental model

- **Global scope** (default) applies to every repository and always syncs:
  `~/.claude.json` (`mcpServers`), `~/.config/opencode/opencode.json` (`mcp`),
  `~/.codex/config.toml` (`[mcp_servers]`).
- **Project scope** only syncs for repositories registered with
  `mcp-sync projects add <path>`: `<repo>/.mcp.json`, `<repo>/opencode.json`,
  `<repo>/.codex/config.toml` (only if it already exists), and the Claude `local` scope.
- `plan` is read-only; `apply` writes with a backup.

What is **not** synced: secret values, `approval_mode`/per-tool permissions, MCPs provided
by plugins, and Hermes.

## Intent → action

| The user says | Do this |
|---|---|
| "sync my MCPs", "add/update this MCP everywhere" | if it is a new MCP, ask global vs project first; then `mcp-sync plan`, show it, and `mcp-sync apply --yes` (with `--scope` if needed) after confirmation |
| "are my MCPs in sync?" | `mcp-sync plan` (or `mcp-sync check`) |
| "check the plugin / health / diagnose" | `mcp-sync doctor` |
| "refresh / reinstall the skill & rules" | `mcp-sync refresh` |
| "remove MCP X" | remove it in one agent natively, then `mcp-sync plan` + `apply` (it propagates and tombstones) |
| "authenticate / log into X" | `mcp-sync status`, then the native command it prints (`opencode mcp auth`, `codex mcp login`, Claude `/mcp`) |
| "register this project" | `mcp-sync projects add "$(git rev-parse --show-toplevel)"` |
| "move this MCP to a project / to global" | `mcp-sync move <name> --to global\|project:<path>` |
| "undo / revert" | `mcp-sync rollback` |
| "stop re-adding X" | `mcp-sync forget X` |

## Adding a new MCP — always ask the scope (no default)

When the user wants to add a new MCP, **always ask whether it should be global or
project-scoped before running any add command**. There is no default; the scope is the
user's choice. Do not infer it from the agent's native default.

Map the answer to the native command:

- **Global** (every project):
  - Claude Code: `claude mcp add -s user <name> ...` (never rely on the `local` default)
  - opencode: `opencode mcp add <name> ...` (writes the global config)
  - Codex: `codex mcp add <name> ...` (writes `~/.codex/config.toml`)
- **Project** (one repository):
  - Claude Code: `claude mcp add -s project <name> ...` (writes `<repo>/.mcp.json`)
  - opencode: edit `<repo>/opencode.json` (`mcp.<name>`) — `opencode mcp add` cannot target a project
  - Codex: `<repo>/.codex/config.toml` (`[mcp_servers.<name>]`), only if that file already exists
  - Ensure the project is registered: `mcp-sync projects add <repo>`

If the server was already declared in the wrong scope (e.g. Claude's `local` default),
`mcp-sync` will flag it as `?` (scope not chosen). Resolve it explicitly — either run
`mcp-sync apply --yes` and answer the interactive prompt, or pass
`mcp-sync apply --yes --scope global` / `--scope project:<path>`. `apply` refuses to place a
new server without an explicit scope.

**If the name already exists in another scope** (e.g. it is global and the user wants it in
a project), `apply` asks at that moment — only then — whether to **keep both** or **move**
it. If the user wants an existing (already synced) server relocated, use
`mcp-sync move <name> --to global|project:<path>`; `apply --scope` never touches servers
that are already synced.

## Safety rules (mandatory)

1. **Always `plan` before `apply`.** Show the diff and get explicit confirmation before
   writing. Never run `apply` unprompted.
2. **Never read, print or copy a secret.** If a definition contains a token/header value,
   it is converted to an env reference; do not surface values.
3. **`blocked` means stop.** A private server headed for a git-tracked file is blocked on
   purpose — explain and let the user decide.
4. **Conflicts are the user's call.** When `plan` reports a conflict (changed in one agent,
   removed in another, or two different definitions), do not pick a winner; present both.
5. **Mass removal needs consent.** More than 5 removals (or >50%) requires
   `--allow-mass-delete`; only pass it when the user clearly wants it.
6. **This is not an input layer.** Do not invent servers; a server must exist in at least
   one agent first.
7. **Always ask the scope for a new MCP.** Global or project — no default. Never let a
   native default (e.g. Claude's `local`) decide silently.

## Troubleshooting

- **Binary missing** → install as above; the checkup will say `not-installed`.
- **Agent not listed by `mcp-sync targets`** → its config dir is absent, so it is skipped
  (its absence is never treated as a removal).
- **`~/.claude.json` changes seem to be reverted** → Claude Code is running and rewrites
  that file; close it, then re-run `apply`.
- **Config malformed** → that agent is dropped from the run; fix the JSON/TOML and re-run.
- **Want a project-scoped MCP ignored** → do not register that project.
