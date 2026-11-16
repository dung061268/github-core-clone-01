[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/dung061268/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/dung061268/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# GitForge — a GitHub-compatible git forge in one Node process

An entry for make.fun's [“Build a GitHub-compatible git forge” bounty](https://make.fun/bounty/github-core-clone-01):
a standalone forge that serves, from one shared in-memory store and with nothing but the
Node.js standard library (no `git` binary, no dependencies),

- **git smart HTTP** — upload-pack protocol v2 (ls-refs, fetch, shallow/deepen) and
  receive-pack v0 with report-status in side-band-64k, fast-forward only;
- **REST v3** under `/api/v3` — repositories, branches, commits, contents (backed by the
  real git object store), labels, issues, comments, pull requests with file diffs and
  squash merges;
- **GraphQL v4** at `/api/graphql` — viewer/repository/node queries, introspection,
  issue connections, and the create/merge mutations;
- **MCP** at `/mcp` — `server/discover` (2026-07-28) plus the legacy initialize handshake,
  six tools acting on the same store as REST.

Every timestamp comes from `MAKEFUN_TRIAL_NOW` and every id from a sequential counter, so
two runs of the same trial leave byte-identical state.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22, which strips TypeScript types on its own.
The program binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL/register`, serves
until `$MAKEFUN_ENV_URL/done` answers true, and exits 0.

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind, register, wait for done).
- `app.ts` — HTTP routing, bearer auth, request ids.
- `forge.ts` — the shared store: git object store, repositories, issues, pull requests,
  file-level three-way and squash merges, line diffs.
- `git.ts` — pkt-lines and packfiles; upload-pack v2 and receive-pack v0.
- `rest.ts` — the `/api/v3` surface.
- `graphql.ts` — the GraphQL parser/executor.
- `mcp.ts` — the MCP endpoint.

MIT licensed.
