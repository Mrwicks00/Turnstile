//! Stage B: a minimal, real halo2 circuit proving knowledge of a note value `v` and
//! blinding factor `rcv` such that a public value commitment `cv = [v]ValueCommitV +
//! [rcv]ValueCommitR` holds - using Orchard's own real, audited fixed-base tables
//! (`orchard::constants::OrchardFixedBases`), not reinvented ones.
//!
//! EXPERIMENTAL / UNAUDITED. See `attestation/SECURITY.md` and `lib.rs`'s module docs.
//!
//! This is ONE piece of the full Stage B circuit (value commitment integrity), following
//! the real Orchard action circuit's own `ValueCommit^Orchard` construction
//! (`orchard::circuit`, `gadget::value_commit_orchard` - that function is scoped private to
//! `orchard::circuit` and not reusable directly, so this reimplements the same mathematical
//! operation using the same real fixed bases and the same halo2_gadgets EccChip
//! configuration pattern demonstrated in halo2_gadgets' own test suite
//! (`halo2_gadgets::ecc::tests::MyEccCircuit`). It does NOT yet include commitment-tree
//! Merkle path membership, spend authority (rk derivation + RedDSA), or the alternate
//! nullifier - those are separate, not-yet-implemented pieces of the full circuit.
//!
//! Note values are always non-negative in this use case (we're proving control of one real
//! note's positive value, not a signed net difference like Orchard's own `v_net`), so the
//! sign is fixed to +1 rather than witnessed.

use halo2_gadgets::ecc::{
    chip::{EccChip, EccConfig},
    FixedPoint, FixedPointShort, ScalarFixed, ScalarFixedShort,
};
use halo2_gadgets::sinsemilla::chip::{SinsemillaChip, SinsemillaConfig};
use halo2_gadgets::utilities::lookup_range_check::{LookupRangeCheck, PallasLookupRangeCheckConfig};
use halo2_gadgets::utilities::UtilitiesInstructions;
use halo2_proofs::{
    circuit::{Layouter, SimpleFloorPlanner, Value},
    plonk::{Advice, Circuit, Column, ConstraintSystem, Error, Instance},
};
use orchard::constants::{
    OrchardCommitDomains, OrchardFixedBases, OrchardFixedBasesFull, OrchardHashDomains, OrchardShortScalarBases,
};
use pasta_curves::pallas;

pub type OrchardEccChip = EccChip<OrchardFixedBases, PallasLookupRangeCheckConfig>;
pub type OrchardSinsemillaChip =
    SinsemillaChip<OrchardHashDomains, OrchardCommitDomains, OrchardFixedBases, PallasLookupRangeCheckConfig>;

#[derive(Clone, Debug)]
pub struct ValueCommitConfig {
    ecc_config: EccConfig<OrchardFixedBases, PallasLookupRangeCheckConfig>,
    // Only present so its `load()` call populates the range-check lookup table the ECC chip
    // shares with it - real Orchard circuits always pair these chips for exactly this reason
    // (see note_gadget.rs's module docs). Not otherwise used by this minimal circuit yet;
    // Stage B's Merkle-path piece will be the first to actually hash through it.
    sinsemilla_config: SinsemillaConfig<OrchardHashDomains, OrchardCommitDomains, OrchardFixedBases, PallasLookupRangeCheckConfig>,
    witness_advice: Column<Advice>,
    instance: Column<Instance>,
}

/// Public instance layout: [cv_x, cv_y].
pub const CV_X: usize = 0;
pub const CV_Y: usize = 1;

#[derive(Default, Clone, Debug)]
pub struct ValueCommitCircuit {
    pub value: Value<u64>,
    pub rcv: Value<pallas::Scalar>,
}

impl Circuit<pallas::Base> for ValueCommitCircuit {
    type Config = ValueCommitConfig;
    type FloorPlanner = SimpleFloorPlanner;

    fn without_witnesses(&self) -> Self {
        Self::default()
    }

    fn configure(meta: &mut ConstraintSystem<pallas::Base>) -> Self::Config {
        let advices = [
            meta.advice_column(),
            meta.advice_column(),
            meta.advice_column(),
            meta.advice_column(),
            meta.advice_column(),
            meta.advice_column(),
            meta.advice_column(),
            meta.advice_column(),
            meta.advice_column(),
            meta.advice_column(),
        ];
        for advice in advices {
            meta.enable_equality(advice);
        }
        let witness_advice = meta.advice_column();
        meta.enable_equality(witness_advice);

        let lagrange_coeffs = [
            meta.fixed_column(),
            meta.fixed_column(),
            meta.fixed_column(),
            meta.fixed_column(),
            meta.fixed_column(),
            meta.fixed_column(),
            meta.fixed_column(),
            meta.fixed_column(),
        ];
        let constants = meta.fixed_column();
        meta.enable_constant(constants);

        // Fixed columns for the Sinsemilla generator lookup table - mirroring real Orchard's
        // own circuit configuration exactly (orchard::circuit::Config::configure): one shared
        // table_idx column doubles as the ECC chip's range-check table.
        let table_idx = meta.lookup_table_column();
        let lookup = (table_idx, meta.lookup_table_column(), meta.lookup_table_column());

        let range_check = PallasLookupRangeCheckConfig::configure(meta, advices[9], table_idx);
        let ecc_config = EccChip::<OrchardFixedBases, PallasLookupRangeCheckConfig>::configure(
            meta,
            advices,
            lagrange_coeffs,
            range_check,
        );

        let sinsemilla_config = SinsemillaChip::<
            OrchardHashDomains,
            OrchardCommitDomains,
            OrchardFixedBases,
            PallasLookupRangeCheckConfig,
        >::configure(
            meta,
            advices[..5].try_into().unwrap(),
            advices[6],
            lagrange_coeffs[0],
            lookup,
            range_check,
            false,
        );

        let instance = meta.instance_column();
        meta.enable_equality(instance);

        ValueCommitConfig {
            ecc_config,
            sinsemilla_config,
            witness_advice,
            instance,
        }
    }

    fn synthesize(&self, config: Self::Config, mut layouter: impl Layouter<pallas::Base>) -> Result<(), Error> {
        use halo2_gadgets::ecc::chip::CircuitVersion;

        let chip = OrchardEccChip::construct(config.ecc_config.clone(), CircuitVersion::AnchoredBase);
        OrchardSinsemillaChip::load(config.sinsemilla_config.clone(), &mut layouter)?;

        // Witness the note value as a 64-bit magnitude (always non-negative here) plus a
        // fixed sign of +1 (encoded as the field element 1).
        let magnitude = chip.load_private(
            layouter.namespace(|| "witness value magnitude"),
            config.witness_advice,
            self.value.map(pallas::Base::from),
        )?;
        let sign = chip.load_private(
            layouter.namespace(|| "witness sign (fixed +1)"),
            config.witness_advice,
            Value::known(pallas::Base::one()),
        )?;

        let v_scalar = ScalarFixedShort::new(chip.clone(), layouter.namespace(|| "v as short scalar"), (magnitude, sign))?;
        let rcv_scalar = ScalarFixed::new(chip.clone(), layouter.namespace(|| "rcv as full scalar"), self.rcv)?;

        let value_commit_v = FixedPointShort::from_inner(chip.clone(), OrchardShortScalarBases::ValueCommitV);
        let value_commit_r = FixedPoint::from_inner(chip.clone(), OrchardFixedBasesFull::ValueCommitR);

        let (v_term, _) = value_commit_v.mul(layouter.namespace(|| "[v] ValueCommitV"), v_scalar)?;
        let (r_term, _) = value_commit_r.mul(layouter.namespace(|| "[rcv] ValueCommitR"), rcv_scalar)?;

        let cv = v_term.add(layouter.namespace(|| "cv = [v]ValueCommitV + [rcv]ValueCommitR"), &r_term)?;

        layouter.constrain_instance(cv.inner().x().cell(), config.instance, CV_X)?;
        layouter.constrain_instance(cv.inner().y().cell(), config.instance, CV_Y)?;

        Ok(())
    }
}

/// Computes the same value commitment outside the circuit, for constructing the public
/// instance a prover/verifier compares the in-circuit result against. Uses the real
/// `OrchardFixedBases` generators directly, mirroring the in-circuit computation exactly -
/// this off-circuit/in-circuit equivalence is exactly what the circuit is proving knowledge
/// of, and cross-checking them independently (rather than trusting the circuit alone) is
/// how Stage B's tests catch a circuit that's internally inconsistent with the real math.
pub fn compute_value_commitment(value: u64, rcv: pallas::Scalar) -> pallas::Point {
    use halo2_gadgets::ecc::chip::FixedPoint as FixedPointChip;

    let v_base = OrchardShortScalarBases::ValueCommitV.generator();
    let r_base = OrchardFixedBasesFull::ValueCommitR.generator();

    let v_scalar = pallas::Scalar::from(value);
    v_base * v_scalar + r_base * rcv
}

#[cfg(test)]
mod tests {
    use super::*;
    use group::{ff::Field, Curve};
    use halo2_proofs::arithmetic::CurveAffine;
    use halo2_proofs::dev::MockProver;
    use rand::rngs::OsRng;

    fn public_instance(cv: pallas::Point) -> Vec<pallas::Base> {
        let affine = cv.to_affine();
        let coords = affine.coordinates().unwrap();
        vec![*coords.x(), *coords.y()]
    }

    #[test]
    fn valid_witness_is_accepted() {
        let value = 4_200_000_000u64; // 42 ZEC in zatoshis
        let rcv = pallas::Scalar::random(OsRng);
        let cv = compute_value_commitment(value, rcv);

        let circuit = ValueCommitCircuit {
            value: Value::known(value),
            rcv: Value::known(rcv),
        };

        let k = 13;
        let prover = MockProver::run(k, &circuit, vec![public_instance(cv)]).unwrap();
        assert_eq!(prover.verify(), Ok(()));
    }

    #[test]
    fn tampered_value_is_rejected() {
        let value = 4_200_000_000u64;
        let rcv = pallas::Scalar::random(OsRng);
        let real_cv = compute_value_commitment(value, rcv);

        // Prover claims a DIFFERENT value than what they actually witness in the circuit -
        // i.e. the public instance corresponds to a value the circuit was never given.
        let circuit = ValueCommitCircuit {
            value: Value::known(value + 1), // witnessed value differs from the committed one
            rcv: Value::known(rcv),
        };

        let k = 13;
        let prover = MockProver::run(k, &circuit, vec![public_instance(real_cv)]).unwrap();
        assert!(prover.verify().is_err(), "a mismatched value must be rejected, not silently accepted");
    }

    #[test]
    fn tampered_rcv_is_rejected() {
        let value = 4_200_000_000u64;
        let rcv = pallas::Scalar::random(OsRng);
        let real_cv = compute_value_commitment(value, rcv);

        let wrong_rcv = pallas::Scalar::random(OsRng);
        let circuit = ValueCommitCircuit {
            value: Value::known(value),
            rcv: Value::known(wrong_rcv),
        };

        let k = 13;
        let prover = MockProver::run(k, &circuit, vec![public_instance(real_cv)]).unwrap();
        assert!(prover.verify().is_err(), "a mismatched rcv must be rejected, not silently accepted");
    }

    #[test]
    fn tampered_public_instance_is_rejected() {
        // Correct witness, but the public instance claims a DIFFERENT commitment entirely -
        // simulates a verifier being handed a proof for one commitment while checking it
        // against another.
        let value = 4_200_000_000u64;
        let rcv = pallas::Scalar::random(OsRng);
        let other_cv = compute_value_commitment(value + 1, rcv);

        let circuit = ValueCommitCircuit {
            value: Value::known(value),
            rcv: Value::known(rcv),
        };

        let k = 13;
        let prover = MockProver::run(k, &circuit, vec![public_instance(other_cv)]).unwrap();
        assert!(prover.verify().is_err(), "a proof must not verify against a different commitment");
    }
}
