import { homedir } from "node:os";
import { resolve } from "node:path";

export interface Config {
  rpcUrl: string;
  /** "cookie" (default, our own zebrad/zcashd-style node), "apikey" (hosted RPC gateway,
   * e.g. Tatum), or "none" (a hosted provider's free tier needing no auth at all). */
  rpcAuthMode: "cookie" | "apikey" | "none";
  rpcCookiePath: string;
  rpcApiKey: string | null;
  network: "testnet" | "mainnet";
  activationHeight: number;
  startHeightOverride: number | null;
  stopHeightOverride: number | null;
  concurrency: number;
  dbPath: string;
  runMode: "once" | "follow";
  pollIntervalMs: number;
  maxReorgDepth: number;
  rpcTimeoutMs: number;
  rpcMaxRetries: number;
  rpcRetryBaseMs: number;
  rpcRetryMaxMs: number;
}

function expandHome(path: string): string {
  if (path.startsWith("~")) {
    return resolve(homedir(), path.slice(1).replace(/^\/+/, ""));
  }
  return path;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${name} must be an integer, got: ${raw}`);
  }
  return n;
}

function envIntOrNull(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${name} must be an integer, got: ${raw}`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const network = (env.TURNSTILE_NETWORK ?? "testnet") as "testnet" | "mainnet";
  if (network !== "testnet" && network !== "mainnet") {
    throw new Error(`TURNSTILE_NETWORK must be "testnet" or "mainnet", got: ${network}`);
  }

  const activationHeightTestnet = envInt("TURNSTILE_ACTIVATION_HEIGHT_TESTNET", 4134000);
  const activationHeightMainnet = envInt("TURNSTILE_ACTIVATION_HEIGHT_MAINNET", 3428143);
  const activationHeight = network === "testnet" ? activationHeightTestnet : activationHeightMainnet;

  const concurrency = envInt("TURNSTILE_CONCURRENCY", 4);
  if (concurrency < 1) {
    throw new Error(`TURNSTILE_CONCURRENCY must be >= 1, got: ${concurrency}`);
  }

  const runMode = (env.TURNSTILE_RUN_MODE ?? "follow") as "once" | "follow";
  if (runMode !== "once" && runMode !== "follow") {
    throw new Error(`TURNSTILE_RUN_MODE must be "once" or "follow", got: ${runMode}`);
  }

  const maxReorgDepth = envInt("TURNSTILE_MAX_REORG_DEPTH", 100);
  if (maxReorgDepth < 1) {
    throw new Error(`TURNSTILE_MAX_REORG_DEPTH must be >= 1, got: ${maxReorgDepth}`);
  }

  const rpcAuthMode = (env.TURNSTILE_RPC_AUTH_MODE ?? "cookie") as "cookie" | "apikey" | "none";
  if (!["cookie", "apikey", "none"].includes(rpcAuthMode)) {
    throw new Error(`TURNSTILE_RPC_AUTH_MODE must be "cookie", "apikey", or "none", got: ${rpcAuthMode}`);
  }
  if (rpcAuthMode === "apikey" && !env.TURNSTILE_RPC_API_KEY) {
    throw new Error(`TURNSTILE_RPC_AUTH_MODE=apikey requires TURNSTILE_RPC_API_KEY to be set`);
  }

  return {
    rpcUrl: env.TURNSTILE_RPC_URL ?? "http://127.0.0.1:8232",
    rpcAuthMode,
    rpcCookiePath: expandHome(env.TURNSTILE_RPC_COOKIE_PATH ?? "~/.cache/zebra/.cookie"),
    rpcApiKey: env.TURNSTILE_RPC_API_KEY ?? null,
    network,
    activationHeight,
    startHeightOverride: envIntOrNull("TURNSTILE_START_HEIGHT_OVERRIDE"),
    stopHeightOverride: envIntOrNull("TURNSTILE_STOP_HEIGHT_OVERRIDE"),
    concurrency,
    dbPath: env.TURNSTILE_DB_PATH ?? "./data/turnstile.sqlite",
    runMode,
    pollIntervalMs: envInt("TURNSTILE_POLL_INTERVAL_MS", 5000),
    maxReorgDepth,
    rpcTimeoutMs: envInt("TURNSTILE_RPC_TIMEOUT_MS", 15000),
    rpcMaxRetries: envInt("TURNSTILE_RPC_MAX_RETRIES", 5),
    rpcRetryBaseMs: envInt("TURNSTILE_RPC_RETRY_BASE_MS", 250),
    rpcRetryMaxMs: envInt("TURNSTILE_RPC_RETRY_MAX_MS", 5000),
  };
}

/** The height Mode B seeds its trusted starting balance from (one below activation). */
export function seedHeight(cfg: Pick<Config, "activationHeight" | "startHeightOverride">): number {
  const effectiveActivation = cfg.startHeightOverride ?? cfg.activationHeight;
  return effectiveActivation - 1;
}

/** The first height Task 1 independently recomputes (activation height, or the test override). */
export function firstIndexedHeight(cfg: Pick<Config, "activationHeight" | "startHeightOverride">): number {
  return cfg.startHeightOverride ?? cfg.activationHeight;
}

export interface ApiConfig {
  port: number;
  host: string;
  dbPath: string;
  poolBalanceDefaultRange: number;
  poolBalanceMaxRange: number;
  checksDefaultLimit: number;
  checksMaxLimit: number;
  drainMaxPoints: number;
  drainWindowBlocks: number;
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  // Falls back to $PORT (the convention hosting platforms like Railway/Heroku/Render inject)
  // so no platform-specific env var mapping is needed to make the server bind correctly.
  const port = envInt("TURNSTILE_API_PORT", envInt("PORT", 8788));
  if (port < 1 || port > 65535) {
    throw new Error(`TURNSTILE_API_PORT must be a valid port number, got: ${port}`);
  }

  const poolBalanceDefaultRange = envInt("TURNSTILE_API_POOL_BALANCE_DEFAULT_RANGE", 1000);
  const poolBalanceMaxRange = envInt("TURNSTILE_API_POOL_BALANCE_MAX_RANGE", 20000);
  if (poolBalanceDefaultRange < 1 || poolBalanceMaxRange < poolBalanceDefaultRange) {
    throw new Error(
      `TURNSTILE_API_POOL_BALANCE_DEFAULT_RANGE/MAX_RANGE must satisfy 1 <= default <= max, got: ` +
        `default=${poolBalanceDefaultRange}, max=${poolBalanceMaxRange}`,
    );
  }

  const checksDefaultLimit = envInt("TURNSTILE_API_CHECKS_DEFAULT_LIMIT", 100);
  const checksMaxLimit = envInt("TURNSTILE_API_CHECKS_MAX_LIMIT", 1000);
  if (checksDefaultLimit < 1 || checksMaxLimit < checksDefaultLimit) {
    throw new Error(
      `TURNSTILE_API_CHECKS_DEFAULT_LIMIT/MAX_LIMIT must satisfy 1 <= default <= max, got: ` +
        `default=${checksDefaultLimit}, max=${checksMaxLimit}`,
    );
  }

  const drainMaxPoints = envInt("TURNSTILE_API_DRAIN_MAX_POINTS", 500);
  const drainWindowBlocks = envInt("TURNSTILE_API_DRAIN_WINDOW_BLOCKS", 2000);
  if (drainMaxPoints < 2) {
    throw new Error(`TURNSTILE_API_DRAIN_MAX_POINTS must be >= 2, got: ${drainMaxPoints}`);
  }
  if (drainWindowBlocks < 1) {
    throw new Error(`TURNSTILE_API_DRAIN_WINDOW_BLOCKS must be >= 1, got: ${drainWindowBlocks}`);
  }

  return {
    port,
    host: env.TURNSTILE_API_HOST ?? "127.0.0.1",
    dbPath: env.TURNSTILE_API_DB_PATH ?? env.TURNSTILE_DB_PATH ?? "./data/turnstile.sqlite",
    poolBalanceDefaultRange,
    poolBalanceMaxRange,
    checksDefaultLimit,
    checksMaxLimit,
    drainMaxPoints,
    drainWindowBlocks,
  };
}

export interface AttestationConfig {
  verifierBinPath: string;
  verifierTimeoutMs: number;
  /** Fixed, permanent, network-scoped domain constant (see attestation/circuit/src/params.rs
   * for the correctness reasoning: this must NEVER vary by anchor height, or the same note
   * could be re-attested at every new anchor and pass dedup every time). */
  domainNetworkId: string;
  maxAnchorStalenessBlocks: number;
}

export function loadAttestationConfig(env: NodeJS.ProcessEnv = process.env): AttestationConfig {
  const verifierTimeoutMs = envInt("TURNSTILE_VERIFIER_TIMEOUT_MS", 10_000);
  if (verifierTimeoutMs < 1) {
    throw new Error(`TURNSTILE_VERIFIER_TIMEOUT_MS must be >= 1, got: ${verifierTimeoutMs}`);
  }

  const maxAnchorStalenessBlocks = envInt("TURNSTILE_MAX_ANCHOR_STALENESS_BLOCKS", 100);
  if (maxAnchorStalenessBlocks < 0) {
    throw new Error(`TURNSTILE_MAX_ANCHOR_STALENESS_BLOCKS must be >= 0, got: ${maxAnchorStalenessBlocks}`);
  }

  const network = (env.TURNSTILE_NETWORK ?? "testnet") as "testnet" | "mainnet";

  return {
    verifierBinPath:
      env.TURNSTILE_VERIFIER_BIN_PATH ??
      resolve("attestation/target/release/turnstile-verifier"),
    verifierTimeoutMs,
    domainNetworkId: network,
    maxAnchorStalenessBlocks,
  };
}
