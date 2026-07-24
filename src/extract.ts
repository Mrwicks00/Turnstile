import type { TxValueFields } from "./types.js";

export interface BlockDeltas {
  orchard_delta: number;
  sapling_delta: number;
  sprout_delta: number;
  tx_count: number;
}

/**
 * Independently recomputes a block's per-pool value delta from its raw transactions.
 * valueBalance is value LEAVING a pool; negate to get value entering/held.
 * Sprout has no valueBalance field - it's the sum of vpub_old (entering transparent -> shielded)
 * minus vpub_new (leaving shielded -> transparent) across every joinsplit in the block.
 */
export function extractBlockDeltas(block: { tx: TxValueFields[] }): BlockDeltas {
  let orchard_delta = 0;
  let sapling_delta = 0;
  let sprout_delta = 0;

  for (const tx of block.tx) {
    sapling_delta -= tx.valueBalanceZat ?? 0;
    orchard_delta -= tx.orchard?.valueBalanceZat ?? 0;
    for (const js of tx.vjoinsplit ?? []) {
      sprout_delta += js.vpub_oldZat;
      sprout_delta -= js.vpub_newZat;
    }
  }

  return { orchard_delta, sapling_delta, sprout_delta, tx_count: block.tx.length };
}
