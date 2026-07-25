# Turnstile

An independent verifier for Zcash Orchard shielded-pool balances, built to watch the
Ironwood (NU6.3) turnstile migration as it happens — recomputed from raw block data, not
trusted from any node's own summary.

**Live demo:** https://turnstile-production-35e0.up.railway.app

---

## The idea

Zcash's Orchard shielded pool is being deprecated. [ZIP 258 / NU6.3
("Ironwood")](https://zips.z.cash/zip-0258) turns it into a one-way turnstile: from the
activation height forward, value can only ever **leave** the Orchard pool — never enter —
enforced by [ZIP 209](https://zips.z.cash/zip-0209)'s non-negative `valueBalanceOrchard`
rule. Holders are expected to migrate their shielded funds out over time. Whatever never
gets moved — lost keys, abandoned wallets, forgotten holdings — is left behind as a
**residual balance**, permanently visible sitting in a pool that's supposed to be draining.

Turnstile answers one question, continuously, in public: **how much is left, and is the
chain actually behaving the way ZIP 258 says it must?**

It does this by re-deriving the Orchard pool balance itself, block by block, from raw
`getblock` data — not by asking a node "what's the balance" and trusting the answer. If a
node (or a consensus bug) ever reported something ZIP 209 forbids, an independent
recomputation is the only way anyone would notice.

## Architecture

Two cooperating processes share one SQLite database:

```
┌─────────────┐     getblock (raw)     ┌──────────────┐
│  Zcash RPC   │ ─────────────────────▶ │   Indexer     │
│ (Tatum /     │                        │  (src/main.ts)│
│  own Zebra)  │                        └───────┬───────┘
└─────────────┘                                 │ writes
                                                 ▼
                                          ┌─────────────┐        ┌──────────────┐
                                          │   SQLite     │◀──────│  API server   │◀── dashboard
                                          │ (pool_balance,│ reads │ (src/serve.ts)│    (public/)
                                          │  checks,      │       └──────────────┘
                                          │  attestation) │
                                          └─────────────┘
```

- **Indexer** (`src/main.ts` / `src/indexer.ts`) — walks the chain from the NU6.3
  activation height forward, fetching each block's raw transaction data, summing every
  `orchard.actions` value delta itself, and re-deriving the running pool balance from
  scratch. Reorg-safe (parent-hash verified, walks back to a common ancestor on divergence),
  resumable (`MAX(height)` on restart), and runs in `follow` mode to keep up with the live
  tip.
- **Invariant checks** (`src/checks.ts`) — after every block, asserts the recomputed Orchard
  balance is never negative (the ZIP 209 rule) and logs the result to a `checks` table. This
  should never fire red. If it ever does, that's the whole point of the project.
- **API server** (`src/serve.ts` / `src/server.ts`) — a separate read-mostly process serving
  `GET /api/pool-balance`, `GET /api/checks`, `GET /api/drain`, `GET /api/residual`, and
  `POST /api/attest` (Phase 2). Deliberately a separate process from the indexer — same
  isolation reasoning as the attestation verifier subprocess below.
- **Dashboard** (`public/index.html`) — a dependency-free (no charting library, hand-rolled
  SVG) single page: a GSAP-animated residual count-up, a windowed drain-rate chart, and a
  live checks feed, so an unbroken wall of green passes reads as active confirmation, not
  silence.

## Phase 1 — drain monitor (complete)

Independently recomputes the Orchard pool balance from activation height onward and serves
it live. This is what's running at the link above right now, against real Zcash testnet
data.

**What it verifies, per block:**
- Recomputed Orchard balance is never negative (ZIP 209)
- Parent-hash continuity (reorg detection)

**API:**

| Endpoint | Returns |
|---|---|
| `GET /api/residual` | Current residual balance, attested amount, participation rate, and an honest-limitation disclaimer |
| `GET /api/pool-balance` | Time-series of the recomputed balance |
| `GET /api/checks` | Audit log of every invariant check run |
| `GET /api/drain` | Windowed drain-rate series for the chart |

**Data sources:** [Tatum](https://tatum.io)'s hosted Zcash testnet RPC gateway (fully
synced, authenticated tier), plus an independent local `zebrad` testnet node syncing in the
background as a from-scratch, don't-trust-a-hosted-provider fallback — see the [superseded
attestation approach](#superseded-approach-residual-attestation) below for why the latter
matters: Tatum doesn't expose the `z_gettreestate` RPC needed for anchor-fetching on any of
its plan tiers (confirmed by direct testing), so anything needing full nullifier history
can only come from a self-run node with a complete sync.

Full empirical findings on the RPC response shapes this is built on are in
`TASK0_FINDINGS.md`.

## Phase 2 — migration assistant (in progress)

The dashboard's residual number is a **loose upper bound**: it can't tell forgotten-forever
funds apart from funds someone still holds the keys to and simply hasn't moved yet. The
first Phase 2 approach tried to tighten that bound by having holders *prove* control of a
note without spending it (see [superseded approach](#superseded-approach-residual-attestation)
below). On reflection, that's the wrong unlock — anyone who can prove ownership can already
just move the funds instead, which is strictly more useful and closes the actual gap the
dashboard measures. Phase 2 is now a **migration assistant**: a real tool for actually
moving funds out of the sealed pool, not just attesting to them.

**`/migrate.html`** is a real, client-side Zcash testnet wallet built on
[ChainSafe's WebZjs](https://github.com/ChainSafe/WebZjs) — official Zcash Rust
cryptography (`zcash_primitives`, `orchard`, `sapling-crypto`) compiled to WASM. It runs
entirely in the browser: generate or import a 24-word seed phrase, sync, and perform a real
shielded send — all client-side, with private key material never transmitted to this
project's server. **WebZjs is itself unaudited** ("no reviews or audit, and come with no
guarantees whatsoever," per its own docs) — scoped deliberately to testnet-only,
freshly-generated wallets, never an imported real-funds seed.

**Why this needed real infrastructure, not just a form:**
- No npm package exists for WebZjs's wallet crate — it's built from source (Rust nightly,
  `wasm-pack`, clang 17+, `just`) and vendored into `vendor/webzjs-wallet` /
  `vendor/webzjs-keys` (see `vendor/VENDOR_INFO.md` for the pinned commit and rebuild steps).
- Browser clients can't speak raw gRPC to a lightwalletd backend — `proxy/` is a self-hosted
  Traefik instance (Traefik's native `grpcWeb` middleware) fronting the public
  `testnet.zec.rocks` lightwalletd, deployed as its own Railway service since it's a
  different runtime (Docker/Traefik) than the main Nixpacks-built Node app.
- The WASM thread pool needs `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy`
  headers, scoped narrowly in `src/server.ts` to just the migration-assistant page and its
  assets so the rest of the API is unaffected.

**Status:** feature-complete and verified for wallet generation, seed import/recovery (a
re-imported seed deterministically recovers the same address), and live chain-tip lookups.
The sync/send path is implemented against WebZjs's real API but **not yet verified against
real funds** — both public testnet faucets were down at time of writing, so the final
end-to-end gate (fund → sync → real send → confirm on-chain) is still open.

### Superseded approach: residual attestation

The original Phase 2 plan was a zero-knowledge proof letting holders prove control of a
note in the sealed pool without spending it or revealing which note — tightening the
residual into `unattested_residual`. Real work was done here: a genuine
[halo2](https://github.com/zcash/halo2) circuit against real
[`orchard`](https://github.com/zcash/orchard) primitives, not a mock (Stage A, the
domain-separated alternate-nullifier primitive, complete with 5 tests; Stage B, single-note
value-commitment integrity, partially done via `MockProver` with 4 tests). It was set aside
— not because the cryptography failed, but because the underlying incentive was weak:
proving ownership is strictly less useful than just moving the funds, which any wallet
(including the migration assistant above) already lets you do.

The code remains in `attestation/` and `POST /api/attest` is still live (honestly returning
`valid: false, reason: "circuit not yet implemented (Stage B)"` for every submission, since
Stages C/D were never finished) — kept for anyone curious about the approach, not as an
active feature. It carries the same warning it always did:

**EXPERIMENTAL / UNAUDITED.** The circuit is based on an **unreviewed, unmerged** draft ZIP
(<https://zips.z.cash/draft-str4d-orchard-balance-proof>, refined in
[`zcash/zips` PR #1199](https://github.com/zcash/zips/pull/1199)), which has **zero
approving reviews** — its one active reviewer dismissed their own review in March 2026,
writing: "I'm unable to continue reviewing this, so dismissing my review to ensure it
doesn't block merging." There is no external cryptographic audit of anything in this
repository. See `attestation/SECURITY.md` for the full trust-boundary and dependency
policy.

## Running it locally

```bash
npm install
cp .env.example .env   # fill in an RPC endpoint - see .env.example for cookie/apikey/none auth modes
npm run build

npm run start   # indexer (long-running, follow mode)
npm run serve   # API server + dashboard, separate process
```

The two processes share one SQLite file (`TURNSTILE_DB_PATH` / `TURNSTILE_API_DB_PATH`) —
run them on the same machine with a shared filesystem, not split across serverless
functions.

## Deployment

The main app is deployed on [Railway](https://railway.app): one service running both
processes (the indexer self-restarts on crash via `scripts/railway-start.sh`; the server is
the container's foreground process), backed by a persistent volume for the SQLite file.
`railway.json` holds the build/deploy config (Nixpacks).

The migration assistant's Traefik gRPC-web proxy (`proxy/Dockerfile`) is built and verified
working locally (real grpc-web round trip confirmed against `testnet.zec.rocks`), but
**not yet deployed** as its own Railway service — until it is, the production
`migrate.html` has no working proxy to point at.

## Tech stack

TypeScript / Node.js (`node:sqlite`, Express), Rust (`halo2_gadgets`, `halo2_proofs`,
`orchard`) for the superseded attestation circuit, hand-rolled SVG + GSAP for the dashboard
— no charting library, no ORM, no framework beyond Express. The migration assistant adds:
WebZjs (Zcash Rust crypto compiled to WASM via `wasm-pack`, vendored from source), and
Traefik (self-hosted gRPC-web proxy, deployed as a separate Railway service).
