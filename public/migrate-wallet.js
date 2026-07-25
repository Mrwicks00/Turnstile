// Real in-browser Zcash testnet wallet, built on ChainSafe's WebZjs (unaudited, see the
// warning banner on the page). Private key material never leaves this module / the browser.
// Nothing is persisted anywhere (no localStorage, no cookies, no server) - a refresh always
// loses the in-memory wallet; "Import" is the only way back in, using a saved seed phrase.

// Same-origin path, forwarded server-side to an internal Traefik gRPC-web proxy
// (see src/server.ts's /grpc-proxy middleware) - avoids needing a separate public
// domain, which Railway's free plan doesn't allow for a second service.
const PROXY_URL = window.__TURNSTILE_GRPC_PROXY_URL__ || `${window.location.origin}/grpc-proxy/testnet`;
const FAUCET_URL = "https://fauzec.com/";

let wasmReady = null;
let wallet = null;
let accountId = null;
let seedPhrase = null;
let currentTip = null;

function setStep(id, state) {
  const el = document.getElementById(id);
  if (el) el.dataset.state = state;
}

// WalletSummary.account_balances serializes (via serde_wasm_bindgen, see WebZjs's
// crates/webzjs-wallet/src/bindgen/wallet.rs) as an array of [accountId, AccountBalance]
// pairs, not a Map - and AccountBalance's fields are plain numbers (spendable zatoshi
// amounts per pool), not BigInt.
function findAccountBalance(accountBalances, id) {
  const entry = (accountBalances || []).find(([accId]) => accId === id);
  return entry ? entry[1] : null;
}

function spendableZats(balanceEntry) {
  if (!balanceEntry) return 0;
  return (balanceEntry.sapling_balance || 0) + (balanceEntry.orchard_balance || 0) + (balanceEntry.unshielded_balance || 0);
}

function describeBalance(balanceEntry) {
  if (!balanceEntry) return "no account balance entry found";
  return `sapling=${balanceEntry.sapling_balance || 0} orchard=${balanceEntry.orchard_balance || 0} ` +
    `transparent=${balanceEntry.unshielded_balance || 0} pending_change=${balanceEntry.pending_change || 0} ` +
    `pending_spendable=${balanceEntry.pending_spendable || 0}`;
}

function log(msg) {
  const el = document.getElementById("wallet-log");
  el.textContent += (el.textContent ? "\n" : "") + msg;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function truncateMiddle(s, head = 14, tail = 10) {
  return s.length <= head + tail + 3 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

// Renders a truncated value with a working copy button - nobody needs 200 raw characters
// of a unified address inline; the full value is still one click away.
function copyChip(containerId, value, label) {
  const container = document.getElementById(containerId);
  container.innerHTML = `
    <p class="field__hint" style="margin-bottom:0.3rem;">${label}</p>
    <div class="addr-chip">
      <span class="addr-chip__text mono" title="${escapeHtml(value)}">${escapeHtml(truncateMiddle(value))}</span>
      <button class="copy-btn" type="button">Copy</button>
    </div>`;
  container.querySelector(".copy-btn").addEventListener("click", () => navigator.clipboard.writeText(value));
}

// The ChainSpec/BlockID messages used here are tiny, so a hand-rolled varint decoder for
// this one call is simpler than pulling in a protobuf runtime for a single field read.
function decodeVarint(bytes, offset) {
  let result = 0n, shift = 0n, pos = offset;
  for (;;) {
    const b = bytes[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  return { value: result, next: pos };
}

function parseGrpcWebHeight(bytes) {
  // grpc-web framing: [1 flag byte][4 length bytes BE][message bytes], repeated.
  let offset = 0;
  while (offset < bytes.length) {
    const flag = bytes[offset];
    const len = (bytes[offset + 1] << 24) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 8) | bytes[offset + 4];
    const bodyStart = offset + 5;
    if (flag === 0x00) {
      // BlockID message: field 1 (varint) = height, field 2 (bytes) = hash
      let p = bodyStart;
      const end = bodyStart + len;
      while (p < end) {
        const tag = bytes[p]; p++;
        const fieldNum = tag >> 3;
        const wireType = tag & 0x7;
        if (wireType === 0) {
          const { value, next } = decodeVarint(bytes, p);
          if (fieldNum === 1) return Number(value);
          p = next;
        } else if (wireType === 2) {
          const { value: skipLen, next } = decodeVarint(bytes, p);
          p = next + Number(skipLen);
        } else {
          throw new Error("unexpected wire type " + wireType);
        }
      }
    }
    offset = bodyStart + len;
  }
  throw new Error("no height field found in response");
}

async function fetchCurrentTip() {
  const res = await fetch(`${PROXY_URL}/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLatestBlock`, {
    method: "POST",
    headers: { "Content-Type": "application/grpc-web+proto", "X-Grpc-Web": "1" },
    body: new Uint8Array([0, 0, 0, 0, 0]), // empty ChainSpec message, grpc-web framed
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  return parseGrpcWebHeight(buf);
}

async function ensureWasmReady() {
  if (!wasmReady) {
    wasmReady = (async () => {
      const mod = await import("/vendor/webzjs-wallet/webzjs_wallet.js");
      await mod.default();
      await mod.initThreadPool(navigator.hardwareConcurrency || 4);
      return mod;
    })();
  }
  return wasmReady;
}

function setBusy(id, busy, label) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.disabled = busy;
  if (label) btn.textContent = label;
}

// Shared by both "generate a new wallet" and "import a saved seed phrase" - both end up
// with a seed phrase and a birthday height, then need the same account-creation + address
// display + UI reveal.
async function activateWallet(seed, birthdayHeight, { showSeed }) {
  const mod = await ensureWasmReady();
  log("wasm + thread pool ready");

  seedPhrase = seed;
  wallet = new mod.WebWallet("test", PROXY_URL, 1, 1, null);

  currentTip = await fetchCurrentTip();
  log(`current chain tip: ${currentTip.toLocaleString()}`);

  const effectiveBirthday = birthdayHeight ?? currentTip;
  accountId = await wallet.create_account("turnstile-demo", seedPhrase, 0, effectiveBirthday);
  const address = await wallet.get_current_address(accountId);

  if (showSeed) {
    document.getElementById("wallet-seed").innerHTML = `
      <div class="seed-box mono">
        <span class="seed-box__label">Your testnet seed phrase — shown once, save it now</span>
        ${escapeHtml(seedPhrase)}
        <div><button class="copy-btn" id="btn-copy-seed" type="button">Copy</button></div>
      </div>`;
    document.getElementById("btn-copy-seed").addEventListener("click", () => {
      navigator.clipboard.writeText(seedPhrase);
    });
  }

  copyChip("wallet-address", address, `Fund this address at <a href="${FAUCET_URL}" target="_blank" rel="noopener">${FAUCET_URL}</a>, then check your balance below.`);

  document.getElementById("wallet-actions-sync").hidden = false;
  document.getElementById("import-form").hidden = true;
  setStep("step-create", "done");
  setStep("step-fund", "active");
  setStep("step-balance", "active");
  log("account created, id=" + accountId + ", birthday=" + effectiveBirthday);
}

document.getElementById("btn-generate").addEventListener("click", async () => {
  setBusy("btn-generate", true, "Generating…");
  try {
    const mod = await ensureWasmReady();
    const seed = mod.generate_seed_phrase();
    await activateWallet(seed, null, { showSeed: true });
    setBusy("btn-generate", true, "Wallet generated");
    setBusy("btn-show-import", true);
  } catch (err) {
    log("ERROR: " + (err && err.message ? err.message : String(err)));
    setBusy("btn-generate", false, "Generate testnet wallet");
  }
});

document.getElementById("btn-show-import").addEventListener("click", () => {
  const form = document.getElementById("import-form");
  form.hidden = !form.hidden;
});

document.getElementById("btn-import").addEventListener("click", async () => {
  setBusy("btn-import", true, "Importing…");
  try {
    const seed = document.getElementById("import-seed").value.trim();
    const birthdayRaw = document.getElementById("import-birthday").value.trim();
    if (!seed) throw new Error("paste your seed phrase first");

    let birthdayHeight = null;
    if (birthdayRaw) {
      birthdayHeight = parseInt(birthdayRaw, 10);
      if (!Number.isInteger(birthdayHeight) || birthdayHeight < 0) throw new Error("birthday height must be a non-negative integer");
    } else {
      // No birthday given: default to a recent buffer rather than genesis, since this
      // demo's realistic use case is a wallet generated minutes/hours ago, not an old
      // real-world wallet. Funds received before this will not be found by sync().
      const tip = await fetchCurrentTip();
      birthdayHeight = Math.max(0, tip - 10000);
    }

    await activateWallet(seed, birthdayHeight, { showSeed: false });
    setBusy("btn-generate", true);
    setBusy("btn-show-import", true, "Imported");
    setBusy("btn-import", false, "Import wallet");
  } catch (err) {
    log("ERROR: " + (err && err.message ? err.message : String(err)));
    setBusy("btn-import", false, "Import wallet");
  }
});

document.getElementById("btn-sync").addEventListener("click", async () => {
  setBusy("btn-sync", true, "Syncing…");
  try {
    await wallet.sync();
    const summary = await wallet.get_wallet_summary();
    const balanceEntry = summary ? findAccountBalance(summary.account_balances, accountId) : null;
    const zats = spendableZats(balanceEntry);
    const zec = zats / 1e8;

    document.getElementById("wallet-balance").innerHTML = `
      <div class="balance-hero">
        <span class="balance-hero__figure mono">${zec.toLocaleString(undefined, { maximumFractionDigits: 8 })}</span>
        <span class="balance-hero__unit">TAZ</span>
      </div>`;

    if (zec > 0) {
      document.getElementById("wallet-actions-send").hidden = false;
      const amountInput = document.getElementById("send-amount");
      const suggested = Math.min(zats / 2, 100000000) / 1e8; // default to half balance, capped at 1 ZEC
      amountInput.value = suggested.toFixed(8);
      amountInput.max = String(zec);
      document.getElementById("send-amount-hint").textContent =
        `Balance is ${zec.toLocaleString(undefined, { maximumFractionDigits: 8 })} TAZ - leave some unspent to cover the network fee.`;
      setStep("step-balance", "done");
      setStep("step-send", "active");
    }
    log("sync complete, balance=" + zec + " TAZ (" + describeBalance(balanceEntry) + ")");
    log("wallet summary: chain_tip=" + summary.chain_tip_height + " fully_scanned=" + summary.fully_scanned_height + " accounts=" + JSON.stringify(summary.account_balances.map(([id]) => id)));
    setBusy("btn-sync", false, "Check balance");
  } catch (err) {
    log("ERROR: " + (err && err.message ? err.message : String(err)));
    setBusy("btn-sync", false, "Check balance");
  }
});

document.getElementById("btn-send").addEventListener("click", async () => {
  setBusy("btn-send", true, "Building proof…");
  try {
    const destAccountId = await wallet.create_account("turnstile-demo-dest", seedPhrase, 1, currentTip);
    const destAddress = await wallet.get_current_address(destAccountId);
    log("migrating to fresh address in same wallet: " + destAddress);

    const summary = await wallet.get_wallet_summary();
    const balanceEntry = findAccountBalance(summary.account_balances, accountId);
    const zats = spendableZats(balanceEntry);

    const requestedZec = parseFloat(document.getElementById("send-amount").value);
    if (!(requestedZec > 0)) throw new Error("enter an amount greater than 0");
    const sendAmount = BigInt(Math.round(requestedZec * 1e8));
    if (sendAmount >= BigInt(zats)) {
      throw new Error(`that's your whole balance - real network fees need some left over. ` +
        `Try something less than ${(zats / 1e8).toFixed(8)} TAZ.`);
    }
    log(`sending ${requestedZec} ZEC of ${zats / 1e8} ZEC balance`);

    const proposal = await wallet.propose_transfer(accountId, destAddress, sendAmount);
    log("proposal created");

    setBusy("btn-send", true, "Proving + signing…");
    const txids = await wallet.create_proposed_transactions(proposal, seedPhrase, 0);
    log("transaction(s) authorized");

    await wallet.send_authorized_transactions(txids);
    log("broadcast to network");

    const txidHex = Array.from(txids.slice(0, 32)).map((b) => b.toString(16).padStart(2, "0")).join("");
    document.getElementById("wallet-result").innerHTML = `
      <div class="field" style="margin-top:1rem;">
        <label>Real txid</label>
        <div class="addr-chip">
          <span class="addr-chip__text mono">${escapeHtml(truncateMiddle(txidHex, 12, 10))}</span>
          <button class="copy-btn" type="button" id="btn-copy-txid">Copy</button>
        </div>
      </div>`;
    document.getElementById("btn-copy-txid").addEventListener("click", () => navigator.clipboard.writeText(txidHex));
    setStep("step-send", "done");
    setBusy("btn-send", false, "Send test migration");
  } catch (err) {
    log("ERROR: " + (err && err.message ? err.message : String(err)));
    setBusy("btn-send", false, "Send test migration");
  }
});
