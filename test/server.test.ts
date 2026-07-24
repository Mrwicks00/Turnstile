import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { openDb, insertRow, insertCheckRow, type PoolBalanceRow, type CheckRow } from "../src/db.js";
import { buildApp } from "../src/server.js";
import type { Config, ApiConfig, AttestationConfig } from "../src/config.js";
import type { VerifyFn } from "../src/verifier.js";

function row(overrides: Partial<PoolBalanceRow> & { height: number }): PoolBalanceRow {
  return {
    block_hash: `hash${overrides.height}`,
    parent_hash: "",
    block_time: 1_600_000_000,
    orchard_delta: 0,
    sapling_delta: 0,
    sprout_delta: 0,
    orchard_balance: 0,
    sapling_balance: 0,
    sprout_balance: 0,
    tx_count: 1,
    ...overrides,
  };
}

function checkRow(overrides: Partial<CheckRow> & { height: number }): CheckRow {
  return {
    check_name: "orchard_balance_nonnegative",
    txid: null,
    status: "pass",
    detail: null,
    checked_at: 1_600_000_000,
    ...overrides,
  };
}

const apiCfg: ApiConfig = {
  port: 0,
  host: "127.0.0.1",
  dbPath: ":memory:",
  poolBalanceDefaultRange: 10,
  poolBalanceMaxRange: 100,
  checksDefaultLimit: 5,
  checksMaxLimit: 50,
  drainMaxPoints: 100,
  drainWindowBlocks: 5,
};

const cfg: Pick<Config, "activationHeight" | "startHeightOverride"> = {
  activationHeight: 101,
  startHeightOverride: null,
};

const attestationCfg: Pick<AttestationConfig, "maxAnchorStalenessBlocks"> = {
  maxAnchorStalenessBlocks: 100,
};

const alwaysValidVerify: VerifyFn = async () => ({ valid: true, dedupTag: "fake-dedup-tag", circuitVersion: "test-v0" });
const alwaysInvalidVerify: VerifyFn = async () => ({ valid: false, reason: "fake rejection for testing" });

async function withServer(
  setup: (db: ReturnType<typeof openDb>) => void,
  run: (baseUrl: string) => Promise<void>,
  verify: VerifyFn = alwaysValidVerify,
): Promise<void> {
  // A single in-memory DB serves as both readDb and writeDb here - :memory: has no separate
  // connections to reconcile, so this is the correct simplification for tests (real deployments
  // use openDbReadOnly + openAttestationWriter against the same on-disk file instead).
  const db = openDb(":memory:");
  setup(db);
  const app = buildApp(db, db, cfg, apiCfg, attestationCfg, verify);
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected an AddressInfo");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

test("GET /api/pool-balance returns rows and 200", async () => {
  await withServer(
    (db) => {
      insertRow(db, row({ height: 100 }));
      insertRow(db, row({ height: 101 }));
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/pool-balance?from=100&to=101`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.count, 2);
    },
  );
});

test("GET /api/pool-balance with an invalid param returns 400", async () => {
  await withServer(
    () => {},
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/pool-balance?from=notanumber`);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.ok(body.error);
    },
  );
});

test("GET /api/checks returns recent checks", async () => {
  await withServer(
    (db) => {
      insertCheckRow(db, checkRow({ height: 100 }));
      insertCheckRow(db, checkRow({ height: 101 }));
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/checks`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.count, 2);
      assert.equal(body.checks[0].height, 101); // most recent first
    },
  );
});

test("GET /api/drain returns seeded:false on an empty table", async () => {
  await withServer(
    () => {},
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/drain`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.seeded, false);
    },
  );
});

test("GET /api/drain returns the residual once seeded", async () => {
  await withServer(
    (db) => {
      insertRow(db, row({ height: 100, orchard_balance: 5000 }));
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/drain`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.seeded, true);
      assert.equal(body.residual, 5000);
    },
  );
});

test("unmatched route returns a 404 JSON body", async () => {
  await withServer(
    () => {},
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/nonexistent`);
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.ok(body.error);
    },
  );
});

test("GET /api/residual returns seeded:false on an empty table", async () => {
  await withServer(
    () => {},
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/residual`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.seeded, false);
    },
  );
});

test("GET /api/residual reports residual, attested, and the disclaimer once seeded", async () => {
  await withServer(
    (db) => {
      insertRow(db, row({ height: 100, orchard_balance: 5000 }));
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/residual`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.seeded, true);
      assert.equal(body.residual, 5000);
      assert.equal(body.attested, 0);
      assert.equal(body.unattestedResidual, 5000);
      assert.ok(body.disclaimer.includes("does not prove counterfeit"));
    },
  );
});

test("POST /api/attest with a valid proof returns 201 and updates GET /api/residual", async () => {
  await withServer(
    (db) => {
      insertRow(db, row({ height: 100, orchard_balance: 5000 }));
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/attest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ anchor: "anchor1", anchorHeight: 100, claimedValue: 1000, proof: "AAAA" }),
      });
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.dedupTag, "fake-dedup-tag");
      assert.equal(body.claimedValue, 1000);

      const residualRes = await fetch(`${baseUrl}/api/residual`);
      const residualBody = await residualRes.json();
      assert.equal(residualBody.attested, 1000);
      assert.equal(residualBody.unattestedResidual, 4000);
      assert.equal(residualBody.attestationCount, 1);
    },
  );
});

test("POST /api/attest with a rejected proof returns 422", async () => {
  await withServer(
    (db) => {
      insertRow(db, row({ height: 100, orchard_balance: 5000 }));
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/attest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ anchor: "anchor1", anchorHeight: 100, claimedValue: 1000, proof: "AAAA" }),
      });
      assert.equal(res.status, 422);
      const body = await res.json();
      assert.ok(body.error.includes("fake rejection"));
    },
    alwaysInvalidVerify,
  );
});

test("POST /api/attest with a malformed body returns 400", async () => {
  await withServer(
    (db) => {
      insertRow(db, row({ height: 100, orchard_balance: 5000 }));
    },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/attest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ anchor: "anchor1" }), // missing anchorHeight/claimedValue/proof
      });
      assert.equal(res.status, 400);
    },
  );
});

test("POST /api/attest with a duplicate dedup_tag returns 409", async () => {
  await withServer(
    (db) => {
      insertRow(db, row({ height: 100, orchard_balance: 5000 }));
    },
    async (baseUrl) => {
      const submit = () =>
        fetch(`${baseUrl}/api/attest`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ anchor: "anchor1", anchorHeight: 100, claimedValue: 1000, proof: "AAAA" }),
        });
      const first = await submit();
      assert.equal(first.status, 201);
      const second = await submit();
      assert.equal(second.status, 409);
      const body = await second.json();
      assert.ok(body.error.includes("already been attested"));
    },
  );
});
