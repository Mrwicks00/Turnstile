import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
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

  // Forwards the migration assistant's gRPC-web calls to the Traefik instance running
  // internally on 127.0.0.1:8081 (see scripts/railway-start.sh) - Railway's free plan
  // doesn't allow a second service, so this proxies in-process instead of Traefik having
  // its own public domain. Mounted before express.json() so the binary grpc-web request
  // body is piped through raw, untouched by body parsing.
  app.use("/grpc-proxy", (req: Request, res: Response) => {
    const target = http.request(
      { hostname: "127.0.0.1", port: 8081, path: req.url, method: req.method, headers: req.headers },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    target.on("error", (err) => {
      logger.error("grpc-proxy forwarding error", { error: err.message });
      if (!res.headersSent) res.status(502).end();
    });
    req.pipe(target);
  });

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

  // COOP/COEP are required for WebZjs's WASM thread pool (SharedArrayBuffer) on
  // migrate.html - scoped narrowly so the JSON /api/* routes and index.html are unaffected.
  const WEBZJS_ENTRY_POINT: Record<string, string> = {
    "/vendor/webzjs-wallet": "/vendor/webzjs-wallet/webzjs_wallet.js",
    "/vendor/webzjs-wallet/": "/vendor/webzjs-wallet/webzjs_wallet.js",
    "/vendor/webzjs-keys": "/vendor/webzjs-keys/webzjs_keys.js",
    "/vendor/webzjs-keys/": "/vendor/webzjs-keys/webzjs_keys.js",
  };
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // wasm-bindgen-rayon's generated worker helper does `import('../../..')` - a bare
    // package-root import that only resolves via a bundler's package.json main-field
    // lookup, not in a native browser ESM load - so rewrite it to the real entry file.
    const rewrite = WEBZJS_ENTRY_POINT[req.path];
    if (rewrite) req.url = rewrite;
    next();
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/migrate.html" || req.path === "/migrate-wallet.js" || req.path.startsWith("/vendor/webzjs")) {
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    }
    next();
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
