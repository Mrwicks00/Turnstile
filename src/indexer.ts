import type { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.js";
import { seedHeight } from "./config.js";
import type { RpcLike } from "./rpc.js";
import { isRpcErrorCode, BLOCK_HEIGHT_NOT_IN_BEST_CHAIN } from "./rpc.js";
import type { GetBlockResult } from "./types.js";
import { extractBlockDeltas } from "./extract.js";
import { loadCursor, getBlockHashAt, insertRow, insertCheckRow, insertCheckRows, rollbackTo, type Cursor } from "./db.js";
import { checkOrchardBalanceNonNegative, checkOrchardTxNonNegative } from "./checks.js";
import { logger } from "./logger.js";

export interface IndexerContext {
  rpc: RpcLike;
  db: DatabaseSync;
  cfg: Config;
  /** Checked between loop iterations; return true (e.g. from a SIGINT handler) to stop cleanly. */
  shouldStop: () => boolean;
}

interface Settled {
  height: number;
  epoch: number;
  block?: GetBlockResult;
  error?: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchTip(rpc: RpcLike): Promise<number> {
  const info = await rpc.getBlockchainInfo();
  return info.blocks;
}

/** Fresh table: seed a trusted boundary row at (activationHeight - 1) from the node's own
 * reported chainValueZat. Every height from activationHeight onward is then independently
 * recomputed from transaction data - this seed row is the only place we trust the node. */
async function ensureSeeded(rpc: RpcLike, db: DatabaseSync, cfg: Config): Promise<void> {
  if (loadCursor(db)) return;

  const seedH = seedHeight(cfg);
  const info = await rpc.getBlockchainInfo();
  if (info.blocks < seedH) {
    throw new Error(
      `Node has only synced to height ${info.blocks}, but Mode B needs height ${seedH} ` +
        `(one below the activation height) to seed the starting balance. Wait for sync to progress.`,
    );
  }

  const block = await rpc.getBlock(seedH, 2);
  const pool = (id: string) => block.valuePools.find((p) => p.id === id)?.chainValueZat ?? 0;
  const orchard_balance = pool("orchard");
  const sapling_balance = pool("sapling");
  const sprout_balance = pool("sprout");

  insertRow(db, {
    height: block.height,
    block_hash: block.hash,
    parent_hash: block.previousblockhash ?? "",
    block_time: block.time,
    orchard_delta: 0,
    sapling_delta: 0,
    sprout_delta: 0,
    orchard_balance,
    sapling_balance,
    sprout_balance,
    tx_count: block.tx.length,
  });

  logger.info("seeded Mode B starting balance", {
    height: block.height,
    orchard_balance,
    sapling_balance,
    sprout_balance,
  });
}

/** Recomputes deltas from the block's own transactions, runs the Task 2 invariant checks,
 * inserts the pool_balance row and check rows atomically, and returns the updated cursor.
 * Assumes the caller already verified previousblockhash. */
function applyBlock(db: DatabaseSync, cursor: Cursor, block: GetBlockResult): Cursor {
  const deltas = extractBlockDeltas(block);
  const orchard_balance = cursor.orchardBalance + deltas.orchard_delta;
  const sapling_balance = cursor.saplingBalance + deltas.sapling_delta;
  const sprout_balance = cursor.sproutBalance + deltas.sprout_delta;

  for (const [name, value] of [
    ["orchard", orchard_balance],
    ["sapling", sapling_balance],
    ["sprout", sprout_balance],
  ] as const) {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Fatal: ${name}_balance lost integer precision at height ${block.height}: ${value}`);
    }
  }

  // Check 2 runs first so its per-tx forensic detail is captured even if check 1 (below)
  // throws for the same block. A check-2 violation is logged and recorded but does NOT
  // halt the indexer: ZIP 258 is consensus-enforced, so a real violation here would mean
  // the network already rejected the block - a hit is far more likely our own bug, and
  // halting the whole pipeline over that isn't obviously right.
  const txChecks = checkOrchardTxNonNegative(block.height, block.tx);
  for (const row of txChecks) {
    if (row.status === "fail") {
      logger.error("ZIP 258 VIOLATION: valueBalanceOrchard negative for Orchard tx", {
        height: row.height,
        txid: row.txid,
        detail: row.detail,
      });
    }
  }

  // Check 1 (ZIP 209): "this should never fire; if it does, it is the headline result" -
  // still fatal, but must now leave a durable audit record before it throws (previously
  // this guard just crashed with nothing written).
  const balanceCheck = checkOrchardBalanceNonNegative(block.height, orchard_balance);

  db.exec("BEGIN");
  try {
    insertRow(db, {
      height: block.height,
      block_hash: block.hash,
      parent_hash: block.previousblockhash ?? "",
      block_time: block.time,
      orchard_delta: deltas.orchard_delta,
      sapling_delta: deltas.sapling_delta,
      sprout_delta: deltas.sprout_delta,
      orchard_balance,
      sapling_balance,
      sprout_balance,
      tx_count: deltas.tx_count,
    });
    insertCheckRows(db, txChecks);
    insertCheckRow(db, balanceCheck);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  if (balanceCheck.status === "fail") {
    logger.error("ZIP 209 VIOLATION: orchard_balance went negative", { height: block.height, orchard_balance });
    throw new Error(
      `ZIP 209 VIOLATION: orchard_balance went negative at height ${block.height} (${orchard_balance} zat). ` +
        `This should never happen - more value left the Orchard pool than ever entered it.`,
    );
  }

  return { height: block.height, blockHash: block.hash, orchardBalance: orchard_balance, saplingBalance: sapling_balance, sproutBalance: sprout_balance };
}

/** Walks backward from `fromHeight` using cheap getblockhash calls until the stored hash
 * matches the node's, or gives up at maxDepth / the Mode B seed boundary. */
async function findCommonAncestor(
  rpc: RpcLike,
  db: DatabaseSync,
  fromHeight: number,
  maxDepth: number,
  seedH: number,
): Promise<number> {
  const floor = Math.max(fromHeight - maxDepth, seedH);
  let h = fromHeight;
  while (h >= floor) {
    const stored = getBlockHashAt(db, h);
    if (stored === null) {
      throw new Error(`Fatal: rollback walked to height ${h} with no stored row (below indexed range)`);
    }
    const real = await rpc.getBlockHash(h);
    if (real === stored) return h;
    h--;
  }
  if (floor === seedH) {
    throw new Error(
      `Fatal: reorg walk-back reached the Mode B seed height (${seedH}) without finding a common ancestor. ` +
        `The seed's trusted boundary block may itself have been reorged out - this needs a fresh reseed, ` +
        `not an automatic rollback.`,
    );
  }
  throw new Error(`Fatal: reorg deeper than maxReorgDepth (${maxDepth}); manual intervention required`);
}

async function performRollback(rpc: RpcLike, db: DatabaseSync, cfg: Config, fromHeight: number): Promise<Cursor> {
  const ancestor = await findCommonAncestor(rpc, db, fromHeight, cfg.maxReorgDepth, seedHeight(cfg));
  logger.warn("reorg: rolling back to common ancestor", { ancestor, rolledBackFrom: fromHeight });
  rollbackTo(db, ancestor);
  const cursor = loadCursor(db);
  if (!cursor) throw new Error("Fatal: rollback emptied the table entirely - reseed required");
  return cursor;
}

export async function runIndexer(ctx: IndexerContext): Promise<void> {
  const { rpc, db, cfg } = ctx;

  await ensureSeeded(rpc, db, cfg);
  let cursor = loadCursor(db)!; // guaranteed non-null: ensureSeeded just ran

  let nextToFetch = cursor.height + 1;
  let nextToApply = cursor.height + 1;
  let epoch = 0;

  const inFlight = new Map<number, Promise<Settled>>();
  const completed = new Map<number, GetBlockResult>();

  const launchFetch = (height: number, myEpoch: number) => {
    inFlight.set(
      height,
      rpc
        .getBlock(height, 2)
        .then((block): Settled => ({ height, epoch: myEpoch, block }))
        .catch((error): Settled => ({ height, epoch: myEpoch, error })),
    );
  };

  const fixedCeiling: number | null =
    cfg.stopHeightOverride ?? (cfg.runMode === "once" ? await fetchTip(rpc) : null);
  let cachedTip = fixedCeiling ?? (await fetchTip(rpc));
  let lastTipFetch = Date.now();

  logger.info("indexer starting", {
    resumeFromHeight: nextToApply,
    mode: cfg.runMode,
    ceiling: fixedCeiling ?? "dynamic (follow)",
    concurrency: cfg.concurrency,
  });

  while (!ctx.shouldStop()) {
    if (fixedCeiling === null && (nextToFetch > cachedTip || Date.now() - lastTipFetch > cfg.pollIntervalMs)) {
      cachedTip = await fetchTip(rpc);
      lastTipFetch = Date.now();
    }
    const ceiling = fixedCeiling ?? cachedTip;

    while (inFlight.size < cfg.concurrency && nextToFetch <= ceiling) {
      launchFetch(nextToFetch, epoch);
      nextToFetch++;
    }

    if (inFlight.size === 0) {
      if (nextToApply > ceiling) {
        if (fixedCeiling !== null) {
          logger.info("indexer reached its ceiling, stopping", { height: nextToApply - 1 });
          return;
        }
        await sleep(cfg.pollIntervalMs);
      }
      continue;
    }

    const settled = await Promise.race(inFlight.values());
    inFlight.delete(settled.height);
    if (settled.epoch !== epoch) continue; // stale result from before a rollback

    if (settled.error !== undefined) {
      if (isRpcErrorCode(settled.error, BLOCK_HEIGHT_NOT_IN_BEST_CHAIN)) {
        logger.warn("reorg signal from fetch (-8 block height not in best chain)", { height: settled.height });
        cursor = await performRollback(rpc, db, cfg, nextToApply - 1);
        nextToFetch = nextToApply = cursor.height + 1;
        epoch++;
        inFlight.clear();
        completed.clear();
        continue;
      }
      throw new Error(`Fatal: block ${settled.height} fetch failed permanently: ${String(settled.error)}`);
    }

    completed.set(settled.height, settled.block!);

    while (completed.has(nextToApply)) {
      const block = completed.get(nextToApply)!;

      if (block.previousblockhash !== undefined && block.previousblockhash !== cursor.blockHash) {
        logger.warn("reorg detected: parent hash mismatch", {
          height: nextToApply,
          expectedParent: cursor.blockHash,
          actualParent: block.previousblockhash,
        });
        cursor = await performRollback(rpc, db, cfg, nextToApply - 1);
        nextToFetch = nextToApply = cursor.height + 1;
        epoch++;
        inFlight.clear();
        completed.clear();
        break;
      }

      completed.delete(nextToApply);
      cursor = applyBlock(db, cursor, block);
      nextToApply++;
    }
  }

  logger.info("indexer stopped", { lastAppliedHeight: cursor.height });
}
