# Security Policy

## Design

mcp-sync is built so that **credentials are never synced**. It reads and writes only MCP
server *declarations*; secret values (tokens, `Authorization` headers, env values) are
stripped and replaced with per-agent environment references. After writing, it scans the
target files for leaked secrets and aborts if it finds any.

## Reporting a vulnerability

If you find a way for mcp-sync to leak a secret (copy a credential into another agent's
config, log it, or write it to disk), please **do not open a public issue**. Report it
privately via GitHub's "Report a vulnerability" (Security → Advisories) on this repository,
or by opening a minimal issue that only asks for a private channel.

Please include: the agent/CLI versions involved, the config snippet that triggers it, and
the observed vs expected behavior. Do not include real secrets.

## Scope

- In scope: secret leakage, writing outside the intended config files, unsafe backup/restore
  behavior, or anything that could corrupt an agent's configuration.
- Out of scope: the behavior of the agents themselves (opencode, Claude Code, Codex), and
  the contents of MCP servers you choose to connect.
