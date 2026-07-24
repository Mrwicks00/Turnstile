import { test } from "node:test";
import assert from "node:assert/strict";
import {
  openDb,
  loadCursor,
  getBlockHashAt,
  insertRow,
  rollbackTo,
  insertCheckRow,
  insertCheckRows,
  getChecksAtHeight,
  listRecentChecks,
  getPoolBalanceRange,
  getLatestPoolBalance,
  getDrainSeries,
  type PoolBalanceRow,
  type CheckRow,
} from "../src/db.js";

function row(overrides: Partial<PoolBalanceRow> & { height: number; block_hash: string }): PoolBalanceRow {
  return {
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

function checkRow(overrides: Partial<CheckRow> & { height: number }): CheckRow {
  return {
    check_name: "orchard_balance_nonnegative",
    txid: null,
    status: "pass",
    detail: null,
    checked_at: 1_600_000_000,
    ...overrides,
  };
}

test("loadCursor returns null on an empty table", () => {
  const db = openDb(":memory:");
  assert.equal(loadCursor(db), null);
  db.close();
});

test("insertRow + loadCursor round-trip", () => {
  const db = openDb(":memory:");
  insertRow(db, row({ height: 100, block_hash: "hash100", orchard_balance: 500 }));
  insertRow(db, row({ height: 101, block_hash: "hash101", parent_hash: "hash100", orchard_balance: 700 }));

  const cursor = loadCursor(db);
  assert.ok(cursor);
  assert.equal(cursor.height, 101);
  assert.equal(cursor.blockHash, "hash101");
  assert.equal(cursor.orchardBalance, 700);
  db.close();
});

test("getBlockHashAt returns the stored hash, or null when absent", () => {
  const db = openDb(":memory:");
  insertRow(db, row({ height: 5, block_hash: "abc" }));
  assert.equal(getBlockHashAt(db, 5), "abc");
  assert.equal(getBlockHashAt(db, 6), null);
  db.close();
});

test("rollbackTo deletes every row above the ancestor height (pool_balance and checks together)", () => {
  const db = openDb(":memory:");
  for (const h of [10, 11, 12, 13]) {
    insertRow(db, row({ height: h, block_hash: `hash${h}` }));
    insertCheckRow(db, checkRow({ height: h }));
  }
  rollbackTo(db, 11);

  assert.equal(getBlockHashAt(db, 11), "hash11");
  assert.equal(getBlockHashAt(db, 12), null);
  assert.equal(getBlockHashAt(db, 13), null);
  const cursor = loadCursor(db);
  assert.equal(cursor?.height, 11);

  assert.equal(getChecksAtHeight(db, 11).length, 1);
  assert.equal(getChecksAtHeight(db, 12).length, 0);
  assert.equal(getChecksAtHeight(db, 13).length, 0);
  db.close();
});

test("insertCheckRow + getChecksAtHeight round-trip", () => {
  const db = openDb(":memory:");
  insertCheckRow(db, checkRow({ height: 50, status: "pass", detail: "orchard_balance=100" }));
  insertCheckRow(db, checkRow({ height: 50, check_name: "orchard_tx_nonnegative", txid: "abc", status: "fail" }));

  const rows = getChecksAtHeight(db, 50);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].check_name, "orchard_balance_nonnegative");
  assert.equal(rows[1].txid, "abc");
  assert.equal(rows[1].status, "fail");
  db.close();
});

test("insertCheckRows inserts a batch in order", () => {
  const db = openDb(":memory:");
  insertCheckRows(db, [
    checkRow({ height: 60, txid: "t1" }),
    checkRow({ height: 60, txid: "t2" }),
  ]);
  assert.equal(getChecksAtHeight(db, 60).length, 2);
  db.close();
});

test("listRecentChecks orders by height DESC, id DESC regardless of insertion order", () => {
  const db = openDb(":memory:");
  insertCheckRow(db, checkRow({ height: 10 }));
  insertCheckRow(db, checkRow({ height: 30 }));
  insertCheckRow(db, checkRow({ height: 20 }));

  const recent = listRecentChecks(db, 2);
  assert.deepEqual(
    recent.map((r) => r.height),
    [30, 20],
  );
  db.close();
});

test("getPoolBalanceRange returns rows within [from, to] inclusive, ordered ascending", () => {
  const db = openDb(":memory:");
  for (const h of [10, 11, 12, 13, 14]) {
    insertRow(db, row({ height: h, block_hash: `hash${h}` }));
  }
  const rows = getPoolBalanceRange(db, 11, 13);
  assert.deepEqual(
    rows.map((r) => r.height),
    [11, 12, 13],
  );
  db.close();
});

test("getPoolBalanceRange returns an empty array for a range with no rows", () => {
  const db = openDb(":memory:");
  insertRow(db, row({ height: 100, block_hash: "hash100" }));
  assert.deepEqual(getPoolBalanceRange(db, 200, 300), []);
  db.close();
});

test("getLatestPoolBalance returns null on an empty table, and the MAX(height) row otherwise", () => {
  const db = openDb(":memory:");
  assert.equal(getLatestPoolBalance(db), null);

  insertRow(db, row({ height: 100, block_hash: "hash100", block_time: 1000 }));
  insertRow(db, row({ height: 101, block_hash: "hash101", block_time: 2000, orchard_balance: 42 }));

  const latest = getLatestPoolBalance(db);
  assert.equal(latest?.height, 101);
  assert.equal(latest?.block_time, 2000);
  assert.equal(latest?.orchard_balance, 42);
  db.close();
});

test("getDrainSeries returns every row when the range fits under maxPoints", () => {
  const db = openDb(":memory:");
  for (const h of [1, 2, 3, 4, 5]) {
    insertRow(db, row({ height: h, block_hash: `hash${h}` }));
  }
  const series = getDrainSeries(db, 1, 5, 100);
  assert.deepEqual(
    series.map((p) => p.height),
    [1, 2, 3, 4, 5],
  );
  db.close();
});

test("getDrainSeries downsamples when the range exceeds maxPoints, and never drops the last point", () => {
  const db = openDb(":memory:");
  for (let h = 0; h < 1000; h++) {
    insertRow(db, row({ height: h, block_hash: `hash${h}` }));
  }
  const series = getDrainSeries(db, 0, 999, 100);
  assert.ok(series.length <= 101, `expected roughly maxPoints rows, got ${series.length}`);
  assert.ok(series.length > 1);
  // The last point (current residual) must always be present, even though 999 doesn't
  // fall on the modulo boundary for a step size like ceil(1000/100)=10.
  assert.equal(series[series.length - 1].height, 999);
  assert.equal(series[0].height, 0);
  db.close();
});
