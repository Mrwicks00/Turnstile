# Vendored WebZjs build

Source: https://github.com/ChainSafe/WebZjs
Pinned commit: a50df944c32243cb8da9f86e7d52cb65ac926439
Built: 2026-07-25 via  /
Toolchain: rustc nightly-2025-01-07 (per WebZjs's rust-toolchain.toml at this commit), wasm-pack 0.13.1, clang-17

These directories (webzjs-wallet/, webzjs-keys/) are wasm-pack "-t web" build output —
no npm package exists for these (unpublished workspace packages). Not audited software;
see migrate.html's warning banner. To rebuild: clone WebZjs at the commit above, install
the toolchain, run `just build-wallet && just build-keys`, copy packages/webzjs-wallet
and packages/webzjs-keys here (preserve the nested snippets/ paths).

## Local patches (webzjs-wallet only)

Patches 1, 2, and 4 are in WebZjs's own `crates/webzjs-wallet/src/wallet.rs` (edited
directly in the WebZjs clone before running `just build-wallet` - normal cargo change
detection works fine for these). Patch 3 is against the *external* git dependency checkout
at `~/.cargo/git/checkouts/librustzcash-nu61-*/*/zcash_client_memory/` - reproducing it
requires re-applying it to a fresh checkout of that dependency (fetched by Cargo when
building WebZjs, pinned via WebZjs's own Cargo.lock).

**Gotcha for patch 3 specifically**: Cargo's fingerprinting for git dependencies did not
pick up in-place edits to that checkout on its own - after editing, delete the stale build
artifacts (`target/wasm32-unknown-unknown/release/{build,deps,.fingerprint}/zcash_client_memory-*`)
before rebuilding, or the edit is silently ignored and the previous binary gets reused
(caught this by comparing output hashes before/after - identical hash meant the edit never
actually compiled in).

1. **`propose_transfer`'s error handling** discarded the real error from the underlying
   `zcash_client_backend::data_api::wallet::propose_transfer` call
   (`.map_err(|_e| Error::Generic("...possibly insufficient balance..".to_string()))`),
   making every real failure indistinguishable and undiagnosable from JS. Patched to
   `.map_err(|e| Error::Generic(format!("propose_transfer real error: {:?}", e)))`.

2. **`zcash_client_memory`'s `note_is_spendable`, `None`-scope arm**: turned out NOT to be
   the actual cause for the specific stuck note investigated (debug logging - see patch 3 -
   showed `scope=Some(External) scope_ok=true` for it), but kept anyway since it's still a
   real incompleteness fix for whenever scope genuinely can't be classified. Falls back to
   the same (stricter) confirmation requirement as `Some(Scope::External)` instead of
   unconditionally `false`.

3. **`zcash_client_memory`'s `note_is_spendable`, `note_in_unscanned_range` check**: the
   actual real cause for the stuck note. For each range still queued above `Scanned`
   priority (kept near the chain tip intentionally, for reorg protection), the code tries to
   resolve the range's note-commitment-tree subtree/checkpoint position bounds; when that
   lookup can't resolve, it defaulted to `true` ("assume this note falls in the unscanned
   range"), regardless of the note's actual position. Confirmed via targeted per-condition
   debug logging (`tracing::warn!`, since `webzjs-wallet` already bridges Rust `tracing` to
   the browser console via `tracing-web`) that this was blanket-flagging a real,
   fully-scanned, fully-confirmed note (`fully_scanned_height == chain_tip`) as permanently
   unspendable. Patched the fallback to `false` (don't assume unscanned when position data
   is missing). **This is a real conservative-to-permissive posture change**, not a narrow
   incompleteness fix like the others - accepted here because it was empirically confirmed
   safe for the specific note investigated, and this is testnet-only, already-disclaimed
   experimental software. The `tracing::warn!` debug logging from this investigation is
   still present in the build (harmless, just verbose) - remove `note_is_spendable`'s
   `// TURNSTILE DEBUG PATCH` block on the next rebuild if a quieter build is wanted.

4. **Three `MultiOutputChangeStrategy::new(...)` call sites** (`propose_transfer`, the
   shielding function, and the PCZT-transfer function) all hardcoded
   `ShieldedProtocol::Orchard` as the preferred pool for change/shielding outputs. Real
   consequence, confirmed by an actual network rejection after a real proof + broadcast:
   `"failed to validate tx: ... the Orchard value balance must be non-negative from NU6.3
   onward"` - the library, unaware NU6.3 forbids new Orchard deposits, tried to route the
   change from a Sapling-only spend into a **new** Orchard note, which the real network
   correctly rejects as a turnstile violation. Patched all three `ShieldedProtocol::Orchard`
   to `ShieldedProtocol::Sapling` - Sapling remains a valid destination for new value,
   sidestepping the freeze entirely for the common case (spending funds that aren't already
   in Orchard). Does not help move funds that are *already* in Orchard (the pool this whole
   project is about) - the library still can't construct anything Orchard-side without
   violating the turnstile it doesn't know exists; this only fixes the change/shielding path
   for non-Orchard inputs.
