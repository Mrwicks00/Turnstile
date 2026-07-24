import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, insertRow, type PoolBalanceRow } from "../src/db.js";
import {
  buildPoolBalanceResponse,
  buildChecksResponse,
  buildDrainResponse,
  buildAttestResponse,
  buildResidualResponse,
  BadRequestError,
  VerificationFailedError,
  DuplicateAttestationError,
  type DrainResponseSeeded,
  type ResidualResponseSeeded,
} from "../src/api.js";
import type { Config, ApiConfig, AttestationConfig } from "../src/config.js";
import type { VerifyFn } from "../src/verifier.js";

function row(overrides: Partial<PoolBalanceRow> & { height: number }): PoolBalanceRow {
  return {
    block_hash: `hash${overrides.height}`,
    parent_hash: "",
    block_time: 1_600_000_000,
    orchard_delta: 0,
    sapling_delta: 0,
    sprout_delta: 0,
    orchard_balance: 0,
    sapling_balance: 0,
    sprout_balance: 0,
    tx_count: 1,
    ...overrides,
  };
}

const apiCfg: ApiConfig = {
  port: 0,
  host: "127.0.0.1",
  dbPath: ":memory:",
  poolBalanceDefaultRange: 10,
  poolBalanceMaxRange: 100,
  checksDefaultLimit: 5,
  checksMaxLimit: 50,
  drainMaxPoints: 100,
  drainWindowBlocks: 5,
};

const cfg: Pick<Config, "activationHeight" | "startHeightOverride"> = {
  activationHeight: 101,
  startHeightOverride: null,
};

// --- buildPoolBalanceResponse ---

test("buildPoolBalanceResponse: explicit from/to returns the matching rows", () => {
  const db = openDb(":memory:");
  for (const h of [100, 101, 102, 103]) insertRow(db, row({ height: h }));
  const result = buildPoolBalanceResponse(db, { from: "101", to: "102" }, apiCfg);
  assert.deepEqual(result.rows.map((r) => r.height), [101, 102]);
  assert.equal(result.from, 101);
  assert.equal(result.to, 102);
  assert.equal(result.count, 2);
  db.close();
});

test("buildPoolBalanceResponse: missing to defaults to the latest indexed height", () => {
  const db = openDb(":memory:");
  for (const h of [100, 101, 102]) insertRow(db, row({ height: h }));
  const result = buildPoolBalanceResponse(db, {}, apiCfg);
  assert.equal(result.to, 102);
  db.close();
});

test("buildPoolBalanceResponse: missing from defaults to (to - defaultRange + 1), clamped at 0", () => {
  const db = openDb(":memory:");
  insertRow(db, row({ height: 3 }));
  const result = buildPoolBalanceResponse(db, { to: "3" }, apiCfg); // defaultRange=10 -> would be -6
  assert.equal(result.from, 0);
  db.close();
});

test("buildPoolBalanceResponse: on an empty table with no params, returns an empty 200-shaped result", () => {
  const db = openDb(":memory:");
  const result = buildPoolBalanceResponse(db, {}, apiCfg);
  assert.equal(result.count, 0);
  assert.deepEqual(result.rows, []);
  db.close();
});

test("buildPoolBalanceResponse: rejects non-integer params", () => {
  const db = openDb(":memory:");
  assert.throws(() => buildPoolBalanceResponse(db, { from: "abc" }, apiCfg), BadRequestError);
  assert.throws(() => buildPoolBalanceResponse(db, { from: "-5" }, apiCfg), BadRequestError);
  db.close();
});

test("buildPoolBalanceResponse: rejects from > to", () => {
  const db = openDb(":memory:");
  assert.throws(() => buildPoolBalanceResponse(db, { from: "10", to: "5" }, apiCfg), BadRequestError);
  db.close();
});

test("buildPoolBalanceResponse: rejects a span exceeding poolBalanceMaxRange", () => {
  const db = openDb(":memory:");
  assert.throws(() => buildPoolBalanceResponse(db, { from: "0", to: "1000" }, apiCfg), BadRequestError);
  db.close();
});

// --- buildChecksResponse ---

test("buildChecksResponse: default limit applies when omitted", () => {
  const db = openDb(":memory:");
  const result = buildChecksResponse(db, {}, apiCfg);
  assert.equal(result.limit, apiCfg.checksDefaultLimit);
  db.close();
});

test("buildChecksResponse: rejects limit <= 0 and limit exceeding max", () => {
  const db = openDb(":memory:");
  assert.throws(() => buildChecksResponse(db, { limit: "0" }, apiCfg), BadRequestError);
  assert.throws(() => buildChecksResponse(db, { limit: "10000" }, apiCfg), BadRequestError);
  db.close();
});

// --- buildDrainResponse ---

test("buildDrainResponse: not-yet-seeded table returns seeded:false, not an error", () => {
  const db = openDb(":memory:");
  const result = buildDrainResponse(db, cfg, apiCfg);
  assert.equal(result.seeded, false);
  db.close();
});

test("buildDrainResponse: single data point (just seeded) yields null rate, not zero", () => {
  const db = openDb(":memory:");
  insertRow(db, row({ height: 100, block_time: 1000, orchard_balance: 5000 })); // seed row at activationHeight-1
  const result = buildDrainResponse(db, cfg, apiCfg) as DrainResponseSeeded;
  assert.equal(result.seeded, true);
  assert.equal(result.rate.sinceSeed, null);
  assert.equal(result.rate.windowed, null);
  assert.equal(result.residual, 5000);
  db.close();
});

test("buildDrainResponse: computes sinceSeed rate and residual correctly across a real drain", () => {
  const db = openDb(":memory:");
  insertRow(db, row({ height: 100, block_time: 0, orchard_balance: 10_000 })); // seed
  insertRow(db, row({ height: 101, block_time: 43_200, orchard_balance: 8_000 })); // half a day later
  insertRow(db, row({ height: 102, block_time: 86_400, orchard_balance: 6_000 })); // 1 day later

  const result = buildDrainResponse(db, cfg, apiCfg) as DrainResponseSeeded;
  assert.equal(result.residual, 6_000);
  assert.equal(result.drainedTotal, 4_000);
  assert.equal(result.latestIndexedHeight, 102);
  // 4000 zat drained over 1 day (86400s) = 4000 zat/day
  assert.equal(result.rate.sinceSeed?.zatPerDay, 4_000);
  assert.equal(result.rate.sinceSeed?.elapsedSeconds, 86_400);
  db.close();
});

test("buildDrainResponse: a confirmed plateau (zero recent drain) yields rate 0, not null", () => {
  const db = openDb(":memory:");
  insertRow(db, row({ height: 100, block_time: 0, orchard_balance: 10_000 }));
  insertRow(db, row({ height: 101, block_time: 43_200, orchard_balance: 5_000 }));
  insertRow(db, row({ height: 102, block_time: 86_400, orchard_balance: 5_000 }));
  insertRow(db, row({ height: 103, block_time: 129_600, orchard_balance: 5_000 }));
  // windowBlocks=2 -> windowStartHeight = 104-2 = 102, which already reflects the plateau
  // (orchard_balance unchanged from 102 to 104), isolating the recent-only window from the
  // earlier real drain (100 -> 101) that sinceSeed still correctly reflects.
  insertRow(db, row({ height: 104, block_time: 172_800, orchard_balance: 5_000 }));
  const plateauApiCfg: ApiConfig = { ...apiCfg, drainWindowBlocks: 2 };

  const result = buildDrainResponse(db, cfg, plateauApiCfg) as DrainResponseSeeded;
  // sinceSeed still shows the historical drain (10000 -> 5000 over the full span).
  assert.ok((result.rate.sinceSeed?.zatPerDay ?? -1) > 0);
  // windowed (last 2 blocks: 102 -> 104) shows the plateau: an explicit rate of 0, never
  // null, since two real data points exist.
  assert.equal(result.rate.windowed?.zatPerDay, 0);
  db.close();
});

test("buildDrainResponse: series always includes the final (residual) point even when downsampled", () => {
  const db = openDb(":memory:");
  for (let h = 100; h <= 199; h++) {
    insertRow(db, row({ height: h, block_time: h * 100, orchard_balance: 10_000 - h }));
  }
  const tightApiCfg: ApiConfig = { ...apiCfg, drainMaxPoints: 10 };
  const result = buildDrainResponse(db, cfg, tightApiCfg) as DrainResponseSeeded;
  assert.equal(result.series[result.series.length - 1].height, 199);
  db.close();
});

// --- buildResidualResponse / buildAttestResponse ---

const attestationCfg: Pick<AttestationConfig, "maxAnchorStalenessBlocks"> = { maxAnchorStalenessBlocks: 100 };
const alwaysValidVerify: VerifyFn = async () => ({ valid: true, dedupTag: "fake-tag", circuitVersion: "test-v0" });
const alwaysInvalidVerify: VerifyFn = async () => ({ valid: false, reason: "rejected for testing" });

test("buildResidualResponse: not-yet-seeded table returns seeded:false", () => {
  const db = openDb(":memory:");
  const result = buildResidualResponse(db);
  assert.equal(result.seeded, false);
  db.close();
});

test("buildResidualResponse: no attestations yet -> attested=0, unattestedResidual=residual", () => {
  const db = openDb(":memory:");
  insertRow(db, row({ height: 100, orchard_balance: 5000 }));
  const result = buildResidualResponse(db) as ResidualResponseSeeded;
  assert.equal(result.residual, 5000);
  assert.equal(result.attested, 0);
  assert.equal(result.unattestedResidual, 5000);
  assert.equal(result.participationRate, 0);
  assert.equal(result.attestationCount, 0);
  assert.match(result.disclaimer, /does not prove counterfeit/);
});

test("buildAttestResponse: a valid proof is stored and reflected in a subsequent residual read", async () => {
  const db = openDb(":memory:");
  insertRow(db, row({ height: 100, orchard_balance: 5000 }));

  const result = await buildAttestResponse(
    db,
    { anchor: "anchor1", anchorHeight: 100, claimedValue: 1200, proof: "AAAA" },
    alwaysValidVerify,
    attestationCfg,
  );
  assert.equal(result.dedupTag, "fake-tag");
  assert.equal(result.claimedValue, 1200);

  const residual = buildResidualResponse(db) as ResidualResponseSeeded;
  assert.equal(residual.attested, 1200);
  assert.equal(residual.unattestedResidual, 3800);
  assert.equal(residual.participationRate, 1200 / 5000);
});

test("buildAttestResponse: rejects malformed bodies before ever calling verify", async () => {
  const db = openDb(":memory:");
  insertRow(db, row({ height: 100, orchard_balance: 5000 }));
  let verifyCalled = false;
  const verify: VerifyFn = async () => {
    verifyCalled = true;
    return { valid: true, dedupTag: "x" };
  };

  await assert.rejects(
    () => buildAttestResponse(db, { anchor: "a" }, verify, attestationCfg),
    BadRequestError,
  );
  assert.equal(verifyCalled, false, "verify must not be called for a request that fails validation first");
});

test("buildAttestResponse: rejects an anchorHeight ahead of the latest indexed height", async () => {
  const db = openDb(":memory:");
  insertRow(db, row({ height: 100, orchard_balance: 5000 }));
  await assert.rejects(
    () => buildAttestResponse(db, { anchor: "a", anchorHeight: 999, claimedValue: 100, proof: "AAAA" }, alwaysValidVerify, attestationCfg),
    BadRequestError,
  );
});

test("buildAttestResponse: rejects an anchor staler than maxAnchorStalenessBlocks", async () => {
  const db = openDb(":memory:");
  insertRow(db, row({ height: 300, orchard_balance: 5000 }));
  const strictCfg = { maxAnchorStalenessBlocks: 10 };
  await assert.rejects(
    () => buildAttestResponse(db, { anchor: "a", anchorHeight: 100, claimedValue: 100, proof: "AAAA" }, alwaysValidVerify, strictCfg),
    BadRequestError,
  );
});

test("buildAttestResponse: a verifier rejection throws VerificationFailedError, not stored", async () => {
  const db = openDb(":memory:");
  insertRow(db, row({ height: 100, orchard_balance: 5000 }));
  await assert.rejects(
    () => buildAttestResponse(db, { anchor: "a", anchorHeight: 100, claimedValue: 100, proof: "AAAA" }, alwaysInvalidVerify, attestationCfg),
    VerificationFailedError,
  );
  const residual = buildResidualResponse(db) as ResidualResponseSeeded;
  assert.equal(residual.attestationCount, 0);
});

test("buildAttestResponse: a duplicate dedup_tag throws DuplicateAttestationError, and the total is not double-counted", async () => {
  const db = openDb(":memory:");
  insertRow(db, row({ height: 100, orchard_balance: 5000 }));
  const body = { anchor: "a", anchorHeight: 100, claimedValue: 500, proof: "AAAA" };

  await buildAttestResponse(db, body, alwaysValidVerify, attestationCfg);
  await assert.rejects(
    () => buildAttestResponse(db, { ...body, proof: "BBBB" }, alwaysValidVerify, attestationCfg),
    DuplicateAttestationError,
  );

  const residual = buildResidualResponse(db) as ResidualResponseSeeded;
  assert.equal(residual.attested, 500, "the duplicate must not have been counted a second time");
  assert.equal(residual.attestationCount, 1);
});
