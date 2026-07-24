//! Turnstile Phase 2 — holder-run prover CLI.
//!
//! ============================================================================
//! WARNING: this tool handles your real Orchard spending key material offline.
//! The circuit it uses is UNAUDITED, NOVEL, and based on an unmerged draft spec
//! (zcash/zips PR #1199, zero approving reviews). Review the source before
//! running this against a mainnet spending key.
//! ============================================================================
//!
//! STUB: Stage B (the actual circuit) is not implemented yet. This binary exists so the
//! Cargo workspace builds end-to-end; it does not yet produce real proofs.

fn main() {
    eprintln!(
        "turnstile-prover: circuit not yet implemented (Stage B). \
         See attestation/circuit/src/lib.rs for current status."
    );
    std::process::exit(1);
}
