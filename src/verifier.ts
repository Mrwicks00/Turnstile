import { spawn } from "node:child_process";

export interface VerifyRequest {
  anchor: string;
  anchorHeight: number;
  claimedValue: number;
  proofB64: string;
}

export interface VerifyResult {
  valid: boolean;
  dedupTag?: string;
  reason?: string;
  circuitVersion?: string;
}

export type VerifyFn = (req: VerifyRequest) => Promise<VerifyResult>;

/**
 * Invokes the compiled `turnstile-verifier` CLI via a subprocess (never `exec`/a shell - the
 * proof/anchor are attacker-controlled bytes reaching this from a public POST /api/attest
 * body). JSON in over stdin, JSON out over stdout, with a hard timeout - a malformed or
 * adversarial proof must never be able to hang or crash the API process itself (see
 * attestation/SECURITY.md and the project plan's "why a subprocess, not an N-API addon"
 * reasoning: a panic in-process could take down the whole Express server).
 *
 * The real circuit (Stage B/C) isn't complete yet - today this always returns
 * `valid: false` from the verifier's own honest "not yet implemented" stub response. That's
 * correct, not a bug: no attestation can genuinely pass until the circuit exists.
 */
export function createVerifierFn(binPath: string, timeoutMs: number): VerifyFn {
  return (req) =>
    new Promise((resolve, reject) => {
      const child = spawn(binPath, ["verify"], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`verifier timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`failed to spawn verifier at ${binPath}: ${err.message}`));
      });
      child.on("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(stdout) as VerifyResult;
          resolve(parsed);
        } catch {
          reject(new Error(`verifier produced invalid JSON output: ${stdout || stderr}`));
        }
      });

      child.stdin.write(
        JSON.stringify({
          anchor: req.anchor,
          anchorHeight: req.anchorHeight,
          claimedValue: req.claimedValue,
          proof: req.proofB64,
        }),
      );
      child.stdin.end();
    });
}
