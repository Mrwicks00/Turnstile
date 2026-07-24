/** Only the fields Task 1 actually reads from getblock's real (much larger) payload. */

export interface JoinSplit {
  vpub_oldZat: number;
  vpub_newZat: number;
}

export interface TxValueFields {
  txid: string;
  valueBalanceZat?: number; // Sapling; absent on pre-Sapling / fully-transparent txs
  orchard?: {
    // Present (empty) on EVERY transaction regardless of version or Orchard usage - it is
    // NOT a reliable signal of real Orchard involvement on its own. `actions.length > 0` is
    // the actual signal; see checks.ts's checkOrchardTxNonNegative.
    actions: unknown[];
    valueBalanceZat?: number;
  };
  vjoinsplit?: JoinSplit[];
}

export interface ValuePoolEntry {
  id: string; // "transparent" | "sprout" | "sapling" | "orchard" | "lockbox" | "ironwood"
  chainValueZat: number;
  monitored: boolean;
}

export interface GetBlockResult {
  hash: string;
  height: number;
  time: number;
  previousblockhash?: string; // absent only at genesis (height 0); irrelevant for Mode B
  tx: TxValueFields[];
  valuePools: ValuePoolEntry[];
}

export interface GetBlockchainInfoResult {
  chain: string;
  blocks: number;
  headers: number;
  valuePools: ValuePoolEntry[];
}

/** Empty {} pre-activation for that pool; { finalRoot, finalState } once activated.
 * finalRoot is the anchor Phase 2 attestation proofs bind to. */
export interface TreestateCommitments {
  finalRoot?: string;
  finalState?: string;
}

/**
 * Shape of z_gettreestate. `sapling` confirmed empirically against a live node at a
 * post-Sapling-activation testnet height (finalRoot/finalState present). `orchard` is typed
 * by symmetry with `sapling` only - NOT yet empirically confirmed populated, since the local
 * node hasn't reached NU5/Orchard activation. Re-verify this shape once it has, following the
 * same "capture real JSON before trusting field names" discipline as Task 0 (see
 * TASK0_FINDINGS.md).
 */
export interface GetTreestateResult {
  hash: string;
  height: number;
  time: number;
  sapling: { commitments: TreestateCommitments };
  orchard: { commitments: TreestateCommitments };
}
