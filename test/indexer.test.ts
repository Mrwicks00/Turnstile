import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { RpcError, type RpcLike } from "../src/rpc.js";
import type { GetBlockResult, GetBlockchainInfoResult, GetTreestateResult, TxValueFields } from "../src/types.js";
import type { Config } from "../src/config.js";
import { openDb, insertRow, loadCursor, getBlockHashAt, getChecksAtHeight } from "../src/db.js";
import { runIndexer } from "../src/indexer.js";

/** A minimal synthetic chain: height -> {hash, previousblockhash}. Mutable so tests can
 * simulate the historical "corrupted stored hash" failure mode without a live node. */
interface SyntheticBlock {
  hash: string;
  previousblockhash: string;
  tx: TxValueFields[];
}

class FakeRpc implements RpcLike {
  constructor(private chain: Map<number, SyntheticBlock>, private tip: number) {}

  async getBlockchainInfo(): Promise<GetBlockchainInfoResult> {
    return { chain: "test", blocks: this.tip, headers: this.tip, valuePools: [] };
  }

  async getBlockHash(height: number): Promise<string> {
    const b = this.chain.get(height);
    if (!b) throw new Error(`FakeRpc: no synthetic block at height ${height}`);
    return b.hash;
  }

  async getBlock(height: number, _verbosity: 2): Promise<GetBlockResult> {
    const b = this.chain.get(height);
    if (!b) throw new Error(`FakeRpc: no synthetic block at height ${height}`);
    return {
      hash: b.hash,
      height,
      time: 1_600_000_000 + height,
      previousblockhash: b.previousblockhash,
      tx: b.tx,
      valuePools: [
        { id: "orchard", chainValueZat: 0, monitored: true },
        { id: "sapling", chainValueZat: 0, monitored: true },
        { id: "sprout", chainValueZat: 0, monitored: true },
      ],
    };
  }

  // The indexer itself never calls z_gettreestate (that's Phase 2's job) - this stub only
  // exists to satisfy RpcLike so these Phase-1 indexer tests don't need to know about it.
  async getTreestate(height: number): Promise<GetTreestateResult> {
    throw new Error(`FakeRpc.getTreestate not implemented (unused by the indexer) - height ${height}`);
  }
}

function baseConfig(overrides: Partial<Config>): Config {
  return {
    rpcUrl: "unused",
    rpcAuthMode: "cookie",
    rpcCookiePath: "unused",
    rpcApiKey: null,
    network: "testnet",
    activationHeight: 101,
    startHeightOverride: null,
    stopHeightOverride: null,
    concurrency: 4,
    dbPath: ":memory:",
    runMode: "once",
    pollIntervalMs: 10,
    maxReorgDepth: 100,
    rpcTimeoutMs: 1000,
    rpcMaxRetries: 0,
    rpcRetryBaseMs: 1,
    rpcRetryMaxMs: 1,
    ...overrides,
  };
}

function buildChain(): Map<number, SyntheticBlock> {
  return new Map<number, SyntheticBlock>([
    [100, { hash: "hash100", previousblockhash: "hash99", tx: [] }],
    [101, { hash: "hash101", previousblockhash: "hash100", tx: [] }],
    [102, { hash: "hash102", previousblockhash: "hash101", tx: [] }],
    [103, { hash: "hash103", previousblockhash: "hash102", tx: [] }],
  ]);
}

/** Pre-seeds the DB directly (bypassing ensureSeeded's own RPC call) so tests can start the
 * pipeline exactly at height 101 without needing a full Mode-B seed round-trip. */
function preseed(db: DatabaseSync, height: number, hash: string, orchard_balance = 0): void {
  insertRow(db, {
    height,
    block_hash: hash,
    parent_hash: "hash99",
    block_time: 1_600_000_000,
    orchard_delta: 0,
    sapling_delta: 0,
    sprout_delta: 0,
    orchard_balance,
    sapling_balance: 0,
    sprout_balance: 0,
    tx_count: 0,
  });
}

/** Overrides one block's transaction list in an otherwise-normal synthetic chain. */
function withTx(chain: Map<number, SyntheticBlock>, height: number, tx: TxValueFields[]): Map<number, SyntheticBlock> {
  const block = chain.get(height);
  if (!block) throw new Error(`withTx: no block at height ${height} in chain`);
  chain.set(height, { ...block, tx });
  return chain;
}

test("normal run: applies blocks in order with correct parent-hash chain", async () => {
  const db = openDb(":memory:");
  preseed(db, 100, "hash100");
  const rpc = new FakeRpc(buildChain(), 102);
  await runIndexer({ rpc, db, cfg: baseConfig({ stopHeightOverride: 102 }), shouldStop: () => false });

  assert.equal(getBlockHashAt(db, 101), "hash101");
  assert.equal(getBlockHashAt(db, 102), "hash102");
  assert.equal(loadCursor(db)?.height, 102);
  db.close();
});

test("resumability: re-running with an unchanged tip makes no further inserts", async () => {
  const db = openDb(":memory:");
  preseed(db, 100, "hash100");
  const chain = buildChain();
  await runIndexer({
    rpc: new FakeRpc(chain, 102),
    db,
    cfg: baseConfig({ stopHeightOverride: 102 }),
    shouldStop: () => false,
  });
  const afterFirst = loadCursor(db);

  await runIndexer({
    rpc: new FakeRpc(chain, 102),
    db,
    cfg: baseConfig({ stopHeightOverride: 102 }),
    shouldStop: () => false,
  });
  const afterSecond = loadCursor(db);

  assert.deepEqual(afterFirst, afterSecond);
  db.close();
});

test("reorg: a corrupted stored hash is detected and rolled back to the common ancestor", async () => {
  const db = openDb(":memory:");
  preseed(db, 100, "hash100");
  const chain = buildChain();

  // First run: index height 101 normally.
  await runIndexer({
    rpc: new FakeRpc(chain, 101),
    db,
    cfg: baseConfig({ stopHeightOverride: 101 }),
    shouldStop: () => false,
  });
  assert.equal(getBlockHashAt(db, 101), "hash101");

  // Simulate the historical failure mode: our stored record of height 101 gets corrupted,
  // even though the chain itself (as the node reports it) never changed.
  db.exec(`UPDATE pool_balance SET block_hash = 'CORRUPTED' WHERE height = 101`);
  assert.equal(getBlockHashAt(db, 101), "CORRUPTED");

  // Second run: fetching block 102 (previousblockhash="hash101") should now mismatch our
  // corrupted cursor ("CORRUPTED"), triggering rollback-and-reindex.
  await runIndexer({
    rpc: new FakeRpc(chain, 102),
    db,
    cfg: baseConfig({ stopHeightOverride: 102 }),
    shouldStop: () => false,
  });

  // Height 101 was re-indexed with the correct hash, and 102 applied cleanly on top.
  assert.equal(getBlockHashAt(db, 101), "hash101");
  assert.equal(getBlockHashAt(db, 102), "hash102");
  assert.equal(loadCursor(db)?.height, 102);
  db.close();
});

test("reorg signaled via a fetch-time -8 error is handled the same way as an apply-time mismatch", async () => {
  const db = openDb(":memory:");
  preseed(db, 100, "hash100");
  const chain = buildChain();

  await runIndexer({
    rpc: new FakeRpc(chain, 101),
    db,
    cfg: baseConfig({ stopHeightOverride: 101 }),
    shouldStop: () => false,
  });

  // Corrupt height 101's stored hash again, then make the fake RPC throw the real -8 shape
  // for height 102 on the *first* attempt only, to simulate "it fell out of the best chain".
  db.exec(`UPDATE pool_balance SET block_hash = 'CORRUPTED' WHERE height = 101`);

  class FlakyOnceRpc extends FakeRpc {
    private thrown = false;
    override async getBlock(height: number, verbosity: 2) {
      if (height === 102 && !this.thrown) {
        this.thrown = true;
        throw new RpcError("block height not in best chain", -8);
      }
      return super.getBlock(height, verbosity);
    }
  }

  await runIndexer({
    rpc: new FlakyOnceRpc(chain, 102),
    db,
    cfg: baseConfig({ stopHeightOverride: 102 }),
    shouldStop: () => false,
  });

  assert.equal(getBlockHashAt(db, 101), "hash101");
  assert.equal(getBlockHashAt(db, 102), "hash102");
  db.close();
});

test("checks: an Orchard-touching tx gets check-1 and check-2 rows; a plain height still gets its check-1 pass row", async () => {
  const db = openDb(":memory:");
  // Seed with a positive orchard balance: valueBalanceZat=10 (value leaving the pool,
  // check-2 pass) produces orchard_delta=-10, so the cumulative balance must start
  // above 10 to stay non-negative (check-1 pass) - matches a real draining pool.
  preseed(db, 100, "hash100", 1000);
  const chain = withTx(buildChain(), 101, [{ txid: "orch1", orchard: { actions: [{}], valueBalanceZat: 10 } }]);

  await runIndexer({ rpc: new FakeRpc(chain, 102), db, cfg: baseConfig({ stopHeightOverride: 102 }), shouldStop: () => false });

  const at101 = getChecksAtHeight(db, 101);
  assert.equal(at101.length, 2);
  assert.ok(at101.some((r) => r.check_name === "orchard_balance_nonnegative" && r.status === "pass"));
  assert.ok(at101.some((r) => r.check_name === "orchard_tx_nonnegative" && r.txid === "orch1" && r.status === "pass"));

  // Height 102 has no transactions at all, but still gets its check-1 pass row - every
  // height, always, not just when there's Orchard activity to report on.
  const at102 = getChecksAtHeight(db, 102);
  assert.equal(at102.length, 1);
  assert.equal(at102[0].check_name, "orchard_balance_nonnegative");
  assert.equal(at102[0].status, "pass");
  db.close();
});

test("checks: check 1 failure writes a durable fail record before the indexer throws", async () => {
  const db = openDb(":memory:");
  preseed(db, 100, "hash100", 0);
  // orchard_delta = -(valueBalanceZat), so a positive valueBalanceZat drives the
  // cumulative orchard_balance negative starting from a zero seed.
  const chain = withTx(buildChain(), 101, [{ txid: "drain", orchard: { actions: [{}], valueBalanceZat: 1_000_000 } }]);

  await assert.rejects(
    () => runIndexer({ rpc: new FakeRpc(chain, 101), db, cfg: baseConfig({ stopHeightOverride: 101 }), shouldStop: () => false }),
    /ZIP 209 VIOLATION/,
  );

  const rows = getChecksAtHeight(db, 101);
  const balanceCheck = rows.find((r) => r.check_name === "orchard_balance_nonnegative");
  assert.ok(balanceCheck, "expected a durable check-1 record even though the indexer threw");
  assert.equal(balanceCheck.status, "fail");
  assert.equal(balanceCheck.detail, "orchard_balance=-1000000");
  db.close();
});

test("checks: check 2 failure is recorded but does not halt the indexer", async () => {
  const db = openDb(":memory:");
  preseed(db, 100, "hash100", 0);
  // A negative valueBalanceZat fails check 2 (value entered the pool), but produces a
  // POSITIVE orchard_delta (-(-500) = +500), so the block's cumulative orchard_balance
  // stays non-negative and check 1 passes - the two checks are independently triggerable.
  const chain = withTx(buildChain(), 101, [{ txid: "sneaky", orchard: { actions: [{}], valueBalanceZat: -500 } }]);

  await runIndexer({ rpc: new FakeRpc(chain, 103), db, cfg: baseConfig({ stopHeightOverride: 103 }), shouldStop: () => false });

  const rows = getChecksAtHeight(db, 101);
  const txCheck = rows.find((r) => r.check_name === "orchard_tx_nonnegative");
  assert.ok(txCheck);
  assert.equal(txCheck.status, "fail");
  assert.equal(txCheck.txid, "sneaky");

  const balanceCheck = rows.find((r) => r.check_name === "orchard_balance_nonnegative");
  assert.equal(balanceCheck?.status, "pass");

  // Indexing continued past the flagged height.
  assert.equal(loadCursor(db)?.height, 103);
  assert.equal(getBlockHashAt(db, 103), "hash103");
  db.close();
});

test("checks: after a reorg, checks rows at the reindexed height match a single fresh application", async () => {
  const db = openDb(":memory:");
  preseed(db, 100, "hash100", 1000);
  const chain = withTx(buildChain(), 101, [{ txid: "orch1", orchard: { actions: [{}], valueBalanceZat: 10 } }]);

  await runIndexer({ rpc: new FakeRpc(chain, 101), db, cfg: baseConfig({ stopHeightOverride: 101 }), shouldStop: () => false });
  assert.equal(getChecksAtHeight(db, 101).length, 2);

  db.exec(`UPDATE pool_balance SET block_hash = 'CORRUPTED' WHERE height = 101`);

  await runIndexer({ rpc: new FakeRpc(chain, 102), db, cfg: baseConfig({ stopHeightOverride: 102 }), shouldStop: () => false });

  // Exactly one fresh application's worth of rows - no stale duplicates left over from
  // the pre-rollback pass.
  const rows = getChecksAtHeight(db, 101);
  assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => r.check_name === "orchard_tx_nonnegative" && r.txid === "orch1" && r.status === "pass"));
  assert.equal(getBlockHashAt(db, 101), "hash101");
  db.close();
});
