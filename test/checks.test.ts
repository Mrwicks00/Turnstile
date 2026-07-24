import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOrchardBalanceNonNegative, checkOrchardTxNonNegative } from "../src/checks.js";
import type { TxValueFields } from "../src/types.js";

test("checkOrchardBalanceNonNegative: non-negative balance passes", () => {
  const row = checkOrchardBalanceNonNegative(500, 1000);
  assert.equal(row.status, "pass");
  assert.equal(row.height, 500);
  assert.equal(row.txid, null);
  assert.equal(row.detail, "orchard_balance=1000");
});

test("checkOrchardBalanceNonNegative: zero balance passes (boundary)", () => {
  const row = checkOrchardBalanceNonNegative(500, 0);
  assert.equal(row.status, "pass");
});

test("checkOrchardBalanceNonNegative: negative balance fails", () => {
  const row = checkOrchardBalanceNonNegative(500, -1);
  assert.equal(row.status, "fail");
  assert.equal(row.detail, "orchard_balance=-1");
});

test("checkOrchardTxNonNegative: a tx with no orchard field at all produces zero rows", () => {
  const txs: TxValueFields[] = [{ txid: "a" }];
  const rows = checkOrchardTxNonNegative(100, txs);
  assert.deepEqual(rows, []);
});

test("checkOrchardTxNonNegative: orchard field present but with zero actions produces zero rows", () => {
  // Verified live against a real node: the `orchard` field is present (empty) on EVERY
  // transaction of every version, including pre-Sapling transparent coinbase txs - it is
  // NOT a signal of real Orchard involvement on its own. This is the exact edge case that
  // was originally implemented wrong (checking the field's presence instead of whether it
  // has any actions), so it gets its own explicit test.
  const txs: TxValueFields[] = [{ txid: "b", orchard: { actions: [], valueBalanceZat: 0 } }];
  const rows = checkOrchardTxNonNegative(100, txs);
  assert.deepEqual(rows, []);
});

test("checkOrchardTxNonNegative: orchard with a real action but valueBalanceZat absent still gets a row", () => {
  const txs: TxValueFields[] = [{ txid: "b2", orchard: { actions: [{}] } }];
  const rows = checkOrchardTxNonNegative(100, txs);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "pass");
  assert.equal(rows[0].detail, "valueBalanceOrchard=0");
});

test("checkOrchardTxNonNegative: negative valueBalanceZat fails with correct txid", () => {
  const txs: TxValueFields[] = [{ txid: "c", orchard: { actions: [{}], valueBalanceZat: -42 } }];
  const rows = checkOrchardTxNonNegative(100, txs);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "fail");
  assert.equal(rows[0].txid, "c");
  assert.equal(rows[0].detail, "valueBalanceOrchard=-42");
});

test("checkOrchardTxNonNegative: positive valueBalanceZat passes", () => {
  const txs: TxValueFields[] = [{ txid: "d", orchard: { actions: [{}], valueBalanceZat: 42 } }];
  const rows = checkOrchardTxNonNegative(100, txs);
  assert.equal(rows[0].status, "pass");
});

test("checkOrchardTxNonNegative: mixed block only records txs with real Orchard actions", () => {
  const txs: TxValueFields[] = [
    { txid: "transparent-only" },
    { txid: "orchard-structural-only", orchard: { actions: [], valueBalanceZat: 0 } },
    { txid: "orchard-pass", orchard: { actions: [{}], valueBalanceZat: 10 } },
    { txid: "sapling-only", valueBalanceZat: 5 },
    { txid: "orchard-fail", orchard: { actions: [{}], valueBalanceZat: -10 } },
  ];
  const rows = checkOrchardTxNonNegative(100, txs);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => [r.txid, r.status]),
    [
      ["orchard-pass", "pass"],
      ["orchard-fail", "fail"],
    ],
  );
});
