import { normalizeEndpoint } from "./http-utils.js";
import { normalizeId, suggestCapabilities } from "./id-utils.js";
import { createHostedHttpProviderConfig, deleteProviderConfig, writeProviderConfig } from "./provider-config.js";
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
  const defaultMethod = String(body.default_method || "").toUpperCase();
  const providerName = body.provider_name || null;
  const secretValue = body.secret_value || "";
  const authHeader = body.auth_header || "";
  if (looksLikeNansenDocsSource(apiUrl)) {
    return discoverNansenDocsServices({
      docsUrl: apiUrl,
      defaultPrice,
      providerName,
      secretValue,
      authHeader
    });
  }
  if (looksLikeSkillSource(apiUrl)) {
    return discoverSkillServices({
      skillUrl: apiUrl,
      defaultPrice,
      providerName,
      secretValue,
      authHeader
    });
  }
  const document = await fetchOpenApiDocument(apiUrl);
  if (document.directEndpoint) {
    const providerTitle = providerName || hostName(apiUrl);
    const providerId = normalizeId(null, providerTitle, "provider");
    const draft = createDirectEndpointDraft({
      apiUrl,
      providerId,
      providerTitle,
      defaultPrice,
      secretValue,
      defaultMethod,
      authHeader
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
    mode: "openapi",
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

async function discoverNansenDocsServices({ docsUrl, defaultPrice, providerName, secretValue, authHeader }) {
  const overview = await fetchTextDocument(docsUrl);
  const docLinks = parseNansenOverviewLinks(overview.raw, docsUrl);
  if (!docLinks.length) {
    const error = new Error("Nansen docs import failed: no endpoint documentation links were found.");
    error.statusCode = 422;
    throw error;
  }
  const providerTitle = providerName || "Nansen";
  const providerId = normalizeId(null, providerTitle, "provider");
  const endpoints = [];
  const skipped = [];
  for (const link of docLinks) {
    try {
      const page = await fetchTextDocument(link);
      const endpoint = parseNansenEndpointDoc(page.text, link);
      if (!endpoint) {
        skipped.push({ source: link, reason: "no_api_endpoint_found" });
        continue;
      }
      endpoints.push(endpoint);
    } catch (error) {
      skipped.push({ source: link, reason: error.message });
    }
  }
  const deduped = uniqueBy(endpoints, (endpoint) => `${endpoint.method} ${endpoint.path}`);
  const drafts = deduped.map((endpoint) => createNansenEndpointDraft({
    endpoint,
    providerId,
    providerTitle,
    defaultPrice,
    secretValue,
    authHeader,
    docsUrl
  }));
  return {
    ok: true,
    mode: "nansen_docs",
    source: docsUrl,
    api_url: "https://api.nansen.ai",
    provider: {
      provider_id: providerId,
      provider_name: providerTitle
    },
    docs: {
      endpoint_count: drafts.length,
      auth_header: authHeader || "apiKey"
    },
    drafts,
    skipped
  };
}

async function discoverSkillServices({ skillUrl, defaultPrice, providerName, secretValue, authHeader }) {
  const skill = await fetchSkillDocument(skillUrl);
  const parsed = parseSkillDocument(skill.text, skillUrl);
  const upstreamBaseUrl = parsed.baseUrl;
  if (!upstreamBaseUrl) {
    const error = new Error("Skill import failed: no Base URL or API host could be found in the skill document.");
    error.statusCode = 422;
    throw error;
  }
  const providerTitle = providerName || parsed.providerName || hostName(upstreamBaseUrl);
  const providerId = normalizeId(null, providerTitle, "provider");
  const secretHeader = authHeader || parsed.authHeader || (secretValue ? "auto" : inferAuthHeader(upstreamBaseUrl));
  const drafts = parsed.endpoints.map((endpoint) => createSkillEndpointDraft({
    endpoint,
    upstreamBaseUrl,
    providerId,
    providerTitle,
    defaultPrice,
    secretValue,
    authHeader: secretHeader,
    skillUrl,
    skillTitle: parsed.title
  }));
  return {
    ok: true,
    mode: "skill_document",
    source: skill.source,
    api_url: upstreamBaseUrl,
    provider: {
      provider_id: providerId,
      provider_name: providerTitle
    },
    skill: {
      title: parsed.title,
      auth_header: secretHeader,
      endpoint_count: drafts.length
    },
    drafts,
    skipped: parsed.skipped
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
        authHeader: draft.auth_header || (draft.secret_value ? "auto" : "authorization"),
        summary: draft.summary
      });
      const duplicate = store.services.get(config.manifest.service_id) || findDuplicateService(store, config.manifest);
      if (duplicate) {
        const validation = duplicate.validation_runs?.at(-1) || { ok: duplicate.verification_status === "verified" };
        if (validation.ok !== true) {
          failed.push({
            service_id: config.manifest.service_id,
            existing_service_id: duplicate.manifest.service_id,
            error: "EXISTING_SERVICE_NOT_VERIFIED",
            message: "A matching service already exists but is not verified. Fix the endpoint/auth/request body and publish again.",
            validation
          });
          continue;
        }
        published.push({
          ok: true,
          service_id: duplicate.manifest.service_id,
          requested_service_id: config.manifest.service_id,
          already_registered: true,
          duplicate_reason: duplicate.manifest.service_id === config.manifest.service_id ? "service_id" : "same_provider_source",
          warning: null,
          registration: publicServiceRecord(duplicate),
          validation
        });
        continue;
      }
      const configPath = await writeProviderConfig(config);
      const record = registerService(store, config.manifest, baseUrl);
      const validation = await validateService(store, config.manifest.service_id);
      if (!validation.ok) {
        unregisterService(store, config.manifest.service_id);
        await deleteProviderConfig(config.manifest.service_id);
        failed.push({
          service_id: config.manifest.service_id,
          error: "VALIDATION_FAILED",
          message: summarizeValidationFailure(validation),
          validation
        });
        continue;
      }
      published.push({
        ok: true,
        service_id: config.manifest.service_id,
        warning: null,
        provider_config_path: configPath,
        registration: publicServiceRecord(record),
        validation
      });
    } catch (error) {
      const existing = store.services.get(draft.service_id);
      if (existing && /already registered/i.test(error.message)) {
        const validation = existing.validation_runs?.at(-1) || { ok: existing.verification_status === "verified" };
        if (validation.ok !== true) {
          failed.push({
            service_id: draft.service_id,
            error: "EXISTING_SERVICE_NOT_VERIFIED",
            message: "A matching service already exists but is not verified. Fix the endpoint/auth/request body and publish again.",
            validation
          });
          continue;
        }
        published.push({
          ok: true,
          service_id: draft.service_id,
          already_registered: true,
          warning: null,
          registration: publicServiceRecord(existing),
          validation
        });
        continue;
      }
      failed.push({
        service_id: draft.service_id,
        error: error.code || "PUBLISH_ERROR",
        message: error.message
      });
    }
  }

  return {
    ok: published.length > 0 && failed.length === 0,
    published,
    failed
  };
}

function summarizeValidationFailure(validation = {}) {
  const providerCode = validation.provider_error?.code;
  const providerMessage = validation.provider_error?.message;
  if (providerCode === "UPSTREAM_ERROR") {
    const upstream = validation.provider_error?.upstream_payload;
    const upstreamCode = upstream?.code;
    const upstreamReason = upstream?.reason;
    if (upstreamCode === "UPSTREAM_NON_JSON_RESPONSE") {
      return "The endpoint responded, but it did not return JSON. Use a JSON API endpoint or update the URL.";
    }
    if (upstreamReason === "auth_or_permission_error") {
      return "The endpoint rejected authentication. Check the API key and auth header, or leave the header blank so AgentRouter can try common header names.";
    }
    if (upstreamReason === "non_success_status" || upstreamReason === "empty_error_payload") {
      return upstream.message || "The endpoint returned an application-level error instead of usable data.";
    }
    return providerMessage || "The endpoint was reachable, but the upstream API rejected or failed the request.";
  }
  const resultCode = validation.result_errors?.[0]?.code;
  if (resultCode === "RESULT_DATA_EMPTY") return "The endpoint returned empty data. Publish requires one real non-empty result.";
  if (resultCode === "RESULT_DATA_PLACEHOLDER") return "The endpoint returned placeholder data. Publish requires a real result, not a shape-only sample.";
  const schemaMessage = validation.schema_errors?.[0]?.message || validation.envelope_errors?.[0]?.message;
  return schemaMessage || "Service was not registered because validation failed. Confirm the API endpoint, auth, request body, and JSON response shape.";
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
  const serviceId = normalizeId(operation.operationId, title, "service");
  const upstreamUrl = `${apiUrl.replace(/\/$/, "")}${routePath}`;
  const sampleRequest = sampleRequestFor(operation, pathItem, doc);
  const previewData = previewDataFor(operation, doc);
  const description = agentDescription({
    title,
    providerTitle,
    method,
    routePath,
    sampleRequest,
    baseDescription: operation.description
  });
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
    auth_header: secretValue ? "auto" : inferAuthHeader(apiUrl),
    secret_name: inferSecretName(apiUrl),
    secret_value: secretValue,
    sample_request: sampleRequest,
    preview_data: previewData,
    summary: resultSummary({ title, providerTitle, routePath, previewData }),
    data_contract: dataContractFor({ method: method.toUpperCase(), routePath, sampleRequest, previewData })
  };
}

function createDirectEndpointDraft({ apiUrl, providerId, providerTitle, defaultPrice, secretValue, defaultMethod, authHeader }) {
  const url = new URL(apiUrl);
  const routePath = url.pathname;
  const method = defaultMethod || inferMethodForEndpoint(apiUrl);
  const title = titleFromPath(routePath, method);
  const sampleRequest = sampleRequestForDirectEndpoint(apiUrl);
  const previewData = previewDataForDirectEndpoint(apiUrl);
  const description = agentDescription({ title, providerTitle, method, routePath, sampleRequest });
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
    auth_header: authHeader || (secretValue ? "auto" : inferAuthHeader(apiUrl)),
    secret_name: inferSecretName(apiUrl),
    secret_value: secretValue,
    sample_request: sampleRequest,
    preview_data: previewData,
    summary: resultSummary({ title, providerTitle, routePath, previewData }),
    data_contract: dataContractFor({ method: method.toUpperCase(), routePath, sampleRequest, previewData }),
    discovery_note: "Generated from a direct API endpoint URL because no OpenAPI/Swagger document was found."
  };
}

function createSkillEndpointDraft({ endpoint, upstreamBaseUrl, providerId, providerTitle, defaultPrice, secretValue, authHeader, skillUrl, skillTitle }) {
  const method = endpoint.method || "GET";
  const routePath = endpoint.path.startsWith("/") ? endpoint.path : new URL(endpoint.path, `${upstreamBaseUrl}/`).pathname;
  const title = endpoint.title || titleFromPath(routePath, method);
  const sampleRequest = { ...endpoint.params };
  const previewData = endpoint.previewData || { status: 0, message: "", data: { example: true } };
  const description = agentDescription({
    title,
    providerTitle,
    method,
    routePath,
    sampleRequest,
    baseDescription: endpoint.description,
    sourceTitle: skillTitle
  });
  const capabilities = suggestCapabilities(`${title} ${description} ${routePath}`).split(",");
  return {
    selected: true,
    service_id: normalizeId(endpoint.operationId, title, "service"),
    provider_id: providerId,
    provider_name: providerTitle,
    title,
    description_for_agent: description,
    capabilities,
    price: defaultPrice,
    method,
    path: routePath,
    upstream_url: `${upstreamBaseUrl.replace(/\/$/, "")}${routePath}`,
    auth_header: authHeader,
    secret_name: inferSecretName(upstreamBaseUrl),
    secret_value: secretValue,
    sample_request: sampleRequest,
    preview_data: previewData,
    summary: endpoint.summary || resultSummary({ title, providerTitle, routePath, previewData }),
    data_contract: dataContractFor({ method, routePath, sampleRequest, previewData }),
    source_type: "skill_import",
    source_url: skillUrl,
    discovery_note: "Generated from a Skill document. The skill text was parsed statically; publish still requires a real upstream validation call."
  };
}

function createNansenEndpointDraft({ endpoint, providerId, providerTitle, defaultPrice, secretValue, authHeader, docsUrl }) {
  const method = endpoint.method || "POST";
  const sampleRequest = endpoint.sampleRequest || {};
  const previewData = endpoint.previewData || { data: [{ example: true }], pagination: { page: 1, per_page: 10, is_last_page: true } };
  const title = endpoint.title || titleFromPath(endpoint.path, method);
  const description = agentDescription({
    title,
    providerTitle,
    method,
    routePath: endpoint.path,
    sampleRequest,
    baseDescription: endpoint.description,
    sourceTitle: "Nansen API docs"
  });
  return {
    selected: true,
    service_id: normalizeId(null, `nansen ${method} ${endpoint.path}`, "service"),
    provider_id: providerId,
    provider_name: providerTitle,
    title,
    description_for_agent: description,
    capabilities: suggestCapabilities(`${title} ${description} ${endpoint.path} nansen smart money profiler token portfolio hyperliquid`).split(","),
    price: defaultPrice,
    method,
    path: endpoint.path,
    upstream_url: `https://api.nansen.ai${endpoint.path}`,
    auth_header: authHeader || "apiKey",
    secret_name: "NANSEN_API_KEY",
    secret_value: secretValue,
    sample_request: sampleRequest,
    preview_data: previewData,
    summary: endpoint.summary || resultSummary({ title, providerTitle, routePath: endpoint.path, previewData }),
    data_contract: dataContractFor({ method, routePath: endpoint.path, sampleRequest, previewData }),
    source_type: "nansen_docs_import",
    source_url: endpoint.sourceUrl || docsUrl,
    discovery_note: "Generated from Nansen API docs. All Nansen API endpoints use POST requests with JSON bodies and apiKey authentication."
  };
}

function agentDescription({ title, providerTitle, method, routePath, sampleRequest = {}, baseDescription = "", sourceTitle = "" }) {
  const cleanBase = cleanDescription(baseDescription);
  const params = Object.keys(sampleRequest);
  const paramText = params.length
    ? ` Accepts ${params.map((name) => `"${name}"`).join(", ")} as input.`
    : " No input is required for the default request.";
  const sourceText = sourceTitle ? ` Imported from ${sourceTitle}.` : "";
  if (cleanBase && !/^use this service to call/i.test(cleanBase)) {
    return `${cleanBase}${paramText}${sourceText}`;
  }
  return `Returns ${title} data from ${providerTitle} via ${String(method).toUpperCase()} ${routePath}.${paramText}${sourceText}`;
}

function cleanDescription(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^use this service to call\s+/i, "")
    .trim();
}

function dataContractFor({ method, routePath, sampleRequest, previewData }) {
  return {
    request: {
      method: String(method || "GET").toUpperCase(),
      path: routePath,
      example: sampleRequest || {}
    },
    response: {
      content_type: "application/json",
      preview_shape: shapeFor(previewData)
    }
  };
}

function shapeFor(value) {
  if (Array.isArray(value)) return value.length ? [shapeFor(value[0])] : [];
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 12).map(([key, child]) => [key, shapeFor(child)]));
  }
  if (value === null) return "null";
  return typeof value;
}

function looksLikeSkillSource(apiUrl) {
  try {
    const url = new URL(apiUrl);
    return /clawhub\.ai$/i.test(url.hostname) || /skill/i.test(url.pathname);
  } catch {
    return false;
  }
}

function looksLikeNansenDocsSource(apiUrl) {
  try {
    const url = new URL(apiUrl);
    return ((/(^|\.)docs\.nansen\.ai$/i.test(url.hostname) && /^\/api(\/|$)/i.test(url.pathname))
      || url.pathname === "/api/overview");
  } catch {
    return false;
  }
}

async function fetchTextDocument(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error(`${url} returned HTTP ${response.status}`);
    error.statusCode = 422;
    throw error;
  }
  const contentType = response.headers.get("content-type") || "";
  const raw = await response.text();
  return {
    source: url,
    raw,
    text: contentType.includes("html") ? htmlToText(raw) : raw
  };
}

async function fetchSkillDocument(skillUrl) {
  const response = await fetch(skillUrl);
  if (!response.ok) {
    const error = new Error(`Skill import failed: ${skillUrl} returned HTTP ${response.status}`);
    error.statusCode = 422;
    throw error;
  }
  const contentType = response.headers.get("content-type") || "";
  const raw = await response.text();
  const text = contentType.includes("html") ? extractSkillReadmeFromHtml(raw) || htmlToText(raw) : raw;
  return { source: skillUrl, text };
}

function parseSkillDocument(text, skillUrl) {
  const title = extractSkillTitle(text, skillUrl);
  const baseUrl = firstMatch(text, /Base URL\s*:\s*`?(https?:\/\/[^\s`]+)`?/i)
    || firstMatch(text, /(https?:\/\/[a-z0-9.-]+(?:\/[a-z0-9._~:/?#[\]@!$&'()*+,;=%-]*)?)/i)?.replace(/\/v\d+\/.*$/i, "");
  const authHeader = firstMatch(text, /Header\s+`?([A-Za-z0-9_-]+)\s*:\s*\$?[A-Z0-9_]+`?/i)
    || firstMatch(text, /Auth\s*:[^\n]*Header\s+`?([A-Za-z0-9_-]+)\s*:\s*\$?[A-Z0-9_]+`?/i)
    || firstMatch(text, /-H\s+["']([^:"']+)\s*:\s*\$?[A-Z0-9_]+["']/i)
    || "";
  const endpoints = parseSkillEndpoints(text, baseUrl);
  if (!endpoints.length) {
    const cliCommands = detectCliSkillCommands(text);
    const error = new Error(cliCommands.length
      ? `Skill import failed: this is a CLI-based Skill, not an HTTP API Skill. Provider Studio can import HTTP API endpoints, but this Skill runs local commands such as: ${cliCommands.slice(0, 3).join("; ")}. Use an API/OpenAPI URL, or add a CLI adapter before publishing it as a data service.`
      : "Skill import failed: no HTTP API endpoints were found in the skill document.");
    error.statusCode = 422;
    error.code = cliCommands.length ? "CLI_SKILL_NOT_HTTP_API" : "NO_HTTP_ENDPOINTS_IN_SKILL";
    error.validation = cliCommands.length ? { detected_cli_commands: cliCommands.slice(0, 12) } : undefined;
    throw error;
  }
  return {
    title,
    baseUrl: baseUrl ? baseUrl.replace(/\/$/, "") : "",
    providerName: providerNameFromSkill(title, baseUrl),
    authHeader,
    endpoints,
    skipped: []
  };
}

function extractSkillTitle(text, skillUrl) {
  const explicitTitle = firstMatch(text, /\b([A-Z][A-Za-z0-9 ._-]{2,80}\s+API Skill)\b/);
  if (explicitTitle) return cleanEndpointTitle(explicitTitle);
  const headings = [...String(text || "").matchAll(/^#\s+(.+)$/gm)]
    .map((match) => cleanEndpointTitle(match[1]))
    .filter((heading) => heading && !/^\d+\./.test(heading));
  return headings.find((heading) => /api skill|skill/i.test(heading) && !/--/.test(heading))
    || headings.find((heading) => /skill/i.test(heading))
    || headings[0]
    || titleFromSkillUrl(skillUrl);
}

function parseSkillEndpoints(text, baseUrl) {
  const endpoints = new Map();
  for (const endpoint of parseCurlEndpoints(text, baseUrl)) {
    endpoints.set(`${endpoint.method} ${endpoint.path}`, endpoint);
  }
  for (const endpoint of parseReferenceEndpoints(text, baseUrl)) {
    if (!endpoints.has(`${endpoint.method} ${endpoint.path}`)) endpoints.set(`${endpoint.method} ${endpoint.path}`, endpoint);
  }
  for (const endpoint of parseLooseUrlEndpoints(text, baseUrl)) {
    if (!endpoints.has(`${endpoint.method} ${endpoint.path}`)) endpoints.set(`${endpoint.method} ${endpoint.path}`, endpoint);
  }
  for (const endpoint of parseLoosePathEndpoints(text)) {
    if (!endpoints.has(`${endpoint.method} ${endpoint.path}`)) endpoints.set(`${endpoint.method} ${endpoint.path}`, endpoint);
  }
  return [...endpoints.values()].filter((endpoint) => !SKIP_PATH_RE.test(endpoint.path));
}

function detectCliSkillCommands(text) {
  const commands = [];
  const re = /(?:^|\n)\s*([a-z][a-z0-9_-]*(?:\s+[a-z0-9:_./=-]+){1,12})(?:\s|$)/gi;
  let match;
  while ((match = re.exec(String(text || "")))) {
    const command = match[1].trim();
    if (/^(curl|GET|POST|PUT|PATCH)\b/i.test(command)) continue;
    if (!/\b(nansen|python|node|npm|npx|bun|uv|deno|go|cargo|docker)\b/i.test(command)) continue;
    if (!commands.includes(command)) commands.push(command);
  }
  return commands;
}

function parseCurlEndpoints(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const endpoints = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!isCurlUrlLine(lines, index)) continue;
    const url = firstMatch(line, /(https?:\/\/[^\s"'`\\]+)/);
    if (!url || (baseUrl && !url.startsWith(baseUrl))) continue;
    const previous = previousComment(lines, index);
    const nextLines = lines.slice(index + 1, index + 8);
    const params = {};
    for (const next of nextLines) {
      if (/curl\s+-/.test(next) || /https?:\/\//.test(next)) break;
      const param = firstMatch(next, /--data-urlencode\s+["']?([^="'\s]+)=([^"'\s]+)["']?/);
      if (param) {
        const match = next.match(/--data-urlencode\s+["']?([^="'\s]+)=([^"'\s]+)["']?/);
        params[match[1]] = normalizeParamExample(match[2]);
      }
    }
    endpoints.push(endpointFromUrl({
      url,
      method: inferMethodFromCurlContext(line, nextLines),
      title: cleanEndpointTitle(previous) || titleFromPath(new URL(url).pathname, "GET"),
      params,
      description: previous ? cleanEndpointTitle(previous) : ""
    }));
  }
  return endpoints;
}

function isCurlUrlLine(lines, index) {
  const line = lines[index].trim();
  if (/^curl\b/i.test(line)) return true;
  if (/^["']?https?:\/\//i.test(line)) {
    return lines.slice(Math.max(0, index - 4), index).some((previous) => /^curl\b/i.test(previous.trim()));
  }
  return false;
}

function parseReferenceEndpoints(text, baseUrl) {
  const endpoints = [];
  const re = /\b(GET|POST|PUT|PATCH)\s+((?:https?:\/\/[^\s`|"'\\]+)|(?:\/[a-z0-9._~:/?#[\]@!$&'()*+,;=%-]+))/gi;
  let match;
  while ((match = re.exec(text))) {
    const method = match[1].toUpperCase();
    const rawTarget = match[2].replace(/\s+$/, "");
    const parsedTarget = endpointTarget(rawTarget, baseUrl);
    if (!parsedTarget || !looksLikeDataPath(parsedTarget.path)) continue;
    const windowText = text.slice(Math.max(0, match.index - 100), Math.min(text.length, match.index + 180));
    const title = cleanEndpointTitle(firstMatch(windowText, /([A-Za-z0-9 /&()[\]_-]{4,80})\s+`?(?:GET|POST|PUT|PATCH)\s+(?:https?:\/\/|\/)/i)) || titleFromPath(parsedTarget.path, method);
    endpoints.push({
      method,
      path: parsedTarget.path,
      title,
      description: `Use this service to call ${method} ${parsedTarget.path}.`,
      params: paramsFromReferenceWindow(windowText),
      operationId: normalizeId(null, `${method} ${parsedTarget.path}`, "service")
    });
  }
  return endpoints.filter((endpoint) => !baseUrl || endpoint.path);
}

function parseLooseUrlEndpoints(text, baseUrl) {
  if (!baseUrl) return [];
  const endpoints = [];
  const re = /https?:\/\/[^\s`|"'\\)]+/gi;
  let match;
  while ((match = re.exec(text))) {
    const rawUrl = match[0].replace(/[.,;:]+$/g, "");
    if (!rawUrl.startsWith(baseUrl)) continue;
    const parsed = endpointTarget(rawUrl, baseUrl);
    if (!parsed || !looksLikeDataPath(parsed.path)) continue;
    if (parsed.path === "/" || parsed.path === new URL(baseUrl).pathname) continue;
    const windowText = text.slice(Math.max(0, match.index - 120), Math.min(text.length, match.index + 220));
    endpoints.push(endpointFromUrl({
      url: rawUrl,
      method: inferMethodFromTextWindow(windowText),
      title: cleanEndpointTitle(firstMatch(windowText, /(?:^|\n)\s*(?:#+\s*)?([A-Za-z0-9 /&()[\]_-]{4,80})\s*(?:\n|$)/)) || titleFromPath(parsed.path, "GET"),
      params: paramsFromReferenceWindow(windowText),
      description: ""
    }));
  }
  return endpoints;
}

function parseLoosePathEndpoints(text) {
  const endpoints = [];
  const re = /\b(?:endpoint|path|url|route)\s*[:=]\s*`?((?:GET|POST|PUT|PATCH)\s+)?(\/[a-z0-9._~:/?#[\]@!$&'()*+,;=%-]+)`?/gi;
  let match;
  while ((match = re.exec(text))) {
    const method = (match[1] || "GET").trim().toUpperCase() || "GET";
    const path = match[2].replace(/[.,;:]+$/g, "");
    if (!looksLikeDataPath(path)) continue;
    const windowText = text.slice(Math.max(0, match.index - 120), Math.min(text.length, match.index + 220));
    endpoints.push({
      method,
      path,
      title: cleanEndpointTitle(firstMatch(windowText, /(?:name|title|summary)\s*[:=]\s*`?([A-Za-z0-9 /&()[\]_-]{4,80})`?/i)) || titleFromPath(path, method),
      description: `Use this service to call ${method} ${path}.`,
      params: paramsFromReferenceWindow(windowText),
      operationId: normalizeId(null, `${method} ${path}`, "service")
    });
  }
  return endpoints;
}

function endpointTarget(rawTarget, baseUrl) {
  try {
    const parsed = rawTarget.startsWith("http")
      ? new URL(rawTarget)
      : new URL(rawTarget, `${baseUrl || "https://skill.local"}/`);
    const params = {};
    for (const [key, value] of parsed.searchParams.entries()) params[key] = normalizeParamExample(value);
    return { path: parsed.pathname, params };
  } catch {
    return null;
  }
}

function looksLikeDataPath(path) {
  if (!path || path === "/") return false;
  if (SKIP_PATH_RE.test(path)) return false;
  if (/\.(png|jpe?g|gif|svg|css|js|ico|xml|rss|atom|html?)$/i.test(path)) return false;
  if (/\/(docs?|documentation|swagger|openapi|redoc)(\/|$)/i.test(path)) return false;
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) return false;
  return true;
}

function inferMethodFromTextWindow(text) {
  const method = firstMatch(text, /\b(GET|POST|PUT|PATCH)\b/i);
  return method ? method.toUpperCase() : "GET";
}

function endpointFromUrl({ url, method, title, params, description }) {
  const parsed = new URL(url);
  for (const [key, value] of parsed.searchParams.entries()) params[key] = normalizeParamExample(value);
  return {
    method,
    path: parsed.pathname,
    title,
    description: description || `Use this service to call ${method} ${parsed.pathname}.`,
    params,
    operationId: normalizeId(null, `${method} ${parsed.pathname}`, "service")
  };
}

function inferMethodFromCurlContext(_line, nextLines) {
  return nextLines.some((line) => /-X\s+POST|--request\s+POST/i.test(line)) ? "POST" : "GET";
}

function previousComment(lines, index) {
  for (let cursor = index - 1; cursor >= Math.max(0, index - 5); cursor -= 1) {
    const line = lines[cursor].trim();
    const comment = firstMatch(line, /^#\s*(.+)$/);
    if (comment) return comment;
    if (line && !/\\$/.test(line) && !/^curl\b/.test(line) && !/^-/.test(line)) return line;
  }
  return "";
}

function paramsFromReferenceWindow(text) {
  const params = {};
  const snippets = text.match(/`[a-zA-Z0-9_]+=[^`]+`|`[a-zA-Z0-9_]+`/g) || [];
  for (const snippet of snippets) {
    const clean = snippet.replace(/`/g, "");
    if (/^GET |^POST |^\//i.test(clean)) continue;
    if (clean.includes("=")) {
      const [key, value] = clean.split("=");
      params[key] = normalizeParamExample((value || "").split("/")[0]);
    }
  }
  return params;
}

function normalizeParamExample(value) {
  const cleaned = String(value || "").replace(/^\[|\]$/g, "");
  if (/^\d+$/.test(cleaned)) return Number(cleaned);
  if (cleaned.includes("/")) return cleaned.split("/")[0];
  return cleaned || "example";
}

function cleanEndpointTitle(value) {
  return String(value || "")
    .replace(/^\d+\.\s*/, "")
    .replace(/[:：]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d|pre|code|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n");
}

function parseNansenOverviewLinks(html, overviewUrl) {
  const links = new Set();
  const overviewHost = new URL(overviewUrl).hostname;
  const re = /href=["']([^"'#?]+)(?:[#?][^"']*)?["']/gi;
  let match;
  while ((match = re.exec(String(html || "")))) {
    const href = match[1];
    let url;
    try {
      url = new URL(href, overviewUrl);
    } catch {
      continue;
    }
    if (!/(^|\.)docs\.nansen\.ai$/i.test(url.hostname) && url.hostname !== overviewHost) continue;
    if (!/^\/api\//i.test(url.pathname)) continue;
    if (isNansenNonEndpointDocPath(url.pathname)) continue;
    links.add(url.toString().replace(/\/$/, ""));
  }
  return [...links].sort();
}

function isNansenNonEndpointDocPath(pathname) {
  const path = pathname.replace(/\/$/, "");
  if (path === "/api/overview") return true;
  if (/\/api-changelog(\/|$)/i.test(path)) return true;
  const parentDocs = new Set([
    "/api/smart-money",
    "/api/profiler",
    "/api/token-god-mode",
    "/api/hyperliquid",
    "/api/prediction-market"
  ]);
  return parentDocs.has(path);
}

function parseNansenEndpointDoc(text, sourceUrl) {
  const content = String(text || "");
  const title = cleanEndpointTitle(firstMatch(content, /^#\s+(.+)$/m)) || titleFromSkillUrl(sourceUrl);
  const fullUrlMatch = content.match(/https:\/\/api\.nansen\.ai(\/api\/v\d+\/[a-z0-9/_-]+)/i);
  const pathMatch = fullUrlMatch?.[1]
    || firstMatch(content, /\bPOST\s+(\/api\/v\d+\/[a-z0-9/_-]+)\s+HTTP\/1\.1/i)
    || firstMatch(content, /\bpost\s*\n\s*(?:https:\/\/api\.nansen\.ai)?(\/api\/v\d+\/[a-z0-9/_-]+)/i);
  if (!pathMatch) return null;
  const path = pathMatch.replace(/\/$/, "");
  const description = extractNansenDescription(content, title, path);
  const sampleRequest = extractNansenRequestBody(content, path) || nansenFallbackSampleRequest(path);
  const previewData = extractNansenPreviewData(content, path) || { data: [{ example: true }] };
  return {
    method: "POST",
    path,
    title,
    description,
    sampleRequest,
    previewData,
    sourceUrl,
    summary: `${title} via Nansen ${path}.`
  };
}

function extractNansenDescription(content, title, path) {
  const pathIndex = content.indexOf(`https://api.nansen.ai${path}`);
  const afterPath = pathIndex >= 0 ? content.slice(pathIndex + `https://api.nansen.ai${path}`.length) : "";
  const description = afterPath
    .split(/\n(?:Authorizations|Body|Responses|Copy)\b/i)[0]
    .replace(/\s+/g, " ")
    .trim();
  return description || `${title} from Nansen API.`;
}

function extractNansenRequestBody(content, path) {
  const start = content.search(new RegExp(`POST\\s+${escapeRegExp(path)}\\s+HTTP\\/1\\.1`, "i"));
  if (start < 0) return null;
  const firstJson = extractFirstBalancedJson(content.slice(start));
  return firstJson && !Array.isArray(firstJson) ? firstJson : null;
}

function extractNansenPreviewData(content, path) {
  const start = content.search(new RegExp(`POST\\s+${escapeRegExp(path)}\\s+HTTP\\/1\\.1`, "i"));
  if (start < 0) return null;
  const segment = content.slice(start);
  const first = extractFirstBalancedJsonWithEnd(segment);
  if (!first) return null;
  const second = extractFirstBalancedJson(segment.slice(first.end));
  if (!second || Array.isArray(second)) return null;
  if (JSON.stringify(second) === JSON.stringify(first.value)) return null;
  return second;
}

function extractFirstBalancedJson(value) {
  return extractFirstBalancedJsonWithEnd(value)?.value || null;
}

function extractFirstBalancedJsonWithEnd(value) {
  const input = String(value || "");
  const start = input.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < input.length; index += 1) {
    const char = input[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return { value: JSON.parse(input.slice(start, index + 1)), end: index + 1 };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function nansenFallbackSampleRequest(path) {
  if (/smart-money|holdings|netflow|dex-trades|dcas|tgm|token|flows|transfers/i.test(path)) {
    return {
      chains: ["ethereum"],
      pagination: { page: 1, per_page: 10 }
    };
  }
  if (/address|profiler/i.test(path)) {
    return {
      address: "0x0000000000000000000000000000000000000000",
      chain: "ethereum",
      pagination: { page: 1, per_page: 10 }
    };
  }
  if (/agent/i.test(path)) return { query: "Summarize current market activity." };
  return { pagination: { page: 1, per_page: 10 } };
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractSkillReadmeFromHtml(html) {
  const readmeLiteral = extractJsStringProperty(html, "readme");
  if (readmeLiteral) return decodeJsStringLiteral(readmeLiteral);
  const markdownLiteral = extractJsStringProperty(html, "markdown")
    || extractJsStringProperty(html, "content");
  const markdown = markdownLiteral ? decodeJsStringLiteral(markdownLiteral) : "";
  return /Base URL|curl\s+-|GET\s+\//i.test(markdown) ? markdown : "";
}

function extractJsStringProperty(source, propertyName) {
  const input = String(source || "");
  const property = `${propertyName}:`;
  let cursor = input.indexOf(property);
  while (cursor !== -1) {
    cursor += property.length;
    while (/\s/.test(input[cursor] || "")) cursor += 1;
    if (input[cursor] === '"') {
      let end = cursor + 1;
      let escaped = false;
      while (end < input.length) {
        const char = input[end];
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          return input.slice(cursor + 1, end);
        }
        end += 1;
      }
    }
    cursor = input.indexOf(property, cursor);
  }
  return "";
}

function decodeJsStringLiteral(value) {
  const input = String(value || "");
  let output = "";
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char !== "\\") {
      output += char;
      continue;
    }
    const next = input[++index];
    if (next === "n") output += "\n";
    else if (next === "r") output += "\r";
    else if (next === "t") output += "\t";
    else if (next === "b") output += "\b";
    else if (next === "f") output += "\f";
    else if (next === "v") output += "\v";
    else if (next === "0") output += "\0";
    else if (next === "x") {
      const hex = input.slice(index + 1, index + 3);
      output += /^[0-9a-f]{2}$/i.test(hex) ? String.fromCharCode(parseInt(hex, 16)) : `\\x${hex}`;
      if (/^[0-9a-f]{2}$/i.test(hex)) index += 2;
    } else if (next === "u") {
      const hex = input.slice(index + 1, index + 5);
      output += /^[0-9a-f]{4}$/i.test(hex) ? String.fromCharCode(parseInt(hex, 16)) : `\\u${hex}`;
      if (/^[0-9a-f]{4}$/i.test(hex)) index += 4;
    } else {
      output += next || "";
    }
  }
  return output;
}

function firstMatch(value, re) {
  const match = String(value || "").match(re);
  return match?.[1] || "";
}

function titleFromSkillUrl(skillUrl) {
  try {
    const path = new URL(skillUrl).pathname.split("/").filter(Boolean).at(-1) || "Imported Skill";
    return path.replace(/[-_]+/g, " ");
  } catch {
    return "Imported Skill";
  }
}

function providerNameFromSkill(title, baseUrl) {
  if (/blockbeats/i.test(title)) return "BlockBeats";
  return baseUrl ? hostName(baseUrl) : title || "Imported Skill Provider";
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
  return "post";
}

function inferAuthHeader(_apiUrl) {
  return "authorization";
}

function inferSecretName(_apiUrl) {
  return "PROVIDER_SECRET";
}

function sampleRequestForDirectEndpoint(_apiUrl) {
  return {};
}

function previewDataForDirectEndpoint(_apiUrl) {
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

function resultSummary({ title, providerTitle, routePath, previewData }) {
  const keys = previewData && typeof previewData === "object" && !Array.isArray(previewData)
    ? Object.keys(previewData).slice(0, 4).filter(Boolean)
    : [];
  const keyText = keys.length ? ` Fields include ${keys.join(", ")}.` : "";
  return `${title} from ${providerTitle} (${routePath}).${keyText}`;
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
