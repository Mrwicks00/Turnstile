import { loadConfig } from "./config.js";
import { RpcClient } from "./rpc.js";
import { openDb } from "./db.js";
import { runIndexer } from "./indexer.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  logger.info("config loaded", {
    network: cfg.network,
    activationHeight: cfg.activationHeight,
    startHeightOverride: cfg.startHeightOverride,
    stopHeightOverride: cfg.stopHeightOverride,
    dbPath: cfg.dbPath,
    concurrency: cfg.concurrency,
    runMode: cfg.runMode,
  });

  const rpc = new RpcClient({
    url: cfg.rpcUrl,
    cookiePath: cfg.rpcAuthMode === "cookie" ? cfg.rpcCookiePath : undefined,
    apiKey: cfg.rpcAuthMode === "apikey" ? (cfg.rpcApiKey ?? undefined) : undefined,
    timeoutMs: cfg.rpcTimeoutMs,
    maxRetries: cfg.rpcMaxRetries,
    retryBaseMs: cfg.rpcRetryBaseMs,
    retryMaxMs: cfg.rpcRetryMaxMs,
  });

  const db = openDb(cfg.dbPath);

  let stopRequested = false;
  const requestStop = (signal: string) => {
    logger.info("shutdown signal received, stopping after current block", { signal });
    stopRequested = true;
  };
  process.on("SIGINT", () => requestStop("SIGINT"));
  process.on("SIGTERM", () => requestStop("SIGTERM"));

  try {
    await runIndexer({ rpc, db, cfg, shouldStop: () => stopRequested });
  } finally {
    db.close();
  }
}

main().catch((err) => {
  logger.error("indexer crashed", { error: err instanceof Error ? err.stack ?? err.message : String(err) });
  process.exitCode = 1;
});
