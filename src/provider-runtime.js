import { isArcNetwork, isEvmAddress, verifyArcUsdcTransfer } from "./arc-payment.js";
import { createPaymentRequirements, verifyDevPaymentProof } from "./payment.js";
import { currentPaymentBackend } from "./payment-adapter.js";
import { createEnvelope, readProviderConfig } from "./provider-config.js";
import { createLiveBtcLiquidationEnvelope, createLiveFundFlowEnvelope } from "./fixtures.js";
import { readJson, sendJson, sendNotFound } from "./http-utils.js";
import { readProviderSecret } from "./provider-secrets.js";
import { isRealX402ProviderEnabled, processProviderX402Payment, sendX402Response, settleProviderX402Payment } from "./real-x402-provider.js";

const issuedChallenges = new Map();

export async function handleFundFlowProvider(req, res) {
  const input = await readJson(req);
  const serviceId = "chain_fund_flow_7d_base";
  const amount = "0.01";
  const currency = "USDC";
  const network = "base";
  const payment = await requirePaymentOrRespond({
    req,
    res,
    serviceId,
    amount,
    currency,
    network,
    payTo: providerPayoutAddress(),
    description: "Base 7D Fund Flow"
  });
  if (!payment.ok) return;

  let body;
  if (input.chain && input.chain !== "base") {
    body = {
      schema_version: "agent_data_envelope_v1",
      service_id: serviceId,
      request_id: `req_${Date.now()}`,
      status: "error",
      error: {
        code: "UNSUPPORTED_CHAIN",
        message: "This demo service only supports Base.",
        retryable: false,
        suggested_action: "Use chain=base."
      }
    };
  } else {
    body = createLiveFundFlowEnvelope(input);
  }
  await sendPaidResult({ res, payment, body });
}

export async function handleBtcLiquidationProvider(req, res) {
  const input = await readJson(req);
  const serviceId = "btc_liquidation_max_pain_demo";
  const amount = "0.02";
  const currency = "USDC";
  const network = "base";
  const payment = await requirePaymentOrRespond({
    req,
    res,
    serviceId,
    amount,
    currency,
    network,
    payTo: providerPayoutAddress(),
    description: "BTC liquidation max pain"
  });
  if (!payment.ok) return;

  let body;
  if (input.asset && String(input.asset).toUpperCase() !== "BTC") {
    body = {
      schema_version: "agent_data_envelope_v1",
      service_id: serviceId,
      request_id: `req_${Date.now()}`,
      status: "error",
      error: {
        code: "UNSUPPORTED_ASSET",
        message: "This demo service only supports BTC.",
        retryable: false,
        suggested_action: "Use asset=BTC."
      }
    };
  } else {
    body = createLiveBtcLiquidationEnvelope(input);
  }
  await sendPaidResult({ res, payment, body });
}

export async function handleCustomProvider(req, res, serviceId) {
  let config;
  try {
    config = await readProviderConfig(serviceId);
  } catch {
    sendNotFound(res, "PROVIDER_CONFIG_NOT_FOUND");
    return;
  }

  const input = await readJson(req);
  const manifest = config.manifest;
  const amount = manifest.pricing.amount;
  const currency = manifest.pricing.currency;
  const network = manifest.pricing.network;
  const payment = await requirePaymentOrRespond({
    req,
    res,
    serviceId,
    amount,
    currency,
    network,
    payTo: providerPayoutAddress(manifest),
    description: manifest.description_for_agent || manifest.title
  });
  if (!payment.ok) return;

  if (config.source?.type === "hosted_http") {
    const upstream = await callHostedHttpSource(config, input);
    if (upstream?.upstream_error) {
      sendJson(res, 502, {
        schema_version: "agent_data_envelope_v1",
        service_id: serviceId,
        request_id: `req_${Date.now()}`,
        status: "error",
        query: input || {},
        error: {
          code: "UPSTREAM_ERROR",
          message: `Upstream API returned HTTP ${upstream.status}.`,
          retryable: upstream.status >= 500,
          upstream_status: upstream.status,
          upstream_payload: upstream.payload
        },
        metadata: {
          data_sources: ["provider_config_hosted_http"],
          generated_at: new Date().toISOString(),
          freshness_seconds: 0,
          is_estimated: false,
          confidence: 0,
          limitations: ["The provider endpoint was reachable, but the upstream API rejected or failed the request."]
        },
        agent_hints: {
          good_for: [],
          warnings: ["Check the provider secret, endpoint permissions, and request body shape."],
          suggested_followups: ["Ask the provider to validate the upstream API key and sample request."]
        },
        summary: "Hosted HTTP upstream call failed."
      });
      return;
    }
    await sendPaidResult({ res, payment, body: createEnvelope({
      serviceId,
      input,
      data: shapeHostedHttpPayload(upstream, input),
      sourceType: "hosted_http",
      sampleType: null,
      isEstimated: false,
      confidence: 0.8,
      summary: config.source.summary
    }) });
    return;
  }

  if (config.source?.type !== "static_json") {
    sendJson(res, 200, {
      schema_version: "agent_data_envelope_v1",
      service_id: serviceId,
      request_id: `req_${Date.now()}`,
      status: "error",
      error: {
        code: "UNSUPPORTED_PROVIDER_SOURCE",
        message: "This MVP runtime currently supports static_json and hosted_http provider configs.",
        retryable: false,
        suggested_action: "Use a supported provider config or add a source adapter."
      }
    });
    return;
  }

  await sendPaidResult({ res, payment, body: createEnvelope({
    serviceId,
    input,
    data: config.source.live_data,
    sourceType: "static_json",
    sampleType: null,
    isEstimated: false,
    confidence: 0.8,
    summary: config.source.summary
  }) });
}

async function requirePaymentOrRespond({ req, res, serviceId, amount, currency, network, payTo, description }) {
  if (isRealX402ProviderEnabled()) {
    const payment = await processProviderX402Payment({
      req,
      serviceId,
      amount,
      network,
      description
    });
    if (!payment.ok) {
      sendX402Response(res, payment.response);
      return { ok: false };
    }
    return { ok: true, payment };
  }

  if (currentPaymentBackend() === "dev" && !isLoopbackProviderRequest(req)) {
    sendJson(res, 503, {
      error: "Payment backend is not production safe",
      code: "PUBLIC_DEV_PAYMENT_DISABLED",
      message: "Public provider endpoints cannot accept dev-x402 proofs. Configure ADN_PAYMENT_BACKEND=circle_arc or another real payment backend before exposing paid data.",
      payment: {
        required: true,
        service_id: serviceId,
        amount,
        asset: currency,
        supported_backends: ["circle_arc", "x402", "omniagentpay"]
      }
    });
    return { ok: false };
  }

  const paymentProof = req.headers["x-payment"];
  if (!paymentProof) {
    if (currentPaymentBackend() === "circle_arc" && !isEvmAddress(payTo)) {
      sendJson(res, 503, {
        error: "Provider payout address is not configured",
        code: "PROVIDER_PAYOUT_ADDRESS_REQUIRED",
        message: "Circle Arc settlement requires a valid provider EVM wallet address."
      });
      return { ok: false };
    }
    const payment = issueChallenge({ serviceId, amount, currency, network: currentPaymentBackend() === "circle_arc" ? "arc-testnet" : network, payTo });
    sendJson(res, 402, {
      error: "Payment Required",
      payment
    });
    return { ok: false };
  }

  const verification = await verifyPaymentWithChallenge(paymentProof, { serviceId, amount, currency, network: currentPaymentBackend() === "circle_arc" ? "arc-testnet" : network });
  if (!verification.ok) {
    sendJson(res, 402, {
      error: "Invalid Payment",
      code: verification.error,
      payment: createPaymentRequirements({ serviceId, amount, currency, network: currentPaymentBackend() === "circle_arc" ? "arc-testnet" : network, payTo })
    });
    return { ok: false };
  }
  return { ok: true, payment: { required: false } };
}

function isLoopbackProviderRequest(req) {
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const hostHeader = forwardedHost || String(req.headers.host || "");
  const host = hostHeader.split(":")[0].toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

async function sendPaidResult({ res, payment, body }) {
  if (payment.payment?.required) {
    const settlement = await settleProviderX402Payment(payment.payment, body);
    if (settlement.failed) {
      sendX402Response(res, settlement.response);
      return;
    }
    sendJson(res, 200, body, settlement.headers);
    return;
  }
  sendJson(res, 200, body);
}

function issueChallenge({ serviceId, amount, currency, network, payTo }) {
  const payment = createPaymentRequirements({ serviceId, amount, currency, network, payTo });
  issuedChallenges.set(payment.nonce, payment);
  return payment;
}

async function verifyPaymentWithChallenge(paymentProof, expected) {
  const decoded = decodeProof(paymentProof);
  if (!decoded.ok) return decoded;
  const challenge = issuedChallenges.get(decoded.payment.challenge_nonce);
  if (!challenge) return { ok: false, error: "UNKNOWN_OR_REPLAYED_PAYMENT_CHALLENGE" };
  const verification = verifyDevPaymentProof(paymentProof, {
    ...expected,
    payTo: challenge.pay_to,
    nonce: challenge.nonce,
    resourceHash: challenge.resource_hash
  });
  if (verification.ok) {
    if (currentPaymentBackend() === "circle_arc" || isArcNetwork(challenge.network)) {
      const arc = await verifyArcUsdcTransfer({
        txHash: decoded.payment.tx_hash,
        expected: {
          amount: challenge.amount,
          payTo: challenge.pay_to,
          payer: decoded.payment.payer
        }
      });
      if (!arc.ok) return arc;
      verification.payment.arc_verification = arc;
    }
    issuedChallenges.delete(challenge.nonce);
  }
  return verification;
}

function providerPayoutAddress(manifest = null) {
  return manifest?.provider?.payout_address ||
    manifest?.pricing?.pay_to ||
    process.env.ADN_PROVIDER_RECEIVE_ADDRESS ||
    process.env.ADN_X402_PAY_TO ||
    "";
}

function decodeProof(proof) {
  try {
    return {
      ok: true,
      payment: JSON.parse(Buffer.from(proof, "base64url").toString("utf8"))
    };
  } catch {
    return { ok: false, error: "INVALID_PAYMENT_PROOF" };
  }
}

export async function handleMockUpstreamSentiment(req, res) {
  const auth = req.headers.authorization;
  const input = await readJson(req);
  if (auth !== "Bearer demo-provider-secret") {
    sendJson(res, 401, {
      error: "missing or invalid provider secret"
    });
    return;
  }
  sendJson(res, 200, {
    asset: input.asset || "ETH",
    window: input.window || "7d",
    sentiment_score: 0.79,
    mentions: 24120,
    positive_ratio: 0.71,
    negative_ratio: 0.12,
    neutral_ratio: 0.17,
    source: "mock_upstream_sentiment"
  });
}

export async function handleMockUpstreamApplicationError(_req, res) {
  sendJson(res, 200, {
    status: 100,
    message: "Missing API key",
    data: null
  });
}

export async function handleMockUpstreamHeaderKey(req, res) {
  if (req.headers["api-key"] !== "demo-provider-secret") {
    sendJson(res, 401, {
      error: "missing or invalid provider secret"
    });
    return;
  }
  const url = new URL(req.url, "http://127.0.0.1");
  const rowCount = boundedInteger(url.searchParams.get("total_rows"), 1, 1000) || 1;
  sendJson(res, 200, {
    status: "success",
    rows: Array.from({ length: rowCount }, (_, index) => ({
      metric: `sample_metric_${index + 1}`,
      value: 42 + index
    })),
    source: "mock_upstream_header_key"
  });
}

async function callHostedHttpSource(config, input) {
  const secretValue = config.source.auth?.secret_value || await readProviderSecret(config.source.auth?.secret_ref);
  const method = (config.source.upstream_method || "POST").toUpperCase();
  const prepared = prepareHostedHttpRequest({
    url: config.source.upstream_url,
    method,
    input
  });
  const authAttempts = buildAuthAttempts({
    mode: config.source.auth?.mode,
    header: config.source.auth?.header,
    secretValue
  });
  let lastError = null;
  for (const attempt of authAttempts) {
    const request = {
      method,
      headers: {
        "content-type": "application/json",
        ...attempt.headers
      }
    };
    if (prepared.body !== undefined) request.body = prepared.body;
    const response = await fetch(prepared.url, request);
    const payload = await parseUpstreamPayload(response);
    const outcome = classifyUpstreamResponse(response, payload, attempt);
    if (!outcome.upstream_error) return payload;
    lastError = outcome;
  }
  return {
    ...lastError,
    attempted_auth_headers: authAttempts.map((attempt) => attempt.label).filter((label) => label !== "none")
  };
}

function prepareHostedHttpRequest({ url, method, input }) {
  let nextUrl = url;
  const consumedPathParams = new Set();
  for (const [key, value] of Object.entries(input || {})) {
    if (value === undefined || value === null) continue;
    const encodedKey = encodeURIComponent(key);
    if (nextUrl.includes(`{${key}}`) || nextUrl.includes(`%7B${encodedKey}%7D`)) {
      nextUrl = nextUrl
        .replaceAll(`{${key}}`, encodeURIComponent(String(value)))
        .replaceAll(`%7B${encodedKey}%7D`, encodeURIComponent(String(value)));
      consumedPathParams.add(key);
    }
  }
  if (method === "GET") {
    const parsed = new URL(nextUrl);
    for (const [key, value] of Object.entries(input || {})) {
      if (consumedPathParams.has(key)) continue;
      if (value !== undefined && value !== null) parsed.searchParams.set(key, String(value));
    }
    return { url: parsed.toString() };
  }
  return {
    url: nextUrl,
    body: JSON.stringify(input)
  };
}

function buildAuthAttempts({ mode, header, secretValue }) {
  if (mode !== "header" || !secretValue) return [{ label: "none", headers: {} }];
  const normalized = String(header || "").trim().toLowerCase();
  if (normalized && normalized !== "auto") {
    return [{
      label: normalized,
      headers: { [normalized]: normalized === "authorization" ? `Bearer ${secretValue}` : secretValue }
    }];
  }
  return [
    { label: "authorization", headers: { authorization: `Bearer ${secretValue}` } },
    { label: "x-api-key", headers: { "x-api-key": secretValue } },
    { label: "api-key", headers: { "api-key": secretValue } },
    { label: "apiKey", headers: { apiKey: secretValue } },
    { label: "apikey", headers: { apikey: secretValue } },
    { label: "x-access-token", headers: { "x-access-token": secretValue } }
  ];
}

function classifyUpstreamResponse(response, payload, attempt) {
  if (payload.non_json) {
    return {
      upstream_error: true,
      status: response.status,
      auth_header: attempt.label,
      payload: {
        code: "UPSTREAM_NON_JSON_RESPONSE",
        content_type: payload.content_type,
        body_preview: payload.body_preview
      }
    };
  }
  if (!response.ok) {
    return {
      upstream_error: true,
      status: response.status,
      auth_header: attempt.label,
      payload
    };
  }
  const applicationError = detectApplicationError(payload);
  if (applicationError) {
    return {
      upstream_error: true,
      status: response.status,
      auth_header: attempt.label,
      payload: applicationError
    };
  }
  return { upstream_error: false };
}

function shapeHostedHttpPayload(payload, input = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const limit = boundedInteger(input.limit ?? input.pagination?.per_page, 0, 100);
  const offset = boundedInteger(input.offset, 0, 100000) || 0;
  if (!limit) return payload;

  for (const key of ["data", "rows", "items", "records", "results"]) {
    if (!Array.isArray(payload[key]) || (payload[key].length <= limit && offset === 0)) continue;
    const page = payload[key].slice(offset, offset + limit);
    return {
      ...payload,
      [key]: page,
      agentrouter_page: {
        applied: true,
        field: key,
        limit,
        offset,
        returned: page.length,
        total_available: payload[key].length,
        truncated: offset + limit < payload[key].length
      }
    };
  }
  return payload;
}

function boundedInteger(value, min, max) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function detectApplicationError(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const message = String(payload.message || payload.error || payload.msg || "").toLowerCase();
  const hasAuthError = /missing api key|api key missing|invalid api key|unauthorized|forbidden|token|auth/.test(message);
  if (hasAuthError) {
    return {
      code: "UPSTREAM_APPLICATION_ERROR",
      reason: "auth_or_permission_error",
      message: payload.message || payload.error || payload.msg || "Upstream API reported an authentication or permission error.",
      upstream_payload: payload
    };
  }
  const status = payload.status ?? payload.code;
  const normalizedStatus = typeof status === "string" ? status.toLowerCase() : status;
  const successStatuses = new Set([0, 1, 200, "0", "1", "200", "ok", "success", "succeeded"]);
  if (status !== undefined && !successStatuses.has(normalizedStatus) && (payload.message || payload.error || payload.data === null)) {
    return {
      code: "UPSTREAM_APPLICATION_ERROR",
      reason: "non_success_status",
      message: payload.message || payload.error || `Upstream API returned non-success status ${status}.`,
      upstream_payload: payload
    };
  }
  if (payload.data === null && (payload.message || payload.error)) {
    return {
      code: "UPSTREAM_APPLICATION_ERROR",
      reason: "empty_error_payload",
      message: payload.message || payload.error || "Upstream API returned null data with an error-like message.",
      upstream_payload: payload
    };
  }
  return null;
}

async function parseUpstreamPayload(response) {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (!text.trim()) return {};
  if (contentType.includes("application/json") || looksLikeJson(text)) {
    try {
      return JSON.parse(text);
    } catch (error) {
      return {
        non_json: true,
        content_type: contentType,
        body_preview: text.slice(0, 240),
        parse_error: error.message
      };
    }
  }
  return {
    non_json: true,
    content_type: contentType,
    body_preview: text.slice(0, 240)
  };
}

function looksLikeJson(text) {
  const trimmed = String(text || "").trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}
