import type { DatabaseSync } from "node:sqlite";
import type { Config, ApiConfig, AttestationConfig } from "./config.js";
import { seedHeight, firstIndexedHeight } from "./config.js";
import {
  getPoolBalanceRange,
  getLatestPoolBalance,
  getDrainSeries,
  listRecentChecks,
  insertAttestation,
  getAttestedTotal,
  countAttestations,
  isUniqueConstraintError,
  type PoolBalanceRow,
  type CheckRow,
  type DrainPoint,
} from "./db.js";
import type { VerifyFn } from "./verifier.js";
import { logger } from "./logger.js";
import { randomUUID } from "node:crypto";

/** Invalid query params map to this; the HTTP layer turns it into a 400. */
export class BadRequestError extends Error {}

function parseNonNegativeIntParam(raw: string, name: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new BadRequestError(`${name} must be a non-negative integer, got: ${raw}`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw new BadRequestError(`${name} is out of range: ${raw}`);
  }
  return n;
}

export interface PoolBalanceResponse {
  from: number;
  to: number;
  count: number;
  rows: PoolBalanceRow[];
}

export function buildPoolBalanceResponse(
  db: DatabaseSync,
  query: { from?: string; to?: string },
  apiCfg: Pick<ApiConfig, "poolBalanceDefaultRange" | "poolBalanceMaxRange">,
): PoolBalanceResponse {
  let to: number;
  if (query.to !== undefined) {
    to = parseNonNegativeIntParam(query.to, "to");
  } else {
    to = getLatestPoolBalance(db)?.height ?? 0;
  }

  let from: number;
  if (query.from !== undefined) {
    from = parseNonNegativeIntParam(query.from, "from");
  } else {
    // Auto-computed default is clamped to 0 rather than rejected - only explicit user
    // input is validated strictly; a derived default going negative is just an empty range.
    from = Math.max(0, to - apiCfg.poolBalanceDefaultRange + 1);
  }

  if (from > to) {
    throw new BadRequestError(`from (${from}) must be <= to (${to})`);
  }
  const span = to - from + 1;
  if (span > apiCfg.poolBalanceMaxRange) {
    throw new BadRequestError(`requested range (${span} heights) exceeds max of ${apiCfg.poolBalanceMaxRange}`);
  }

  const rows = getPoolBalanceRange(db, from, to);
  return { from, to, count: rows.length, rows };
}

export interface ChecksResponse {
  limit: number;
  count: number;
  checks: CheckRow[];
}

export function buildChecksResponse(
  db: DatabaseSync,
  query: { limit?: string },
  apiCfg: Pick<ApiConfig, "checksDefaultLimit" | "checksMaxLimit">,
): ChecksResponse {
  let limit = apiCfg.checksDefaultLimit;
  if (query.limit !== undefined) {
    limit = parseNonNegativeIntParam(query.limit, "limit");
    if (limit < 1) {
      throw new BadRequestError(`limit must be >= 1, got: ${limit}`);
    }
    if (limit > apiCfg.checksMaxLimit) {
      throw new BadRequestError(`limit (${limit}) exceeds max of ${apiCfg.checksMaxLimit}`);
    }
  }

  const checks = listRecentChecks(db, limit);
  return { limit, count: checks.length, checks };
}

export interface DrainRate {
  zatPerDay: number;
  elapsedSeconds: number;
}

export interface DrainRateWindowed extends DrainRate {
  windowBlocks: number;
}

export interface DrainResponseSeeded {
  seeded: true;
  activationHeight: number;
  seedHeight: number;
  seedBalance: number;
  latestIndexedHeight: number;
  residual: number;
  drainedTotal: number;
  rate: {
    sinceSeed: DrainRate | null;
    windowed: DrainRateWindowed | null;
  };
  series: DrainPoint[];
}

export interface DrainResponseNotSeeded {
  seeded: false;
  message: string;
}

export type DrainResponse = DrainResponseSeeded | DrainResponseNotSeeded;

/** null (not a rate of 0) when there are fewer than two distinct-time data points - a
 * computed rate of exactly zero is a meaningful signal (confirmed plateau) and must never
 * be conflated with "not enough data yet". */
function computeRate(startRow: PoolBalanceRow, endRow: PoolBalanceRow): DrainRate | null {
  const elapsedSeconds = endRow.block_time - startRow.block_time;
  if (elapsedSeconds <= 0) return null;
  const drained = startRow.orchard_balance - endRow.orchard_balance;
  return { zatPerDay: Math.round((drained / elapsedSeconds) * 86400), elapsedSeconds };
}

export function buildDrainResponse(
  db: DatabaseSync,
  cfg: Pick<Config, "activationHeight" | "startHeightOverride">,
  apiCfg: Pick<ApiConfig, "drainMaxPoints" | "drainWindowBlocks">,
): DrainResponse {
  const seedH = seedHeight(cfg);
  const seedRows = getPoolBalanceRange(db, seedH, seedH);
  if (seedRows.length === 0) {
    return { seeded: false, message: "Indexer has not seeded a starting balance yet." };
  }
  const seedRow = seedRows[0];

  // Non-null: seedRow's own presence guarantees at least one row exists.
  const latestRow = getLatestPoolBalance(db)!;

  const sinceSeed = computeRate(seedRow, latestRow);

  const windowStartHeight = Math.max(seedH, latestRow.height - apiCfg.drainWindowBlocks);
  const windowStartRows = getPoolBalanceRange(db, windowStartHeight, windowStartHeight);
  const windowStartRow = windowStartRows[0] ?? seedRow;
  const windowedBase = computeRate(windowStartRow, latestRow);
  const windowed = windowedBase ? { ...windowedBase, windowBlocks: latestRow.height - windowStartRow.height } : null;

  const series = getDrainSeries(db, seedH, latestRow.height, apiCfg.drainMaxPoints);

  return {
    seeded: true,
    activationHeight: firstIndexedHeight(cfg),
    seedHeight: seedH,
    seedBalance: seedRow.orchard_balance,
    latestIndexedHeight: latestRow.height,
    residual: latestRow.orchard_balance,
    drainedTotal: seedRow.orchard_balance - latestRow.orchard_balance,
    rate: { sinceSeed, windowed },
    series,
  };
}

// ---- Phase 2: residual attestation ----

/** A submitted proof failed verification (a real cryptographic rejection, not a shape/input
 * problem) - maps to 422, distinct from BadRequestError's 400. */
export class VerificationFailedError extends Error {}

/** The submitted proof verified, but its dedup_tag (revealed alternate nullifier) has already
 * been claimed by a prior attestation - maps to 409. This IS the mechanism that prevents the
 * same note from being counted twice toward `attested`. */
export class DuplicateAttestationError extends Error {}

export interface AttestRequestBody {
  anchor: string;
  anchorHeight: number;
  claimedValue: number;
  proof: string; // base64
}

function parseAttestBody(body: unknown): AttestRequestBody {
  if (typeof body !== "object" || body === null) {
    throw new BadRequestError("request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;

  if (typeof b.anchor !== "string" || b.anchor.length === 0) {
    throw new BadRequestError("anchor must be a non-empty string");
  }
  if (typeof b.anchorHeight !== "number" || !Number.isSafeInteger(b.anchorHeight) || b.anchorHeight < 0) {
    throw new BadRequestError("anchorHeight must be a non-negative integer");
  }
  if (typeof b.claimedValue !== "number" || !Number.isSafeInteger(b.claimedValue) || b.claimedValue <= 0) {
    throw new BadRequestError("claimedValue must be a positive integer (zatoshis)");
  }
  if (typeof b.proof !== "string" || b.proof.length === 0) {
    throw new BadRequestError("proof must be a non-empty base64 string");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b.proof)) {
    throw new BadRequestError("proof must be valid base64");
  }

  return { anchor: b.anchor, anchorHeight: b.anchorHeight, claimedValue: b.claimedValue, proof: b.proof };
}

export interface AttestResponse {
  id: string;
  dedupTag: string;
  claimedValue: number;
  anchorHeight: number;
  verifiedAt: number;
  circuitVersion?: string;
}

export async function buildAttestResponse(
  db: DatabaseSync,
  body: unknown,
  verify: VerifyFn,
  cfg: Pick<AttestationConfig, "maxAnchorStalenessBlocks">,
): Promise<AttestResponse> {
  const req = parseAttestBody(body);

  const latest = getLatestPoolBalance(db);
  if (latest === null) {
    throw new BadRequestError("cannot accept attestations before the indexer has seeded a starting balance");
  }
  if (req.anchorHeight > latest.height) {
    throw new BadRequestError(
      `anchorHeight (${req.anchorHeight}) is ahead of the latest indexed height (${latest.height})`,
    );
  }
  const staleness = latest.height - req.anchorHeight;
  if (staleness > cfg.maxAnchorStalenessBlocks) {
    throw new BadRequestError(
      `anchor is ${staleness} blocks behind the latest indexed height, exceeding max staleness of ${cfg.maxAnchorStalenessBlocks}`,
    );
  }

  const result = await verify({
    anchor: req.anchor,
    anchorHeight: req.anchorHeight,
    claimedValue: req.claimedValue,
    proofB64: req.proof,
  });

  if (!result.valid || !result.dedupTag) {
    throw new VerificationFailedError(result.reason ?? "proof verification failed");
  }

  const id = randomUUID();
  const verifiedAt = Math.floor(Date.now() / 1000);

  try {
    insertAttestation(db, {
      id,
      anchor: req.anchor,
      anchor_height: req.anchorHeight,
      claimed_value: req.claimedValue,
      proof: Buffer.from(req.proof, "base64"),
      dedup_tag: result.dedupTag,
      verified_at: verifiedAt,
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new DuplicateAttestationError("this note has already been attested (duplicate dedup_tag)");
    }
    throw err;
  }

  return {
    id,
    dedupTag: result.dedupTag,
    claimedValue: req.claimedValue,
    anchorHeight: req.anchorHeight,
    verifiedAt,
    circuitVersion: result.circuitVersion,
  };
}

const RESIDUAL_DISCLAIMER =
  "Non-attestation does not prove counterfeit. Most holders will never bother to attest, and " +
  "holders of lost keys cannot. unattestedResidual is a loose UPPER BOUND on possible " +
  "counterfeit, not proof of anything, and is only meaningful alongside participationRate.";

export interface ResidualResponseSeeded {
  seeded: true;
  latestIndexedHeight: number;
  residual: number;
  attested: number;
  unattestedResidual: number;
  participationRate: number;
  attestationCount: number;
  disclaimer: string;
}

export interface ResidualResponseNotSeeded {
  seeded: false;
  message: string;
}

export type ResidualResponse = ResidualResponseSeeded | ResidualResponseNotSeeded;

export function buildResidualResponse(db: DatabaseSync): ResidualResponse {
  const latest = getLatestPoolBalance(db);
  if (latest === null) {
    return { seeded: false, message: "Indexer has not seeded a starting balance yet." };
  }

  const residual = latest.orchard_balance;
  const attested = getAttestedTotal(db);
  const attestationCount = countAttestations(db);

  let unattestedResidual = residual - attested;
  if (unattestedResidual < 0) {
    logger.warn("attested total exceeds residual - clamping unattestedResidual to 0", { residual, attested });
    unattestedResidual = 0;
  }
  const participationRate = residual > 0 ? Math.min(1, attested / residual) : 0;

  return {
    seeded: true,
    latestIndexedHeight: latest.height,
    residual,
    attested,
    unattestedResidual,
    participationRate,
    attestationCount,
    disclaimer: RESIDUAL_DISCLAIMER,
  };
}
