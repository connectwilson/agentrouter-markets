import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { deleteProviderSecret, writeProviderSecret } from "./provider-secrets.js";
import { assertPersistentProviderStorageReady, deletePersistentProviderConfig, listPersistentProviderConfigs, readPersistentProviderConfig, writePersistentProviderConfig } from "./persistence.js";

export const PROVIDER_DIR = path.resolve(process.env.ADN_PROVIDER_DIR || "providers");

export async function ensureProviderDir() {
  await fs.mkdir(PROVIDER_DIR, { recursive: true });
}

export function providerConfigPath(serviceId) {
  return path.join(PROVIDER_DIR, `${serviceId}.json`);
}

export async function writeProviderConfig(config) {
  await ensureProviderDir();
  assertPersistentProviderStorageReady({ requiresSecret: Boolean(config.source?.auth?.secret_value) });
  const sanitized = await sanitizeProviderConfig(config);
  await writePersistentProviderConfig(sanitized);
  await fs.writeFile(providerConfigPath(config.manifest.service_id), `${JSON.stringify(sanitized, null, 2)}\n`);
  return providerConfigPath(config.manifest.service_id);
}

export async function readProviderConfig(serviceId) {
  const persistent = await readPersistentProviderConfig(serviceId);
  if (persistent) return persistent;
  const content = await fs.readFile(providerConfigPath(serviceId), "utf8");
  return JSON.parse(content);
}

export async function deleteProviderConfig(serviceId) {
  let config = null;
  try {
    config = await readProviderConfig(serviceId);
  } catch {
    // It may only exist in one backing store; still delete the known paths.
  }
  await deletePersistentProviderConfig(serviceId);
  if (config?.source?.auth?.secret_ref) {
    await deleteProviderSecret(config.source.auth.secret_ref);
  }
  try {
    await fs.rm(providerConfigPath(serviceId), { force: true });
  } catch {
    // Best-effort cleanup.
  }
  return true;
}

export async function listProviderConfigs() {
  const persistent = await listPersistentProviderConfigs();
  try {
    await ensureProviderDir();
    const files = await fs.readdir(PROVIDER_DIR);
    const seen = new Set(persistent.map((config) => config.manifest?.service_id).filter(Boolean));
    const configs = [...persistent];
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const content = await fs.readFile(path.join(PROVIDER_DIR, file), "utf8");
      const config = JSON.parse(content);
      if (seen.has(config.manifest?.service_id)) continue;
      configs.push(config);
    }
    return configs;
  } catch {
    return persistent;
  }
}

export function createStaticProviderConfig({
  baseUrl,
  serviceId,
  providerId,
  title,
  description,
  capabilities,
  price,
  sampleRequest,
  sampleData,
  liveData,
  summary
}) {
  const manifest = {
    manifest_version: "agent_data_service_manifest_v1",
    service_id: serviceId,
    provider: {
      provider_id: providerId,
      agent_identity: {
        standard: "erc-8004-compatible",
        agent_registry: "optional",
        agent_id: "optional",
        agent_uri: "optional"
      }
    },
    title,
    description_for_agent: description,
    capabilities,
    not_for: [],
    input_schema: schemaFromSample(sampleRequest),
    output_schema: {
      type: "object",
      required: ["schema_version", "service_id", "request_id", "status", "query", "data", "metadata"],
      properties: {
        schema_version: { type: "string" },
        service_id: { type: "string" },
        request_id: { type: "string" },
        status: { type: "string" },
        query: { type: "object" },
        data: { type: "object" },
        metadata: { type: "object" }
      }
    },
    sample_request: sampleRequest,
    sample_response: createEnvelope({
      serviceId,
      input: sampleRequest,
      data: sampleData,
      sampleType: "mock",
      isEstimated: true,
      confidence: 0.7,
      summary: `${summary} (sample response)`
    }),
    pricing: {
      amount: price,
      currency: "USDC",
      network: "base",
      protocol: "x402"
    },
    endpoint: {
      url: `${baseUrl.replace(/\/$/, "")}/provider/custom/${serviceId}`,
      method: "POST"
    },
    data_source_claim: {
      source_type: "static_dataset",
      source_provenance_level: "provider_owned",
      authorization_status: "provider_declared",
      redistribution_status: "provider_declared",
      credential_custody: "none",
      platform_stores_credentials: false
    },
    freshness: {
      update_frequency: "manual",
      max_data_lag_seconds: 86400
    },
    agent_contract: createAgentContract({ capabilities, sampleRequest, sampleData, summary }),
    registration: {
      source_fingerprint: createSourceFingerprint({
        type: "static_json",
        provider_id: providerId,
        summary,
        sample_request: sampleRequest,
        sample_data: sampleData
      }),
      duplicate_policy: "same_provider_source_is_idempotent"
    }
  };

  return {
    provider_config_version: "adn_provider_config_v1",
    source: {
      type: "static_json",
      live_data: liveData,
      summary
    },
    manifest
  };
}

export function createHostedHttpProviderConfig({
  baseUrl,
  serviceId,
  providerId,
  title,
  description,
  capabilities,
  price,
  sampleRequest,
  sampleData,
  upstreamUrl,
  upstreamMethod = "POST",
  secretName = "PROVIDER_SECRET",
  secretValue = "",
  authHeader = "authorization",
  summary
}) {
  const manifest = {
    manifest_version: "agent_data_service_manifest_v1",
    service_id: serviceId,
    provider: {
      provider_id: providerId,
      agent_identity: {
        standard: "erc-8004-compatible",
        agent_registry: "optional",
        agent_id: "optional",
        agent_uri: "optional"
      }
    },
    title,
    description_for_agent: description,
    capabilities,
    not_for: [],
    input_schema: schemaFromSample(sampleRequest),
    output_schema: {
      type: "object",
      required: ["schema_version", "service_id", "request_id", "status", "query", "data", "metadata"],
      properties: {
        schema_version: { type: "string" },
        service_id: { type: "string" },
        request_id: { type: "string" },
        status: { type: "string" },
        query: { type: "object" },
        data: { type: "object" },
        metadata: { type: "object" }
      }
    },
    sample_request: sampleRequest,
    sample_response: createEnvelope({
      serviceId,
      input: sampleRequest,
      data: sampleData,
      sourceType: "hosted_http",
      sampleType: "mock",
      isEstimated: true,
      confidence: 0.7,
      summary: `${summary} (sample response)`
    }),
    pricing: {
      amount: price,
      currency: "USDC",
      network: "base",
      protocol: "x402"
    },
    endpoint: {
      url: `${baseUrl.replace(/\/$/, "")}/provider/custom/${serviceId}`,
      method: "POST"
    },
    runtime_secrets: {
      required: Boolean(secretValue),
      custody: "hosted_runtime_config",
      public: false
    },
    data_source_claim: {
      source_type: "provider_declared_data_service",
      source_provenance_level: inferSourceProvenanceLevel({ upstreamUrl, secretValue }),
      authorization_status: "provider_declared",
      redistribution_status: "provider_declared",
      credential_custody: secretValue ? "hosted_runtime_config" : "none",
      platform_stores_credentials: Boolean(secretValue)
    },
    freshness: {
      update_frequency: "on_request",
      max_data_lag_seconds: 300
    },
    agent_contract: createAgentContract({ capabilities, sampleRequest, sampleData, summary }),
    registration: {
      source_fingerprint: createSourceFingerprint({
        type: "hosted_http",
        provider_id: providerId,
        upstream_url: canonicalizeUrl(upstreamUrl),
        upstream_method: String(upstreamMethod || "POST").toUpperCase()
      }),
      duplicate_policy: "same_provider_source_is_idempotent"
    }
  };

  return {
    provider_config_version: "adn_provider_config_v1",
    source: {
      type: "hosted_http",
      upstream_url: upstreamUrl,
      upstream_method: upstreamMethod,
      auth: {
        mode: secretValue ? "header" : "none",
        header: authHeader,
        secret_name: secretName,
        secret_value: secretValue
      },
      summary
    },
    manifest
  };
}

function inferSourceProvenanceLevel({ upstreamUrl = "", secretValue = "" } = {}) {
  const url = String(upstreamUrl || "").toLowerCase();
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(url)) return "provider_owned";
  if (/api\.|docs\.|data\./.test(url) && secretValue) return "wrapped_api";
  if (/scrap|crawl|html|page/.test(url)) return "scraped";
  return secretValue ? "wrapped_api" : "unknown";
}

function createAgentContract({ capabilities = [], sampleRequest = {}, sampleData = {}, summary = "" }) {
  return {
    contract_version: "agent_data_service_contract_v1",
    capability_tags: capabilities,
    example_questions: exampleQuestionsForCapabilities(capabilities),
    request_shape_summary: summarizeShape(sampleRequest),
    response_shape_summary: summarizeShape(sampleData),
    request_data: requestDataContract(sampleRequest),
    response_data: responseDataContract(sampleData),
    quality_expectations: {
      result_envelope: "agent_data_envelope_v1",
      must_include_metadata: ["data_sources", "generated_at", "freshness_seconds", "confidence", "limitations"],
      preview_paid_shape_should_match: true,
      empty_result_should_be_explicit: true
    },
    routing_hints: {
      good_for: capabilities.filter((capability) => capability !== "data_service").slice(0, 8),
      not_for: []
    },
    summary
  };
}

function requestDataContract(sampleRequest = {}) {
  return {
    purpose: "Use this example before payment to decide whether the service accepts the fields needed for the task.",
    fields: Object.keys(sampleRequest || {}),
    example: sampleRequest || {},
    shape_summary: summarizeShape(sampleRequest)
  };
}

function responseDataContract(sampleData = {}) {
  return {
    purpose: "Use this preview before payment to decide whether the service can return data useful for the task. It is a sample/preview, not a guaranteed paid result.",
    fields: collectFieldPaths(sampleData, 16),
    preview: sampleData || {},
    shape_summary: summarizeShape(sampleData)
  };
}

function schemaFromSample(sample) {
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(sample || {}).map(([key, value]) => [key, schemaForValue(value)])
    )
  };
}

function schemaForValue(value) {
  if (Array.isArray(value)) {
    return { type: "array", items: value.length ? schemaForValue(value[0]) : {} };
  }
  if (value && typeof value === "object") {
    return {
      type: "object",
      properties: Object.fromEntries(Object.entries(value).map(([key, child]) => [key, schemaForValue(child)]))
    };
  }
  if (typeof value === "number") return { type: "number" };
  if (typeof value === "boolean") return { type: "boolean" };
  return { type: "string" };
}

function summarizeShape(value) {
  if (Array.isArray(value)) return `array(${value.length} sample items)`;
  if (value && typeof value === "object") return `object keys: ${Object.keys(value).slice(0, 12).join(", ") || "none"}`;
  return typeof value;
}

function collectFieldPaths(value, limit = 16, prefix = "") {
  if (limit <= 0) return [];
  if (Array.isArray(value)) return value.length ? collectFieldPaths(value[0], limit, prefix) : [];
  if (!value || typeof value !== "object") return [];
  const paths = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    paths.push(path);
    if (paths.length >= limit) break;
    if (child && typeof child === "object") {
      for (const nested of collectFieldPaths(child, limit - paths.length, path)) {
        paths.push(nested);
        if (paths.length >= limit) break;
      }
    }
    if (paths.length >= limit) break;
  }
  return paths;
}

function exampleQuestionsForCapabilities(capabilities = []) {
  if (capabilities.includes("smart_money_netflow")) return ["Query ETH smart money netflow for the latest page.", "查询 ETH 近 24 小时 smart money netflow。"];
  if (capabilities.includes("smart_money_holdings")) return ["Query the first 10 smart money holdings rows.", "查询 smart money holdings 的前 10 条数据。"];
  if (capabilities.includes("perp_liquidation_max_pain")) return ["What is BTC's current liquidation max-pain price?"];
  if (capabilities.includes("fund_flow")) return ["What is the recent fund flow for this chain?"];
  return ["Query this provider data service with the sample request shape."];
}

function createSourceFingerprint(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function canonicalizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    return url.toString();
  } catch {
    return String(rawUrl || "").trim();
  }
}

async function sanitizeProviderConfig(config) {
  const next = structuredClone(config);
  const auth = next.source?.auth;
  if (auth?.secret_value) {
    const secretRef = await writeProviderSecret({
      serviceId: next.manifest.service_id,
      secretName: auth.secret_name || "PROVIDER_SECRET",
      secretValue: auth.secret_value
    });
    auth.secret_ref = secretRef;
    delete auth.secret_value;
  }
  return next;
}

export function createEnvelope({ serviceId, input, data, sampleType, isEstimated, confidence, summary, sourceType = "static_json" }) {
  const now = new Date().toISOString();
  const envelope = {
    schema_version: "agent_data_envelope_v1",
    service_id: serviceId,
    request_id: sampleType ? "sample_req" : `req_${Date.now()}`,
    status: "success",
    query: input || {},
    data,
    metadata: {
      data_sources: [`provider_config_${sourceType}`],
      generated_at: now,
      freshness_seconds: sampleType ? 86400 : 60,
      is_estimated: isEstimated,
      confidence,
      limitations: sampleType ? ["Sample response is mock/static and not a live paid response."] : [`${sourceType} provider for MVP onboarding.`]
    },
    agent_hints: {
      good_for: ["MVP validation", "Agent response parsing"],
      warnings: sampleType ? ["Use paid invocation for the full response."] : [],
      suggested_followups: []
    },
    summary
  };
  if (sampleType) envelope.sample_type = sampleType;
  return envelope;
}
