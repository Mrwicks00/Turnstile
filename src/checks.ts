import type { TxValueFields } from "./types.js";
import type { CheckRow, CheckStatus } from "./db.js";

export const CHECK_ORCHARD_BALANCE_NONNEGATIVE = "orchard_balance_nonnegative";
export const CHECK_ORCHARD_TX_NONNEGATIVE = "orchard_tx_nonnegative";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Check 1 (block-level, ZIP 209): orchard_balance >= 0 at every height.
 * Always returns a row - pass or fail - so the audit log proves the check ran at
 * every height, not just when something went wrong (an audit log that only
 * records failures is indistinguishable from "the checker never ran").
 */
export function checkOrchardBalanceNonNegative(height: number, orchardBalance: number): CheckRow {
  const status: CheckStatus = orchardBalance >= 0 ? "pass" : "fail";
  return {
    check_name: CHECK_ORCHARD_BALANCE_NONNEGATIVE,
    height,
    txid: null,
    status,
    detail: `orchard_balance=${orchardBalance}`,
    checked_at: nowSeconds(),
  };
}

/**
 * Check 2 (tx-level, ZIP 258 / NU6.3+): valueBalanceOrchard >= 0 for every
 * Orchard-touching transaction. Only transactions with at least one real Orchard
 * action get a row (pass or fail). Verified empirically against a live node: the
 * `orchard` field is present (with empty `actions` and zero `valueBalanceZat`) on
 * EVERY transaction of every version, including pre-Sapling transparent coinbase
 * transactions - it is a structural part of the RPC schema, not a signal of real
 * Orchard involvement. `actions.length > 0` is the actual signal; a transaction
 * with zero actions carries zero audit value, so it is intentionally skipped
 * (unlike check 1, which records every height).
 *
 * Mode-agnostic and does no activation-height gating itself: in Mode B every
 * block passed to this function is already at/after the activation height by
 * construction (see ensureSeeded/firstIndexedHeight in indexer.ts/config.ts). A
 * future Mode A caller (recomputing from NU5 activation) MUST gate calls to this
 * function on `block.height >= activationHeight` itself, since pre-NU6.3
 * Orchard txs are legitimately allowed to be negative.
 */
export function checkOrchardTxNonNegative(height: number, txs: TxValueFields[]): CheckRow[] {
  const rows: CheckRow[] = [];
  const checkedAt = nowSeconds();
  for (const tx of txs) {
    if (tx.orchard === undefined || tx.orchard.actions.length === 0) continue; // no real Orchard activity
    const value = tx.orchard.valueBalanceZat ?? 0;
    const status: CheckStatus = value >= 0 ? "pass" : "fail";
    rows.push({
      check_name: CHECK_ORCHARD_TX_NONNEGATIVE,
      height,
      txid: tx.txid,
      status,
      detail: `valueBalanceOrchard=${value}`,
      checked_at: checkedAt,
    });
  }
  return rows;
}

// TASK 2, item 3 (Mode A only, out of scope here): recomputed orchard_balance at
// tip vs. the node's own reported chainValueZat. Would live here as
// checkOrchardBalanceMatchesNode(...), called once at tip rather than per-block,
// and would need an archive node (not available under Mode B / pruned sync).
