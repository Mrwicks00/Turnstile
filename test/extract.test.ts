import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractBlockDeltas } from "../src/extract.js";
import type { TxValueFields } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): { tx: TxValueFields[] } {
  return JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));
}

test("block 1 (coinbase only, no shielded activity) -> all-zero deltas", () => {
  const block = loadFixture("block-1.json");
  const result = extractBlockDeltas(block);
  assert.deepEqual(result, { orchard_delta: 0, sapling_delta: 0, sprout_delta: 0, tx_count: 1 });
});

test("block 12350 (real testnet joinsplit) -> correct sprout_delta", () => {
  const block = loadFixture("block-12350.json");
  const result = extractBlockDeltas(block);
  // vpub_old=0, vpub_new=612040000 zat for the one joinsplit in this block.
  assert.equal(result.sprout_delta, 0 - 612040000);
  assert.equal(result.orchard_delta, 0);
  assert.equal(result.sapling_delta, 0);
  assert.equal(result.tx_count, 2);
});

test("synthetic multi-tx, multi-joinsplit block sums and negates correctly", () => {
  const block: { tx: TxValueFields[] } = {
    tx: [
      { txid: "a", valueBalanceZat: 1000, orchard: { actions: [{}], valueBalanceZat: 2000 } },
      { txid: "b", valueBalanceZat: -500, orchard: { actions: [{}], valueBalanceZat: -300 } },
      {
        txid: "c",
        vjoinsplit: [
          { vpub_oldZat: 100, vpub_newZat: 0 },
          { vpub_oldZat: 0, vpub_newZat: 40 },
        ],
      },
    ],
  };
  const result = extractBlockDeltas(block);
  // sapling_delta = -(1000 + -500) = -500
  assert.equal(result.sapling_delta, -500);
  // orchard_delta = -(2000 + -300) = -1700
  assert.equal(result.orchard_delta, -1700);
  // sprout_delta = (100 + 0) - (0 + 40) = 60
  assert.equal(result.sprout_delta, 60);
  assert.equal(result.tx_count, 3);
});

test("transparent-only tx (no valueBalance/orchard/vjoinsplit fields) contributes zero", () => {
  const block: { tx: TxValueFields[] } = { tx: [{ txid: "t" }] };
  const result = extractBlockDeltas(block);
  assert.deepEqual(result, { orchard_delta: 0, sapling_delta: 0, sprout_delta: 0, tx_count: 1 });
});
