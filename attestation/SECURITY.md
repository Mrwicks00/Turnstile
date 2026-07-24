# Security notes — Turnstile Phase 2 (residual attestation)

## Status: EXPERIMENTAL / UNAUDITED

- No external cryptographic audit has been performed on any code in this workspace.
- The circuit is based on an **unreviewed, unmerged** draft ZIP:
  <https://zips.z.cash/draft-str4d-orchard-balance-proof>, refined further in
  [`zcash/zips` PR #1199](https://github.com/zcash/zips/pull/1199). That PR has zero
  approving reviews. Its one active reviewer (str4d) explicitly dismissed their own review
  in March 2026: "I'm unable to continue reviewing this, so dismissing my review to ensure
  it doesn't block merging." Treat nothing in the upstream draft as battle-tested.
- No trusted-setup ceremony has occurred. halo2's IPA proving system is transparent
  (no toxic waste to generate via ceremony) — but the proving/verifying parameters are still
  generated artifacts that must be version-pinned and distributed carefully; "transparent"
  does not mean "nothing to get wrong here."

## Trust boundary (non-negotiable, enforced at the crate level)

- **Proving** happens only on the holder's own machine, using their own Orchard spending
  key material. `attestation/prover` is the only crate in this workspace that ever touches
  key material.
- **Verification** happens on the Turnstile service and must never receive, request, or
  store key material of any kind — only a proof blob, a claimed value, and an anchor.
  `attestation/verifier`'s `Cargo.toml` should be reviewable on its own to confirm it has no
  path to deriving or handling spending keys. If a future change to `verifier/Cargo.toml`
  adds a dependency capable of key derivation, that is a bug in itself, independent of
  anything else.

## Dependency policy

Only these two upstream crate families are trusted, and only from their real, official
repositories:

| Crate | Repository |
|---|---|
| `orchard` | `github.com/zcash/orchard` |
| `halo2_gadgets`, `halo2_proofs` | `github.com/zcash/halo2` |

All three are **exact-pinned** (`=x.y.z`, not caret ranges) in `attestation/Cargo.toml`'s
`[workspace.dependencies]`. A version bump to any of them is a reviewed event, not a
routine `cargo update` — an automatic minor-version bump to security-critical crypto code
is itself a supply-chain risk.

**Explicitly not used, and not to be added without serious independent verification**:
`imt-tree` (`github.com/valargroup/vote-nullifier-pir`) and `voting-circuits`
(`github.com/valargroup/voting-circuits`) — both found on crates.io during Phase 2 research,
both implementing suspiciously exactly the mechanisms this project needs (nullifier
non-membership proofs, Zcash shielded-voting circuits), both published under an unfamiliar
org ("Valar Group") that this project already had to independently verify via minisign
signature in an unrelated context (the Zakura node fork, see `TASK0_FINDINGS.md`). This
precise a vocabulary match, for an unmerged/zero-review spec, from an unproven org, is
treated as a hard "do not depend on this" signal — not proof of malice, but a bar this
project isn't in a position to clear via casual review. If a future contributor wants to
use either crate, that requires out-of-band verification of the publishing org's identity
and a full manual source read, before it ever touches a machine with real spending keys.

## Circuit version tracking

Every attestation row and every verifier CLI result carries a `circuitVersion` field
(`turnstile_circuit::params::CIRCUIT_VERSION`). This is deliberate: the `attestation` table
is meant to be read years from now as part of the project's forensic record, so every row
must be self-documenting about exactly which (unaudited, versioned) circuit produced it.

## Current implementation status

- **Stage A** (off-circuit alternate-nullifier primitive) — implemented, tested.
- **Stage B** (minimal single-note circuit) — not yet implemented.
- **Stage C** (in-circuit dedup wiring) — not yet implemented.
- **Stage D** (nullifier non-membership/exclusion tree) — explicitly deferred, blocked on
  Phase 1's own already-deferred "Mode A" (archive node) shipping first. Do not attempt a
  partial version.
- **Stage E** (real anchor fetching via `z_gettreestate`) — implemented on the TypeScript
  side (`src/rpc.ts`), empirically verified against a live node.
