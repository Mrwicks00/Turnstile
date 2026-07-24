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
background as a from-scratch, don't-trust-a-hosted-provider fallback — see [Phase 2's
bottleneck](#phase-2--residual-attestation-in-progress) below for why the latter matters.

Full empirical findings on the RPC response shapes this is built on are in
`TASK0_FINDINGS.md`.

## Phase 2 — residual attestation (in progress)

The dashboard's residual number is a **loose upper bound**, not proof of anything: it can't
tell forgotten-forever funds apart from funds someone still holds the keys to and simply
hasn't moved yet. Phase 2 lets holders voluntarily prove control of a note in the sealed
pool — without spending it and without revealing which note — tightening that bound into
`unattested_residual`.

This is genuine, security-critical zero-knowledge cryptography, built with a real
[halo2](https://github.com/zcash/halo2) circuit against real
[`orchard`](https://github.com/zcash/orchard) primitives (audited fixed-base tables, real
Sinsemilla/Poseidon hashing) — not a mock. **It is also unaudited and based on an
unreviewed, unmerged spec.** See the [warning below](#️-phase-2--experimental--unaudited)
before treating any of it as trustworthy.

**Staged build-out, in order:**

| Stage | What it is | Status |
|---|---|---|
| **A** | Off-circuit domain-separated "alternate nullifier" primitive (dedup without revealing the real nullifier) | ✅ Done, 5 tests |
| **B** | Single-note circuit: value-commitment integrity against real `OrchardFixedBases` | 🟡 Partial — value commitment proven via `MockProver` in both directions (valid witness accepted; tampered value / tampered blinding factor / tampered public instance each independently rejected, 4 tests). Commitment-tree Merkle membership and spend-authority (RedDSA) proof are **not yet implemented**. No real prove/verify key round trip attempted yet — MockProver only. |
| **C** | Wire the in-circuit alternate nullifier as a public output, cross-checked against Stage A's oracle, into `attestation.dedup_tag UNIQUE` | ⬜ Not started |
| **D** | Nullifier non-membership/exclusion tree — the piece that would let an attestation prove a note is *still* unspent, not just that it existed at some anchor height | ⬜ Explicitly deferred |

**Why Stage D is blocked, concretely — this is the thing actually slowing Phase 2 down
right now:** proving non-membership requires the complete revealed-nullifier history from
NU5 activation up to the attestation's anchor height. That means an **archive node with a
full, from-genesis sync** — a hosted RPC gateway can't provide it, because the mechanism
depends on having ingested and indexed *every* nullifier ever revealed, not just recent
blocks. Tatum (the hosted provider Phase 1 uses for its live data) doesn't even expose the
`z_gettreestate` RPC needed for anchor-fetching in the first place — confirmed by direct
testing, not assumption — on any of its plan tiers. So Stage D's anchor/nullifier-history
data can only come from a **self-run node with a complete sync**, and that node is
currently still syncing from scratch in the background (independent of and behind the
Tatum-backed data Phase 1 uses for its live numbers). Until that sync finishes, Stage D
can't start, by design — an incomplete non-membership tree fails in the dangerous
direction (a spent note could pass as unspent simply because its data was never ingested),
so a partial/approximate version is deliberately not being attempted.

**Node integration boundary (already built):** `POST /api/attest` invokes a compiled
`turnstile-verifier` Rust binary via `child_process.spawn` (never a shell) — JSON in over
stdin, JSON out over stdout, hard timeout with `SIGKILL`. A malformed or adversarial proof
can only ever crash that subprocess, never the API server itself. Today the verifier
honestly returns `valid: false, reason: "circuit not yet implemented (Stage B)"` for every
submission — that's correct behavior, not a bug: no attestation can genuinely pass before
the circuit exists.

### ⚠️ Phase 2 — EXPERIMENTAL / UNAUDITED

The `attestation/` workspace implements a zero-knowledge proof-of-balance circuit based on
an **unreviewed, unmerged** draft ZIP
(<https://zips.z.cash/draft-str4d-orchard-balance-proof>, refined in
[`zcash/zips` PR #1199](https://github.com/zcash/zips/pull/1199)). That PR has **zero
approving reviews**, and its one active reviewer dismissed their own review in March 2026,
writing: "I'm unable to continue reviewing this, so dismissing my review to ensure it
doesn't block merging." There is no external cryptographic audit of anything in this
repository.

Do not treat any output of `attestation/` as cryptographically sound without independent
review. See `attestation/SECURITY.md` for the exact trust boundary and dependency policy
(including the explicit policy against two suspiciously-on-topic crates from an unverified
publisher, found and deliberately rejected during Phase 2 research).

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

Deployed on [Railway](https://railway.app): one service running both processes (the
indexer self-restarts on crash via `scripts/railway-start.sh`; the server is the container's
foreground process), backed by a persistent volume for the SQLite file. `railway.json`
holds the build/deploy config.

## Tech stack

TypeScript / Node.js (`node:sqlite`, Express), Rust (`halo2_gadgets`, `halo2_proofs`,
`orchard`) for the Phase 2 circuit, hand-rolled SVG + GSAP for the dashboard — no charting
library, no ORM, no framework beyond Express.
