import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface PoolBalanceRow {
  height: number;
  block_hash: string;
  parent_hash: string;
  block_time: number;
  orchard_delta: number;
  sapling_delta: number;
  sprout_delta: number;
  orchard_balance: number;
  sapling_balance: number;
  sprout_balance: number;
  tx_count: number;
}

/** In-memory pipeline state, mirroring the last-applied row. */
export interface Cursor {
  height: number;
  blockHash: string;
  orchardBalance: number;
  saplingBalance: number;
  sproutBalance: number;
}

export type CheckStatus = "pass" | "fail";

export interface CheckRow {
  check_name: string;
  height: number;
  txid: string | null;
  status: CheckStatus;
  detail: string | null;
  checked_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pool_balance (
  height          INTEGER PRIMARY KEY,
  block_hash      TEXT    NOT NULL,
  parent_hash     TEXT    NOT NULL,
  block_time      INTEGER NOT NULL,
  orchard_delta   INTEGER NOT NULL,
  sapling_delta   INTEGER NOT NULL,
  sprout_delta    INTEGER NOT NULL,
  orchard_balance INTEGER NOT NULL,
  sapling_balance INTEGER NOT NULL,
  sprout_balance  INTEGER NOT NULL,
  tx_count        INTEGER NOT NULL
);
`;

const CHECKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS checks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  check_name  TEXT    NOT NULL,
  height      INTEGER NOT NULL,
  txid        TEXT,
  status      TEXT    NOT NULL CHECK (status IN ('pass', 'fail')),
  detail      TEXT,
  checked_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checks_recent   ON checks(height, id);
CREATE INDEX IF NOT EXISTS idx_checks_name     ON checks(check_name, height);
CREATE INDEX IF NOT EXISTS idx_checks_failures ON checks(status) WHERE status = 'fail';
`;

/** Phase 2 (residual attestation) - verbatim schema from the project spec. dedup_tag is the
 * revealed alternate nullifier (nf_dom); its UNIQUE constraint is what actually prevents the
 * same note being counted twice toward `attested` (see api.ts's buildAttestResponse). */
const ATTESTATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS attestation (
  id             TEXT PRIMARY KEY,
  anchor         TEXT    NOT NULL,
  anchor_height  INTEGER NOT NULL,
  claimed_value  INTEGER NOT NULL,
  proof          BLOB    NOT NULL,
  dedup_tag      TEXT    NOT NULL UNIQUE,
  verified_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attestation_anchor_height ON attestation(anchor_height);
`;

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);
  db.exec(CHECKS_SCHEMA);
  db.exec(ATTESTATION_SCHEMA);
  return db;
}

/** Opens a read-only handle for the API server (a separate process from the indexer).
 * Deliberately does NOT run WAL/pragma setup or CREATE TABLE - a reader must never attempt
 * schema changes, and WAL is a persistent file-header property the writer already set once.
 * `timeout` gives a brief busy-retry window in case a query lands during a rare writer
 * checkpoint lock, rather than failing immediately with SQLITE_BUSY. */
export function openDbReadOnly(path: string): DatabaseSync {
  try {
    return new DatabaseSync(path, { readOnly: true, timeout: 3000 });
  } catch (err) {
    throw new Error(
      `Cannot open read-only database at ${path} - has the indexer been started at least once? ` +
        `(see TURNSTILE_DB_PATH / TURNSTILE_API_DB_PATH). Original error: ${String(err)}`,
    );
  }
}

/** A second, narrowly-scoped writable handle for the API process - used ONLY by
 * POST /api/attest's insert path. Attestations are submitted through the API (not produced
 * by the indexer's block-processing loop), so the API is the one legitimate writer for this
 * single table. Deliberately does NOT create/touch pool_balance or checks (those stay
 * indexer-owned; see openDbReadOnly's docs) - only ensures the attestation table itself
 * exists, so a fresh deployment can accept attestations even if the API happens to start
 * before the indexer ever has. WAL/pragma setup here is idempotent with whatever the indexer
 * already configured on the same file. */
export function openAttestationWriter(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { timeout: 3000 });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(ATTESTATION_SCHEMA);
  return db;
}

export function loadCursor(db: DatabaseSync): Cursor | null {
  const row = db
    .prepare(
      `SELECT height, block_hash, orchard_balance, sapling_balance, sprout_balance
       FROM pool_balance ORDER BY height DESC LIMIT 1`,
    )
    .get() as
    | { height: number; block_hash: string; orchard_balance: number; sapling_balance: number; sprout_balance: number }
    | undefined;

  if (!row) return null;
  return {
    height: row.height,
    blockHash: row.block_hash,
    orchardBalance: row.orchard_balance,
    saplingBalance: row.sapling_balance,
    sproutBalance: row.sprout_balance,
  };
}

/** Task 3's GET /api/pool-balance range read path. `height` is already the primary key,
 * so this is an efficient indexed range scan regardless of how wide [from, to] is. */
export function getPoolBalanceRange(db: DatabaseSync, from: number, to: number): PoolBalanceRow[] {
  return db
    .prepare(
      `SELECT height, block_hash, parent_hash, block_time,
              orchard_delta, sapling_delta, sprout_delta,
              orchard_balance, sapling_balance, sprout_balance, tx_count
       FROM pool_balance WHERE height BETWEEN $from AND $to ORDER BY height ASC`,
    )
    .all({ from, to }) as unknown as PoolBalanceRow[];
}

/** The most recently indexed row (MAX(height)), full shape - includes block_time, which
 * loadCursor's minimal cursor shape does not, needed for the drain endpoint's elapsed-time
 * calculations. Deliberately a separate, API-layer-owned function rather than repurposing
 * loadCursor (an indexer-internal contract), mirroring the existing separation between
 * getChecksAtHeight and listRecentChecks. */
export function getLatestPoolBalance(db: DatabaseSync): PoolBalanceRow | null {
  const row = db
    .prepare(
      `SELECT height, block_hash, parent_hash, block_time,
              orchard_delta, sapling_delta, sprout_delta,
              orchard_balance, sapling_balance, sprout_balance, tx_count
       FROM pool_balance ORDER BY height DESC LIMIT 1`,
    )
    .get() as unknown as PoolBalanceRow | undefined;
  return row ?? null;
}

export interface DrainPoint {
  height: number;
  block_time: number;
  orchard_balance: number;
}

/** Downsampled series for the drain chart. Returns every row if the range already fits
 * under maxPoints; otherwise modulo-samples every `step`th height, explicitly OR-ing in
 * height = to so the last point (the current residual) is never dropped by the modulo
 * boundary - the whole point of this endpoint is that exact final number. */
export function getDrainSeries(db: DatabaseSync, from: number, to: number, maxPoints: number): DrainPoint[] {
  const total = to - from + 1;
  if (total <= maxPoints) {
    return db
      .prepare(
        `SELECT height, block_time, orchard_balance FROM pool_balance
         WHERE height BETWEEN $from AND $to ORDER BY height ASC`,
      )
      .all({ from, to }) as unknown as DrainPoint[];
  }
  const step = Math.ceil(total / maxPoints);
  return db
    .prepare(
      `SELECT height, block_time, orchard_balance FROM pool_balance
       WHERE height BETWEEN $from AND $to AND ((height - $from) % $step = 0 OR height = $to)
       ORDER BY height ASC`,
    )
    .all({ from, to, step }) as unknown as DrainPoint[];
}

export function getBlockHashAt(db: DatabaseSync, height: number): string | null {
  const row = db.prepare(`SELECT block_hash FROM pool_balance WHERE height = $height`).get({ height }) as
    | { block_hash: string }
    | undefined;
  return row ? row.block_hash : null;
}

const INSERT_SQL = `
INSERT INTO pool_balance
  (height, block_hash, parent_hash, block_time,
   orchard_delta, sapling_delta, sprout_delta,
   orchard_balance, sapling_balance, sprout_balance, tx_count)
VALUES
  ($height, $block_hash, $parent_hash, $block_time,
   $orchard_delta, $sapling_delta, $sprout_delta,
   $orchard_balance, $sapling_balance, $sprout_balance, $tx_count)
`;

export function insertRow(db: DatabaseSync, row: PoolBalanceRow): void {
  db.prepare(INSERT_SQL).run(row as unknown as Record<string, SQLInputValue>);
}

/** Reorg recovery: discard every row above the found common ancestor height. Checks rows are
 * only ever written together with their height's pool_balance row (same trigger, same
 * transaction - see applyBlock in indexer.ts), so this can never orphan a still-valid check
 * row for a different, non-reorged block at the same height. */
export function rollbackTo(db: DatabaseSync, ancestorHeight: number): void {
  db.prepare(`DELETE FROM pool_balance WHERE height > $ancestorHeight`).run({ ancestorHeight });
  db.prepare(`DELETE FROM checks WHERE height > $ancestorHeight`).run({ ancestorHeight });
}

const INSERT_CHECK_SQL = `
INSERT INTO checks (check_name, height, txid, status, detail, checked_at)
VALUES ($check_name, $height, $txid, $status, $detail, $checked_at)
`;

export function insertCheckRow(db: DatabaseSync, row: CheckRow): void {
  db.prepare(INSERT_CHECK_SQL).run(row as unknown as Record<string, SQLInputValue>);
}

export function insertCheckRows(db: DatabaseSync, rows: CheckRow[]): void {
  for (const row of rows) insertCheckRow(db, row);
}

export function getChecksAtHeight(db: DatabaseSync, height: number): CheckRow[] {
  return db
    .prepare(
      `SELECT check_name, height, txid, status, detail, checked_at FROM checks WHERE height = $height ORDER BY id`,
    )
    .all({ height }) as unknown as CheckRow[];
}

/** Task 3's future GET /api/checks read path - "most recent first". The (height, id) index
 * makes this a pure reverse index scan with no sort step. */
export function listRecentChecks(db: DatabaseSync, limit: number): CheckRow[] {
  return db
    .prepare(
      `SELECT check_name, height, txid, status, detail, checked_at
       FROM checks ORDER BY height DESC, id DESC LIMIT $limit`,
    )
    .all({ limit }) as unknown as CheckRow[];
}

export interface AttestationRow {
  id: string;
  anchor: string;
  anchor_height: number;
  claimed_value: number;
  proof: Buffer;
  dedup_tag: string;
  verified_at: number;
}

/** SQLite's extended result code for a UNIQUE constraint violation (SQLITE_CONSTRAINT_UNIQUE =
 * SQLITE_CONSTRAINT | (2<<8)). Verified empirically against node:sqlite's real thrown error
 * shape - node:sqlite exposes this as `err.errcode`, not the generic `err.code`
 * ("ERR_SQLITE_ERROR", which fires for every SQLite error, not just this one). */
export const SQLITE_CONSTRAINT_UNIQUE = 2067;

export function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { errcode?: number }).errcode === SQLITE_CONSTRAINT_UNIQUE;
}

const INSERT_ATTESTATION_SQL = `
INSERT INTO attestation (id, anchor, anchor_height, claimed_value, proof, dedup_tag, verified_at)
VALUES ($id, $anchor, $anchor_height, $claimed_value, $proof, $dedup_tag, $verified_at)
`;

/** Throws (propagates) a raw node:sqlite error on a duplicate dedup_tag - callers use
 * isUniqueConstraintError to map that into a typed DuplicateAttestationError; this function
 * deliberately does not catch it itself, matching how insertRow/insertCheckRow let SQL errors
 * propagate to whichever layer knows how to interpret them. */
export function insertAttestation(db: DatabaseSync, row: AttestationRow): void {
  db.prepare(INSERT_ATTESTATION_SQL).run(row as unknown as Record<string, SQLInputValue>);
}

/** Sum of claimed_value across every verified attestation. 0 (not null) on an empty table. */
export function getAttestedTotal(db: DatabaseSync): number {
  const row = db.prepare(`SELECT COALESCE(SUM(claimed_value), 0) AS total FROM attestation`).get() as
    | { total: number }
    | undefined;
  return row?.total ?? 0;
}

export function countAttestations(db: DatabaseSync): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM attestation`).get() as { n: number } | undefined;
  return row?.n ?? 0;
}
