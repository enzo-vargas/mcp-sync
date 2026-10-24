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

## Session checkup (do this first)

When this skill loads, run the read-only checkup and report a short summary:

```sh
bash "$(dirname "<this skill's SKILL.md>")/scripts/checkup.sh"
```

If the path is unknown, the script also ships in the repo at `skill/mcp-sync/scripts/checkup.sh`.
It prints a `HEALTH:` verdict line:

- `not-installed` — the `mcp-sync` binary is not on PATH. Show the install steps below; do
  not try to sync.
- `not-registered` — the current project is not registered, so only global-scope MCPs sync.
  Mention `mcp-sync projects add <path>` if the user wants project scope.
- `drift` — there is a difference between agents. Run `mcp-sync plan` and offer to apply.
- `ok` — in sync.

The checkup never writes. Never run `apply` as part of the checkup.

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
| "sync my MCPs", "add/update this MCP everywhere" | `mcp-sync plan`, show it, then `mcp-sync apply --yes` after confirmation |
| "are my MCPs in sync?" | `mcp-sync plan` (or `mcp-sync check`) |
| "remove MCP X" | remove it in one agent natively, then `mcp-sync plan` + `apply` (it propagates and tombstones) |
| "authenticate / log into X" | `mcp-sync status`, then the native command it prints (`opencode mcp auth`, `codex mcp login`, Claude `/mcp`) |
| "register this project" | `mcp-sync projects add "$(git rev-parse --show-toplevel)"` |
| "undo / revert" | `mcp-sync rollback` |
| "stop re-adding X" | `mcp-sync forget X` |

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

## Troubleshooting

- **Binary missing** → install as above; the checkup will say `not-installed`.
- **Agent not listed by `mcp-sync targets`** → its config dir is absent, so it is skipped
  (its absence is never treated as a removal).
- **`~/.claude.json` changes seem to be reverted** → Claude Code is running and rewrites
  that file; close it, then re-run `apply`.
- **Config malformed** → that agent is dropped from the run; fix the JSON/TOML and re-run.
- **Want a project-scoped MCP ignored** → do not register that project.
