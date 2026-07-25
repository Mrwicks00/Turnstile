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

2. **`zcash_client_memory/src/types/memory_wallet/mod.rs`'s `note_is_spendable`** treated a
   note with an undetermined `recipient_key_scope` (`None`) as unconditionally unspendable
   forever, regardless of confirmations - observed in practice for a real, correctly-valued,
   unspent, fully-confirmed testnet note received via a diversified Sapling address not
   produced by this wallet's own address-generation flow (its scope just never got
   classified by the underlying scanning logic - a real, separate gap upstream in
   `zcash_client_backend`/`zcash_client_memory`, not something fixable at this layer).
   Patched the `None` arm to fall back to the same (stricter) confirmation requirement as
   `Some(Scope::External)` instead of `false` - every other check (spent status, value
   floor, nullifier/position/mined-height presence) is untouched, so this only stops an
   incompleteness bug from being a permanent freeze, it doesn't relax any actual security
   check.
