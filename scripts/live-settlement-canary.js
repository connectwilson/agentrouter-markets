#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const confirmSpend = args.has("--confirm-spend");
const keepFiles = args.has("--keep-files");
const allowMock = args.has("--allow-mock");

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentrouter-live-settlement-"));
process.env.ADN_PROVIDER_DIR ||= path.join(tmpRoot, "providers");
process.env.ADN_PAYMENT_BACKEND = "circle_arc";

const {
  createServer
} = await import("../src/server.js");
const {
  getArcUsdcBalance,
  arcAmountAtomic,
  isEvmAddress,
  verifyArcUsdcTransfer
} = await import("../src/arc-payment.js");
const {
  readWallet,
  readPaymentLog
} = await import("../src/wallet.js");

function usage(message) {
  if (message) console.error(message);
  console.error(`
Usage:
  ADN_CANARY_PROVIDER_PAYOUT_ADDRESS=0x... \\
  ADN_WALLET_PASSPHRASE=... \\
  npm run canary:settlement -- --confirm-spend

Required:
  --confirm-spend                         Explicitly allows a real Arc Testnet USDC transfer.
  ADN_CANARY_PROVIDER_PAYOUT_ADDRESS      Provider payout wallet to verify.

Optional:
  ADN_CANARY_AMOUNT                       USDC amount, default 0.001.
  ADN_ARC_RPC_URL                         Arc Testnet RPC URL.
  --keep-files                            Keep temporary provider config files for inspection.
`);
  process.exit(1);
}

if (!confirmSpend) usage("Refusing to run without --confirm-spend.");
if (!allowMock) {
  if (process.env.ADN_ARC_TRANSFER_MODE === "mock") usage("Refusing to run with ADN_ARC_TRANSFER_MODE=mock.");
  if (process.env.ADN_ARC_VERIFY_MODE === "mock") usage("Refusing to run with ADN_ARC_VERIFY_MODE=mock.");
  if (process.env.ADN_ARC_BALANCE_MOCK != null) usage("Refusing to run with ADN_ARC_BALANCE_MOCK set.");
}

const payoutAddress = process.env.ADN_CANARY_PROVIDER_PAYOUT_ADDRESS || process.env.ADN_PROVIDER_RECEIVE_ADDRESS || "";
if (!isEvmAddress(payoutAddress)) usage("ADN_CANARY_PROVIDER_PAYOUT_ADDRESS must be a valid EVM address.");

const amount = String(process.env.ADN_CANARY_AMOUNT || "0.001");
if (!(Number(amount) > 0)) usage("ADN_CANARY_AMOUNT must be positive.");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

function balanceDelta(before, after) {
  return BigInt(after.amount_atomic) - BigInt(before.amount_atomic);
}

const server = createServer();
const serviceId = `live_arc_settlement_canary_${Date.now()}`;
const authCookie = "ar_session=live-canary-session";
const startedAt = Date.now();

try {
  const wallet = await readWallet();
  const payerBefore = await getArcUsdcBalance(wallet.address);
  const providerBefore = await getArcUsdcBalance(payoutAddress);
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  server.store.authSessions.set("live-canary-session", {
    user: {
      provider: "github",
      id: "live-canary",
      name: "Live Canary",
      email: "canary@agentrouter.network",
      avatar_url: "",
      handle: "live-canary"
    },
    created_at: Date.now(),
    expires_at: Date.now() + 10 * 60 * 1000
  });

  const studio = await jsonFetch(`${baseUrl}/studio/providers`, {
    method: "POST",
    headers: { cookie: authCookie },
    body: JSON.stringify({
      mode: "static-json",
      service_id: serviceId,
      provider_name: "AgentRouter Live Settlement Canary",
      title: "Live Arc Settlement Canary",
      description_for_agent: "Use this canary service only to verify live Arc Testnet settlement wiring.",
      capabilities: "data_service,onchain_data,fund_flow,canary",
      price: amount,
      payout_address: payoutAddress,
      sample_request: JSON.stringify({ chain: "base", days: 1 }),
      sample_data: JSON.stringify({ ok: true, sample: true }),
      live_data: JSON.stringify({
        ok: true,
        settlement_canary: true,
        generated_at: new Date().toISOString()
      }),
      summary: "Live settlement canary response."
    })
  });
  assert.equal(studio.response.status, 201, JSON.stringify(studio.body));
  assert.equal(studio.body.ok, true);

  const erc8004 = await jsonFetch(`${baseUrl}/services/${serviceId}/erc8004/register`, {
    method: "POST",
    body: JSON.stringify({})
  });
  const erc8004Ok = erc8004.response.status === 200 && erc8004.body?.ok === true;

  const routed = await jsonFetch(`${baseUrl}/agent-router/request`, {
    method: "POST",
    body: JSON.stringify({
      capability: "onchain_fund_flow",
      params: { chain: "base", days: 1 },
      constraints: { max_price_usdc: amount },
      consumer_context: { purpose: "live_settlement_canary" }
    })
  });
  assert.equal(routed.response.status, 200, JSON.stringify(routed.body));
  assert.equal(routed.body.ok, true, JSON.stringify(routed.body));
  assert.equal(routed.body.selected_service.service_id, serviceId);
  assert.equal(routed.body.feedback.settlement_receipt.pay_to, payoutAddress);

  const txHash = routed.body.feedback.payment_tx;
  const paymentLog = await readPaymentLog();
  const paymentEvent = paymentLog.find((event) => event.service_id === serviceId && event.payment_tx === txHash);
  assert.ok(paymentEvent, "Payment event was not recorded.");
  assert.equal(paymentEvent.status, "success");
  assert.equal(paymentEvent.pay_to.toLowerCase(), payoutAddress.toLowerCase());

  const verification = await verifyArcUsdcTransfer({
    txHash,
    expected: {
      amount,
      payTo: payoutAddress,
      payer: wallet.address
    }
  });
  assert.equal(verification.ok, true, JSON.stringify(verification));

  const payerAfter = await getArcUsdcBalance(wallet.address);
  const providerAfter = await getArcUsdcBalance(payoutAddress);
  const requiredDelta = arcAmountAtomic(amount);
  const providerDelta = balanceDelta(providerBefore, providerAfter);
  assert.ok(providerDelta >= requiredDelta, `Provider balance delta ${providerDelta} is lower than required ${requiredDelta}.`);

  const evidence = await jsonFetch(`${baseUrl}/agent-router/evidence?request_id=${encodeURIComponent(routed.body.result.request_id)}`);
  assert.equal(evidence.response.status, 200);
  assert.ok((evidence.body.events || []).length >= 1);

  const feedback = await jsonFetch(`${baseUrl}/agent-router/feedback`, {
    method: "POST",
    body: JSON.stringify({
      request_id: routed.body.consumer_feedback_request?.request_id || routed.body.result.request_id,
      service_id: serviceId,
      consumer_id: "live_settlement_canary",
      feedback: {
        intent_fit: "yes",
        answer_useful: "yes",
        data_quality_score: 1,
        used_in_final_answer: true,
        reason: "Live settlement canary returned the expected provider data and verified Arc USDC payment.",
        confidence: 1
      }
    })
  });
  assert.equal(feedback.response.status, 200, JSON.stringify(feedback.body));
  assert.equal(feedback.body.ok, true, JSON.stringify(feedback.body));

  console.log(JSON.stringify({
    ok: true,
    canary_version: "agentrouter_live_settlement_canary_v1",
    service_id: serviceId,
    elapsed_ms: Date.now() - startedAt,
    amount,
    payer: wallet.address,
    provider_payout_address: payoutAddress,
    tx_hash: txHash,
    explorer_url: verification.explorer_url || routed.body.feedback.settlement_receipt.explorer_url || null,
    payer_balance_before: payerBefore.amount,
    payer_balance_after: payerAfter.amount,
    provider_balance_before: providerBefore.amount,
    provider_balance_after: providerAfter.amount,
    provider_delta_atomic: providerDelta.toString(),
    erc8004: {
      ok: erc8004Ok,
      status: erc8004.body?.erc8004?.status || erc8004.body?.error?.code || erc8004.body?.error || null,
      tx_hash: erc8004.body?.erc8004?.tx_hash || null,
      agent_id: erc8004.body?.erc8004?.agent_id || null,
      note: erc8004Ok ? "ERC-8004 identity registration endpoint completed." : "ERC-8004 identity registration is not configured for this local canary environment."
    },
    evidence_trace_hash: routed.body.evidence?.trace_hash || null,
    evidence_events: evidence.body.events.length,
    feedback_request_id: routed.body.consumer_feedback_request?.request_id || null,
    consumer_feedback_recorded: feedback.body.ok,
    consumer_feedback_anchor_status: feedback.body.arc_anchor?.status || null,
    consumer_feedback_erc8004_status: feedback.body.erc8004?.status || null
  }, null, 2));
} finally {
  await close(server).catch(() => {});
  if (!keepFiles) await fs.rm(tmpRoot, { recursive: true, force: true });
}
