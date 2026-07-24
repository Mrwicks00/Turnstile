import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { Config, ApiConfig, AttestationConfig } from "./config.js";
import {
  BadRequestError,
  VerificationFailedError,
  DuplicateAttestationError,
  buildPoolBalanceResponse,
  buildChecksResponse,
  buildDrainResponse,
  buildAttestResponse,
  buildResidualResponse,
} from "./api.js";
import type { VerifyFn } from "./verifier.js";
import { logger } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function buildApp(
  readDb: DatabaseSync,
  writeDb: DatabaseSync,
  cfg: Pick<Config, "activationHeight" | "startHeightOverride">,
  apiCfg: ApiConfig,
  attestationCfg: Pick<AttestationConfig, "maxAnchorStalenessBlocks">,
  verify: VerifyFn,
): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/pool-balance", (req: Request, res: Response) => {
    const result = buildPoolBalanceResponse(readDb, { from: req.query.from as string | undefined, to: req.query.to as string | undefined }, apiCfg);
    res.json(result);
  });

  app.get("/api/checks", (req: Request, res: Response) => {
    const result = buildChecksResponse(readDb, { limit: req.query.limit as string | undefined }, apiCfg);
    res.json(result);
  });

  app.get("/api/drain", (_req: Request, res: Response) => {
    const result = buildDrainResponse(readDb, cfg, apiCfg);
    res.json(result);
  });

  // Uses writeDb, not readDb: this is the one route that legitimately writes (to the
  // attestation table only - see openAttestationWriter's docs). Its own staleness-check read
  // (getLatestPoolBalance against pool_balance) is fine to do through the same writable
  // connection; SQLite doesn't restrict reads on a writable handle.
  app.post("/api/attest", async (req: Request, res: Response) => {
    const result = await buildAttestResponse(writeDb, req.body, verify, attestationCfg);
    res.status(201).json(result);
  });

  app.get("/api/residual", (_req: Request, res: Response) => {
    const result = buildResidualResponse(readDb);
    res.json(result);
  });

  app.use(express.static(join(__dirname, "..", "public")));

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "not found" });
  });

  // Express 5 propagates rejected async handler promises here automatically; this also
  // catches errors thrown synchronously from the (sync) handlers above.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof BadRequestError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof VerificationFailedError) {
      res.status(422).json({ error: err.message });
      return;
    }
    if (err instanceof DuplicateAttestationError) {
      res.status(409).json({ error: err.message });
      return;
    }
    logger.error("unhandled API error", { error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    res.status(500).json({ error: "internal server error" });
  });

  return app;
}
