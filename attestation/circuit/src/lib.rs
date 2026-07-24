//! Turnstile Phase 2 — residual attestation circuit.
//!
//! EXPERIMENTAL / UNAUDITED. Based on an unreviewed, unmerged draft ZIP
//! (<https://zips.z.cash/draft-str4d-orchard-balance-proof>, refined in the still-open,
//! zero-approval `zcash/zips` PR #1199 — the one active reviewer dismissed their own review
//! in March 2026 saying "I'm unable to continue reviewing this"). There is no external
//! cryptographic audit of anything in this crate. See `attestation/SECURITY.md` before
//! depending on this for anything beyond research/experimentation.
//!
//! Staged build-out (see the project plan for full detail):
//!   Stage A (`alt_nullifier` module) - off-circuit primitives. DONE, tested (5 tests).
//!   Stage B (`note_gadget` module) - PARTIAL: value commitment integrity is implemented
//!             and tested via MockProver in both directions (valid witness accepted;
//!             tampered value, tampered rcv, and tampered public instance each independently
//!             rejected - 4 tests). Commitment-tree Merkle path membership and spend
//!             authority (rk derivation + RedDSA) are NOT yet implemented - the real
//!             end-to-end proving/verifying key round trip described in the project plan
//!             has not been attempted yet, only MockProver.
//!   Stage C - in-circuit alternate-nullifier gadget as a public output, cross-checked
//!             against Stage A's oracle. Not yet implemented.
//!   Stage D - nullifier non-membership/exclusion tree. Explicitly BLOCKED on Phase 1's
//!             own already-deferred "Mode A" (archive node) shipping first. Do not attempt
//!             a partial version - an incomplete exclusion tree fails in the dangerous
//!             direction (a spent note could pass as unspent).
//!
//! Notable finding from building Stage B: `orchard::circuit`'s own internal gadget helpers
//! (e.g. `gadget::value_commit_orchard`) are deliberately scoped private to that module and
//! not reusable externally, even with the `unstable-voting-circuits` feature (that feature
//! only lifts visibility on `constants`/`spec`, not `circuit::gadget`). This crate's gadgets
//! are therefore original implementations using the same real, audited fixed-base constants
//! and the same halo2_gadgets EccChip/SinsemillaChip configuration pattern real Orchard uses
//! (confirmed by reading `zcash/orchard`'s and `zcash/halo2`'s own source directly), not
//! copies of orchard's internal circuit code.

pub mod alt_nullifier;
pub mod note_gadget;
pub mod params;
