import { normalizeEndpoint } from "./http-utils.js";
import { normalizeId, suggestCapabilities } from "./id-utils.js";
import { createHostedHttpProviderConfig, writeProviderConfig } from "./provider-config.js";
import { findDuplicateService, registerService, unregisterService, validateService } from "./registry.js";
import { publicServiceRecord } from "./store.js";

const OPENAPI_CANDIDATES = [
  "",
  "/openapi.json",
  "/swagger.json",
  "/.well-known/openapi.json",
  "/api/openapi.json",
  "/api/swagger.json",
  "/api-docs",
  "/api-docs.json",
  "/v3/api-docs",
  "/docs/openapi.json",
  "/docs/swagger.json"
];
const SKIP_PATH_RE = /\/(auth|login|logout|user|users|admin|debug|health|metrics|internal|webhook|reload|refresh|sync)(\/|$)/i;
const DATA_PATH_RE = /(data|market|price|funding|liquidation|wallet|onchain|search|analytics|open-interest|interest|orderbook|sentiment|flow|risk|profile)/i;

export async function discoverApiServices(body, baseUrl) {
  const apiUrl = normalizeEndpoint(requireString(body.api_url, "api_url"), baseUrl).replace(/\/$/, "");
  const defaultPrice = String(body.default_price || "0.01");
  const providerName = body.provider_name || null;
  const secretValue = body.secret_value || "";
  const document = await fetchOpenApiDocument(apiUrl);
  if (document.directEndpoint) {
    const providerTitle = providerName || hostName(apiUrl);
    const providerId = normalizeId(null, providerTitle, "provider");
    const draft = createDirectEndpointDraft({
      apiUrl,
      providerId,
      providerTitle,
      defaultPrice,
      secretValue
    });
    return {
      ok: true,
      mode: "direct_endpoint",
      source: apiUrl,
      api_url: new URL(apiUrl).origin,
      provider: {
        provider_id: providerId,
        provider_name: providerTitle
      },
      drafts: [draft],
      skipped: []
    };
  }
  const upstreamBaseUrl = resolveOpenApiServerUrl(document.doc, document.source, apiUrl);
  const providerTitle = providerName || document.doc.info?.title || hostName(apiUrl);
  const providerId = normalizeId(null, providerTitle, "provider");
  const drafts = [];
  const skipped = [];

  for (const [routePath, pathItem] of Object.entries(document.doc.paths || {})) {
    for (const method of ["get", "post", "put", "patch"]) {
      const operation = pathItem?.[method];
      if (!operation) continue;
      const skipReason = skipReasonFor(routePath, method, operation);
      if (skipReason) {
        skipped.push({ method: method.toUpperCase(), path: routePath, reason: skipReason });
        continue;
      }
      drafts.push(createServiceDraft({
        apiUrl: upstreamBaseUrl,
        routePath,
        method,
        operation,
        pathItem,
        doc: document.doc,
        providerId,
        providerTitle,
        defaultPrice,
        secretValue
      }));
    }
  }

  return {
    ok: true,
    source: document.source,
    api_url: upstreamBaseUrl,
    provider: {
      provider_id: providerId,
      provider_name: providerTitle
    },
    drafts,
    skipped
  };
}

function resolveOpenApiServerUrl(doc, sourceUrl, requestedUrl) {
  const serverUrl = doc.servers?.[0]?.url;
  if (serverUrl) return normalizeEndpoint(serverUrl, sourceUrl).replace(/\/$/, "");
  if (requestedUrl.endsWith(".json")) {
    return new URL(".", sourceUrl).toString().replace(/\/$/, "");
  }
  return requestedUrl.replace(/\/$/, "");
}

export async function publishApiDrafts(body, store, baseUrl) {
  const drafts = Array.isArray(body.drafts) ? body.drafts : [];
  if (!drafts.length) {
    const error = new Error("drafts must include at least one service draft");
    error.statusCode = 422;
    throw error;
  }
  const remoteUrl = normalizedRemoteRegistryUrl(body.remote_registry_url);
  if (shouldPublishToRemote({ body, baseUrl, remoteUrl })) {
    return publishApiDraftsToRemote({ body, remoteUrl });
  }
  return publishApiDraftsLocal(body, store, baseUrl);
}

async function publishApiDraftsLocal(body, store, baseUrl) {
  const drafts = Array.isArray(body.drafts) ? body.drafts : [];
  const published = [];
  const failed = [];
  for (const draft of drafts.filter((item) => item.selected !== false)) {
    try {
      const config = createHostedHttpProviderConfig({
        baseUrl,
        serviceId: draft.service_id,
        providerId: draft.provider_id,
        title: draft.title,
        description: draft.description_for_agent,
        capabilities: draft.capabilities,
        price: draft.price,
        sampleRequest: draft.sample_request,
        sampleData: draft.preview_data,
        upstreamUrl: draft.upstream_url,
        upstreamMethod: draft.method,
        secretName: draft.secret_name || "PROVIDER_SECRET",
        secretValue: draft.secret_value || "",
        authHeader: draft.auth_header || "authorization",
        summary: draft.summary
      });
      const duplicate = store.services.get(config.manifest.service_id) || findDuplicateService(store, config.manifest);
      if (duplicate) {
        const validation = duplicate.validation_runs?.at(-1) || { ok: duplicate.verification_status === "verified" };
        published.push({
          ok: validation.ok === true,
          service_id: duplicate.manifest.service_id,
          requested_service_id: config.manifest.service_id,
          already_registered: true,
          duplicate_reason: duplicate.manifest.service_id === config.manifest.service_id ? "service_id" : "same_provider_source",
          warning: validation.ok === true ? null : "EXISTING_SERVICE_NOT_VERIFIED",
          registration: publicServiceRecord(duplicate),
          validation
        });
        continue;
      }
      const configPath = await writeProviderConfig(config);
      const record = registerService(store, config.manifest, baseUrl);
      const validation = await validateService(store, config.manifest.service_id);
      published.push({
        ok: validation.ok,
        service_id: config.manifest.service_id,
        warning: validation.ok ? null : "VALIDATION_FAILED_SERVICE_REGISTERED_UNVERIFIED",
        provider_config_path: configPath,
        registration: publicServiceRecord(record),
        validation
      });
    } catch (error) {
      const existing = store.services.get(draft.service_id);
      if (existing && /already registered/i.test(error.message)) {
        const validation = existing.validation_runs?.at(-1) || { ok: existing.verification_status === "verified" };
        published.push({
          ok: validation.ok === true,
          service_id: draft.service_id,
          already_registered: true,
          warning: validation.ok === true ? null : "EXISTING_SERVICE_NOT_VERIFIED",
          registration: publicServiceRecord(existing),
          validation
        });
        continue;
      }
      failed.push({
        service_id: draft.service_id,
        error: error.message
      });
    }
  }

  return {
    ok: published.length > 0 && failed.length === 0,
    published,
    failed
  };
}

function shouldPublishToRemote({ body, baseUrl, remoteUrl }) {
  const scope = body.publish_scope || process.env.ADN_PUBLISH_SCOPE || "remote_and_local";
  if (scope === "local_only") return false;
  if (!remoteUrl) return false;
  if (!isLocalBaseUrl(baseUrl)) return false;
  return new URL(remoteUrl).origin !== new URL(baseUrl).origin;
}

function normalizedRemoteRegistryUrl(value) {
  const renderUrl = process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : "";
  const raw = value || process.env.ADN_REMOTE_REGISTRY_URL || process.env.AGENT_ROUTER_PUBLIC_URL || renderUrl || "https://agentrouter-markets.onrender.com";
  if (!raw) return "";
  return normalizeEndpoint(raw, "https://agentrouter.local").replace(/\/$/, "");
}

function isLocalBaseUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

async function publishApiDraftsToRemote({ body, remoteUrl }) {
  const response = await fetch(`${remoteUrl}/studio/import/publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...body,
      publish_scope: "local_only",
      remote_registry_url: undefined
    })
  });
  const payload = await response.json();
  return {
    ...payload,
    ok: response.ok && payload.ok === true,
    remote_registry_url: remoteUrl,
    publish_scope: "remote_and_local",
    remote_status: response.status,
    local_published: false
  };
}

async function fetchOpenApiDocument(apiUrl) {
  const candidates = buildOpenApiCandidates(apiUrl);
  const attempted = [];
  for (const candidate of candidates) {
    try {
      attempted.push(candidate);
      const response = await fetch(candidate);
      if (!response.ok) continue;
      const doc = await response.json();
      if (doc.openapi || doc.swagger) return { source: candidate, doc };
      const converted = convertEndpointIndex(doc, apiUrl);
      if (converted) return { source: candidate, doc: converted };
    } catch {
      // Try the next candidate.
    }
  }
  const error = new Error(`Could not find OpenAPI/Swagger or endpoint index. Tried: ${attempted.join(", ")}`);
  if (looksLikeCallableEndpoint(apiUrl)) return { source: apiUrl, directEndpoint: true };
  error.statusCode = 422;
  throw error;
}

function buildOpenApiCandidates(apiUrl) {
  if (apiUrl.endsWith(".json")) return [apiUrl];
  const normalized = apiUrl.replace(/\/$/, "");
  const url = new URL(normalized);
  const candidates = new Set(OPENAPI_CANDIDATES.map((suffix) => `${normalized}${suffix}`));
  if (url.pathname.endsWith("/api")) {
    const root = `${url.origin}${url.pathname.replace(/\/api$/, "")}`;
    for (const suffix of OPENAPI_CANDIDATES) candidates.add(`${root}${suffix}`);
  }
  return [...candidates];
}

function convertEndpointIndex(doc, apiUrl) {
  const endpoints = Array.isArray(doc) ? doc : doc.endpoints || doc.routes || doc.data_endpoints;
  if (!Array.isArray(endpoints)) return null;
  const paths = {};
  for (const endpoint of endpoints) {
    const path = endpoint.path || endpoint.url || endpoint.endpoint;
    if (!path) continue;
    const method = String(endpoint.method || "GET").toLowerCase();
    paths[path.startsWith("/") ? path : new URL(path, `${apiUrl.replace(/\/$/, "")}/`).pathname] = {
      [method]: {
        operationId: endpoint.operationId || endpoint.id,
        summary: endpoint.title || endpoint.summary || titleFromPath(path, method),
        description: endpoint.description || "",
        parameters: Object.entries(endpoint.params || endpoint.query || {}).map(([name, example]) => ({
          name,
          in: "query",
          schema: { type: typeof example === "number" ? "number" : "string", example }
        })),
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                example: endpoint.example_response || endpoint.preview_data || { ok: true }
              }
            }
          }
        }
      }
    };
  }
  return {
    openapi: "3.0.0",
    info: { title: hostName(apiUrl), version: "generated" },
    paths
  };
}

function createServiceDraft({ apiUrl, routePath, method, operation, pathItem, doc, providerId, providerTitle, defaultPrice, secretValue }) {
  const title = operation.summary || titleFromPath(routePath, method);
  const description = operation.description || `Use this service to call ${method.toUpperCase()} ${routePath} from ${providerTitle}.`;
  const serviceId = normalizeId(operation.operationId, title, "service");
  const upstreamUrl = `${apiUrl.replace(/\/$/, "")}${routePath}`;
  const sampleRequest = sampleRequestFor(operation, pathItem, doc);
  const previewData = previewDataFor(operation, doc);
  const capabilities = suggestCapabilities(`${title} ${description} ${routePath}`);

  return {
    selected: true,
    service_id: serviceId,
    provider_id: providerId,
    provider_name: providerTitle,
    title,
    description_for_agent: description,
    capabilities: capabilities.split(","),
    price: defaultPrice,
    method: method.toUpperCase(),
    path: routePath,
    upstream_url: upstreamUrl,
    auth_header: inferAuthHeader(apiUrl),
    secret_name: inferSecretName(apiUrl),
    secret_value: secretValue,
    sample_request: sampleRequest,
    preview_data: previewData,
    summary: summaryFor(title, previewData)
  };
}

function createDirectEndpointDraft({ apiUrl, providerId, providerTitle, defaultPrice, secretValue }) {
  const url = new URL(apiUrl);
  const routePath = url.pathname;
  const method = inferMethodForEndpoint(apiUrl);
  const title = titleFromPath(routePath, method);
  const description = `Use this service to call ${method.toUpperCase()} ${routePath} from ${providerTitle}.`;
  const sampleRequest = sampleRequestForDirectEndpoint(apiUrl);
  const previewData = previewDataForDirectEndpoint(apiUrl);
  return {
    selected: true,
    service_id: normalizeId(null, title, "service"),
    provider_id: providerId,
    provider_name: providerTitle,
    title,
    description_for_agent: description,
    capabilities: suggestCapabilities(`${title} ${description} ${routePath}`).split(","),
    price: defaultPrice,
    method: method.toUpperCase(),
    path: routePath,
    upstream_url: apiUrl,
    auth_header: inferAuthHeader(apiUrl),
    secret_name: inferSecretName(apiUrl),
    secret_value: secretValue,
    sample_request: sampleRequest,
    preview_data: previewData,
    summary: summaryFor(title, previewData),
    discovery_note: "Generated from a direct API endpoint URL because no OpenAPI/Swagger document was found."
  };
}

function looksLikeCallableEndpoint(apiUrl) {
  try {
    const url = new URL(apiUrl);
    if (/docs?|documentation|gitbook|swagger|openapi/i.test(url.hostname)) return false;
    if (url.pathname.endsWith(".json")) return false;
    if (/\/(docs?|documentation|swagger|openapi)(\/|$)/i.test(url.pathname)) return false;
    return /\/api\/|\/v\d+\//i.test(url.pathname);
  } catch {
    return false;
  }
}

function inferMethodForEndpoint(apiUrl) {
  try {
    const url = new URL(apiUrl);
    if (/\/api\/v\d+\/smart-money\//i.test(url.pathname)) return "post";
  } catch {
    // Use default.
  }
  return "post";
}

function inferAuthHeader(apiUrl) {
  try {
    const url = new URL(apiUrl);
    if (url.hostname.endsWith("nansen.ai") || /\/api\/v\d+\/smart-money\//i.test(url.pathname)) return "apikey";
  } catch {
    // Use default.
  }
  return "authorization";
}

function inferSecretName(apiUrl) {
  try {
    const url = new URL(apiUrl);
    if (url.hostname.endsWith("nansen.ai") || /\/api\/v\d+\/smart-money\//i.test(url.pathname)) return "NANSEN_API_KEY";
  } catch {
    // Use default.
  }
  return "PROVIDER_SECRET";
}

function sampleRequestForDirectEndpoint(apiUrl) {
  try {
    const url = new URL(apiUrl);
    if (/\/api\/v\d+\/smart-money\/dex-trades$/i.test(url.pathname)) {
      return {
        chains: ["ethereum"],
        filters: {
          include_smart_money_labels: ["Fund", "Smart Trader"],
          trade_value_usd: { min: 1000 }
        },
        pagination: { page: 1, per_page: 10 },
        order_by: [{ field: "trade_value_usd", direction: "DESC" }]
      };
    }
    if (/\/api\/v\d+\/smart-money\//i.test(url.pathname)) {
      return {
        chains: ["ethereum"],
        pagination: { page: 1, per_page: 10 }
      };
    }
  } catch {
    // Use generic sample.
  }
  return {};
}

function previewDataForDirectEndpoint(apiUrl) {
  try {
    const url = new URL(apiUrl);
    if (/\/api\/v\d+\/smart-money\/dex-trades$/i.test(url.pathname)) {
      return {
        data: [
          {
            chain: "ethereum",
            block_timestamp: "sample",
            transaction_hash: "0xsample",
            trader_address: "0xsample",
            trader_address_label: "Smart Trader",
            token_bought_symbol: "ETH",
            token_sold_symbol: "USDC",
            trade_value_usd: 1000
          }
        ],
        pagination: { page: 1, per_page: 10, is_last_page: true }
      };
    }
    if (/\/api\/v\d+\/smart-money\//i.test(url.pathname)) {
      return {
        data: [
          {
            chain: "ethereum",
            label: "Smart Trader",
            value_usd: 1000
          }
        ],
        pagination: { page: 1, per_page: 10, is_last_page: true }
      };
    }
  } catch {
    // Use generic sample.
  }
  return { ok: true };
}

function skipReasonFor(routePath, method, operation) {
  if (SKIP_PATH_RE.test(routePath)) return "non-data or operational endpoint";
  if (operation.deprecated) return "deprecated operation";
  const text = `${routePath} ${operation.summary || ""} ${operation.description || ""}`;
  if (method !== "get" && method !== "post") return "non-query HTTP method";
  if (!DATA_PATH_RE.test(text) && method !== "get") return "not clearly a data query endpoint";
  return null;
}

function sampleRequestFor(operation, pathItem, doc) {
  const sample = {};
  for (const parameter of [...(pathItem.parameters || []), ...(operation.parameters || [])]) {
    if (!["query", "path"].includes(parameter.in)) continue;
    sample[parameter.name] = exampleForSchema(parameter.schema, {
      explicitExample: parameter.example,
      name: parameter.name,
      doc
    });
  }
  const bodySchema = operation.requestBody?.content?.["application/json"]?.schema;
  const resolvedBodySchema = resolveSchemaRef(bodySchema, doc);
  if (resolvedBodySchema?.properties) {
    for (const [key, schema] of Object.entries(resolvedBodySchema.properties)) {
      sample[key] = exampleForSchema(schema, {
        explicitExample: schema.example,
        name: key,
        doc
      });
    }
  }
  return sample;
}

function previewDataFor(operation, doc) {
  const response = operation.responses?.["200"] || operation.responses?.["201"] || Object.values(operation.responses || {})[0];
  const json = response?.content?.["application/json"];
  if (json?.example) return json.example;
  const examples = json?.examples;
  if (examples) {
    const first = Object.values(examples)[0];
    if (first?.value) return first.value;
  }
  const schema = json?.schema;
  return exampleObjectForSchema(schema, doc);
}

function exampleObjectForSchema(schema, doc, name = "") {
  schema = resolveSchemaRef(schema, doc);
  if (!schema) return { ok: true };
  if (schema.example) return schema.example;
  if (schema.type === "array") return [exampleObjectForSchema(schema.items, doc, name)];
  if (schema.properties) {
    const output = {};
    for (const [key, child] of Object.entries(schema.properties)) {
      output[key] = exampleForSchema(child, { name: key, doc });
    }
    return output;
  }
  return exampleForSchema(schema, { name, doc });
}

function exampleForSchema(schema = {}, { explicitExample, name = "", doc } = {}) {
  schema = resolveSchemaRef(schema, doc) || {};
  if (explicitExample !== undefined) return explicitExample;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.type === "number" || schema.type === "integer") return 1;
  if (schema.type === "boolean") return true;
  if (schema.type === "array") return [exampleForSchema(schema.items || {}, { name, doc })];
  if (schema.type === "object" || schema.properties) return exampleObjectForSchema(schema, doc, name);
  return sampleStringForName(name || schema.title || "");
}

function resolveSchemaRef(schema, doc) {
  if (!schema?.$ref || !doc) return schema;
  const prefix = "#/components/schemas/";
  if (!schema.$ref.startsWith(prefix)) return schema;
  const name = schema.$ref.slice(prefix.length);
  return doc.components?.schemas?.[name] || schema;
}

function sampleStringForName(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.includes("asset") || lower.includes("symbol")) return "BTC";
  if (lower.includes("chain")) return "base";
  if (lower.includes("window")) return "7d";
  return "example";
}

function titleFromPath(routePath, method) {
  const words = routePath.split("/").filter(Boolean).join(" ").replace(/[-_]/g, " ");
  return `${method.toUpperCase()} ${words}`.trim();
}

function summaryFor(title, previewData) {
  const keys = previewData && typeof previewData === "object" && !Array.isArray(previewData)
    ? Object.keys(previewData).slice(0, 3).join(", ")
    : "data";
  return `${title} returned ${keys}.`;
}

function hostName(apiUrl) {
  try {
    return new URL(apiUrl).hostname;
  } catch {
    return "Imported API";
  }
}

function requireString(value, name) {
  if (!String(value || "").trim()) {
    const error = new Error(`${name} is required`);
    error.statusCode = 422;
    throw error;
  }
  return String(value).trim();
}
