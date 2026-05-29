import { assertArcUsdcBalance, sendArcUsdcTransfer } from "./arc-payment.js";
import { hashJson } from "./evidence.js";
import { createArcPaymentProof } from "./payment.js";
import { createSettlementReceipt, currentPaymentBackend } from "./payment-adapter.js";
import { invokeWithRealX402, isRealX402Enabled } from "./real-x402-client.js";
import { assertPolicyAllows, readWallet, recordPayment } from "./wallet.js";

export async function invokePaidServiceWithLocalWallet({ baseUrl, serviceId, input = {}, budget = { max_amount: "0.05", currency: "USDC" }, request = null }) {
  const manifest = await postJson(baseUrl, "/connector/get_manifest", { service_id: serviceId });
  if (budget.max_amount != null && Number(manifest.pricing.amount) > Number(budget.max_amount)) {
    throw new Error(`Service costs ${manifest.pricing.amount} ${manifest.pricing.currency}, above budget ${budget.max_amount} ${budget.currency}.`);
  }
  if (isRealX402Enabled()) {
    return invokeOfficialX402Service({ baseUrl, manifest, serviceId, input, request });
  }
  if (currentPaymentBackend() !== "circle_arc") {
    throw new Error("Local paid invocation requires ADN_PAYMENT_BACKEND=circle_arc or official x402 configuration.");
  }

  const firstResponse = await fetch(manifest.endpoint.url, {
    method: manifest.endpoint.method || "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  if (firstResponse.status !== 402) {
    let payload = null;
    try {
      payload = await firstResponse.json();
    } catch {}
    const prepayFailure = payload?.error?.code === "PREPAY_VALIDATION_FAILED";
    const error = new Error(prepayFailure
      ? payload.error.message
      : `Expected HTTP 402 payment challenge, got ${firstResponse.status}.`);
    error.code = firstResponse.status >= 500 ? "provider_unavailable_before_payment" : "payment_challenge_unavailable";
    if (prepayFailure) error.code = "provider_prepay_validation_failed";
    error.upstreamStatus = firstResponse.status;
    error.retryable = firstResponse.status >= 500;
    error.payload = payload;
    throw error;
  }

  const challenge = await firstResponse.json();
  const payment = challenge.payment;
  const policyManifest = currentPaymentBackend() === "circle_arc"
    ? {
        ...manifest,
        pricing: {
          ...manifest.pricing,
          network: payment.network,
          token_address: payment.token_address,
          pay_to: payment.pay_to,
          settlement_model: payment.settlement_model
        }
      }
    : manifest;
  await assertPolicyAllows({
    serviceId,
    amount: payment.amount,
    currency: payment.asset,
    network: payment.network,
    payTo: payment.pay_to,
    providerId: manifest.provider.provider_id,
    manifest: policyManifest,
    challenge: payment
  });
  const wallet = await readWallet();
  let arcTransfer = null;
  let arcBalance = null;
  if (currentPaymentBackend() === "circle_arc") {
    arcBalance = await assertArcUsdcBalance({ wallet, payment });
    arcTransfer = await sendArcUsdcTransfer({ wallet, payment });
  }
  const proof = createArcPaymentProof({
    wallet,
    serviceId,
    amount: payment.amount,
    currency: payment.asset,
    network: payment.network,
    payTo: payment.pay_to,
    challenge: payment,
    tx: arcTransfer
  });

  const paidResponse = await fetch(manifest.endpoint.url, {
    method: manifest.endpoint.method || "POST",
    headers: {
      "content-type": "application/json",
      "x-payment": proof
    },
    body: JSON.stringify(input)
  });
  const result = await paidResponse.json();
  const event = {
    event_version: "agent_local_payment_event_v1",
    service_id: serviceId,
    provider_id: manifest.provider.provider_id,
    payer: wallet.address,
    payment_tx: decodePaymentTx(proof),
    amount: payment.amount,
    currency: payment.asset,
    network: payment.network,
    pay_to: payment.pay_to,
    challenge_nonce: payment.nonce,
    challenge_expires_at: payment.expires_at,
    status: paidResponse.ok && result.status === "success" ? "success" : "error",
    backend: currentPaymentBackend(),
    balance_before_payment: arcBalance,
    arc_transfer: arcTransfer
  };
  event.event_hash = hashJson(event);
  await recordPayment(event);
  const feedback = {
    event_version: "agent_service_feedback_v1",
    request_id: result?.request_id || `req_${Date.now()}`,
    service_id: serviceId,
    provider_id: manifest.provider.provider_id,
    consumer_id: "local_agent_wallet",
    payment_tx: event.payment_tx,
    payment_collected: true,
    billing_status: event.status === "success" ? "charged_success" : "charged_provider_error",
    result_delivery_status: event.status === "success" ? "delivered" : "failed_after_payment",
    settlement_receipt: createSettlementReceipt({
      manifest: policyManifest,
      challenge: payment,
      txHash: event.payment_tx
    }),
    status: event.status,
    schema_valid: result?.status === "success",
    latency_ms: null,
    consumer_rating: event.status === "success" ? 1 : 0,
    payment_backend: currentPaymentBackend()
  };
  feedback.feedback_hash = hashJson(feedback);

  const evidenceRecording = await recordCompletedInvocation({
    baseUrl,
    serviceId,
    input,
    result,
    feedback,
    localPayment: event,
    budget,
    request: request || {
      capability: "direct_service_invocation",
      params: input,
      constraints: {
        max_price_usdc: budget.max_amount,
        currency: budget.currency || "USDC"
      },
      consumer_context: {
        source: "local_agent_wallet"
      }
    }
  });
  if (!result?.request_id && evidenceRecording?.request_id) {
    result.request_id = evidenceRecording.request_id;
  }

  return {
    result,
    local_payment: event,
    feedback,
    evidence_recording: evidenceRecording
  };
}

async function invokeOfficialX402Service({ baseUrl, manifest, serviceId, input, request = null }) {
  const wallet = await readWallet();
  const started = Date.now();
  const body = methodAllowsBody(manifest.endpoint.method) ? JSON.stringify(input) : undefined;
  const paid = await invokeWithRealX402({
    url: manifest.endpoint.url,
    method: manifest.endpoint.method || "POST",
    body,
    wallet
  });
  const result = paid.payload;
  const settlement = paid.settlement;
  const event = {
    service_id: serviceId,
    provider_id: manifest.provider.provider_id,
    payer: wallet.address,
    payment_tx: paid.payment_tx,
    amount: settlement?.amount || manifest.pricing.amount,
    currency: manifest.pricing.currency,
    network: settlement?.network || manifest.pricing.network,
    pay_to: manifest.pricing.pay_to || null,
    challenge_nonce: null,
    challenge_expires_at: null,
    status: "success",
    backend: "x402"
  };
  await recordPayment(event);
  const feedback = {
    event_version: "agent_service_feedback_v1",
    request_id: result?.request_id || `req_${Date.now()}`,
    service_id: serviceId,
    provider_id: manifest.provider.provider_id,
    consumer_id: "local_agent_wallet",
    payment_tx: paid.payment_tx,
    settlement_receipt: createSettlementReceipt({
      manifest,
      challenge: {
        amount: event.amount,
        asset: event.currency,
        network: event.network,
        pay_to: event.pay_to
      },
      txHash: paid.payment_tx
    }),
    status: "success",
    schema_valid: true,
    latency_ms: Date.now() - started,
    consumer_rating: 1,
    notes: ["Paid through official x402 client flow."],
    payment_backend: currentPaymentBackend()
  };
  const evidenceRecording = await recordCompletedInvocation({
    baseUrl,
    serviceId,
    input,
    result,
    feedback,
    localPayment: event,
    budget: { max_amount: manifest.pricing.amount, currency: manifest.pricing.currency },
    request: request || {
      capability: "direct_service_invocation",
      params: input,
      constraints: {
        max_price_usdc: manifest.pricing.amount,
        currency: manifest.pricing.currency
      },
      consumer_context: {
        source: "local_agent_wallet",
        x402_client: "official"
      }
    }
  });
  if (!result?.request_id && evidenceRecording?.request_id) {
    result.request_id = evidenceRecording.request_id;
  }
  return {
    result,
    local_payment: event,
    feedback,
    evidence_recording: evidenceRecording
  };
}

async function recordCompletedInvocation({ baseUrl, serviceId, input, result, feedback, localPayment, budget, request }) {
  if (!baseUrl) return { ok: false, status: "skipped", reason: "missing_registry_url" };
  try {
    return await postJson(baseUrl, "/agent-router/calls/complete", {
      service_id: serviceId,
      request,
      input,
      result,
      feedback,
      local_payment: localPayment,
      budget
    });
  } catch (error) {
    return {
      ok: false,
      status: "evidence_recording_failed",
      error: {
        message: error.message,
        payload: error.payload || null
      }
    };
  }
}

async function postJson(baseUrl, path, body) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.error?.code || `HTTP ${response.status}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

function decodePaymentTx(proof) {
  try {
    return JSON.parse(Buffer.from(proof, "base64url").toString("utf8")).tx_hash;
  } catch {
    return null;
  }
}

function methodAllowsBody(method = "POST") {
  return !["GET", "HEAD"].includes(String(method).toUpperCase());
}
