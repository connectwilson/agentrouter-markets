import { createDevPaymentProof } from "./payment.js";
import { validateEnvelope, validateJsonSchema } from "./schema.js";
import { publicServiceRecord } from "./store.js";
import { normalizeEndpoint } from "./http-utils.js";
import { suggestCapabilities } from "./id-utils.js";
import { createSettlementReceipt } from "./payment-adapter.js";

export function registerService(store, manifest, baseUrl) {
  const manifestErrors = validateManifest(manifest);
  if (manifestErrors.length) {
    const error = new Error(`Invalid manifest: ${manifestErrors.join(", ")}`);
    error.statusCode = 422;
    throw error;
  }
  if (store.services.has(manifest.service_id)) {
    const error = new Error(`Service ${manifest.service_id} is already registered.`);
    error.statusCode = 409;
    error.code = "SERVICE_ALREADY_REGISTERED";
    throw error;
  }

  const normalized = {
    ...manifest,
    capabilities: normalizeManifestCapabilities(manifest),
    endpoint: {
      ...manifest.endpoint,
      url: normalizeEndpoint(manifest.endpoint.url, baseUrl)
    }
  };
  const duplicate = findDuplicateService(store, normalized);
  if (duplicate) {
    const error = new Error(`Service source is already registered as ${duplicate.manifest.service_id}.`);
    error.statusCode = 409;
    error.code = "SERVICE_SOURCE_ALREADY_REGISTERED";
    error.existingServiceId = duplicate.manifest.service_id;
    throw error;
  }

  const record = {
    manifest: normalized,
    verification_status: "pending",
    validation_runs: [],
    feedback_events: []
  };
  store.providers.set(normalized.provider.provider_id, normalized.provider);
  store.services.set(normalized.service_id, record);
  return record;
}

export function findDuplicateService(store, manifest) {
  const fingerprint = manifest?.registration?.source_fingerprint;
  const providerId = manifest?.provider?.provider_id;
  if (!fingerprint || !providerId) return null;
  for (const record of store.services.values()) {
    if (record.manifest.service_id === manifest.service_id) continue;
    if (record.manifest.provider?.provider_id !== providerId) continue;
    if (record.manifest.registration?.source_fingerprint === fingerprint) return record;
  }
  return null;
}

export function unregisterService(store, serviceId) {
  const record = store.services.get(serviceId);
  if (!record) return false;
  store.services.delete(serviceId);
  const providerId = record.manifest?.provider?.provider_id;
  if (providerId) {
    const providerStillUsed = [...store.services.values()].some((item) => item.manifest?.provider?.provider_id === providerId);
    if (!providerStillUsed) store.providers.delete(providerId);
  }
  return true;
}

function normalizeManifestCapabilities(manifest) {
  const declared = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  const inferred = suggestCapabilities([
    manifest.service_id,
    manifest.title,
    manifest.description_for_agent,
    declared.join(" ")
  ].join(" ")).split(",");
  return [...new Set([...declared, ...inferred])];
}

export async function validateService(store, serviceId) {
  const record = store.services.get(serviceId);
  if (!record) return { ok: false, error: "SERVICE_NOT_FOUND" };

  const manifest = record.manifest;
  const requestBody = manifest.sample_request || {};
  const firstResponse = await fetch(manifest.endpoint.url, {
    method: manifest.endpoint.method || "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody)
  });

  if (firstResponse.status !== 402) {
    return storeValidation(record, {
      ok: false,
      service_id: serviceId,
      error: "EXPECTED_402_PAYMENT_REQUIRED",
      status: firstResponse.status,
      created_at: new Date().toISOString()
    });
  }

  const paymentChallenge = await firstResponse.json();
  const proof = createDevPaymentProof({
    serviceId,
    amount: paymentChallenge.payment.amount,
    currency: paymentChallenge.payment.asset,
    network: paymentChallenge.payment.network,
    challenge: paymentChallenge.payment,
    payer: "validator"
  });

  const paidResponse = await fetch(manifest.endpoint.url, {
    method: manifest.endpoint.method || "POST",
    headers: {
      "content-type": "application/json",
      "x-payment": proof
    },
    body: JSON.stringify(requestBody)
  });
  const responseBody = await paidResponse.json();
  const schemaErrors = validateJsonSchema(responseBody, manifest.output_schema);
  const envelopeErrors = validateEnvelope(responseBody);
  const ok = paidResponse.ok && schemaErrors.length === 0 && envelopeErrors.length === 0;

  return storeValidation(record, {
    ok,
    service_id: serviceId,
    status: paidResponse.status,
    provider_error: responseBody?.error || null,
    schema_errors: schemaErrors,
    envelope_errors: envelopeErrors,
    created_at: new Date().toISOString()
  });
}

export function searchServices(store, { query = "", capabilities = [], maxPrice, verifiedOnly = false } = {}) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const max = maxPrice == null || maxPrice === "" ? null : Number(maxPrice);
  const results = [];

  for (const record of store.services.values()) {
    if (verifiedOnly && record.verification_status !== "verified") continue;
    const manifest = record.manifest;
    if (max != null && Number(manifest.pricing.amount) > max) continue;
    if (capabilities.length && !capabilities.every((capability) => manifest.capabilities.includes(capability))) continue;

    const haystack = [
      manifest.title,
      manifest.description_for_agent,
      ...(manifest.capabilities || []),
      manifest.service_id
    ].join(" ").toLowerCase();

    const matchCount = terms.filter((term) => haystack.includes(term)).length;
    if (terms.length && matchCount === 0) continue;

    results.push({
      ...publicServiceRecord(record),
      match_score: terms.length ? matchCount / terms.length : 1
    });
  }

  return results.sort((a, b) => b.match_score - a.match_score);
}

export async function invokePaidService(store, serviceId, input, budget) {
  const record = store.services.get(serviceId);
  if (!record) return { statusCode: 404, body: { error: { code: "SERVICE_NOT_FOUND" } } };

  const manifest = record.manifest;
  if (budget.max_amount != null && Number(manifest.pricing.amount) > Number(budget.max_amount)) {
    return {
      statusCode: 402,
      body: {
        error: {
          code: "BUDGET_TOO_LOW",
          message: `Service costs ${manifest.pricing.amount} ${manifest.pricing.currency}.`
        }
      }
    };
  }

  const started = Date.now();
  const firstResponse = await fetch(manifest.endpoint.url, {
    method: manifest.endpoint.method || "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  if (firstResponse.status !== 402) {
    return { statusCode: 502, body: { error: { code: "EXPECTED_402_PAYMENT_REQUIRED" } } };
  }
  const challenge = await firstResponse.json();
  const proof = createDevPaymentProof({
    serviceId,
    amount: challenge.payment.amount,
    currency: challenge.payment.asset,
    network: challenge.payment.network,
    challenge: challenge.payment
  });
  const paidResponse = await fetch(manifest.endpoint.url, {
    method: manifest.endpoint.method || "POST",
    headers: {
      "content-type": "application/json",
      "x-payment": proof
    },
    body: JSON.stringify(input)
  });
  const body = await paidResponse.json();
  const schemaErrors = validateJsonSchema(body, manifest.output_schema);
  const envelopeErrors = validateEnvelope(body);
  const schemaValid = schemaErrors.length === 0 && envelopeErrors.length === 0;
  const paymentTx = decodePaymentTx(proof);
  const settlementReceipt = createSettlementReceipt({
    manifest,
    challenge: challenge.payment,
    txHash: paymentTx
  });
  const feedback = {
    event_version: "agent_service_feedback_v1",
    request_id: body.request_id || `req_${Date.now()}`,
    service_id: serviceId,
    provider_id: manifest.provider.provider_id,
    consumer_id: "consumer_demo_agent",
    payment_tx: paymentTx,
    settlement_receipt: settlementReceipt,
    status: paidResponse.ok ? "success" : "error",
    schema_valid: schemaValid,
    latency_ms: Date.now() - started,
    consumer_rating: paidResponse.ok && schemaValid ? 1 : 0,
    created_at: new Date().toISOString()
  };
  record.feedback_events.push(feedback);
  store.feedbackEvents.push(feedback);
  store.invocationLogs.push({ service_id: serviceId, input, feedback });

  return {
    statusCode: paidResponse.status,
    body: {
      result: body,
      feedback
    }
  };
}

export async function loadProviderConfigs(store, baseUrl, { validate = true } = {}) {
  const { listProviderConfigs } = await import("./provider-config.js");
  const configs = await listProviderConfigs();
  const loaded = [];
  for (const config of configs) {
    const manifest = withCurrentRuntimeEndpoint(config.manifest, baseUrl);
    const record = registerService(store, manifest, baseUrl);
    let validation = null;
    if (validate) {
      try {
        validation = await validateService(store, manifest.service_id);
      } catch (error) {
        validation = storeValidation(record, {
          ok: false,
          service_id: manifest.service_id,
          error: "VALIDATION_REQUEST_FAILED",
          message: error.message,
          created_at: new Date().toISOString()
        });
      }
    }
    loaded.push({ service_id: manifest.service_id, record, validation });
  }
  return loaded;
}

function withCurrentRuntimeEndpoint(manifest, baseUrl) {
  const endpointUrl = manifest?.endpoint?.url || "";
  if (!baseUrl || !endpointUrl) return manifest;
  let pathname = "";
  try {
    pathname = new URL(endpointUrl).pathname;
  } catch {
    return manifest;
  }
  if (!pathname.startsWith("/provider/custom/")) return manifest;
  return {
    ...manifest,
    endpoint: {
      ...manifest.endpoint,
      url: `${baseUrl.replace(/\/$/, "")}${pathname}`
    }
  };
}

function validateManifest(manifest) {
  const errors = [];
  for (const key of ["manifest_version", "service_id", "provider", "title", "description_for_agent", "capabilities", "input_schema", "output_schema", "sample_request", "sample_response", "pricing", "endpoint"]) {
    if (!manifest?.[key]) errors.push(`${key} is required`);
  }
  if (!manifest?.provider?.provider_id) errors.push("provider.provider_id is required");
  if (!manifest?.pricing?.amount || !manifest?.pricing?.currency || !manifest?.pricing?.network) errors.push("pricing amount/currency/network are required");
  if (!manifest?.endpoint?.url) errors.push("endpoint.url is required");
  if (manifest?.service_id && !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(manifest.service_id)) errors.push("service_id must be 3-64 chars and use lowercase letters, numbers, _ or -");
  if (manifest?.pricing?.amount && !(Number(manifest.pricing.amount) > 0)) errors.push("pricing.amount must be positive");
  if (manifest?.capabilities && (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0)) errors.push("capabilities must be a non-empty array");
  return errors;
}

function storeValidation(record, result) {
  record.validation_runs.push(result);
  record.verification_status = result.ok ? "verified" : "failed";
  return result;
}

function decodePaymentTx(proof) {
  try {
    return JSON.parse(Buffer.from(proof, "base64url").toString("utf8")).tx_hash;
  } catch {
    return null;
  }
}
