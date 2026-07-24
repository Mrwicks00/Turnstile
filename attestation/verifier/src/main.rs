//! Turnstile Phase 2 — verifier CLI, invoked by the Node API's POST /api/attest handler via
//! child_process. Takes a proof + claimed value + anchor on stdin as JSON, returns a verify
//! result on stdout as JSON. Deliberately the ONLY thing the Node service ever shells out to
//! for attestation verification - it must never receive, request, or store key material of
//! any kind (see attestation/SECURITY.md).
//!
//! STUB: Stage B (the actual circuit) is not implemented yet.

use std::io::Read;

fn main() {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        println!(r#"{{"valid":false,"reason":"failed to read stdin"}}"#);
        std::process::exit(1);
    }

    println!(
        r#"{{"valid":false,"reason":"circuit not yet implemented (Stage B)","circuitVersion":"{}"}}"#,
        turnstile_circuit::params::CIRCUIT_VERSION
    );
    std::process::exit(1);
}
