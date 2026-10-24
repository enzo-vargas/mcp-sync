# Contributing

Thanks for taking a look at mcp-sync.

## Development

```sh
npm install
npm test          # node --test via tsx
npm run typecheck # tsc --noEmit
```

## Ground rules

- **Never sync secrets.** mcp-sync only ever writes the *declaration* (name, transport,
  url, command, env/header variable *names*). Any change that could copy a value, a token
  or an `Authorization` header is a non-starter.
- **Plan before apply.** `apply` writes to real agent configs; keep it conservative and
  backed up.
- **One canonical definition per `(scope, name)`.** Per-agent servers belong in the ignore
  list, not in the reconcile model.
- **Add a test** for every behavior change (see `test/`). Prefer fixtures over touching the
  real `$HOME`.

## Pull requests

- Keep the diff focused; describe the behavior change and how you verified it.
- CI must be green (`typecheck` + `test`).
- Note any change to the reader/writer for an agent, since CLI formats drift between
  versions (opencode, Claude Code, Codex).
