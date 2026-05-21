import { createPaymentRequirements, verifyDevPaymentProof } from "./payment.js";
import { createEnvelope, readProviderConfig } from "./provider-config.js";
import { createLiveBtcLiquidationEnvelope, createLiveFundFlowEnvelope } from "./fixtures.js";
import { readJson, sendJson, sendNotFound } from "./http-utils.js";
import { readProviderSecret } from "./provider-secrets.js";

const issuedChallenges = new Map();

export async function handleFundFlowProvider(req, res) {
  const paymentProof = req.headers["x-payment"];
  const input = await readJson(req);
  const serviceId = "chain_fund_flow_7d_base";
  const amount = "0.01";
  const currency = "USDC";
  const network = "base";

  if (!paymentProof) {
    const payment = issueChallenge({ serviceId, amount, currency, network });
    sendJson(res, 402, {
      error: "Payment Required",
      payment
    });
    return;
  }

  const verification = verifyPaymentWithChallenge(paymentProof, { serviceId, amount, currency, network });
  if (!verification.ok) {
    sendJson(res, 402, {
      error: "Invalid Payment",
      code: verification.error,
      payment: createPaymentRequirements({ serviceId, amount, currency, network })
    });
    return;
  }

  if (input.chain && input.chain !== "base") {
    sendJson(res, 200, {
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
    });
    return;
  }

  sendJson(res, 200, createLiveFundFlowEnvelope(input));
}

export async function handleBtcLiquidationProvider(req, res) {
  const paymentProof = req.headers["x-payment"];
  const input = await readJson(req);
  const serviceId = "btc_liquidation_max_pain_demo";
  const amount = "0.02";
  const currency = "USDC";
  const network = "base";

  if (!paymentProof) {
    const payment = issueChallenge({ serviceId, amount, currency, network });
    sendJson(res, 402, {
      error: "Payment Required",
      payment
    });
    return;
  }

  const verification = verifyPaymentWithChallenge(paymentProof, { serviceId, amount, currency, network });
  if (!verification.ok) {
    sendJson(res, 402, {
      error: "Invalid Payment",
      code: verification.error,
      payment: createPaymentRequirements({ serviceId, amount, currency, network })
    });
    return;
  }

  if (input.asset && String(input.asset).toUpperCase() !== "BTC") {
    sendJson(res, 200, {
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
    });
    return;
  }

  sendJson(res, 200, createLiveBtcLiquidationEnvelope(input));
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
  const paymentProof = req.headers["x-payment"];

  if (!paymentProof) {
    const payment = issueChallenge({ serviceId, amount, currency, network });
    sendJson(res, 402, {
      error: "Payment Required",
      payment
    });
    return;
  }

  const verification = verifyPaymentWithChallenge(paymentProof, { serviceId, amount, currency, network });
  if (!verification.ok) {
    sendJson(res, 402, {
      error: "Invalid Payment",
      code: verification.error,
      payment: createPaymentRequirements({ serviceId, amount, currency, network })
    });
    return;
  }

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
    sendJson(res, 200, createEnvelope({
      serviceId,
      input,
      data: upstream,
      sourceType: "hosted_http",
      sampleType: null,
      isEstimated: false,
      confidence: 0.8,
      summary: config.source.summary
    }));
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

  sendJson(res, 200, createEnvelope({
    serviceId,
    input,
    data: config.source.live_data,
    sourceType: "static_json",
    sampleType: null,
    isEstimated: false,
    confidence: 0.8,
    summary: config.source.summary
  }));
}

function issueChallenge({ serviceId, amount, currency, network }) {
  const payment = createPaymentRequirements({ serviceId, amount, currency, network });
  issuedChallenges.set(payment.nonce, payment);
  return payment;
}

function verifyPaymentWithChallenge(paymentProof, expected) {
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
    issuedChallenges.delete(challenge.nonce);
  }
  return verification;
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

export async function handleMockUpstreamBtcEtf(req, res) {
  if (req.headers["api-key"] !== "demo-blockbeats-key") {
    sendJson(res, 200, {
      status: 100,
      message: "Missing API key",
      data: null
    });
    return;
  }
  sendJson(res, 200, {
    status: 0,
    message: "",
    data: [
      {
        date: "2026-05-20",
        day_net_inflow_million: "-70.50",
        total_net_inflow_million: "106875.00"
      }
    ]
  });
}

async function callHostedHttpSource(config, input) {
  const headers = { "content-type": "application/json" };
  const secretValue = config.source.auth?.secret_value || await readProviderSecret(config.source.auth?.secret_ref);
  if (config.source.auth?.mode === "header" && secretValue) {
    headers[config.source.auth.header || "authorization"] = config.source.auth.header?.toLowerCase() === "authorization"
      ? `Bearer ${secretValue}`
      : secretValue;
  }
  const method = (config.source.upstream_method || "POST").toUpperCase();
  const request = { method, headers };
  let url = config.source.upstream_url;
  const consumedPathParams = new Set();
  for (const [key, value] of Object.entries(input || {})) {
    if (value === undefined || value === null) continue;
    const encodedKey = encodeURIComponent(key);
    if (url.includes(`{${key}}`) || url.includes(`%7B${encodedKey}%7D`)) {
      url = url
        .replaceAll(`{${key}}`, encodeURIComponent(String(value)))
        .replaceAll(`%7B${encodedKey}%7D`, encodeURIComponent(String(value)));
      consumedPathParams.add(key);
    }
  }
  if (method === "GET") {
    const parsed = new URL(url);
    for (const [key, value] of Object.entries(input || {})) {
      if (consumedPathParams.has(key)) continue;
      if (value !== undefined && value !== null) parsed.searchParams.set(key, String(value));
    }
    url = parsed.toString();
  } else {
    request.body = JSON.stringify(input);
  }
  const response = await fetch(url, request);
  const payload = await parseUpstreamPayload(response);
  if (payload.non_json) {
    return {
      upstream_error: true,
      status: response.status,
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
      payload
    };
  }
  const applicationError = detectApplicationError(payload);
  if (applicationError) {
    return {
      upstream_error: true,
      status: response.status,
      payload: applicationError
    };
  }
  return payload;
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
