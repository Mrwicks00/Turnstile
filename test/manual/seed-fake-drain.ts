/**
 * Manual verification fixture generator - NOT an automated test (no .test.ts suffix, so
 * `npm test`'s glob never picks it up). Populates a real scratch SQLite file with a
 * fabricated-but-realistic decaying drain, so the chart page and API endpoints can
 * actually be eyeballed in a browser without waiting for the real node to reach a real
 * post-NU6.3 activation height (a very long way off).
 *
 * Usage:
 *   npm run build
 *   npm run seed-fake
 *   TURNSTILE_API_DB_PATH=./data/fake-drain.sqlite npm run serve
 *   open http://127.0.0.1:8788/
 */
import { openDb, insertRow, insertCheckRow } from "../../src/db.js";
import { checkOrchardBalanceNonNegative, checkOrchardTxNonNegative } from "../../src/checks.js";

const DB_PATH = "./data/fake-drain.sqlite";
const SEED_HEIGHT = 4133999; // activationHeight (4134000) - 1
const BLOCK_COUNT = 3000;
const BLOCK_SPACING_SECONDS = 75; // Zcash's approximate real average block time
const SEED_BALANCE = 12_345_678_900_000; // ~123,456 ZEC, a plausible pre-seal Orchard balance
const PLATEAU_FRACTION = 0.15; // the drain settles at ~15% of the seed balance, never reaching 0

function main(): void {
  const db = openDb(DB_PATH);
  console.log(`Seeding ${BLOCK_COUNT} fabricated blocks into ${DB_PATH}...`);

  const seedTime = 1_753_600_000; // arbitrary but plausible unix timestamp
  insertRow(db, {
    height: SEED_HEIGHT,
    block_hash: `fakehash${SEED_HEIGHT}`,
    parent_hash: `fakehash${SEED_HEIGHT - 1}`,
    block_time: seedTime,
    orchard_delta: 0,
    sapling_delta: 0,
    sprout_delta: 0,
    orchard_balance: SEED_BALANCE,
    sapling_balance: 0,
    sprout_balance: 0,
    tx_count: 1,
  });

  const plateauBalance = Math.round(SEED_BALANCE * PLATEAU_FRACTION);
  let prevBalance = SEED_BALANCE;

  for (let i = 1; i <= BLOCK_COUNT; i++) {
    const height = SEED_HEIGHT + i;
    const blockTime = seedTime + i * BLOCK_SPACING_SECONDS;

    // Exponential decay toward the plateau, with the drain slowing down over time -
    // a plausible shape for "most legitimate holders migrate quickly, a long tail trickles
    // out, and some residual never moves".
    const progress = i / BLOCK_COUNT;
    const decayFactor = Math.exp(-3 * progress);
    const targetBalance = plateauBalance + Math.round((SEED_BALANCE - plateauBalance) * decayFactor);
    const orchard_balance = Math.min(prevBalance, targetBalance);
    const orchard_delta = orchard_balance - prevBalance; // <= 0, value only ever leaves

    const hasOrchardTx = i % 7 === 0; // sprinkle in some Orchard-touching transactions
    const txCount = hasOrchardTx ? 2 : 1;

    insertRow(db, {
      height,
      block_hash: `fakehash${height}`,
      parent_hash: `fakehash${height - 1}`,
      block_time: blockTime,
      orchard_delta,
      sapling_delta: 0,
      sprout_delta: 0,
      orchard_balance,
      sapling_balance: 0,
      sprout_balance: 0,
      tx_count: txCount,
    });

    const balanceCheck = checkOrchardBalanceNonNegative(height, orchard_balance);
    insertCheckRow(db, balanceCheck);

    if (hasOrchardTx) {
      const txChecks = checkOrchardTxNonNegative(height, [
        { txid: `faketx${height}`, orchard: { actions: [{}], valueBalanceZat: -orchard_delta } },
      ]);
      for (const c of txChecks) insertCheckRow(db, c);
    }

    // One deliberate, isolated check-2 failure partway through, to give /api/checks
    // something to show besides an unbroken wall of passes.
    if (i === Math.floor(BLOCK_COUNT / 2)) {
      insertCheckRow(db, {
        check_name: "orchard_tx_nonnegative",
        height,
        txid: "deliberate-fake-violation-for-manual-testing",
        status: "fail",
        detail: "valueBalanceOrchard=-500 (fabricated for manual testing only)",
        checked_at: blockTime,
      });
    }

    prevBalance = orchard_balance;
  }

  console.log(`Done. Seed balance: ${SEED_BALANCE} zat, final residual: ${prevBalance} zat.`);
  db.close();
}

main();
