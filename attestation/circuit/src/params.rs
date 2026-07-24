//! Fixed, project-wide constants for the residual-attestation circuit.
//!
//! EXPERIMENTAL / UNAUDITED. Based on an unreviewed, unmerged draft ZIP
//! (<https://zips.z.cash/draft-str4d-orchard-balance-proof>, refined in the still-open,
//! zero-approval `zcash/zips` PR #1199 — the one active reviewer dismissed their own review
//! in March 2026). No external cryptographic audit has been performed. See
//! `attestation/SECURITY.md`.

use pasta_curves::pallas;

/// The domain-separation label fed into the alternate-nullifier PRF, together with a
/// network id (see [`network_id`]).
///
/// CORRECTNESS-CRITICAL: this must be a FIXED, PERMANENT constant that never varies by
/// anchor height or attestation epoch. If the domain incorporated e.g. the anchor height,
/// the same note would produce a different alternate nullifier at every new anchor, letting
/// a holder re-attest the identical note indefinitely while still passing the
/// `attestation.dedup_tag UNIQUE` check every time (different anchor -> different domain ->
/// different nf_dom -> no collision detected). Making the domain a fixed constant is what
/// makes dedup global and permanent by construction, at the cost of the known limitation
/// that this alone cannot detect a note being *re-spent* after attestation (see Stage D in
/// the project plan - that requires the nullifier non-membership tree, not this).
pub const DOMAIN_LABEL: &str = "turnstile-residual-attestation";

/// Distinguishes mainnet from testnet attestations sharing the same domain label, so a
/// testnet attestation can never collide with (or be replayed as) a mainnet one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NetworkId {
    Mainnet,
    Testnet,
}

impl NetworkId {
    pub fn as_str(self) -> &'static str {
        match self {
            NetworkId::Mainnet => "mainnet",
            NetworkId::Testnet => "testnet",
        }
    }
}

/// Version tag stored alongside every attestation and verifier result, so the `attestation`
/// table - and anyone reading it years from now, which is the whole forensic point of this
/// project - is self-documenting about exactly which (unaudited) circuit version produced
/// each row.
pub const CIRCUIT_VERSION: &str = "turnstile-attestation-circuit-v0-stageA";

/// The real Orchard note commitment tree depth (confirmed against the actual zcash/orchard
/// source: `orchard::constants::MERKLE_DEPTH_ORCHARD = 32`). This is a DIFFERENT tree from
/// the nullifier non-membership/exclusion tree that Stage D will need (that tree's depth is
/// a separate, still-unaudited recommendation from the draft ZIP, not this constant).
pub const MERKLE_DEPTH_ORCHARD: usize = 32;

/// Placeholder type until Stage B needs to move field-element construction into its own
/// module; kept here for now so params.rs and alt_nullifier.rs agree on the field type
/// without a circular import.
pub type Base = pallas::Base;
