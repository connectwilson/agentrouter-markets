import http from "node:http";
import { URL } from "node:url";
import { readJson, sendHtml, sendJson, sendNotFound, getRequestBaseUrl } from "./http-utils.js";
import { createMemoryStore, publicServiceRecord } from "./store.js";
import { baseFundFlowManifest, btcLiquidationMaxPainManifest } from "./fixtures.js";
import { handleBtcLiquidationProvider, handleCustomProvider, handleFundFlowProvider, handleMockUpstreamSentiment } from "./provider-runtime.js";
import { invokePaidService, registerService, searchServices, validateService, loadProviderConfigs } from "./registry.js";
import { discoverApiServices, publishApiDrafts } from "./openapi-import.js";
import { getCapabilityCatalog, quoteCapabilityRequest, resolveRoute, routeCapabilityRequest, routeTask } from "./router.js";
import { askAgentRouter } from "./agent-router.js";
import { createProviderFromStudio, studioHtml } from "./studio.js";
import { createHostedHttpProviderConfig, writeProviderConfig } from "./provider-config.js";

export function createServer({ store = createMemoryStore(), baseUrl = "" } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      await routeRequest(req, res, store, baseUrl || getRequestBaseUrl(req));
    } catch (error) {
      sendJson(res, error.statusCode || 500, {
        error: {
          code: error.code || (error.statusCode ? "REQUEST_ERROR" : "INTERNAL_ERROR"),
          message: error.message
        }
      });
    }
  });

  server.store = store;
  return server;
}

async function routeRequest(req, res, store, baseUrl) {
  const url = new URL(req.url, baseUrl);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/agent-router/health") {
    sendJson(res, 200, { ok: true, service: "agent-router" });
    return;
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/studio")) {
    sendHtml(res, 200, studioHtml());
    return;
  }

  if (req.method === "GET" && (url.pathname === "/demo" || url.pathname === "/agent-router/demo")) {
    sendHtml(res, 200, agentRouterDemoHtml());
    return;
  }

  if (req.method === "POST" && url.pathname === "/studio/use-draft") {
    const body = await readForm(req);
    const draft = JSON.parse(body.draft || "{}");
    sendHtml(res, 200, studioHtml({ draft }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/studio/providers") {
    const body = await readJson(req);
    const result = await createProviderFromStudio(body, store, baseUrl);
    sendJson(res, result.ok ? 201 : 422, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/studio/import/discover") {
    const body = await readJson(req);
    const result = await discoverApiServices(body, baseUrl);
    sendJson(res, 200, markExistingDrafts(result, store));
    return;
  }

  if (req.method === "GET" && url.pathname === "/studio/import/discover-page") {
    const result = await discoverApiServices({
      api_url: url.searchParams.get("import_api_url") || url.searchParams.get("api_url"),
      default_price: url.searchParams.get("import_default_price") || url.searchParams.get("default_price") || "0.01",
      secret_value: url.searchParams.get("import_secret_value") || ""
    }, baseUrl);
    sendHtml(res, 200, discoverPageHtml(markExistingDrafts(result, store)));
    return;
  }

  if (req.method === "POST" && url.pathname === "/studio/import/publish") {
    const body = await readJson(req);
    const result = await publishApiDrafts(body, store, baseUrl);
    sendJson(res, result.ok ? 201 : 207, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/services/register") {
    const manifest = await readJson(req);
    const record = registerService(store, manifest, baseUrl);
    sendJson(res, 201, publicServiceRecord(record));
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/services/") && url.pathname.endsWith("/validate")) {
    const serviceId = url.pathname.split("/")[2];
    const result = await validateService(store, serviceId);
    sendJson(res, result.ok ? 200 : 422, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/services/search") {
    const query = url.searchParams.get("q") || "";
    const maxPrice = url.searchParams.get("max_price");
    const verifiedOnly = url.searchParams.get("verified_only") === "true";
    const capabilities = url.searchParams.getAll("capability");
    sendJson(res, 200, searchServices(store, { query, capabilities, maxPrice, verifiedOnly }));
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/services/") && url.pathname.endsWith("/manifest")) {
    const serviceId = url.pathname.split("/")[2];
    const record = store.services.get(serviceId);
    if (!record) return sendNotFound(res, "SERVICE_NOT_FOUND");
    sendJson(res, 200, record.manifest);
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/services/") && url.pathname.endsWith("/preview")) {
    const serviceId = url.pathname.split("/")[2];
    const record = store.services.get(serviceId);
    if (!record) return sendNotFound(res, "SERVICE_NOT_FOUND");
    sendJson(res, 200, record.manifest.sample_response);
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/services/") && url.pathname.endsWith("/feedback")) {
    const serviceId = url.pathname.split("/")[2];
    const record = store.services.get(serviceId);
    if (!record) return sendNotFound(res, "SERVICE_NOT_FOUND");
    sendJson(res, 200, record.feedback_events || []);
    return;
  }

  if (req.method === "POST" && url.pathname === "/connector/search_services") {
    const body = await readJson(req);
    const result = searchServices(store, {
      query: body.query || "",
      capabilities: body.capabilities || [],
      maxPrice: body.max_price,
      verifiedOnly: body.verified_only
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/connector/get_manifest") {
    const { service_id: serviceId } = await readJson(req);
    const record = store.services.get(serviceId);
    if (!record) return sendNotFound(res, "SERVICE_NOT_FOUND");
    sendJson(res, 200, record.manifest);
    return;
  }

  if (req.method === "POST" && url.pathname === "/connector/preview_service") {
    const { service_id: serviceId } = await readJson(req);
    const record = store.services.get(serviceId);
    if (!record) return sendNotFound(res, "SERVICE_NOT_FOUND");
    sendJson(res, 200, record.manifest.sample_response);
    return;
  }

  if (req.method === "POST" && url.pathname === "/connector/invoke_paid_service") {
    const body = await readJson(req);
    const result = await invokePaidService(store, body.service_id, body.input || {}, body.budget || {});
    sendJson(res, result.statusCode, result.body);
    return;
  }

  if (req.method === "POST" && url.pathname === "/router/route") {
    const body = await readJson(req);
    const result = await routeTask(store, body);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/router/resolve") {
    const body = await readJson(req);
    const result = resolveRoute(store, body);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/capabilities") {
    sendJson(res, 200, {
      catalog_version: "agent_router_capability_catalog_v1",
      preferred_endpoint: "/agent-router/request",
      note: "Main agents should parse user intent into this structured capability schema. /agent-router/ask is a demo fallback, not the core protocol.",
      capabilities: getCapabilityCatalog()
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/agent-router/request") {
    const body = await readJson(req);
    const result = await routeCapabilityRequest(store, body);
    sendJson(res, result.ok === false && result.status === "invalid_request" ? 422 : 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/agent-router/quote") {
    const body = await readJson(req);
    const result = quoteCapabilityRequest(store, body);
    sendJson(res, result.ok === false && result.status === "invalid_request" ? 422 : 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/agent-router/ask") {
    const body = await readJson(req);
    const result = await askAgentRouter(store, {
      task: body.task || body.query || "",
      max_price: body.max_price || body.maxPrice || "0.05",
      currency: body.currency || "USDC"
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/agent-router/evidence") {
    const serviceId = url.searchParams.get("service_id");
    const events = serviceId
      ? store.evidenceEvents.filter((event) => event.service_id === serviceId)
      : store.evidenceEvents;
    sendJson(res, 200, {
      evidence_event_version: "agent_router_evidence_events_v1",
      storage: "offchain_memory_db",
      chain_anchor: "simulated_arc_anchor",
      count: events.length,
      events
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/agent-router/observations") {
    const serviceId = url.searchParams.get("service_id");
    const capability = url.searchParams.get("capability");
    const status = url.searchParams.get("status");
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 50)));
    const observations = (store.routeObservations || [])
      .filter((event) => !serviceId || event.selected_service_id === serviceId)
      .filter((event) => !capability || event.request?.capability === capability)
      .filter((event) => !status || event.status === status)
      .slice(-limit);
    sendJson(res, 200, {
      observation_feed_version: "agent_router_route_observations_v1",
      storage: "offchain_memory_db",
      note: "Route observations are lightweight training/evaluation records for future learned routing.",
      count: observations.length,
      observations
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/agent-router/trust") {
    const serviceId = url.searchParams.get("service_id");
    const services = [...store.services.values()]
      .filter((record) => !serviceId || record.manifest.service_id === serviceId)
      .map((record) => publicServiceRecord(record).trust);
    sendJson(res, 200, {
      trust_snapshot_version: "agent_router_trust_snapshot_v1",
      storage: "offchain_memory_db",
      audit_anchor: "trust scores are computed offchain from feedback events; evidence hashes can be anchored on Arc.",
      services
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/connector/get_feedback") {
    const { service_id: serviceId } = await readJson(req);
    const record = store.services.get(serviceId);
    if (!record) return sendNotFound(res, "SERVICE_NOT_FOUND");
    sendJson(res, 200, record.feedback_events || []);
    return;
  }

  if (req.method === "POST" && url.pathname === "/provider/chain-fund-flow") {
    await handleFundFlowProvider(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/provider/btc-liquidation-max-pain") {
    await handleBtcLiquidationProvider(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/provider/custom/")) {
    const serviceId = decodeURIComponent(url.pathname.split("/")[3] || "");
    await handleCustomProvider(req, res, serviceId);
    return;
  }

  if (req.method === "POST" && url.pathname === "/mock/upstream/sentiment") {
    await handleMockUpstreamSentiment(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/mock/upstream/html-error") {
    res.writeHead(404, { "content-type": "text/html" });
    res.end("<html><h1>Not Found</h1></html>");
    return;
  }

  if (req.method === "GET" && url.pathname === "/mock/api/openapi.json") {
    sendJson(res, 200, mockOpenApi(baseUrl));
    return;
  }

  if (req.method === "GET" && url.pathname === "/mock/api/v1/funding-rate") {
    sendJson(res, 200, {
      asset: url.searchParams.get("asset") || "BTC",
      funding_rate: 0.00018,
      venue: "Binance",
      source: "mock_openapi"
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/mock/api/v1/liquidation/max-pain") {
    sendJson(res, 200, {
      asset: url.searchParams.get("asset") || "BTC",
      max_liquidation_pain_price: 103500,
      estimated_liquidation_notional_usd: 820000000,
      source: "mock_openapi"
    });
    return;
  }

  sendNotFound(res, "ROUTE_NOT_FOUND");
}

function markExistingDrafts(result, store) {
  return {
    ...result,
    drafts: (result.drafts || []).map((draft) => {
      const record = store.services.get(draft.service_id);
      if (!record) return draft;
      const verified = record.verification_status === "verified";
      return {
        ...draft,
        selected: !verified,
        published: verified,
        existing_service_status: record.verification_status,
        existing_service_verified: verified
      };
    })
  };
}

async function readForm(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  return Object.fromEntries(params.entries());
}

function discoverPageHtml(result) {
  const rows = result.drafts.map((draft) => `
    <tr>
      <td>${escapeHtml(draft.title)}</td>
      <td><code>${escapeHtml(draft.method)} ${escapeHtml(draft.path)}</code></td>
      <td>${escapeHtml(draft.price)} USDC</td>
      <td>${escapeHtml(draft.capabilities.join(", "))}</td>
      <td>
        <form method="POST" action="/studio/use-draft">
          <input type="hidden" name="draft" value="${escapeHtml(JSON.stringify(draft))}" />
          <button type="submit">Use in form</button>
        </form>
      </td>
    </tr>
  `).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Discovered API Services</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 28px; color: #17201a; background: #f6f4ef; }
    table { border-collapse: collapse; width: 100%; background: white; border: 1px solid #d8ded7; }
    th, td { text-align: left; border-bottom: 1px solid #d8ded7; padding: 10px; vertical-align: top; }
    button { border: 0; border-radius: 6px; padding: 8px 10px; background: #0f766e; color: white; font-weight: 700; cursor: pointer; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre { background: #111814; color: #edf8f0; border-radius: 8px; padding: 14px; overflow: auto; }
    a { color: #0f766e; font-weight: 700; }
  </style>
</head>
<body>
  <h1>Discovered API Services</h1>
  <p>Source: <code>${escapeHtml(result.source)}</code></p>
  <p>Found ${result.drafts.length} publishable data endpoints. Skipped ${result.skipped.length} operational endpoints.</p>
  <table>
    <thead><tr><th>Service</th><th>Endpoint</th><th>Price</th><th>Routing Tags</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <h2>Raw Drafts</h2>
  <pre>${escapeHtml(JSON.stringify(result.drafts, null, 2))}</pre>
  <p><a href="/studio">Back to Provider Studio</a></p>
</body>
</html>`;
}

function agentRouterDemoHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AgentRouter Markets Demo</title>
  <style>
    :root { color-scheme: light; --ink:#17201a; --muted:#5f6b63; --line:#d9ded7; --bg:#f6f4ef; --panel:#ffffff; --accent:#0f766e; --warn:#8a5a00; --code:#101813; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--bg); }
    header { padding: 22px 28px 14px; border-bottom: 1px solid var(--line); background: #fbfaf7; }
    h1 { margin: 0 0 6px; font-size: 28px; letter-spacing: 0; }
    p { color: var(--muted); line-height: 1.45; }
    main { display: grid; grid-template-columns: minmax(360px, 0.92fr) minmax(420px, 1.08fr); gap: 18px; padding: 18px; }
    section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px; }
    h2 { margin: 0 0 12px; font-size: 18px; }
    label { display: block; margin: 12px 0 6px; font-weight: 750; }
    input, select, textarea { width: 100%; border: 1px solid #cbd4cb; border-radius: 6px; padding: 10px 11px; font: inherit; background: white; color: var(--ink); }
    textarea { min-height: 88px; resize: vertical; }
    button { border: 0; border-radius: 6px; background: var(--accent); color: white; font-weight: 800; padding: 10px 12px; cursor: pointer; }
    button.secondary { background: #e7ece8; color: var(--ink); }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .actions { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
    .cards { display: grid; gap: 10px; margin-top: 10px; }
    .card { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #fcfcfa; }
    .card strong { display: block; margin-bottom: 4px; }
    .pill { display: inline-block; border: 1px solid #cbd4cb; border-radius: 999px; padding: 3px 8px; margin: 3px 4px 0 0; color: var(--muted); font-size: 12px; }
    pre { margin: 0; min-height: 160px; border-radius: 8px; padding: 14px; background: var(--code); color: #edf8f0; overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
    .notice { margin-top: 10px; color: var(--warn); font-weight: 700; }
    @media (max-width: 920px) { main { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>AgentRouter Markets</h1>
    <p>Structured market-intelligence routing with per-call USDC payment and trust feedback.</p>
  </header>
  <main>
    <section>
      <h2>Capability Request</h2>
      <label for="capability">Capability</label>
      <select id="capability"></select>
      <div class="row">
        <div>
          <label for="asset">Asset</label>
          <input id="asset" value="BTC" />
        </div>
        <div>
          <label for="maxPrice">Max Price USDC</label>
          <input id="maxPrice" value="0.05" />
        </div>
      </div>
      <div class="row">
        <div>
          <label for="marketType">Market Type</label>
          <input id="marketType" value="perpetual_futures" />
        </div>
        <div>
          <label for="window">Window</label>
          <input id="window" value="current" />
        </div>
      </div>
      <label for="task">Natural-language demo wrapper</label>
      <textarea id="task">BTC 当前最大爆仓痛点是多少？如果我现在有 3x long，要不要降杠杆？</textarea>
      <div class="actions">
        <button id="runStructured">Route Structured Request</button>
        <button class="secondary" id="runAsk">Run /ask Demo Wrapper</button>
      </div>
      <div id="notice" class="notice"></div>
      <h2 style="margin-top:18px;">Capability Catalog</h2>
      <div id="catalog" class="cards"></div>
    </section>
    <section>
      <h2>Route Result</h2>
      <pre id="output">Submit a request to see selected provider, payment receipt, result data, and trust feedback.</pre>
    </section>
  </main>
  <script>
    const capability = document.getElementById("capability");
    const catalogEl = document.getElementById("catalog");
    const output = document.getElementById("output");
    const notice = document.getElementById("notice");

    function show(value) {
      output.textContent = JSON.stringify(value, null, 2);
    }

    async function post(path, body) {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = await response.json();
      if (!response.ok) {
        notice.textContent = payload.error?.message || payload.error || "Request failed";
      } else {
        notice.textContent = "";
      }
      return payload;
    }

    async function loadCatalog() {
      const payload = await fetch("/capabilities").then((res) => res.json());
      capability.innerHTML = payload.capabilities.map((item) => \`<option value="\${item.capability}">\${item.capability}</option>\`).join("");
      catalogEl.innerHTML = payload.capabilities.map((item) => \`
        <div class="card">
          <strong>\${item.capability}</strong>
          <div>\${item.agent_description}</div>
          <div>\${(item.provider_capabilities || []).map((cap) => \`<span class="pill">\${cap}</span>\`).join("")}</div>
        </div>
      \`).join("");
    }

    document.getElementById("runStructured").addEventListener("click", async () => {
      const selected = capability.value;
      const params = selected === "onchain_fund_flow"
        ? { chain: "base", days: 7 }
        : selected === "options_max_pain"
          ? { asset: document.getElementById("asset").value, expiry: "nearest" }
          : {
              asset: document.getElementById("asset").value,
              market_type: document.getElementById("marketType").value,
              window: document.getElementById("window").value
            };
      show(await post("/agent-router/request", {
        capability: selected,
        params,
        constraints: {
          max_price_usdc: document.getElementById("maxPrice").value,
          freshness_seconds: 300,
          min_confidence: 0.7
        },
        consumer_context: {
          position: { direction: "long", leverage: 3 }
        }
      }));
    });

    document.getElementById("runAsk").addEventListener("click", async () => {
      show(await post("/agent-router/ask", {
        task: document.getElementById("task").value,
        max_price: document.getElementById("maxPrice").value
      }));
    });

    loadCatalog().catch((error) => {
      notice.textContent = error.message;
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function mockOpenApi(baseUrl) {
  return {
    openapi: "3.0.0",
    info: {
      title: "Mock Derivatives API",
      version: "1.0.0"
    },
    servers: [{ url: `${baseUrl.replace(/\/$/, "")}/mock/api` }],
    paths: {
      "/v1/funding-rate": {
        get: {
          operationId: "get_funding_rate",
          summary: "Get Funding Rate",
          description: "Fetch current perpetual futures funding rate for an asset.",
          parameters: [
            { name: "asset", in: "query", schema: { type: "string", example: "BTC" } }
          ],
          responses: {
            "200": {
              description: "Funding rate",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/FundingRateResponse" }
                }
              }
            }
          }
        }
      },
      "/v1/liquidation/max-pain": {
        get: {
          operationId: "get_liquidation_max_pain",
          summary: "Get Liquidation Max Pain",
          description: "Fetch BTC perpetual liquidation max-pain data.",
          parameters: [
            { name: "asset", in: "query", schema: { type: "string", example: "BTC" } }
          ],
          responses: {
            "200": {
              description: "Liquidation max pain",
              content: {
                "application/json": {
                  example: { asset: "BTC", max_liquidation_pain_price: 103500, estimated_liquidation_notional_usd: 820000000 }
                }
              }
            }
          }
        }
      },
      "/health": {
        get: {
          summary: "Health Check",
          responses: { "200": { description: "OK" } }
        }
      },
      "/auth/login": {
        post: {
          summary: "Login",
          responses: { "200": { description: "Token" } }
        }
      }
    },
    components: {
      schemas: {
        FundingRateResponse: {
          type: "object",
          properties: {
            asset: { type: "string", example: "BTC" },
            funding_rate: { type: "number", example: 0.00018 },
            venue: { type: "string", example: "Binance" }
          }
        }
      }
    }
  };
}

export async function seedDemoService(serverUrl, store) {
  const record = registerService(store, baseFundFlowManifest, serverUrl);
  await validateService(store, record.manifest.service_id);
  const liquidationRecord = registerService(store, btcLiquidationMaxPainManifest, serverUrl);
  await validateService(store, liquidationRecord.manifest.service_id);
  return record;
}

export async function bootstrapServer(server, baseUrl) {
  await seedDemoService(baseUrl, server.store);
  await loadProviderConfigs(server.store, baseUrl, { validate: true });
  await seedEnvProviderServices(baseUrl, server.store);
}

export async function seedEnvProviderServices(baseUrl, store) {
  const nansenApiKey = process.env.NANSEN_API_KEY || process.env.ADN_NANSEN_API_KEY;
  if (!nansenApiKey) return [];

  const price = process.env.NANSEN_PRICE_USDC || "0.01";
  const services = [
    {
      serviceId: "nansen_smart_money_netflow",
      title: "Nansen Smart Money Netflow",
      description: "Use this service to query Nansen Smart Money netflow data for supported chains.",
      capabilities: ["data_service", "smart_money_netflow", "netflow", "smart_money", "onchain_data"],
      upstreamUrl: "https://api.nansen.ai/api/v1/smart-money/netflow",
      sampleRequest: {
        chains: ["ethereum"],
        pagination: { page: 1, per_page: 10 }
      },
      sampleData: {
        data: [
          {
            chain: "ethereum",
            label: "Smart Trader",
            netflow_usd: 0,
            note: "Shape-only sample. Paid calls query Nansen."
          }
        ],
        pagination: { page: 1, per_page: 10 }
      },
      summary: "Nansen Smart Money netflow data."
    },
    {
      serviceId: "nansen_smart_money_holdings",
      title: "Nansen Smart Money Holdings",
      description: "Use this service to query Nansen Smart Money holdings data for supported chains.",
      capabilities: ["data_service", "smart_money_holdings", "smart_money", "onchain_data"],
      upstreamUrl: "https://api.nansen.ai/api/v1/smart-money/holdings",
      sampleRequest: {
        chains: ["ethereum"],
        pagination: { page: 1, per_page: 10 }
      },
      sampleData: {
        data: [
          {
            chain: "ethereum",
            label: "Smart Trader",
            token_symbol: "ETH",
            value_usd: 0,
            note: "Shape-only sample. Paid calls query Nansen."
          }
        ],
        pagination: { page: 1, per_page: 10 }
      },
      summary: "Nansen Smart Money holdings data."
    }
  ];

  const seeded = [];
  for (const service of services) {
    if (store.services.has(service.serviceId)) continue;
    const config = createHostedHttpProviderConfig({
      baseUrl,
      serviceId: service.serviceId,
      providerId: "nansen",
      title: service.title,
      description: service.description,
      capabilities: service.capabilities,
      price,
      sampleRequest: service.sampleRequest,
      sampleData: service.sampleData,
      upstreamUrl: service.upstreamUrl,
      upstreamMethod: "POST",
      secretName: "NANSEN_API_KEY",
      secretValue: nansenApiKey,
      authHeader: "apikey",
      summary: service.summary
    });
    await writeProviderConfig(config);
    const record = registerService(store, config.manifest, baseUrl);
    seeded.push({ service_id: record.manifest.service_id, verification_status: record.verification_status });
  }
  return seeded;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "0.0.0.0";
  const server = createServer();
  server.listen(port, host, async () => {
    const baseUrl = `http://127.0.0.1:${port}`;
    await bootstrapServer(server, baseUrl);
    console.log(`Agent Native Data Network MVP running at ${baseUrl} on ${host}`);
  });
}
