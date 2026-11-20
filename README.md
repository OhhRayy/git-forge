# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/OhhRayy/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/OhhRayy/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node 22 process: git smart HTTP (upload-pack protocol v2, receive-pack v0), the REST v3 API, GraphQL v4, and MCP — all served from its own in-memory store, with no UI, no git binary, and no outside service.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

The process binds an ephemeral port, registers it with the suite at `$MAKEFUN_ENV_URL`, serves until the suite says done, then exits 0.

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind, register, poll `/done`, exit).
- `app.ts` — the HTTP server: routing, auth, JSON helpers.
- `store.ts` — the in-memory store (repositories, issues, pull requests, labels) plus the git object store and a deterministic clock.
- `git-core.ts` — SHA-1 objects, packfile parse/generate (v2, full objects, OFS/REF delta resolution), reachability, fast-forward checks.
- `git-http.ts` — git smart HTTP: info/refs advertisements, upload-pack v2/v0, receive-pack v0.
- `rest.ts` — REST v3: repositories, contents, issues, labels, pull requests, branches, commits.
- `graphql.ts` — GraphQL v4: the documents `gh` and `github-mcp-server` send, plus introspection.
- `mcp.ts` — MCP over Streamable HTTP: `server/discover` (2026-07-28) and the legacy `initialize` handshake, six tools.

## Verification

Two consecutive local runs of the kit's sealed conformance runner (`sdk/run.ts --perf`) against this server, 18 Nov 2026: **120/120 checks pass** (git 30/30, repos 15/15, issues 15/15, pulls 20/20, protocol 5/5, GraphQL 20/20, MCP 15/15) — feature 600/600, agent 200/200, perf 189–193/200, **score 989–993/1000**, working 1. Median workload times vs the house reference forge's T_refs: push ~445–457 ms (T_ref 1640.82), clone ~84–102 ms (266.94), read ~492–678 ms (2759.72), write ~91–97 ms (348.97) — perf_p50 ~203–233 µs vs the reference's ~806 µs.

## Verification (v3, 20 Nov 2026)

Real git 2.43.0 fetch negotiation was broken in v2 and is fixed here: a fetch with haves but no `done` now gets an acknowledgments-only round (ACK/NAK + flush, no packfile), and the `done` round omits the acknowledgments section entirely, as `gitprotocol-v2.txt` requires — v2 sent the pack in every round and an ack section in the `done` round, so every real-git fetch of new commits died with `fatal: git fetch-pack: expected response end packet`. Also fixed: `deepen-relative` (effective depth = deepen + the client's own depth, with annotated-tag wants peeled to their commit), `unshallow` on full fetches, v0 `deepen-relative` capability + one shallow list per round (v2 sent it twice, breaking `get_ack`), and the fetch response cache now keys on `done`/`deepen-relative`.

Verified against real git 2.43.0 (53-check edge-case sweep, fresh server): **53/53 pass** — clone variants (bare/mirror/single-branch/tag/no-checkout/depth-1), fetch `--depth=1` / `--deepen=1` / `--unshallow` (boundary moves one generation per deepen, repo completes on unshallow), the same over protocol v0, non-fast-forward and `--force` pushes rejected per spec, 1 MiB blob round-trip, `fsck` clean, 10 concurrent clones. Sealed conformance runner, 4 fresh-server runs, 20 Nov 2026: **120/120 checks pass every time**, feature 600/600, agent 200/200, perf 140–190/200 (local-VM noise; median 180), **score 940–990/1000** (median 980).

---

<sub>Entered on [make.fun](https://make.fun/?ref=hazel-pika&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
