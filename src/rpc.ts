import { readFileSync } from "node:fs";
import type { GetBlockResult, GetBlockchainInfoResult, GetTreestateResult } from "./types.js";

export interface RpcClientOptions {
  url: string;
  /** Cookie-file Basic auth (our own zebrad/zcashd-style node). Mutually exclusive with
   * `apiKey` - set exactly one, or neither for an endpoint that needs no auth at all (e.g. a
   * hosted provider's free tier). */
  cookiePath?: string;
  /** Sent as `x-api-key` (the convention hosted RPC gateways like Tatum use), instead of
   * cookie-based Basic auth. */
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

/** A JSON-RPC error response (HTTP 200, non-null "error" field). Non-retryable at this layer. */
export class RpcError extends Error {
  constructor(message: string, public readonly code?: number, public readonly data?: unknown) {
    super(message);
    this.name = "RpcError";
  }
}

/** Network-level failure (connection refused/reset, timeout, HTTP 5xx). Retried with backoff. */
class TransientRpcFailure extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Cookie file content is literally "__cookie__:<token>" - already the "user:pass" string
 * that HTTP Basic auth expects, so we just base64 it directly (equivalent to curl -u). */
function cookieAuthHeader(cookiePath: string): string {
  const raw = readFileSync(cookiePath, "utf8").trim();
  return "Basic " + Buffer.from(raw, "utf8").toString("base64");
}

/** The subset of RpcClient's surface the indexer depends on - lets tests substitute a fake. */
export interface RpcLike {
  getBlockchainInfo(): Promise<GetBlockchainInfoResult>;
  getBlockHash(height: number): Promise<string>;
  getBlock(height: number, verbosity: 2): Promise<GetBlockResult>;
  getTreestate(height: number): Promise<GetTreestateResult>;
}

export class RpcClient implements RpcLike {
  private readonly url: string;
  private readonly cookiePath?: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  constructor(opts: RpcClientOptions) {
    if (opts.cookiePath && opts.apiKey) {
      throw new Error("RpcClient: set at most one of cookiePath or apiKey, not both");
    }
    this.url = opts.url;
    this.cookiePath = opts.cookiePath;
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxRetries = opts.maxRetries ?? 5;
    this.retryBaseMs = opts.retryBaseMs ?? 250;
    this.retryMaxMs = opts.retryMaxMs ?? 5_000;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cookiePath) {
      headers.authorization = cookieAuthHeader(this.cookiePath);
    } else if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }
    // Neither set: no auth header at all - a hosted provider's free/public tier (e.g. Tatum).
    return headers;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const body = JSON.stringify({ jsonrpc: "1.0", id: `${method}-${Date.now()}`, method, params });
    let lastErr: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers: this.buildHeaders(),
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        // Cookie may have just rotated (node restart) - one free retry after re-reading the file.
        // Only relevant in cookie-auth mode; harmless no-op otherwise.
        if (res.status === 401 && attempt === 0 && this.cookiePath) continue;

        // 429 (rate limited - real on hosted providers like Tatum's free tier) and 5xx are
        // both transient: worth retrying with backoff rather than failing the whole block.
        if (res.status === 429 || res.status >= 500) {
          throw new TransientRpcFailure(`HTTP ${res.status} from ${method}`);
        }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new RpcError(`HTTP ${res.status} from ${method}: ${text}`);
        }

        const json = (await res.json()) as { result: T; error: { code: number; message: string } | null };
        if (json.error) {
          throw new RpcError(json.error.message ?? JSON.stringify(json.error), json.error.code, json.error);
        }
        return json.result;
      } catch (err) {
        if (err instanceof RpcError) throw err; // application-level: propagate immediately, no retry
        lastErr = err;
        if (attempt === this.maxRetries) break;
        const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** attempt);
        await sleep(delay * (0.5 + Math.random() * 0.5)); // jittered backoff
      }
    }
    throw new RpcError(`${method} failed after ${this.maxRetries + 1} attempts: ${String(lastErr)}`);
  }

  async getBlockchainInfo(): Promise<GetBlockchainInfoResult> {
    return this.call<GetBlockchainInfoResult>("getblockchaininfo", []);
  }

  /** Verified: getblockhash takes the height as a NUMBER, not a string. */
  async getBlockHash(height: number): Promise<string> {
    return this.call<string>("getblockhash", [height]);
  }

  /** Verified: getblock takes the height as a STRING, not a number (opposite of getblockhash). */
  async getBlock(height: number, verbosity: 2): Promise<GetBlockResult> {
    return this.call<GetBlockResult>("getblock", [String(height), verbosity]);
  }

  /** Verified: z_gettreestate takes the height as a STRING, same convention as getblock. */
  async getTreestate(height: number): Promise<GetTreestateResult> {
    return this.call<GetTreestateResult>("z_gettreestate", [String(height)]);
  }
}

/** True if `err` is an RpcError with the given JSON-RPC error code. */
export function isRpcErrorCode(err: unknown, code: number): boolean {
  return err instanceof RpcError && err.code === code;
}

/** "block height not in best chain" - returned for a height beyond tip, or one that just fell
 * out of the best chain during a live reorg. Treated as a reorg signal, not a fatal error. */
export const BLOCK_HEIGHT_NOT_IN_BEST_CHAIN = -8;
