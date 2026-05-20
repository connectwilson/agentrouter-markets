import { normalizeEndpoint, parseCapabilities, parseMaybeJson } from "./http-utils.js";
import { normalizeId, suggestCapabilities } from "./id-utils.js";
import { createHostedHttpProviderConfig, createStaticProviderConfig, writeProviderConfig } from "./provider-config.js";
import { findDuplicateService, registerService, unregisterService, validateService } from "./registry.js";
import { publicServiceRecord } from "./store.js";

export async function createProviderFromStudio(body, store, baseUrl) {
  const serviceId = normalizeId(body.service_id, body.title, "service");
  const providerId = normalizeId(body.provider_id, body.provider_name || body.title, "provider");
  const normalizedBody = {
    ...body,
    service_id: serviceId,
    provider_id: providerId
  };
  validateStudioInput(normalizedBody, store);
  const mode = normalizedBody.mode || "static-json";
  const common = {
    baseUrl,
    serviceId,
    providerId,
    title: normalizedBody.title,
    description: normalizedBody.description_for_agent,
    capabilities: parseCapabilities(normalizedBody.capabilities || suggestCapabilities(`${normalizedBody.title} ${normalizedBody.description_for_agent}`)),
    price: normalizedBody.price,
    sampleRequest: parseMaybeJson(normalizedBody.sample_request, "sample_request"),
    sampleData: parseMaybeJson(normalizedBody.sample_data, "sample_data"),
    summary: normalizedBody.summary
  };
  const config = mode === "hosted-http"
    ? createHostedHttpProviderConfig({
      ...common,
      upstreamUrl: normalizeEndpoint(normalizedBody.upstream_url, baseUrl),
      upstreamMethod: normalizedBody.upstream_method || "POST",
      secretName: normalizedBody.secret_name || "PROVIDER_SECRET",
      secretValue: normalizedBody.secret_value || "",
      authHeader: normalizedBody.auth_header || "authorization"
    })
    : createStaticProviderConfig({
      ...common,
      liveData: parseMaybeJson(normalizedBody.live_data, "live_data")
    });

  const duplicate = findDuplicateService(store, config.manifest);
  if (duplicate) {
    const verified = duplicate.verification_status === "verified";
    const error = new Error(verified
      ? `This provider source is already verified and routable as ${duplicate.manifest.service_id}`
      : `This provider source already exists as ${duplicate.manifest.service_id}, but it is not verified`);
    error.statusCode = 409;
    error.code = verified ? "SERVICE_SOURCE_ALREADY_REGISTERED" : "SERVICE_SOURCE_NOT_VERIFIED";
    error.existing_service_id = duplicate.manifest.service_id;
    throw error;
  }

  const configPath = await writeProviderConfig(config);
  const record = registerService(store, config.manifest, baseUrl);
  const validation = await validateService(store, config.manifest.service_id);
  if (!validation.ok) {
    unregisterService(store, config.manifest.service_id);
  }
  return {
    ok: validation.ok,
    service_id: config.manifest.service_id,
    provider_config_path: configPath,
    endpoint: config.manifest.endpoint.url,
    registration: publicServiceRecord(record),
    validation,
    manifest: config.manifest,
    next_steps: [
      `node bin/adn.js search "${config.manifest.title}"`,
      `node bin/adn.js preview ${config.manifest.service_id}`,
      `node bin/adn.js wallet init`,
      `node bin/adn.js invoke ${config.manifest.service_id} '${JSON.stringify(config.manifest.sample_request)}'`
    ]
  };
}

function validateStudioInput(body, store) {
  const errors = [];
  const required = ["title", "description_for_agent", "price", "sample_request", "sample_data", "summary"];
  for (const key of required) {
    if (!String(body[key] || "").trim()) errors.push(`${key} is required`);
  }
  if (body.service_id && !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(body.service_id)) {
    errors.push("service_id must be 3-64 chars and use lowercase letters, numbers, _ or -");
  }
  if (body.price && !(Number(body.price) > 0)) {
    errors.push("price must be positive");
  }
  if (store.services.has(body.service_id)) {
    errors.push(`service_id ${body.service_id} is already registered`);
  }
  if ((body.mode || "static-json") === "hosted-http" && !String(body.upstream_url || "").trim()) {
    errors.push("upstream_url is required for hosted-http");
  }
  if (errors.length) {
    const error = new Error(errors.join("; "));
    error.statusCode = 422;
    error.code = "INVALID_STUDIO_INPUT";
    throw error;
  }
}

export function studioHtml({ draft } = {}) {
  const formDefaults = defaultsFromDraft(draft);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ADN Provider Studio</title>
  <style>
    :root { color-scheme: light; --ink:#17201a; --muted:#5d695f; --line:#d8ded7; --panel:#ffffff; --bg:#f6f4ef; --accent:#0f766e; --accent2:#6d5dfc; --bad:#b42318; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--ink); }
    header { padding: 28px 32px 18px; border-bottom: 1px solid var(--line); background: #fbfaf6; }
    h1 { margin: 0 0 6px; font-size: 28px; letter-spacing: 0; }
    p { margin: 0; color: var(--muted); line-height: 1.5; }
    main { display: grid; grid-template-columns: minmax(420px, 0.95fr) minmax(360px, 1.05fr); gap: 20px; padding: 22px 32px 32px; align-items: start; }
    form, .output { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px; }
    fieldset { border: 0; padding: 0; margin: 0 0 18px; }
    legend { font-weight: 700; margin-bottom: 10px; }
    label { display: grid; gap: 6px; margin-bottom: 12px; font-size: 13px; font-weight: 650; color: #28332b; }
    input, select, textarea { width: 100%; border: 1px solid var(--line); border-radius: 6px; padding: 10px 11px; font: inherit; background: #fff; color: var(--ink); }
    input.invalid, textarea.invalid, select.invalid { border-color: var(--bad); box-shadow: 0 0 0 2px #ffe1de; }
    input[readonly] { background: #f6f8f5; color: var(--muted); }
    textarea { min-height: 86px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.45; }
    code, .code-preview { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .code-preview { display: block; margin: 8px 0 14px; white-space: pre-wrap; word-break: break-word; background: #111814; color: #edf8f0; border-radius: 8px; padding: 12px; font-size: 12px; line-height: 1.45; max-height: 260px; overflow: auto; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    details { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #fbfcfa; margin-bottom: 18px; }
    summary { cursor: pointer; font-weight: 700; }
    details .grid { margin-top: 12px; }
    .actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    button { border: 0; border-radius: 6px; padding: 10px 14px; font: inherit; font-weight: 700; cursor: pointer; background: var(--accent); color: white; }
    button.secondary { background: #e7e8ff; color: #23205f; }
    button.ghost { background: #edf2ef; color: #29372f; }
    button:disabled, input:disabled { opacity: 0.55; cursor: not-allowed; }
    pre { margin: 12px 0 0; white-space: pre-wrap; word-break: break-word; background: #111814; color: #edf8f0; border-radius: 8px; padding: 14px; max-height: 360px; overflow: auto; font-size: 12px; line-height: 1.45; }
    .hint { font-size: 12px; color: var(--muted); font-weight: 500; }
    .section-note { margin: -4px 0 14px; font-size: 12px; color: var(--muted); }
    .hidden { display: none; }
    .status { margin-left: auto; font-size: 13px; color: var(--muted); }
    .error { color: var(--bad); }
    .notice { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin: 12px 0; font-size: 13px; color: var(--muted); background: #fbfcfa; }
    .notice.success { border-color: #9bc9b8; color: #173d2f; background: #f2faf6; }
    .notice.error { border-color: #efb3ad; color: var(--bad); background: #fff6f5; }
    .confirm-panel { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 14px; }
    .confirm-panel button { width: 100%; }
    .divider { height: 1px; background: var(--line); margin: 20px 0; }
    .draft-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 10px 0 4px; }
    .draft-list { display: grid; gap: 8px; margin: 12px 0; }
    .draft-row { display: grid; grid-template-columns: 28px minmax(0, 1fr) 110px 112px; gap: 10px; align-items: start; border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: #fff; }
    .draft-row.selected { border-color: #81b7a7; background: #f4fbf8; }
    .draft-row.published { border-color: #cbd8d1; background: #f5f7f5; opacity: 0.78; }
    .draft-row input[type="checkbox"] { width: 18px; height: 18px; margin-top: 4px; }
    .draft-title { font-weight: 750; }
    .draft-meta { color: var(--muted); font-size: 12px; margin-top: 2px; overflow-wrap: anywhere; }
    .draft-price input { padding: 8px; }
    .mini-button { padding: 8px 10px; font-size: 12px; background: #29372f; align-self: center; }
    .tiny-button { padding: 7px 9px; font-size: 12px; background: #edf2ef; color: #29372f; }
    .draft-badge { display: inline-flex; margin-top: 6px; border: 1px solid #bfd9cf; border-radius: 999px; padding: 2px 7px; font-size: 11px; color: #174235; background: #ffffff; }
    .flow-note { border-left: 3px solid var(--accent); padding: 8px 10px; background: #f1f8f5; border-radius: 0 6px 6px 0; margin: 10px 0 12px; }
    .side-grid { display: grid; gap: 12px; margin-top: 12px; }
    .side-card { border: 1px solid var(--line); background: #fbfcfa; border-radius: 8px; padding: 12px; }
    .side-card h3 { margin: 0 0 8px; font-size: 15px; }
    .check-list { display: grid; gap: 7px; font-size: 13px; }
    .check-item { display: flex; gap: 8px; align-items: center; color: var(--muted); }
    .check-item.done { color: #173d2f; font-weight: 650; }
    .pill-row { display: flex; flex-wrap: wrap; gap: 6px; }
    .pill { border: 1px solid #cbd8d1; background: #fff; border-radius: 999px; padding: 4px 8px; font-size: 12px; color: #34443a; }
    .kv { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 6px 10px; font-size: 13px; }
    .kv div:nth-child(odd) { color: var(--muted); }
    .kv div:nth-child(even) { overflow-wrap: anywhere; font-weight: 650; }
    @media (max-width: 900px) { main { grid-template-columns: 1fr; padding: 16px; } header { padding: 22px 16px 14px; } .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>ADN Provider Studio</h1>
    <p>Connect an existing data API, review the discovered endpoints, and publish them as Agent-callable paid services.</p>
  </header>
  <main>
    <form id="provider-form">
      <fieldset>
        <legend>1. Import API</legend>
        <p class="section-note">Paste an OpenAPI/Swagger URL or an API base URL. Studio will find data endpoints and make publishable service cards.</p>
        <label>API or OpenAPI URL
          <input name="import_api_url" value="/mock/api" />
        </label>
        <label>Default price per call (USDC)
          <input name="import_default_price" value="0.01" />
        </label>
        <details>
          <summary>Optional endpoint authentication</summary>
          <p class="hint">Use this only when your own endpoint requires a token. It is stored locally as a Provider Secret.</p>
          <label>Access Token / Secret
            <input name="import_secret_value" value="" />
          </label>
        </details>
        <div class="actions">
          <button type="button" class="secondary" id="discover-api">Discover Endpoints</button>
          <button type="button" class="ghost" id="publish-drafts">Publish Selected</button>
          <span class="status" id="status"></span>
        </div>
        <div class="draft-toolbar hidden" id="draft-toolbar">
          <button type="button" class="tiny-button" id="select-all-drafts">Select All</button>
          <button type="button" class="tiny-button" id="clear-drafts">Clear Selection</button>
          <span class="hint" id="selected-drafts-status">0 selected</span>
        </div>
        <p class="flow-note">Checked endpoint cards are published together by <strong>Publish Selected</strong>. <strong>Edit Details</strong> fills the single-service form below for one endpoint only.</p>
        <p class="hint" id="import-status">Discovery supports OpenAPI/Swagger URLs and simple endpoint-index JSON.</p>
        <div id="draft-list" class="draft-list"></div>
        <details>
          <summary>Developer debug JSON</summary>
          <label>Raw Drafts
            <textarea id="import-drafts" spellcheck="false">[]</textarea>
          </label>
        </details>
        <div class="divider"></div>
      </fieldset>
      <details id="service-editor" class="editor-details">
        <summary>Manual single-service editor</summary>
        <p class="section-note">Use this only for pasted JSON data or when one discovered endpoint needs manual adjustment.</p>
        <fieldset>
          <legend>2. Service</legend>
          <div class="grid">
            <label>Data Source
              <select name="mode" id="mode">
                <option value="static-json">Pasted JSON result</option>
                <option value="hosted-http" ${formDefaults.mode === "hosted-http" ? "selected" : ""}>HTTP API endpoint</option>
              </select>
            </label>
            <label>Price per call (USDC)
              <input name="price" value="${html(formDefaults.price)}" />
            </label>
          </div>
          <label>Service name
            <input name="title" value="${html(formDefaults.title)}" />
          </label>
          <label>Provider Name
            <input name="provider_name" value="${html(formDefaults.providerName)}" />
          </label>
          <label>What this service gives the buyer Agent
            <textarea name="description_for_agent">${html(formDefaults.description)}</textarea>
          </label>
        </fieldset>
        <details>
          <summary>Advanced routing metadata</summary>
          <p class="hint">The router uses these tags and IDs to match services. They are generated from your title and description unless you edit them.</p>
          <label>Capability Tags <span class="hint">comma separated</span>
            <input name="capabilities" value="${html(formDefaults.capabilities)}" />
          </label>
          <div class="grid">
            <label>Service ID
              <input name="service_id" value="${html(formDefaults.serviceId)}" />
            </label>
            <label>Provider ID
              <input name="provider_id" value="${html(formDefaults.providerId)}" />
            </label>
          </div>
        </details>
        <fieldset>
          <legend>3. Data Contract</legend>
          <label>Example input JSON
            <textarea name="sample_request">${html(formDefaults.sampleRequest)}</textarea>
          </label>
          <label id="live-data-label" class="${formDefaults.mode === "hosted-http" ? "hidden" : ""}">Paid result JSON
            <textarea name="live_data">${html(formDefaults.liveData)}</textarea>
            <span class="hint">For pasted-data services only. This is the full result returned after payment.</span>
          </label>
          <input type="hidden" name="sample_data" value="${html(formDefaults.sampleData)}" />
          <details id="preview-settings" open>
            <summary>Free preview shown before payment</summary>
            <p class="hint">Generated from the API schema or pasted result. It is read-only here so providers do not accidentally publish a mismatched shape.</p>
            <code class="code-preview" id="preview-data-view">${html(formDefaults.sampleData)}</code>
          </details>
          <label>One-line result summary
            <input name="summary" value="${html(formDefaults.summary)}" />
          </label>
          <details>
            <summary>Agent envelope preview</summary>
            <p class="hint">This is the normalized response wrapper buyer Agents receive. It is generated automatically.</p>
            <code class="code-preview" id="envelope-preview"></code>
          </details>
        </fieldset>
        <fieldset id="hosted-http-fields" class="${formDefaults.mode === "hosted-http" ? "" : "hidden"}">
          <legend>4. Endpoint</legend>
          <label>Endpoint URL
            <input name="upstream_url" value="${html(formDefaults.upstreamUrl)}" />
          </label>
          <label>Endpoint token <span class="hint">optional</span>
            <input name="secret_value" value="${html(formDefaults.secretValue)}" />
          </label>
          <details>
            <summary>Advanced endpoint settings</summary>
            <div class="grid">
              <label>HTTP Method
                <input name="upstream_method" value="${html(formDefaults.upstreamMethod)}" />
              </label>
              <label>Auth Header
                <input name="auth_header" value="${html(formDefaults.authHeader)}" />
              </label>
            </div>
            <label>Secret Reference Name
              <input name="secret_name" value="${html(formDefaults.secretName)}" />
            </label>
          </details>
          <p class="hint">Tokens are encrypted into the local Provider Secret store; manifests only keep a secret reference.</p>
        </fieldset>
      </details>
      <details>
        <summary>Demo helper</summary>
        <button type="button" class="secondary" id="fill-hosted">Load hosted demo</button>
      </details>
    </form>
    <section class="output">
      <h2>Live Preview</h2>
      <p>Review what will be published and what buyer Agents will see.</p>
      <div id="side-panel" class="side-grid"></div>
      <div class="confirm-panel">
        <button type="submit" form="provider-form" id="publish-service" disabled>Create, Register, Validate</button>
        <div id="form-message" class="notice hidden"></div>
      </div>
      <details>
        <summary>Raw response</summary>
        <pre id="result">Submit the form to create a provider service.</pre>
      </details>
    </section>
  </main>
  <script>
  (() => {
  try {
    const form = document.querySelector("#provider-form");
    const serviceEditor = document.querySelector("#service-editor");
    const mode = document.querySelector("#mode");
    const hostedFields = document.querySelector("#hosted-http-fields");
    const liveDataLabel = document.querySelector("#live-data-label");
    const result = document.querySelector("#result");
    const sidePanel = document.querySelector("#side-panel");
    const status = document.querySelector("#status");
    const formMessage = document.querySelector("#form-message");
    const publishService = document.querySelector("#publish-service");
    const fillHosted = document.querySelector("#fill-hosted");
    const discoverApi = document.querySelector("#discover-api");
    const publishDrafts = document.querySelector("#publish-drafts");
    const importDrafts = document.querySelector("#import-drafts");
    const draftList = document.querySelector("#draft-list");
    const draftToolbar = document.querySelector("#draft-toolbar");
    const selectAllDrafts = document.querySelector("#select-all-drafts");
    const clearDrafts = document.querySelector("#clear-drafts");
    const selectedDraftsStatus = document.querySelector("#selected-drafts-status");
    const importStatus = document.querySelector("#import-status");
    const importApiUrl = form.elements.namedItem("import_api_url");
    const importDefaultPrice = form.elements.namedItem("import_default_price");
    const importSecretValue = form.elements.namedItem("import_secret_value");
    let discoveredDrafts = [];
    let lastImportMeta = null;
    const publishedServiceIds = new Set();
    let singleServiceReady = false;
    const previewSettings = document.querySelector("#preview-settings");
    const previewDataView = document.querySelector("#preview-data-view");
    const envelopePreview = document.querySelector("#envelope-preview");
    const titleInput = form.elements.namedItem("title");
    const providerNameInput = form.elements.namedItem("provider_name");
    const descriptionInput = form.elements.namedItem("description_for_agent");
    const serviceIdInput = form.elements.namedItem("service_id");
    const providerIdInput = form.elements.namedItem("provider_id");
    const capabilitiesInput = form.elements.namedItem("capabilities");
    const liveDataInput = form.elements.namedItem("live_data");
    const sampleDataInput = form.elements.namedItem("sample_data");
    const sampleRequestInput = form.elements.namedItem("sample_request");
    const summaryInput = form.elements.namedItem("summary");
    const upstreamUrlInput = form.elements.namedItem("upstream_url");
    const secretValueInput = form.elements.namedItem("secret_value");
    const upstreamMethodInput = form.elements.namedItem("upstream_method");
    const authHeaderInput = form.elements.namedItem("auth_header");
    const secretNameInput = form.elements.namedItem("secret_name");
    const priceInput = form.elements.namedItem("price");
    let serviceIdTouched = false;
    let providerIdTouched = false;

    function slugify(value, prefix) {
      const base = String(value || prefix)
        .trim()
        .toLowerCase()
        .replace(/['"]/g, "")
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .replace(/_{2,}/g, "_")
        .slice(0, 56);
      const normalized = base || prefix;
      return normalized.length >= 3 ? normalized : prefix + "_" + normalized;
    }

    function syncGeneratedIds() {
      if (!serviceIdTouched) serviceIdInput.value = slugify(titleInput.value, "service");
      if (!providerIdTouched) providerIdInput.value = slugify(providerNameInput.value, "provider");
      if (!capabilitiesInput.dataset.touched) capabilitiesInput.value = suggestCapabilities(titleInput.value + " " + descriptionInput.value);
      syncPreviewData();
      syncEnvelopePreview();
      updateSidePanel();
    }

    function showNotice(target, message, type = "") {
      if (!target) return;
      target.textContent = message;
      target.classList.remove("hidden", "success", "error");
      if (type) target.classList.add(type);
    }

    function hideNotice(target) {
      if (!target) return;
      target.textContent = "";
      target.classList.add("hidden");
      target.classList.remove("success", "error");
    }

    function markInvalid(field, invalid) {
      if (!field) return;
      field.classList.toggle("invalid", Boolean(invalid));
    }

    function validateJsonField(field, label, { required = true, objectOnly = false } = {}) {
      const value = String(field?.value || "").trim();
      if (!value) return required ? label + " is required." : null;
      try {
        const parsed = JSON.parse(value);
        if (objectOnly && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) {
          return label + " must be a JSON object.";
        }
        return null;
      } catch (error) {
        return label + " is not valid JSON: " + error.message;
      }
    }

    function validateSingleServiceForm() {
      const fields = [
        titleInput,
        providerNameInput,
        descriptionInput,
        priceInput,
        sampleRequestInput,
        summaryInput,
        upstreamUrlInput,
        liveDataInput,
        serviceIdInput,
        providerIdInput
      ];
      fields.forEach((field) => markInvalid(field, false));
      const errors = [];
      const requiredText = [
        [titleInput, "Service name"],
        [providerNameInput, "Provider name"],
        [descriptionInput, "What this service gives the buyer Agent"],
        [summaryInput, "One-line result summary"]
      ];
      for (const [field, label] of requiredText) {
        if (!String(field.value || "").trim()) {
          errors.push(label + " is required.");
          markInvalid(field, true);
        }
      }
      const price = Number(priceInput.value);
      if (!(price > 0)) {
        errors.push("Price per call must be greater than 0.");
        markInvalid(priceInput, true);
      }
      const sampleError = validateJsonField(sampleRequestInput, "Example input JSON", { objectOnly: true });
      if (sampleError) {
        errors.push(sampleError);
        markInvalid(sampleRequestInput, true);
      }
      const sampleDataError = validateJsonField(sampleDataInput, "Free preview data", { required: true });
      if (sampleDataError) errors.push(sampleDataError);
      if (mode.value === "hosted-http") {
        if (!String(upstreamUrlInput.value || "").trim()) {
          errors.push("Endpoint URL is required for HTTP API services.");
          markInvalid(upstreamUrlInput, true);
        }
      } else {
        const liveError = validateJsonField(liveDataInput, "Paid result JSON", { required: true });
        if (liveError) {
          errors.push(liveError);
          markInvalid(liveDataInput, true);
        }
      }
      if (serviceIdInput.value && !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(serviceIdInput.value)) {
        errors.push("Service ID must be 3-64 chars and use lowercase letters, numbers, _ or -.");
        markInvalid(serviceIdInput, true);
      }
      if (providerIdInput.value && !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(providerIdInput.value)) {
        errors.push("Provider ID must be 3-64 chars and use lowercase letters, numbers, _ or -.");
        markInvalid(providerIdInput, true);
      }
      return errors;
    }

    function validateImportForm() {
      markInvalid(importApiUrl, false);
      markInvalid(importDefaultPrice, false);
      const errors = [];
      if (!String(importApiUrl.value || "").trim()) {
        errors.push("API or OpenAPI URL is required.");
        markInvalid(importApiUrl, true);
      }
      if (!(Number(importDefaultPrice.value) > 0)) {
        errors.push("Default price per call must be greater than 0.");
        markInvalid(importDefaultPrice, true);
      }
      return errors;
    }

    function userFacingError(payload, fallback = "Publish failed. Check the fields above and try again.") {
      const message = payload?.error?.message || fallback;
      if (message.includes("already registered")) {
        return "This service has already been published. Use the existing published card, or change the Service ID under Advanced routing metadata if you want to publish a separate copy.";
      }
      if (message.includes("sample_request")) return "Example input JSON is missing or invalid.";
      if (message.includes("sample_data")) return "Free preview data is missing or invalid.";
      if (message.includes("upstream_url")) return "Endpoint URL is required for HTTP API services.";
      return message;
    }

    function setSingleServiceReady(ready, message = "") {
      singleServiceReady = Boolean(ready);
      publishService.disabled = !singleServiceReady;
      if (message) showNotice(formMessage, message, ready ? "" : "error");
    }
    function suggestCapabilities(value) {
      const lower = String(value || "").toLowerCase();
      const tags = new Set(["data_service"]);
      if (/sentiment|情绪|社媒|social/.test(lower)) tags.add("sentiment_data");
      if (/fund flow|资金流|inflow|outflow|链上|onchain/.test(lower)) {
        tags.add("onchain_data");
        tags.add("fund_flow");
      }
      if (/liquidation|爆仓|清算|perp|永续|合约/.test(lower)) {
        tags.add("crypto_derivatives");
        tags.add("perp_liquidation_max_pain");
      }
      if (/price|价格|ticker|行情/.test(lower)) tags.add("market_data");
      if (/wallet|address|地址/.test(lower)) tags.add("wallet_profile");
      return Array.from(tags).join(",");
    }
    titleInput.addEventListener("input", () => { markInvalid(titleInput, false); syncGeneratedIds(); });
    providerNameInput.addEventListener("input", () => { markInvalid(providerNameInput, false); syncGeneratedIds(); });
    descriptionInput.addEventListener("input", () => { markInvalid(descriptionInput, false); syncGeneratedIds(); });
    priceInput.addEventListener("input", () => markInvalid(priceInput, false));
    importApiUrl.addEventListener("input", () => markInvalid(importApiUrl, false));
    importDefaultPrice.addEventListener("input", () => markInvalid(importDefaultPrice, false));
    serviceIdInput.addEventListener("input", () => { serviceIdTouched = true; markInvalid(serviceIdInput, false); });
    providerIdInput.addEventListener("input", () => { providerIdTouched = true; markInvalid(providerIdInput, false); });
    capabilitiesInput.addEventListener("input", () => { capabilitiesInput.dataset.touched = "true"; });
    liveDataInput.addEventListener("input", () => {
      markInvalid(liveDataInput, false);
      syncPreviewData();
      syncEnvelopePreview();
    });
    sampleRequestInput.addEventListener("input", () => { markInvalid(sampleRequestInput, false); syncEnvelopePreview(); });
    summaryInput.addEventListener("input", () => { markInvalid(summaryInput, false); syncEnvelopePreview(); });
    upstreamUrlInput.addEventListener("input", () => markInvalid(upstreamUrlInput, false));
    serviceEditor.addEventListener("toggle", () => {
      if (serviceEditor.open && !singleServiceReady) {
        setSingleServiceReady(true, "Manual editor enabled. Review the fields, then confirm on the right.");
      }
    });
    previewSettings.addEventListener("toggle", syncPreviewData);
    syncGeneratedIds();

    discoverApi.addEventListener("click", async (event) => {
      event.preventDefault();
      hideNotice(formMessage);
      const importErrors = validateImportForm();
      if (importErrors.length) {
        importStatus.textContent = importErrors.join(" ");
        importStatus.classList.add("error");
        status.textContent = "Check import fields";
        status.classList.add("error");
        return;
      }
      status.textContent = "Discovering endpoints...";
      status.classList.remove("error");
      importStatus.textContent = "Discovering endpoints from " + importApiUrl.value + "...";
      importStatus.classList.remove("error");
      draftList.innerHTML = '<p class="hint">Discovering...</p>';
      try {
        const response = await fetch("/studio/import/discover", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            api_url: importApiUrl.value,
            default_price: importDefaultPrice.value,
            secret_value: importSecretValue.value
          })
        });
        const payload = await response.json();
        result.textContent = JSON.stringify(payload, null, 2);
        if (!response.ok || !payload.ok) {
          discoveredDrafts = [];
          lastImportMeta = null;
          importDrafts.value = "[]";
          renderDraftList([]);
          const message = payload.error?.message || "Discovery failed.";
          importStatus.textContent = message;
          importStatus.classList.add("error");
          status.textContent = "Discovery failed";
          status.classList.add("error");
          return;
        }
        discoveredDrafts = payload.drafts || [];
        for (const draft of discoveredDrafts.filter((item) => item.published)) {
          publishedServiceIds.add(draft.service_id);
        }
        lastImportMeta = {
          skipped: payload.skipped?.length || 0,
          source: payload.source
        };
        importDrafts.value = JSON.stringify(discoveredDrafts, null, 2);
        renderDraftList(discoveredDrafts);
        updateDraftSelectionUi();
        updateSidePanel({
          importSummary: {
            found: discoveredDrafts.length,
            selected: selectedDraftCount(),
            skipped: payload.skipped?.length || 0,
            source: payload.source
          }
        });
        importStatus.textContent = discoveredDrafts.length
          ? "Found " + discoveredDrafts.length + " data endpoints to verify before publishing. Skipped " + (payload.skipped?.length || 0) + "."
          : "No data endpoints found.";
        importStatus.classList.remove("error");
        status.textContent = "Drafts generated";
        status.classList.remove("error");
      } catch (error) {
        status.textContent = "Discovery error";
        status.classList.add("error");
        importStatus.textContent = error.message;
        importStatus.classList.add("error");
        result.textContent = error.stack || error.message;
      }
    });

    publishDrafts.addEventListener("click", async () => {
      hideNotice(formMessage);
      status.textContent = "Publishing services...";
      status.classList.remove("error");
      try {
        syncDraftsFromList();
        const drafts = JSON.parse(importDrafts.value || "[]");
        const selected = drafts.filter((draft) => draft.selected !== false);
        if (!selected.length) {
          status.textContent = "Select at least one endpoint";
          status.classList.add("error");
          importStatus.textContent = "Select one or more endpoint cards before publishing.";
          importStatus.classList.add("error");
          return;
        }
        const response = await fetch("/studio/import/publish", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ drafts, publish_scope: "remote_and_local" })
        });
        const payload = await response.json();
        result.textContent = JSON.stringify(payload, null, 2);
        status.textContent = payload.ok ? "Remote verified " + payload.published.length + " services" : "Remote verification failed";
        status.classList.toggle("error", !payload.ok);
        showNotice(
          formMessage,
          payload.ok
            ? "Verified and published to " + (payload.remote_registry_url || "this registry") + ". Buyer agents can route to it now."
            : "Not published to remote registry: " + ((payload.failed || []).map((item) => item.service_id + ": " + item.error).join("; ") || "Validation failed."),
          payload.ok ? "success" : "error"
        );
        for (const item of payload.published || []) publishedServiceIds.add(item.service_id);
        discoveredDrafts = discoveredDrafts.map((draft) => publishedServiceIds.has(draft.service_id)
          ? { ...draft, selected: false, published: true }
          : draft);
        renderDraftList(discoveredDrafts);
        updateDraftSelectionUi();
        setSingleServiceReady(false);
        updateSidePanel({ batchPublishResult: payload });
      } catch (error) {
        status.textContent = "Publish error";
        status.classList.add("error");
        result.textContent = error.stack || error.message;
      }
    });

    function renderDraftList(drafts) {
      if (!drafts.length) {
        draftToolbar.classList.add("hidden");
        draftList.innerHTML = '<p class="hint">No data endpoints discovered yet.</p>';
        return;
      }
      draftToolbar.classList.remove("hidden");
      draftList.innerHTML = drafts.map((draft, index) => [
        '<div class="draft-row ' + draftRowClass(draft) + '" data-index="' + index + '">',
        '<input type="checkbox" class="draft-selected" ' + checkboxAttrs(draft) + " />",
        "<div>",
        '<div class="draft-title">' + escapeHtml(draft.title || draft.service_id) + "</div>",
        '<div class="draft-meta">' + escapeHtml(draft.method || "GET") + " " + escapeHtml(draft.path || draft.upstream_url || "") + "</div>",
        '<div class="draft-meta">' + escapeHtml((draft.capabilities || []).join(", ")) + "</div>",
        '<span class="draft-badge">' + draftBadge(draft) + "</span>",
        "</div>",
        '<label class="draft-price">USDC',
        '<input class="draft-price-input" value="' + escapeHtml(draft.price || importDefaultPrice.value || "0.01") + '" ' + (draft.published ? "disabled" : "") + " />",
        "</label>",
        '<button type="button" class="mini-button use-draft" ' + (draft.published ? "disabled" : "") + ">" + (draft.published ? "Verified" : "Edit Details") + "</button>",
        "</div>"
      ].join("")).join("");
    }

    function draftRowClass(draft) {
      if (draft.published) return "published";
      return draft.selected === false ? "" : "selected";
    }

    function checkboxAttrs(draft) {
      return [
        draft.selected === false ? "" : "checked",
        draft.published ? "disabled" : ""
      ].join(" ");
    }

    function draftBadge(draft) {
      if (draft.published) return "Verified and routable";
      if (draft.existing_service_status && draft.existing_service_status !== "verified") return "Needs verification";
      return draft.selected === false ? "Not selected" : "Selected for verification";
    }

    draftList.addEventListener("change", (event) => {
      if (!event.target.classList.contains("draft-selected")) return;
      syncDraftsFromList();
      renderDraftList(discoveredDrafts);
      updateDraftSelectionUi();
    });

    draftList.addEventListener("input", (event) => {
      if (!event.target.classList.contains("draft-price-input")) return;
      syncDraftsFromList();
      updateDraftSelectionUi();
    });

    draftList.addEventListener("click", (event) => {
      if (!event.target.classList.contains("use-draft")) return;
      const row = event.target.closest(".draft-row");
      const index = Number(row.dataset.index);
      syncDraftsFromList();
      fillDraftIntoForm(discoveredDrafts[index]);
    });

    selectAllDrafts.addEventListener("click", () => {
      discoveredDrafts = discoveredDrafts.map((draft) => ({ ...draft, selected: true }));
      importDrafts.value = JSON.stringify(discoveredDrafts, null, 2);
      renderDraftList(discoveredDrafts);
      updateDraftSelectionUi();
    });

    clearDrafts.addEventListener("click", () => {
      discoveredDrafts = discoveredDrafts.map((draft) => ({ ...draft, selected: false }));
      importDrafts.value = JSON.stringify(discoveredDrafts, null, 2);
      renderDraftList(discoveredDrafts);
      updateDraftSelectionUi();
    });

    function selectedDraftCount() {
      return discoveredDrafts.filter((draft) => !draft.published && draft.selected !== false).length;
    }

    function updateDraftSelectionUi() {
      const selected = selectedDraftCount();
      const total = discoveredDrafts.length;
      const published = discoveredDrafts.filter((draft) => draft.published).length;
      publishDrafts.textContent = total ? "Publish " + selected + " Selected" : "Publish Selected";
      publishDrafts.disabled = total > 0 && selected === 0;
      selectedDraftsStatus.textContent = selected + " of " + total + " endpoints selected" + (published ? " · " + published + " published" : "");
      importStatus.textContent = total
        ? "Found " + total + " data endpoints. " + selected + " selected for verification. " + published + " already verified and routable. Skipped " + (lastImportMeta?.skipped || 0) + "."
        : importStatus.textContent;
      importStatus.classList.remove("error");
      importDrafts.value = JSON.stringify(discoveredDrafts, null, 2);
      updateSidePanel({
        importSummary: {
          found: total,
          selected,
          published,
          skipped: lastImportMeta?.skipped || 0,
          source: lastImportMeta?.source || importApiUrl.value
        }
      });
    }

    function syncDraftsFromList() {
      const rows = [...draftList.querySelectorAll(".draft-row")];
      for (const row of rows) {
        const index = Number(row.dataset.index);
        if (discoveredDrafts[index].published) continue;
        discoveredDrafts[index].selected = row.querySelector(".draft-selected").checked;
        discoveredDrafts[index].price = row.querySelector(".draft-price-input").value;
      }
      importDrafts.value = JSON.stringify(discoveredDrafts, null, 2);
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function syncMode() {
      const hosted = mode.value === "hosted-http";
      hostedFields.classList.toggle("hidden", !hosted);
      liveDataLabel.classList.toggle("hidden", hosted);
      syncPreviewData();
      syncEnvelopePreview();
    }
    mode.addEventListener("change", syncMode);
    syncMode();

    fillHosted.addEventListener("click", () => {
      serviceEditor.open = true;
      setSingleServiceReady(true);
      mode.value = "hosted-http";
      serviceIdTouched = false;
      providerIdTouched = false;
      titleInput.value = "Studio Hosted Sentiment Demo";
      providerNameInput.value = "Provider Studio Hosted";
      descriptionInput.value = "Use this service to fetch sentiment data through a hosted Provider Runtime with a private Provider Secret.";
      upstreamUrlInput.value = "/mock/upstream/sentiment";
      secretValueInput.value = "demo-provider-secret";
      liveDataInput.value = ${JSON.stringify("{\"asset\":\"ETH\",\"sentiment_score\":0.79,\"mentions\":24120,\"source\":\"mock_upstream_sentiment\"}")};
      syncGeneratedIds();
      capabilitiesInput.dataset.touched = "true";
      capabilitiesInput.value = "sentiment_data,hosted_http,demo_data";
      syncMode();
    });

    function fillDraftIntoForm(draft) {
      if (!draft) return;
      serviceEditor.open = true;
      setSingleServiceReady(true);
      mode.value = "hosted-http";
      serviceIdTouched = true;
      providerIdTouched = true;
      titleInput.value = draft.title || "";
      providerNameInput.value = draft.provider_name || draft.provider_id || "";
      serviceIdInput.value = draft.service_id || slugify(draft.title || "service", "service");
      providerIdInput.value = draft.provider_id || slugify(draft.provider_name || "provider", "provider");
      descriptionInput.value = draft.description_for_agent || "";
      capabilitiesInput.dataset.touched = "true";
      capabilitiesInput.value = (draft.capabilities || []).join(",");
      priceInput.value = draft.price || importDefaultPrice.value || "0.01";
      sampleRequestInput.value = JSON.stringify(draft.sample_request || {}, null, 2);
      sampleDataInput.value = JSON.stringify(draft.preview_data ?? { ok: true }, null, 2);
      previewDataView.textContent = sampleDataInput.value;
      liveDataInput.value = JSON.stringify(draft.preview_data ?? { ok: true }, null, 2);
      summaryInput.value = draft.summary || "";
      upstreamUrlInput.value = draft.upstream_url || "";
      upstreamMethodInput.value = draft.method || "GET";
      authHeaderInput.value = draft.auth_header || "authorization";
      secretNameInput.value = draft.secret_name || "PROVIDER_SECRET";
      secretValueInput.value = draft.secret_value || importSecretValue.value || "";
      syncMode();
      syncEnvelopePreview();
      updateSidePanel({ selectedDraft: draft });
      status.textContent = "Draft filled into the service form";
      status.classList.remove("error");
      result.textContent = JSON.stringify({
        filled_from_draft: draft.service_id,
        next_step: "Review the single-service editor, then click Publish This Service."
      }, null, 2);
    }

    function syncPreviewData() {
      if (!previewSettings.open) {
        sampleDataInput.value = liveDataInput.value;
      }
      previewDataView.textContent = sampleDataInput.value;
    }

    function syncEnvelopePreview() {
      const dataSource = mode.value === "hosted-http" ? "hosted_http" : "static_json";
      const sample = safeJson(sampleRequestInput.value, {});
      const data = mode.value === "hosted-http"
        ? safeJson(sampleDataInput.value, { example: "preview" })
        : safeJson(liveDataInput.value, { example: "result" });
      const envelope = {
        schema_version: "agent_data_envelope_v1",
        service_id: serviceIdInput.value || "generated_service_id",
        request_id: "req_example",
        status: "success",
        query: sample,
        data,
        metadata: {
          data_sources: ["provider_config_" + dataSource],
          generated_at: new Date(0).toISOString(),
          freshness_seconds: mode.value === "hosted-http" ? 60 : 86400,
          is_estimated: mode.value !== "hosted-http",
          confidence: mode.value === "hosted-http" ? 0.8 : 0.7,
          limitations: ["MVP example response format."]
        },
        agent_hints: {
          good_for: ["Agent response parsing"],
          warnings: [],
          suggested_followups: []
        },
        summary: summaryInput.value || "Short result summary."
      };
      envelopePreview.textContent = JSON.stringify(envelope, null, 2);
      updateSidePanel();
    }

    function updateSidePanel(extra = {}) {
      if (!sidePanel) return;
      const checks = [
        ["Service name", titleInput.value],
        ["Provider name", providerNameInput.value],
        ["Price", priceInput.value],
        ["Example request", sampleRequestInput.value],
        [mode.value === "hosted-http" ? "API endpoint" : "Result data", mode.value === "hosted-http" ? upstreamUrlInput.value : liveDataInput.value],
        ["Summary", summaryInput.value]
      ];
      const tags = (capabilitiesInput.value || "").split(",").map((item) => item.trim()).filter(Boolean);
      const cards = [];
      cards.push(
        '<div class="side-card"><h3>Publish Checklist</h3><div class="check-list">' +
        checks.map(([label, value]) => '<div class="check-item ' + (String(value || "").trim() ? "done" : "") + '"><span>' + (String(value || "").trim() ? "✓" : "○") + '</span><span>' + escapeHtml(label) + '</span></div>').join("") +
        "</div></div>"
      );
      if (extra.importSummary) {
        cards.push(
          '<div class="side-card"><h3>Discovered Endpoints</h3><div class="kv">' +
          '<div>Found</div><div>' + extra.importSummary.found + '</div>' +
          '<div>Selected</div><div>' + (extra.importSummary.selected ?? extra.importSummary.found) + '</div>' +
          '<div>Published</div><div>' + (extra.importSummary.published || 0) + '</div>' +
          '<div>Skipped</div><div>' + extra.importSummary.skipped + '</div>' +
          '<div>Source</div><div>' + escapeHtml(extra.importSummary.source) + '</div>' +
          "</div></div>"
        );
      }
      cards.push(
        '<div class="side-card"><h3>Agent Preview</h3><div class="kv">' +
        '<div>Title</div><div>' + escapeHtml(titleInput.value || "Untitled service") + '</div>' +
        '<div>Price</div><div>' + escapeHtml(priceInput.value || "0.01") + ' USDC</div>' +
        '<div>Source</div><div>' + (mode.value === "hosted-http" ? "HTTP endpoint" : "Pasted data") + '</div>' +
        '<div>Endpoint</div><div>' + escapeHtml(mode.value === "hosted-http" ? upstreamUrlInput.value || "Not set" : "Hosted by ADN runtime") + '</div>' +
        "</div></div>"
      );
      cards.push(
        '<div class="side-card"><h3>Routing Tags</h3><div class="pill-row">' +
        (tags.length ? tags.map((tag) => '<span class="pill">' + escapeHtml(tag) + '</span>').join("") : '<span class="pill">data_service</span>') +
        "</div></div>"
      );
      if (extra.publishResult) {
        cards.push(
          '<div class="side-card"><h3>' + (extra.publishResult.ok ? "Published" : "Needs Attention") + '</h3><div class="kv">' +
          '<div>Service ID</div><div>' + escapeHtml(extra.publishResult.service_id || "-") + '</div>' +
          '<div>Validation</div><div>' + escapeHtml(extra.publishResult.validation?.ok ? "passed" : "failed") + '</div>' +
          '<div>Endpoint</div><div>' + escapeHtml(extra.publishResult.endpoint || "-") + '</div>' +
          "</div></div>"
        );
      }
      if (extra.batchPublishResult) {
        cards.push(
          '<div class="side-card"><h3>' + (extra.batchPublishResult.ok ? "Verified Services" : "Verification Issues") + '</h3><div class="kv">' +
          '<div>Registry</div><div>' + escapeHtml(extra.batchPublishResult.remote_registry_url || "current") + '</div>' +
          '<div>Verified</div><div>' + escapeHtml(extra.batchPublishResult.published?.length || 0) + '</div>' +
          '<div>Failed</div><div>' + escapeHtml(extra.batchPublishResult.failed?.length || 0) + '</div>' +
          '<div>Routable services</div><div>' + escapeHtml((extra.batchPublishResult.published || []).map((item) => item.service_id).join(", ") || "-") + '</div>' +
          "</div></div>"
        );
      }
      sidePanel.innerHTML = cards.join("");
    }

    function safeJson(value, fallback) {
      try {
        return JSON.parse(value);
      } catch {
        return fallback;
      }
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      hideNotice(formMessage);
      if (!singleServiceReady) {
        showNotice(formMessage, "Choose Edit Details on a discovered endpoint, or open the manual editor before creating a single service.", "error");
        return;
      }
      const clientErrors = validateSingleServiceForm();
      if (clientErrors.length) {
        serviceEditor.open = true;
        status.textContent = "Check required fields";
        status.classList.add("error");
        showNotice(formMessage, clientErrors.join(" "), "error");
        result.textContent = JSON.stringify({
          ok: false,
          code: "CLIENT_VALIDATION_FAILED",
          errors: clientErrors
        }, null, 2);
        return;
      }
      if (publishedServiceIds.has(serviceIdInput.value)) {
        status.textContent = "Already published";
        status.classList.add("error");
        showNotice(formMessage, "This service is already published. Use the published endpoint card or change the Service ID in Advanced routing metadata.", "error");
        result.textContent = JSON.stringify({
          ok: false,
          code: "SERVICE_ALREADY_PUBLISHED",
          message: "This endpoint was already published from the discovered endpoint card."
        }, null, 2);
        return;
      }
      status.textContent = "Submitting...";
      status.classList.remove("error");
      const data = Object.fromEntries(new FormData(form).entries());
      try {
        const response = await fetch("/studio/providers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data)
        });
        const payload = await response.json();
        result.textContent = JSON.stringify(payload, null, 2);
        const alreadyRegistered = payload.error?.message?.includes("already registered");
        status.textContent = payload.ok ? "Validated" : alreadyRegistered ? "Already published" : "Validation failed";
        status.classList.toggle("error", !payload.ok);
        if (payload.ok) publishedServiceIds.add(payload.service_id);
        if (payload.ok) {
          discoveredDrafts = discoveredDrafts.map((draft) => draft.service_id === payload.service_id
            ? { ...draft, selected: false, published: true }
            : draft);
          renderDraftList(discoveredDrafts);
          updateDraftSelectionUi();
          setSingleServiceReady(false);
        }
        showNotice(
          formMessage,
          payload.ok
            ? "Service published and validated successfully."
            : userFacingError(payload),
          payload.ok ? "success" : "error"
        );
        updateSidePanel({ publishResult: payload });
      } catch (error) {
        status.textContent = "Error";
        status.classList.add("error");
        showNotice(formMessage, error.message || "Publish failed.", "error");
        result.textContent = error.stack || error.message;
      }
    });
  } catch (error) {
    const target = document.querySelector("#import-status") || document.querySelector("#status");
    if (target) {
      target.textContent = "Studio script error: " + error.message;
      target.classList.add("error");
    }
    console.error(error);
  }
  })();
  </script>
</body>
</html>`;
}

function defaultsFromDraft(draft) {
  const defaultLiveData = {
    asset: "ETH",
    sentiment_score: 0.74,
    mentions: 18230,
    positive_ratio: 0.67
  };
  if (draft) {
    const preview = draft.preview_data ?? { ok: true };
    return {
      mode: "hosted-http",
      price: draft.price || "0.01",
      title: draft.title || "Imported API Service",
      providerName: draft.provider_name || draft.provider_id || "Imported API",
      description: draft.description_for_agent || "Use this service to call an imported API endpoint.",
      capabilities: (draft.capabilities || ["data_service"]).join(","),
      serviceId: draft.service_id || normalizeId(null, draft.title, "service"),
      providerId: draft.provider_id || normalizeId(null, draft.provider_name, "provider"),
      sampleRequest: prettyJson(draft.sample_request || {}),
      sampleData: prettyJson(preview),
      liveData: prettyJson(preview),
      summary: draft.summary || "",
      upstreamUrl: draft.upstream_url || "",
      upstreamMethod: draft.method || "GET",
      authHeader: draft.auth_header || "authorization",
      secretName: draft.secret_name || "PROVIDER_SECRET",
      secretValue: draft.secret_value || ""
    };
  }
  return {
    mode: "static-json",
    price: "0.01",
    title: "Studio Sentiment Demo",
    providerName: "Provider Studio Demo",
    description: "Use this service to fetch a demo sentiment dataset through Provider Studio.",
    capabilities: "sentiment_data,demo_data",
    serviceId: "studio_sentiment_demo",
    providerId: "provider_studio_demo",
    sampleRequest: prettyJson({ asset: "ETH", window: "7d" }),
    sampleData: prettyJson(defaultLiveData),
    liveData: prettyJson(defaultLiveData),
    summary: "ETH community sentiment is positive over the selected window.",
    upstreamUrl: "/mock/upstream/sentiment",
    upstreamMethod: "POST",
    authHeader: "authorization",
    secretName: "PROVIDER_SECRET",
    secretValue: "demo-provider-secret"
  };
}

function prettyJson(value) {
  return JSON.stringify(value, null, 2);
}

function html(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
