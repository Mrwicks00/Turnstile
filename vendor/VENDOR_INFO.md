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

Both patches are against the upstream git dependency checkout at
`~/.cargo/git/checkouts/librustzcash-nu61-*/*/`, not against WebZjs's own `crates/`
directory - reproducing this build requires re-applying them to a fresh checkout of that
dependency (fetched by Cargo when building WebZjs, pinned via WebZjs's own Cargo.lock).
**Gotcha**: Cargo's fingerprinting for git dependencies did not pick up in-place edits to
that checkout on its own - after editing, delete the stale build artifacts
(`target/wasm32-unknown-unknown/release/{build,deps,.fingerprint}/zcash_client_memory-*`)
before rebuilding, or the edit is silently ignored and the previous binary gets reused.

1. **`crates/webzjs-wallet/src/wallet.rs`'s `propose_transfer`** discarded the real error
   from the underlying `zcash_client_backend::data_api::wallet::propose_transfer` call
   (`.map_err(|_e| Error::Generic("...possibly insufficient balance..".to_string()))`),
   making every real failure indistinguishable and undiagnosable from JS. Patched to
   `.map_err(|e| Error::Generic(format!("propose_transfer real error: {:?}", e)))`.

2. **`zcash_client_memory/src/types/memory_wallet/mod.rs`'s `note_is_spendable`** - `None`
   scope arm: turned out NOT to be the actual cause for the specific stuck note investigated
   (debug logging - see patch 3 - showed `scope=Some(External) scope_ok=true` for it), but
   kept anyway since it's still a real incompleteness fix for whenever scope genuinely can't
   be classified. Falls back to the same (stricter) confirmation requirement as
   `Some(Scope::External)` instead of unconditionally `false`.

3. **`unscanned_ranges()`'s consumer in `note_is_spendable`** (the `note_in_unscanned_range`
   check): the actual real cause. For each range still queued above `Scanned` priority (kept
   near the chain tip intentionally, for reorg protection), the code tries to resolve the
   range's note-commitment-tree subtree/checkpoint position bounds; when that lookup can't
   resolve, it defaulted to `true` ("assume this note falls in the unscanned range"),
   regardless of the note's actual position. Confirmed via targeted per-condition debug
   logging (`tracing::warn!`, since `webzjs-wallet` already bridges Rust `tracing` to the
   browser console via `tracing-web`) that this was blanket-flagging a real, fully-scanned,
   fully-confirmed note (`fully_scanned_height == chain_tip`) as permanently unspendable.
   Patched the fallback to `false` (don't assume unscanned when position data is missing).
   **This is a real conservative-to-permissive posture change**, not a narrow incompleteness
   fix like the other two - accepted here because it was empirically confirmed safe for the
   specific note investigated, and this is testnet-only, already-disclaimed experimental
   software. The `tracing::warn!` debug logging from patch 2's investigation is still present
   in this build (harmless, just verbose) - remove `note_is_spendable`'s
   `// TURNSTILE DEBUG PATCH` block on the next rebuild if a quieter build is wanted.
