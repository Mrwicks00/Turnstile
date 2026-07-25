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
