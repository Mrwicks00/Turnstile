//! Stage A: the off-circuit "oracle" for the domain-separated alternate nullifier.
//!
//! EXPERIMENTAL / UNAUDITED. See `attestation/SECURITY.md` and `params.rs`'s module docs.
//!
//! This is plain Rust, no halo2 circuit yet - Stage B/C will build the in-circuit gadget
//! version and cross-check it against this reference implementation on matching inputs
//! (a real, common failure mode in halo2 development is a mismatch between a primitive
//! reference implementation and its in-circuit chip; testing this explicitly is required,
//! not optional, before Stage C is considered done).
//!
//! Formula, following the more complete/refined `zcash/zips` PR #1199 draft rather than the
//! earlier elliptic-curve-based construction in the original str4d draft (PR #1199 is
//! explicitly described upstream as the fuller, more complete proposal):
//!
//!   nf_dom = Poseidon(nk, dom, nf)
//!
//! using Orchard's own real Poseidon parameterization (P128Pow5T3, width 3 rate 2,
//! ConstantLength<3>) - the exact same instantiation the real `orchard` crate uses
//! internally for its standard nullifier PRF (see `orchard::spec::prf_nf`, which computes
//! `Poseidon(nk, rho)` under `ConstantLength<2>`). Reusing the identical Poseidon
//! instantiation, rather than inventing a different one, is a deliberate risk-reduction
//! choice: it's the same well-exercised code path Orchard's own consensus-critical
//! nullifier derivation depends on.
//!
//! `nk` and `nf` here are real Orchard field elements (the holder's nullifier-deriving key,
//! and the note's real standard nullifier - both witnesses, NEVER revealed). Only `dom`
//! (a fixed, public, project-wide constant - see `params::DOMAIN_LABEL`) and the resulting
//! `nf_dom` are ever exposed publicly.

use halo2_gadgets::poseidon::primitives::{self as poseidon, ConstantLength, P128Pow5T3};
use pasta_curves::pallas;

use crate::params::{NetworkId, DOMAIN_LABEL};

/// Derives the fixed, public `dom` field element for a given network, from
/// `params::DOMAIN_LABEL` and the network id. Uses BLAKE2b (the same hash family Orchard's
/// own protocol uses pervasively for personalized/domain-separated hashing elsewhere, e.g.
/// PRF^expand) with a 64-byte digest mapped into the Pallas base field via
/// `FromUniformBytes`, which is the standard "hash arbitrary bytes into this field" pattern
/// used throughout the pasta_curves/orchard ecosystem (see e.g. orchard's own
/// `pallas::Scalar::from_uniform_bytes` usage in its property-test generators).
///
/// This domain-derivation scheme is a Turnstile-specific design choice (residual attestation
/// is explicitly not one of the draft ZIP's own motivating use cases), not something
/// specified byte-for-byte upstream - documented here so a future reader knows it was a
/// deliberate choice, not an assumption.
pub fn derive_domain(network: NetworkId) -> pallas::Base {
    use group::ff::FromUniformBytes;

    let mut hasher = blake2b_simd::Params::new()
        .hash_length(64)
        .personal(b"Turnstile_AttDom")
        .to_state();
    hasher.update(DOMAIN_LABEL.as_bytes());
    hasher.update(network.as_str().as_bytes());
    let digest = hasher.finalize();

    let mut wide = [0u8; 64];
    wide.copy_from_slice(digest.as_bytes());
    pallas::Base::from_uniform_bytes(&wide)
}

/// The off-circuit alternate-nullifier oracle: `nf_dom = Poseidon(nk, dom, nf)`.
pub fn derive_alternate_nullifier(nk: pallas::Base, dom: pallas::Base, nf: pallas::Base) -> pallas::Base {
    poseidon::Hash::<_, P128Pow5T3, ConstantLength<3>, 3, 2>::init().hash([nk, dom, nf])
}

#[cfg(test)]
mod tests {
    use super::*;
    use group::ff::Field;
    use rand::rngs::OsRng;

    fn random_base() -> pallas::Base {
        pallas::Base::random(OsRng)
    }

    #[test]
    fn deterministic_same_inputs_same_output() {
        let nk = random_base();
        let nf = random_base();
        let dom = derive_domain(NetworkId::Testnet);

        let a = derive_alternate_nullifier(nk, dom, nf);
        let b = derive_alternate_nullifier(nk, dom, nf);
        assert_eq!(a, b, "same (nk, dom, nf) must always produce the same nf_dom");
    }

    #[test]
    fn different_domain_different_output() {
        let nk = random_base();
        let nf = random_base();

        let dom_mainnet = derive_domain(NetworkId::Mainnet);
        let dom_testnet = derive_domain(NetworkId::Testnet);
        assert_ne!(dom_mainnet, dom_testnet, "network ids must derive distinct domain constants");

        let a = derive_alternate_nullifier(nk, dom_mainnet, nf);
        let b = derive_alternate_nullifier(nk, dom_testnet, nf);
        // Sanity check on sample data, NOT a security proof of cross-domain unlinkability -
        // that requires real cryptographic analysis this project has not performed (the
        // draft ZIP itself flags "security analysis, in particular for collision attacks and
        // for linkability across domains" as an open TODO upstream).
        assert_ne!(a, b, "the same note under two different domains must yield different nf_dom");
    }

    #[test]
    fn different_note_different_output() {
        let nk = random_base();
        let dom = derive_domain(NetworkId::Testnet);
        let nf1 = random_base();
        let nf2 = random_base();

        assert_ne!(
            derive_alternate_nullifier(nk, dom, nf1),
            derive_alternate_nullifier(nk, dom, nf2),
            "different notes (different real nullifiers) must yield different nf_dom on sample data"
        );
    }

    #[test]
    fn domain_derivation_is_deterministic() {
        assert_eq!(derive_domain(NetworkId::Mainnet), derive_domain(NetworkId::Mainnet));
        assert_eq!(derive_domain(NetworkId::Testnet), derive_domain(NetworkId::Testnet));
    }

    #[test]
    fn alternate_nullifier_never_equals_the_real_nullifier_it_was_derived_from() {
        // The whole point of nf_dom is that revealing it must not reveal (or equal) the real
        // nf - that's what lets the same note be used across different domains without
        // becoming linkable. A hash output equaling one of its own inputs would be a
        // catastrophic, near-impossible-by-construction break of that property; this test
        // exists as a cheap, direct sanity check on real sample data, per the project plan's
        // explicit requirement, not as a substitute for real cryptanalysis.
        for _ in 0..20 {
            let nk = random_base();
            let nf = random_base();
            let dom = derive_domain(NetworkId::Mainnet);
            let nf_dom = derive_alternate_nullifier(nk, dom, nf);
            assert_ne!(nf_dom, nf, "nf_dom must never equal the real nullifier it was derived from");
        }
    }
}
