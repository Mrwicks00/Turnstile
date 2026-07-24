import { loadConfig, loadApiConfig, loadAttestationConfig } from "./config.js";
import { openDbReadOnly, openAttestationWriter } from "./db.js";
import { buildApp } from "./server.js";
import { createVerifierFn } from "./verifier.js";
import { logger } from "./logger.js";

function main(): void {
  const cfg = loadConfig();
  const apiCfg = loadApiConfig();
  const attestationCfg = loadAttestationConfig();

  logger.info("api config loaded", {
    port: apiCfg.port,
    host: apiCfg.host,
    dbPath: apiCfg.dbPath,
    network: cfg.network,
    activationHeight: cfg.activationHeight,
    verifierBinPath: attestationCfg.verifierBinPath,
  });

  const readDb = openDbReadOnly(apiCfg.dbPath);
  const writeDb = openAttestationWriter(apiCfg.dbPath);
  const verify = createVerifierFn(attestationCfg.verifierBinPath, attestationCfg.verifierTimeoutMs);
  const app = buildApp(readDb, writeDb, cfg, apiCfg, attestationCfg, verify);

  const server = app.listen(apiCfg.port, apiCfg.host, () => {
    logger.info("api server listening", { host: apiCfg.host, port: apiCfg.port });
  });

  const shutdown = (signal: string) => {
    logger.info("shutdown signal received", { signal });
    server.close(() => {
      readDb.close();
      writeDb.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

try {
  main();
} catch (err) {
  logger.error("api server crashed", { error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  process.exitCode = 1;
}
