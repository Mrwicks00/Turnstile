# Turnstile Verifier

An independent recomputation of Zcash shielded pool balances from raw block data,
used to verify the Ironwood (NU6.3) turnstile migration.

## Background

Zcash enforces a consensus rule (ZIP 209) that shielded pool balances must never
go negative. This is the "turnstile": no more value can leave a pool than
entered it.

A soundness flaw was found in the Orchard circuit in May 2026. There is no
evidence it was exploited, but because Orchard hides amounts, nobody can prove
it wasn't. Ironwood seals the legacy Orchard pool at block **3,428,143**
(mainnet, ~28 July 2026). After that height, ZIP 258 requires that
`valueBalanceOrchard >= 0` for every transaction — meaning **no new value can
enter the pool, only leave**.

The pool can therefore only drain. How it drains — and what residue is left
stranded when migration plateaus — is the forensic signal. Nobody is measuring it.

This is worth building because the turnstile has already been broken once by an
implementation bug: a zcashd defect allowed a duplicate block header to silently
reset pool balance tracking fields, disabling ZIP 209 enforcement and persisting
corrupted per-block deltas to disk. Independent recomputation is exactly the
check that catches that class of failure.

## The formula

```
Orchard pool balance = -( sum of valueBalanceOrchard over all transactions )
Sapling pool balance = -( sum of valueBalanceSapling over all transactions )
Sprout  pool balance =  ( sum of vpub_old ) - ( sum of vpub_new )
```

`valueBalance` is value *leaving* the pool. Negate to get value *held in* it.

## Two modes

**Mode B — Ironwood drain monitor (build this first)**

Index only from the NU6.3 activation height forward. Take the pool balance at
activation as a starting constant read from the node. Track the drain.

Small block range, works on a pruned node, delivers the actual product.

**Mode A — full independent recomputation (stretch)**

Recompute from Orchard activation (NU5, mainnet block 1687104) to tip, and
compare the result against the node's own reported figure. This is the real
verification, but it requires an **archive** node — a pruned node does not
retain the history needed.

Note the conflict: Zakura's pruned snapshot is the fast path to a running node,
but it cannot support Mode A. Use the pruned snapshot for Mode B; use the
archive snapshot if attempting Mode A.

## TASK 0 — Determine the RPC shape (do this first, report back)

Start the node and fetch one block:

```bash
curl -s -X POST http://127.0.0.1:8232 \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"1.0","id":"x","method":"getblock","params":["2000000",2]}' \
  | head -c 4000
```

Determine which is true:

- **(a)** the block response carries a `valuePools` array with per-block deltas
- **(b)** the block response inlines transaction objects carrying
  `valueBalanceOrchard` / `valueBalanceSapling`
- **(c)** neither — transaction detail needs a separate `getrawtransaction`
  call per txid

Also run `getblockchaininfo` and check whether it returns `valuePools` with
per-pool `chainValue`. That figure is the node's own answer, and Mode A compares
against it.

Report which case holds before writing the indexer. Case (c) means one RPC call
per transaction instead of one per block, which changes throughput by orders of
magnitude and makes batching mandatory.

## TASK 1 — Indexer

```sql
CREATE TABLE pool_balance (
  height          INTEGER PRIMARY KEY,
  block_hash      TEXT    NOT NULL,
  parent_hash     TEXT    NOT NULL,
  block_time      INTEGER NOT NULL,
  orchard_delta   INTEGER NOT NULL,  -- zatoshis, this block only
  sapling_delta   INTEGER NOT NULL,
  sprout_delta    INTEGER NOT NULL,
  orchard_balance INTEGER NOT NULL,  -- cumulative
  sapling_balance INTEGER NOT NULL,
  sprout_balance  INTEGER NOT NULL,
  tx_count        INTEGER NOT NULL
);
```

Hard requirements:

- **Integers only, in zatoshis. 1 ZEC = 100_000_000 zat.**
  The RPC returns ZEC as a JSON decimal. Do NOT parse to a JS float and multiply
  by 1e8 — that introduces rounding error. Extract the raw numeric literal as a
  string and convert to an integer by decimal-shifting the string.
- **Resumable.** On start, continue from `MAX(height)`. Never re-scan silently.
- **Reorg safe.** Before writing height N, confirm the stored `block_hash` at
  N-1 equals the new block's `parent_hash`. On mismatch, delete forward from the
  divergence point and re-index.
- **Bounded concurrency**, configurable, default 4.

## TASK 2 — Invariant checks

Run these continuously. They are the point of the tool.

1. `orchard_balance >= 0` at every height. A negative value means ZIP 209 was
   violated. This should never fire; if it does, it is the headline result.
2. From the NU6.3 activation height onward, every transaction's
   `valueBalanceOrchard >= 0`. A negative value means value entered a sealed
   pool. Flag the txid.
3. **(Mode A only)** recomputed `orchard_balance` at tip equals the node's own
   reported `chainValue` for Orchard. Disagreement means either your extraction
   is wrong or the node's accounting is. Investigate before publishing anything.

Each check writes a pass/fail record with the height and a timestamp. The output
is an audit log, not just a chart.

## TASK 3 — Output

```
GET /api/pool-balance?from=<height>&to=<height>
GET /api/checks            -> invariant results, most recent first
GET /api/drain             -> post-activation Orchard drain: balance over time,
                              rate, and current residual
```

Chart: Orchard balance from the activation height to tip, with the residual
called out as a single number. That residual is the story.

## Stack

- Node: Zakura or Zebra (interchangeable, same RPC). Testnet first.
- Indexer: TypeScript / Node
- Store: SQLite
- No wallet, no keys, no Zallet. Node RPC only.

## Testnet first

Ironwood already activated on testnet at height **4,134,000**. Real
post-activation drain data exists there today. Build and validate against
testnet, then point at mainnet after 28 July.

---

# PHASE 2 — Residual attestation

**Do not start this until Phase 1 is running and correct.** Phase 1 is a
complete, shippable project on its own. Phase 2 is a layer on top of it and is
substantially harder.

## The problem it solves

Phase 1 produces a residual: value left stranded in the sealed Orchard pool once
migration plateaus.

That number is ambiguous. Stranded value could be:

- lost keys, dead wallets, inactive holders — entirely legitimate
- counterfeit notes that could not exit through the turnstile

From the outside these are indistinguishable. The residual alone proves nothing,
which is the weakness of Phase 1 as a forensic instrument.

## The mechanism

Proof-of-balance lets a holder prove they control N ZEC inside the sealed pool
**without moving the funds and without revealing which notes are theirs**.

Each valid attestation accounts for part of the residual as legitimately held.
What remains unattested is a much sharper number than the raw residual.

```
residual              = value stranded in sealed Orchard pool
attested              = sum of verified proof-of-balance attestations
unattested_residual   = residual - attested
```

`unattested_residual` is the closest anyone gets to answering whether the
Orchard soundness bug was ever exploited.

## Honest limitation — state this in any writeup

Non-attestation does not prove counterfeit. Most holders will simply never
bother to attest, and holders of lost keys cannot. So `unattested_residual` is
an **upper bound** on possible counterfeit, and a loose one. It gets tighter as
attestation participation rises, and it is only meaningful alongside a stated
participation rate.

Do not overclaim this. The value is that the bound exists at all and shrinks
over time. Presenting it as proof of anything would be dishonest and would be
correctly torn apart by anyone who knows the protocol.

## Tasks

1. **Read the spec state.** There is no finished specification.
   - ZIP issue: https://github.com/zcash/zips/issues/1229
   - Fuller draft referenced as PR #1199
   - Original: https://zips.z.cash/draft-str4d-orchard-balance-proof

   Note the stated motivating use cases in #1229 are airdrops and coinholder
   voting. Turnstile residual attestation is not among them. That application
   is the novel contribution here.

2. **Circuit.** halo2. Prove knowledge of the spending authority for one or more
   Orchard notes, and reveal only the summed value via the value commitments
   (analogous to how `valueBalance` reveals a sum without revealing components).

3. **Anchor binding.** The proof must be bound to a specific note commitment
   tree anchor so it cannot be replayed against a different chain state. Fetch
   anchors via `z_gettreestate`. This is the RPC dependency, and it is
   load-bearing — the proof is meaningless without it.

4. **Nullifier-style deduplication.** Two attestations must not be able to claim
   the same note twice. Without this the attested total is trivially inflatable.
   This is the hardest design problem in Phase 2 and should be settled on paper
   before any circuit code is written.

5. **Storage and API.**

```sql
CREATE TABLE attestation (
  id             TEXT PRIMARY KEY,
  anchor         TEXT    NOT NULL,
  anchor_height  INTEGER NOT NULL,
  claimed_value  INTEGER NOT NULL,  -- zatoshis
  proof          BLOB    NOT NULL,
  dedup_tag      TEXT    NOT NULL UNIQUE,
  verified_at    INTEGER NOT NULL
);
```

```
POST /api/attest      -> submit proof, verify, store
GET  /api/residual    -> residual, attested, unattested, participation rate
```

## Warnings

- The specification is a moving target. Anything built now may need reworking.
- There is no reference implementation to check against.
- Scope is weeks, not days. Budget accordingly.
- If Phase 2 does not land, Phase 1 still stands alone as a finished project.
  Protect that.

## References

- ZIP 209 — Prohibit Out-of-Range Chain Value Pool Balances
  https://zips.z.cash/zip-0209
- ZIP 258 — Deployment of the NU6.3 Network Upgrade
  https://github.com/zcash/zips/blob/main/zips/zip-0258.md
- Zebra value pool implementation notes
  https://zebra.zfnd.org/dev/rfcs/0012-value-pools.html
- ZIP 224 — Orchard Shielded Protocol (circuit background for Phase 2)
  https://zips.z.cash/zip-0224
- Orchard Proof-of-Balance, open ZIP issue
  https://github.com/zcash/zips/issues/1229