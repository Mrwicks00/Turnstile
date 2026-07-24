# Task 0 findings — RPC shape (testnet)

Nodes tested: `zakurad` v1.0.3 (Zebra fork, "Valar Group") and `zebrad` v6.2.1
(official Zcash Foundation release), both testnet, RPC on `127.0.0.1:8232`
with cookie auth. Both binaries verified — Zakura via minisign signature
against the publisher's key, Zebra via SHA256SUMS from the official GitHub
release. §§1-2 were answered against Zakura; §3 (the central question)
required switching to Zebra because Zakura's sync never completed reliably
(see "Zakura sync reliability" below) — the RPC *shape* is expected to be
identical between them since Zakura inherits this code from Zebra, and
nothing in the known Zakura bugs touches the `getblock`/`getblockchaininfo`
handlers themselves, only the P2P sync layer.

## 1. Node reachable, network + height — CONFIRMED

`getblockchaininfo` works over cookie-authenticated JSON-RPC
(`Authorization: Basic <cookie>` where the cookie is read from
`~/.cache/zakura/.cookie`, format `__cookie__:<token>`).

```
curl -s -X POST http://127.0.0.1:8232 -u "$(cat ~/.cache/zakura/.cookie)" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"1.0","id":"x","method":"getblockchaininfo","params":[]}'
```

Reports `"chain":"test"` and a real, advancing `blocks`/`headers` count.

## 2. valuePools with chainValue — CONFIRMED, raw JSON below

```json
{
  "jsonrpc": "1.0",
  "id": "x",
  "result": {
    "chain": "test",
    "blocks": 59600,
    "headers": 59600,
    "difficulty": 1.0633803683869723e+37,
    "verificationprogress": 0.017280872162138652,
    "chainwork": 0,
    "pruned": true,
    "size_on_disk": 200372858,
    "commitments": 0,
    "bestblockhash": "0021b489b7770ef9328bf3dd9be2bdbe26820333f6a40788df7b3b73a78c2f65",
    "estimatedheight": 3448900,
    "chainSupply": {
      "chainValue": 620012.4871755,
      "chainValueZat": 62001248717550,
      "monitored": true
    },
    "valuePools": [
      { "id": "transparent", "chainValue": 569189.51696138, "chainValueZat": 56918951696138, "monitored": true },
      { "id": "sprout",      "chainValue": 50822.97021412,  "chainValueZat": 5082297021412,  "monitored": true },
      { "id": "sapling",     "chainValue": 0.0, "chainValueZat": 0, "monitored": false },
      { "id": "orchard",    "chainValue": 0.0, "chainValueZat": 0, "monitored": false },
      { "id": "lockbox",    "chainValue": 0.0, "chainValueZat": 0, "monitored": false },
      { "id": "ironwood",   "chainValue": 0.0, "chainValueZat": 0, "monitored": false }
    ],
    "upgrades": { "...": { "name": "...", "activationheight": 0, "status": "pending" } },
    "consensus": { "chaintip": "00000000", "nextblock": "00000000" }
  },
  "error": null
}
```

Key points:

- Each pool entry carries **both** `chainValue` (ZEC, JSON float/decimal) and
  **`chainValueZat` (integer zatoshi)**. At the chain-info level there is no
  need to decimal-shift a string — the integer is handed to you directly.
- `monitored: false` for a pool means its network upgrade hasn't activated
  yet on this chain (sapling/orchard/lockbox/ironwood are all pre-activation
  at height 59,600 on testnet). `monitored` flips to `true` at activation.
  Relevant for Mode B: `orchard.monitored` should already be `true` well
  before the NU6.3 sealing height (1687104 is Orchard/NU5 activation).
- This directly answers Task 0 point 2: **yes**, `getblockchaininfo` returns
  `valuePools` with per-pool `chainValue`, and it's the node's own answer
  Mode A needs to compare against (via `chainValueZat`, no parsing required).

## 3. getblock verbosity 2 shape (case a/b/c) — DETERMINED: (a) AND (b), NOT (c)

**Zakura v1.0.3 could not answer this** — four separate sync attempts (see
"Zakura sync reliability" below) all hit a reproducible stall in the
block-body-sync pipeline before ever producing a working `getblock` response.
We switched to real upstream **Zebra v6.2.1** (`ZcashFoundation/zebra`,
official release, SHA256-checksum verified) on the same testnet, and it
synced cleanly with `getblock` working from the very first check (block 1
retrievable within seconds of startup, no stall).

**Both (a) and (b) are true at once** — the spec's three cases weren't
mutually exclusive in practice:

```
curl -s -X POST http://127.0.0.1:8232 -u "$(cat ~/.cache/zebra/.cookie)" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"1.0","id":"x","method":"getblock","params":["1",2]}'
```

```json
{
  "jsonrpc": "1.0",
  "id": "x",
  "result": {
    "hash": "025579869bcf52a989337342f5f57a84f3a28b968f7d6a8307902b065a668d23",
    "height": 1,
    "nTx": 1,
    "tx": [
      {
        "txid": "f37e9f691fffb635de0999491d906ee85ba40cd36dae9f6e5911a8277d7c5f75",
        "vin": [ { "coinbase": "510101", "sequence": 4294967295 } ],
        "vout": [
          { "value": 0.0005, "valueZat": 50000, "n": 0, "scriptPubKey": { "...": "..." } },
          { "value": 0.000125, "valueZat": 12500, "n": 1, "scriptPubKey": { "...": "..." } }
        ],
        "vShieldedSpend": [],
        "vShieldedOutput": [],
        "vjoinsplit": [],
        "orchard": { "actions": [], "valueBalance": 0.0, "valueBalanceZat": 0 },
        "valueBalance": 0.0,
        "valueBalanceZat": 0,
        "overwintered": false,
        "version": 1,
        "locktime": 0
      }
    ],
    "chainSupply": { "chainValue": 0.000625, "chainValueZat": 62500, "monitored": true },
    "valuePools": [
      { "id": "transparent", "chainValue": 0.000625, "chainValueZat": 62500, "monitored": true, "valueDelta": 0.000625, "valueDeltaZat": 62500 },
      { "id": "sprout",      "chainValue": 0.0, "chainValueZat": 0, "monitored": false, "valueDelta": 0.0, "valueDeltaZat": 0 },
      { "id": "sapling",     "chainValue": 0.0, "chainValueZat": 0, "monitored": false, "valueDelta": 0.0, "valueDeltaZat": 0 },
      { "id": "orchard",     "chainValue": 0.0, "chainValueZat": 0, "monitored": false, "valueDelta": 0.0, "valueDeltaZat": 0 },
      { "id": "lockbox",     "chainValue": 0.0, "chainValueZat": 0, "monitored": false, "valueDelta": 0.0, "valueDeltaZat": 0 },
      { "id": "ironwood",    "chainValue": 0.0, "chainValueZat": 0, "monitored": false, "valueDelta": 0.0, "valueDeltaZat": 0 }
    ],
    "previousblockhash": "05a60a92d99d85997cce3b87616c089f6124d7342af37106edc76126334a2c38",
    "nextblockhash": "00f1a49e54553ac3ef735f2eb1d8247c9a87c22a47dbd7823ae70adcd6c21a18"
  },
  "error": null
}
```

Key implications for the indexer:

- **(a) confirmed**: the block itself carries `valuePools` with per-pool
  `chainValue`/`chainValueZat` (cumulative to this block) **and
  `valueDelta`/`valueDeltaZat`** (this block's delta) — the node computes
  the per-block delta for you. This could arguably replace summing
  `valueBalance` across transactions entirely for the trusted-node figure,
  though the spec's whole point is *independent* recomputation, so Task 1
  should still sum from `tx[]` and use `valueDelta`/`chainValue` only as
  the cross-check (Mode A invariant #3), not as the source of truth.
- **(b) confirmed**: `tx` is an array of full transaction objects, not
  txids. Sapling's `valueBalance`/`valueBalanceZat` sits at the top level
  of each transaction; Orchard's sits inside a nested `orchard` object
  (`orchard.valueBalance` / `orchard.valueBalanceZat`). `vjoinsplit` is
  where Sprout's `vpub_old`/`vpub_new` per-joinsplit entries will appear
  (empty in this block; not yet exercised empirically this session).
- **(c) ruled out**: no separate `getrawtransaction` call is needed. One
  `getblock` call per block is sufficient — this is the good case for
  throughput, exactly as the spec hoped.
- **Encoding confirmed end-to-end**: every decimal ZEC field (`value`,
  `valueBalance`, `chainValue`, `valueDelta`) has a sibling integer zatoshi
  field (`valueZat`, `valueBalanceZat`, `chainValueZat`, `valueDeltaZat`).
  The indexer never needs to parse or decimal-shift a string — read the
  `*Zat` fields directly as JSON integers.

## Zakura sync reliability (separate from the RPC-shape question)

Before switching to Zebra, four Zakura v1.0.3 sync attempts all stalled
before producing a working `getblock`:

| Attempt | Config | Stalled at height |
|---|---|---|
| 1 | default (`checkpoint_sync=true`, pruned) | 140,800 |
| 2 | `checkpoint_sync=false` (full validation) | 74,800 |
| 3 | same + IPv6 disabled at OS level | 59,600 |
| 4 | same again (retry) | 20,800 |

Every attempt: steady progress, then a hard freeze (`time_since_last_state_block`
climbing indefinitely), correlated with a stuck peer connection
(`Network is unreachable` / `Cannot assign requested address` to the same
IPv6 destination, repeating). `getblockhash`/`getbestblockhash` worked
throughout; `getblock` returned `"block not found"` at every height tested,
including the current tip, ruling out pruning retention as the explanation.

This matches **currently open, unresolved issues in zakura-core/zakura**:
- **#322** — "fix(sync): recover near-tip legacy sync stall with a FindHeaders
  fallback": an operator report of sync making zero progress despite the
  correct next block being available, root-caused to a bug in `obtain_tips`
  described as "inherited verbatim from upstream Zebra."
- **#166** — "fix(network): ability to re-connect reactor kicked peers": a
  stuck peer connection's stream can remain permanently unavailable without
  recovery — this part is Zakura-specific (its custom iroh/QUIC-based "Zakura
  P2P v2" transport; real Zebra uses plain TCP and doesn't have this
  component).

A published Zakura snapshot (avoiding sync entirely) was also attempted and
failed independently: `zakura.valargroup.dev` would not complete a TLS
handshake from this machine across three attempts (unrelated to the sync bug).

**Zebra v6.2.1 does not exhibit this** — synced cleanly with no stalls in the
time we ran it. One of the two known bug patterns (#322) is described as
inherited from upstream Zebra, so it isn't guaranteed proof-immune, but in
practice this session it worked on the first try. Recommend Zebra over this
Zakura build for anything beyond quick RPC-shape spelunking.

## 4. Real, unplanned finding: a dedicated indexer RPC exists

The binary ships a **separate gRPC "Indexer" service**
(`zebra.indexer.rpc.Indexer`, with `BlockAndHash`, `BlockRequest`,
`BlockHashAndHeight`, `MempoolChangeMessage`, `NonFinalizedStateChangeRequest`
message types, plus gRPC server reflection), gated behind a config field
`rpc.indexer_listen_addr` (unset/disabled by default). Startup logs a WARN:

```
configure an indexer_listen_addr to start the indexer RPC server
```

This is inherited from upstream Zebra, not Zakura-specific. **This is very
likely the intended interface for exactly what Task 1 needs** (structured,
indexed block/tx data) rather than routing through `getblock` /
`getrawtransaction` at all. It wasn't tested this session (out of scope,
and the underlying sync-stall bug would have blocked it too), but it's the
strongest lead for whoever picks up Task 1 — worth enabling
`indexer_listen_addr` and inspecting its schema via gRPC reflection before
committing to a `getblock`-based design.

## 5. Value encoding — CONFIRMED end-to-end (see §3)

Every decimal ZEC field, at both chain-summary and per-transaction level,
has a sibling integer-zatoshi field (`chainValueZat`, `valueDeltaZat`,
`valueBalanceZat`, `valueZat`). All are plain JSON numbers (not strings),
exact at these magnitudes. The indexer should read the `*Zat` fields
directly rather than parsing/decimal-shifting the ZEC decimal strings —
satisfies the spec's "integers only, in zatoshis" requirement without any
string manipulation.

## Trust/supply-chain notes (for the record)

- `zakura-core/zakura` on GitHub: real project, forked from Zebra, Apache-2.0/MIT,
  6,538 commits. Binary release v1.0.3 verified via minisign against the
  publisher's published key (`RWTZkHOmfhxdQf43RZJyOawUNvMSlbPH539O9Y2Sir/ZHTihqnSO1RZn`)
  — signature and trusted comment (`zakura v1.0.3 SHA256SUMS.txt`) checked out,
  and the hash matched both `SHA256SUMS.txt` and the value hardcoded in the
  installer script.
- `gh attestation verify` was not available (local `gh` 2.46.0 predates that
  subcommand) — attestation was not checked, signature verification was.
- The binary's own version banner attributes it to **Valar Group**, the same
  org behind the `valargroup/zcashd` "zcashd-compat" sidecar bundled in the
  installer — i.e. one company operating under two GitHub org names, not two
  unrelated projects as initially assumed.

## Scripts

Throwaway install/probe scripts (official Zakura installer, ad-hoc
`curl`/`wait_*.sh` polling scripts, Zebra binary fetch+verify) are in the
session scratchpad, not committed to the repo — none are needed going
forward. The Zebra config that actually produced the working `getblock`
response was:

```toml
[network]
network = "Testnet"
[state]
cache_dir = "/home/user/.cache/zebra"
[rpc]
listen_addr = "127.0.0.1:8232"
```
