const installCommand = "claude mcp add AgentRouter -- npx -y @agentrouter/mcp";
const localInstallCommand = "claude mcp add AgentRouter -e AGENT_ROUTER_URL=http://127.0.0.1:8800 -- npx -y @agentrouter/mcp";

export function homeHtml() {
  return page({
    title: "AgentRouter Markets",
    body: `
      <header class="hero">
        <div class="dot-grid" aria-hidden="true"></div>
        <div class="shell hero-center">
          <span class="eyebrow">Agent-native API hub</span>
          <h1>AgentRouter Markets</h1>
          <p class="lead">Discover, call, and verify data APIs for AI agents. Providers publish working endpoints. Agents install once, route by task, and feed quality signals back into the network.</p>
          <form class="hero-search" action="/agent" method="GET">
            <input name="q" placeholder="Search APIs, providers, capabilities, or tasks..." />
            <button type="submit">Search</button>
          </form>
          <div class="home-panel">
            <strong>Network snapshot</strong>
            <div class="metrics compact">
              <div class="metric"><strong id="home-services">--</strong><span>Services</span></div>
              <div class="metric"><strong id="home-verified">--</strong><span>Verified</span></div>
              <div class="metric"><strong id="home-calls">--</strong><span>Calls</span></div>
              <div class="metric"><strong id="home-usdc">--</strong><span>USDC</span></div>
            </div>
          </div>
        </div>
      </header>

      <main>
        <div class="shell landing-grid">
          <a class="path-card" href="/human">
            <span class="path-label">For human</span>
            <h2>Publish and manage data APIs</h2>
            <p>See your provided APIs, edit listings, add endpoints, and track total calls and USDC received.</p>
            <span class="path-action">Open provider dashboard</span>
          </a>
          <a class="path-card" href="/agent">
            <span class="path-label">For agent</span>
            <h2>Install once and route to services</h2>
            <p>Search registered services, inspect trust signals, and copy the MCP install command for AI clients.</p>
            <span class="path-action">Open agent API hub</span>
          </a>
          <a class="path-card" href="/agent-router/trust">
            <span class="path-label">Trust</span>
            <h2>Audit service quality</h2>
            <p>Inspect trust snapshots, feedback counts, verification status, quality events, and route observations.</p>
            <span class="path-action">See reputation data</span>
          </a>
        </div>

        <div class="shell">
          <section class="card overview">
            <div>
              <h2>Why this exists</h2>
              <p>Traditional API hubs assume a human developer chooses an API, subscribes, manages keys, and wires clients manually. AgentRouter is for the moment an AI agent knows it needs data but should not force the user to pre-install every provider-specific tool.</p>
            </div>
            <div class="step-row">
              <div><b>1</b><span>Provider publishes a verified endpoint</span></div>
              <div><b>2</b><span>Agent discovers and routes by task</span></div>
              <div><b>3</b><span>Call results update trust signals</span></div>
            </div>
          </section>
        </div>
      </main>
      <script>
        async function loadHomeStats() {
          let stats = { services: [], registered_services: 0, verified_services: 0, total_calls: 0 };
          try { stats = await fetch("/agent-router/stats").then((res) => res.json()); } catch {}
          const usdc = (stats.services || []).reduce((sum, service) => sum + Number(service.price || 0) * Number(service.total_calls || 0), 0);
          setText("home-services", stats.registered_services || 0);
          setText("home-verified", stats.verified_services || 0);
          setText("home-calls", stats.total_calls || 0);
          setText("home-usdc", formatUsdc(usdc));
        }
        ${sharedClientHelpers()}
        loadHomeStats();
      </script>
    `
  });
}

export function humanHtml() {
  return appPage({
    title: "For human",
    subtitle: "Manage provided data/APIs, edit services, and track USDC received.",
    active: "human",
    body: `
      <main>
        <div class="shell human-layout">
          <section class="card">
            <h2>Provider Dashboard</h2>
            <p>Track services published in this registry. The MVP shows all providers until account-level ownership is added.</p>
            <div class="metrics">
              <div class="metric"><strong id="human-services">--</strong><span>Provided APIs</span></div>
              <div class="metric"><strong id="human-verified">--</strong><span>Verified APIs</span></div>
              <div class="metric"><strong id="human-calls">--</strong><span>Total calls received</span></div>
              <div class="metric"><strong id="human-usdc">--</strong><span>USDC received</span></div>
            </div>
            <div class="actions">
              <a class="button primary" href="/studio">Add data/API</a>
              <a class="button" href="/studio">Edit services</a>
              <a class="button ghost" href="/agent-router/stats">Open stats JSON</a>
            </div>
          </section>
          <section>
            <div class="section-head card">
              <h2>Your API cards</h2>
              <a class="button" href="/studio">New service</a>
            </div>
            <div class="service-grid" id="human-api-cards"></div>
          </section>
        </div>
      </main>
      <script>
        ${serviceClientScript()}
        function renderPage(stats) {
          const services = stats.services || [];
          const totalUsdc = services.reduce((sum, service) => sum + serviceRevenue(service), 0);
          setText("human-services", services.length);
          setText("human-verified", stats.verified_services || 0);
          setText("human-calls", stats.total_calls || 0);
          setText("human-usdc", formatUsdc(totalUsdc));
          document.getElementById("human-api-cards").innerHTML = services.map((service) => apiCard(service, { human: true })).join("") ||
            '<div class="card muted">No services yet. Add your first API in Provider Studio.</div>';
        }
        loadStats().then(renderPage);
      </script>
    `
  });
}

export function agentHtml() {
  return appPage({
    title: "For agent",
    subtitle: "Install once, search the API hub, and route to registered services.",
    active: "agent",
    body: `
      <main>
        <div class="shell hub-layout">
          <section>
            <div class="card search-card">
              <h2>API Hub for agents</h2>
              <p>Search registered services by capability, provider, or task. Pick a service to inspect the agent playground.</p>
              <div class="install-banner">
                <strong>One-line install</strong>
                <code>${html(installCommand)}</code>
                <details>
                  <summary>Local development endpoint</summary>
                  <code>${html(localInstallCommand)}</code>
                </details>
              </div>
              <div class="search-row">
                <input id="service-search" placeholder="Search APIs, providers, or capabilities" />
                <select id="sort-services">
                  <option value="relevance">By relevance</option>
                  <option value="calls">Most called</option>
                  <option value="trust">Highest trust</option>
                  <option value="price">Lowest price</option>
                </select>
              </div>
              <div class="category-row" id="category-row"></div>
            </div>
            <div class="service-grid" id="agent-api-cards"></div>
          </section>
          <aside class="playground">
            <div class="playground-head">
              <h2>Playground</h2>
              <span class="muted" id="playground-status">Select a service</span>
            </div>
            <div class="playground-body">
              <div class="endpoint-list" id="endpoint-list"></div>
              <div class="play-content">
                <div class="kv" id="playground-kv"></div>
                <div>
                  <strong>Install command</strong>
                  <div class="command-wrap">
                    <button class="copy-button" type="button" id="copy-install">Copy</button>
                    <code class="command" id="install-command">${html(installCommand)}</code>
                  </div>
                </div>
                <div>
                  <strong>Structured request</strong>
                  <code class="command" id="request-preview">{}</code>
                </div>
                <p class="note">In Claude or Codex, ask: "Use AgentRouter to query this data." The router handles discovery, quote, paid invocation, and verification feedback.</p>
              </div>
            </div>
          </aside>
        </div>
      </main>
      <script>
        ${serviceClientScript()}
        const installCommand = ${JSON.stringify(installCommand)};
        const localInstallCommand = ${JSON.stringify(localInstallCommand)};
        const categories = ["All", "Data", "Crypto", "Market Data", "On-chain", "Derivatives", "Wallet"];
        let latestStats = { services: [] };
        let selectedServiceId = null;
        let activeCategory = "All";
        document.getElementById("copy-install").addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(installCommand);
            document.getElementById("copy-install").textContent = "Copied";
            setTimeout(() => document.getElementById("copy-install").textContent = "Copy", 1200);
          } catch {
            document.getElementById("copy-install").textContent = "Select text";
          }
        });
        document.getElementById("service-search").addEventListener("input", renderAgentHub);
        document.getElementById("sort-services").addEventListener("change", renderAgentHub);
        function renderPage(stats) {
          latestStats = stats;
          selectedServiceId = stats.services?.[0]?.service_id || null;
          const query = new URLSearchParams(location.search).get("q") || "";
          document.getElementById("service-search").value = query;
          renderCategories();
          renderAgentHub();
          renderPlayground(selectedService());
        }
        function renderCategories() {
          document.getElementById("category-row").innerHTML = categories.map((category) =>
            '<button type="button" class="category ' + (category === activeCategory ? "active" : "") + '" data-category="' + escapeHtml(category) + '">' + escapeHtml(category) + '</button>'
          ).join("");
          document.querySelectorAll(".category").forEach((button) => {
            button.addEventListener("click", () => {
              activeCategory = button.dataset.category;
              renderCategories();
              renderAgentHub();
            });
          });
        }
        function renderAgentHub() {
          const services = filteredServices();
          if (!services.some((service) => service.service_id === selectedServiceId)) {
            selectedServiceId = services[0]?.service_id || null;
          }
          document.getElementById("agent-api-cards").innerHTML = services.map((service) => apiCard(service, { selected: service.service_id === selectedServiceId })).join("") ||
            '<div class="card muted">No matching services found.</div>';
          document.querySelectorAll("[data-service-id]").forEach((card) => {
            card.addEventListener("click", () => {
              selectedServiceId = card.dataset.serviceId;
              renderAgentHub();
              renderPlayground(selectedService());
            });
          });
          renderPlayground(selectedService());
        }
        function filteredServices() {
          const query = document.getElementById("service-search").value.trim().toLowerCase();
          const sort = document.getElementById("sort-services").value;
          let services = [...(latestStats.services || [])].filter((service) => {
            const haystack = [service.title, service.service_id, service.provider_id, service.description_for_agent, ...(service.capabilities || [])].join(" ").toLowerCase();
            const categoryMatch = activeCategory === "All" || categoryMatches(service, activeCategory);
            return categoryMatch && (!query || haystack.includes(query));
          });
          services.sort((a, b) => {
            if (sort === "calls") return Number(b.total_calls || 0) - Number(a.total_calls || 0);
            if (sort === "trust") return Number(b.trust_score || 0) - Number(a.trust_score || 0);
            if (sort === "price") return Number(a.price || 0) - Number(b.price || 0);
            return Number(b.trust_score || 0) + Number(b.total_calls || 0) - Number(a.trust_score || 0) - Number(a.total_calls || 0);
          });
          return services;
        }
        function categoryMatches(service, category) {
          const text = [service.title, service.description_for_agent, ...(service.capabilities || [])].join(" ").toLowerCase();
          if (category === "Data") return text.includes("data");
          if (category === "Crypto") return /crypto|btc|eth|chain|perp/.test(text);
          if (category === "Market Data") return /market|price|etf|funding/.test(text);
          if (category === "On-chain") return /onchain|chain|wallet|fund_flow/.test(text);
          if (category === "Derivatives") return /derivative|perp|liquidation|funding/.test(text);
          if (category === "Wallet") return /wallet|address/.test(text);
          return true;
        }
        function renderPlayground(service) {
          if (!service) {
            document.getElementById("endpoint-list").innerHTML = '<div class="endpoint-item">No service</div>';
            document.getElementById("playground-kv").innerHTML = '<div>Status</div><div>No registered services</div>';
            document.getElementById("request-preview").textContent = "{}";
            return;
          }
          document.getElementById("playground-status").textContent = service.service_id;
          document.getElementById("endpoint-list").innerHTML = '<div class="endpoint-item active">POST route</div><div class="endpoint-item">GET manifest</div><div class="endpoint-item">POST invoke</div>';
          document.getElementById("playground-kv").innerHTML = [
            ["Service", service.title || service.service_id],
            ["Provider", service.provider_id],
            ["Price", formatUsdc(Number(service.price || 0)) + " " + (service.currency || "USDC")],
            ["Calls", service.total_calls || 0],
            ["Trust", formatTrust(service.trust_score)],
            ["Endpoint", service.endpoint_url || "/connector/invoke_paid_service"]
          ].map(([key, value]) => '<div>' + escapeHtml(key) + '</div><div>' + escapeHtml(value) + '</div>').join("");
          const request = { service_id: service.service_id, input: service.sample_request || {}, budget: { max_amount: "0.05", currency: "USDC" } };
          document.getElementById("request-preview").textContent = JSON.stringify(request, null, 2);
        }
        function selectedService() {
          if (!selectedServiceId) return null;
          return (latestStats.services || []).find((service) => service.service_id === selectedServiceId) || null;
        }
        loadStats().then(renderPage);
      </script>
    `
  });
}

function appPage({ title, subtitle, active, body }) {
  return page({
    title: `${title} · AgentRouter Markets`,
    body: `
      <header class="app-header">
        <div class="shell app-title">
          <div>
            <span class="eyebrow">${html(active === "human" ? "Provider workspace" : "Agent API hub")}</span>
            <h1>${html(title)}</h1>
            <p class="lead">${html(subtitle)}</p>
          </div>
          <nav class="section-nav" aria-label="Section">
            <a class="${active === "human" ? "active" : ""}" href="/human">For human</a>
            <a class="${active === "agent" ? "active" : ""}" href="/agent">For agent</a>
          </nav>
        </div>
      </header>
      ${body}
    `
  });
}

function page({ title, body }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${html(title)}</title>
  <style>${styles()}</style>
</head>
<body>
  <div class="topbar">
    <div class="shell nav">
      <a class="brand" href="/"><span>AgentRouter</span><small>Markets</small></a>
      <form class="top-search" action="/agent" method="GET">
        <input name="q" placeholder="Search service, provider, capability..." />
      </form>
      <nav class="nav-links" aria-label="Primary">
        <a href="/agent">SERVICES</a>
        <a href="/human">PROVIDERS</a>
        <a href="/agent-router/trust">FEEDBACK</a>
        <a href="/agent-router/observations">ROUTES</a>
        <a href="/studio">STUDIO</a>
      </nav>
      <div class="nav-tools" aria-hidden="true"><span></span><span></span></div>
    </div>
  </div>
  ${body}
  <footer class="footer">
    <div class="shell">AgentRouter Markets · <a href="/human">For human</a> · <a href="/agent">For agent</a> · <a href="/studio">Provider Studio</a></div>
  </footer>
</body>
</html>`;
}

function styles() {
  return `
    :root { color-scheme: light; --ink:#25272a; --muted:#737373; --faint:#a8a8a8; --line:#e3e3e3; --strong-line:#d4d4d4; --panel:#f7f7f7; --bg:#ffffff; --soft:#f3f3f3; --code:#202124; --accent:#5cff73; --accent-ink:#0c240f; }
    * { box-sizing: border-box; }
    body { margin:0; font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--ink); }
    a { color:inherit; text-decoration:none; }
    button, input, select { font:inherit; }
    .shell { max-width:1160px; margin:0 auto; padding:0 24px; }
    .topbar { position:sticky; top:0; z-index:20; border-top:4px solid #dffcff; border-bottom:1px solid var(--line); background:rgba(255,255,255,.96); backdrop-filter:blur(10px); }
    .nav { min-height:68px; display:grid; grid-template-columns:220px minmax(240px, 1fr) auto auto; align-items:center; gap:16px; }
    .brand { display:grid; gap:0; font-weight:780; line-height:1.05; font-size:18px; }
    .brand small { color:#111; font-weight:520; font-size:13px; }
    .top-search input { width:100%; min-height:36px; border:1px solid var(--line); background:#fbfbfb; color:var(--ink); padding:8px 13px; outline:none; border-radius:0; }
    .top-search input:focus, .hero-search input:focus, .search-row input:focus, .search-row select:focus { border-color:#999; background:#fff; }
    .nav-links { display:flex; align-items:center; gap:22px; color:#5f5f5f; font-size:12px; font-weight:650; white-space:nowrap; }
    .nav-tools { display:flex; gap:12px; }
    .nav-tools span { width:35px; height:35px; border:1px solid var(--line); background:#fff; display:block; position:relative; }
    .nav-tools span:first-child::after { content:""; width:10px; height:10px; border:2px solid #222; border-radius:50%; position:absolute; inset:0; margin:auto; }
    .nav-tools span:last-child::after { content:""; width:14px; height:14px; border-radius:50%; border-right:2px solid #f6cb36; border-bottom:2px solid #f6cb36; position:absolute; inset:0; margin:auto; }
    .button { display:inline-flex; align-items:center; justify-content:center; min-height:40px; border:2px solid #252525; border-radius:0; background:#fff; color:var(--ink); padding:9px 16px; font-weight:760; cursor:pointer; text-transform:uppercase; font-size:12px; letter-spacing:0; }
    .button::before, .path-action::before { content:">"; margin-right:10px; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .button.primary { background:var(--accent); border-color:var(--accent); color:#002b08; }
    .button.ghost { background:#fff; }
    .hero { padding:0 0 34px; }
    .dot-grid { height:96px; border-bottom:1px solid #ededed; background-image:radial-gradient(#9c9c9c .8px, transparent .8px); background-size:12px 12px; background-position:0 3px; }
    .hero-center { text-align:center; padding-top:82px; display:grid; justify-items:center; }
    .eyebrow { display:inline-flex; color:#686868; font-size:12px; font-weight:760; text-transform:uppercase; letter-spacing:0; }
    h1 { margin:14px 0 14px; font-size:clamp(42px,5vw,62px); line-height:1.04; font-weight:720; letter-spacing:0; }
    .lead { margin:0; color:#a3a3a3; font-size:18px; line-height:1.72; max-width:760px; }
    .hero-search { width:min(680px, 100%); margin-top:58px; display:grid; grid-template-columns:minmax(0,1fr) 124px; }
    .hero-search input { min-height:64px; border:2px solid var(--line); background:#fafafa; color:var(--ink); padding:0 20px; font-size:18px; outline:none; border-radius:0; }
    .hero-search button { border:2px solid #252525; border-left:0; background:#fff; color:#252525; font-weight:760; text-transform:uppercase; font-size:12px; cursor:pointer; }
    .hero-actions, .actions { display:flex; flex-wrap:wrap; gap:9px; margin-top:14px; }
    main { padding:22px 0 42px; }
    .home-panel { width:min(720px, 100%); margin-top:34px; text-align:left; }
    .home-panel, .card { border:1px solid var(--line); border-radius:0; background:var(--panel); padding:20px; }
    .metrics { display:grid; grid-template-columns:repeat(4, 1fr); gap:0; margin-top:14px; border:1px solid var(--line); background:#fff; }
    .metric { border-right:1px solid var(--line); background:#fff; padding:16px; }
    .metric:last-child { border-right:0; }
    .metric strong { display:block; font-size:27px; line-height:1; font-weight:720; }
    .metric span { display:block; margin-top:8px; color:var(--muted); font-size:11px; font-weight:760; text-transform:uppercase; }
    .landing-grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:16px; margin-bottom:18px; }
    .path-card { border:1px solid var(--line); border-radius:0; background:var(--panel); padding:28px 24px 22px; min-height:236px; display:flex; flex-direction:column; justify-content:space-between; transition:border-color 140ms ease, background 140ms ease; }
    .path-card:hover { border-color:#b8b8b8; background:#fff; }
    .path-card h2, .card h2 { margin:0 0 14px; font-size:19px; font-weight:650; letter-spacing:0; }
    .path-card p, .card p { margin:0; color:var(--muted); line-height:1.48; }
    .path-label { display:inline-flex; width:max-content; color:#111; font-size:12px; font-weight:760; text-transform:uppercase; }
    .path-action { display:inline-flex; width:max-content; border:2px solid #252525; background:#fff; color:#252525; font-weight:760; margin-top:18px; padding:10px 16px; font-size:12px; text-transform:uppercase; }
    .path-card:nth-child(3) .path-action { background:var(--accent); border-color:var(--accent); color:#002b08; }
    .overview { display:grid; grid-template-columns:.9fr 1.1fr; gap:18px; align-items:center; margin-bottom:26px; }
    .step-row { display:grid; grid-template-columns:repeat(3, 1fr); gap:10px; }
    .step-row div { border:1px solid var(--line); border-radius:0; padding:12px; background:#fff; }
    .step-row b { display:block; color:#111; margin-bottom:8px; }
    .step-row span { color:var(--muted); font-size:13px; line-height:1.4; }
    .app-header { padding:0 0 18px; }
    .app-header::before { content:""; display:block; height:72px; margin-bottom:42px; border-bottom:1px solid #ededed; background-image:radial-gradient(#9c9c9c .8px, transparent .8px); background-size:12px 12px; }
    .app-title { display:flex; align-items:end; justify-content:space-between; gap:18px; }
    .app-title h1 { font-size:clamp(36px,4vw,54px); }
    .section-nav { display:grid; grid-template-columns:1fr 1fr; gap:0; border:1px solid var(--line); background:#fff; min-width:320px; }
    .section-nav a { padding:13px 16px; color:var(--muted); font-weight:760; text-align:center; text-transform:uppercase; font-size:12px; border-right:1px solid var(--line); }
    .section-nav a:last-child { border-right:0; }
    .section-nav a.active { background:#222; color:#fff; }
    .hub-layout, .human-layout { display:grid; grid-template-columns:minmax(0,.92fr) minmax(420px,1.08fr); gap:16px; align-items:start; }
    .section-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px; }
    .search-card { display:grid; gap:12px; }
    .search-row { display:grid; grid-template-columns:minmax(0,1fr) 154px; gap:10px; }
    .search-row input, .search-row select { width:100%; border:1px solid var(--line); border-radius:0; background:#fff; color:var(--ink); min-height:44px; padding:10px 12px; outline:none; }
    .install-banner { border:1px solid var(--line); border-radius:0; padding:13px; background:#fff; display:grid; gap:8px; }
    .install-banner code, .command { display:block; white-space:pre-wrap; word-break:break-word; border-radius:0; background:var(--code); color:#f8fafc; padding:14px; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; line-height:1.45; }
    .install-banner details { color:var(--muted); font-size:12px; }
    .install-banner summary { cursor:pointer; font-weight:760; width:max-content; }
    .install-banner details code { margin-top:7px; background:#343434; }
    .category-row { display:flex; flex-wrap:wrap; gap:8px; }
    .category { border:1px solid var(--line); border-radius:0; background:#fff; color:#555; padding:8px 11px; font-size:12px; font-weight:760; cursor:pointer; }
    .category.active { background:#222; border-color:#222; color:#fff; }
    .service-grid { display:grid; gap:12px; margin-top:12px; }
    .api-card { position:relative; border:1px solid var(--line); border-radius:0; background:#fff; padding:20px; cursor:pointer; transition:border-color 140ms ease, box-shadow 140ms ease; }
    .api-card:hover, .api-card.selected { border-color:#b8b8b8; box-shadow:0 10px 20px rgba(0,0,0,.04); }
    .api-top { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:13px; }
    .type-badge { display:inline-flex; border-radius:0; background:#f0edff; color:#9f1239; padding:7px 10px; font-weight:780; }
    .heart { color:#667085; font-size:22px; line-height:1; }
    .api-main { display:grid; grid-template-columns:54px minmax(0,1fr); gap:13px; }
    .logo { width:54px; height:54px; border-radius:50%; display:grid; place-items:center; background:#ff7a45; color:#111827; font-weight:900; font-size:16px; border:1px solid #f3a179; }
    .api-card h3 { margin:0 0 5px; font-size:21px; letter-spacing:0; }
    .api-card p { margin:0; color:var(--muted); line-height:1.42; }
    .byline { display:flex; justify-content:space-between; gap:12px; margin-top:14px; color:var(--muted); font-size:13px; }
    .stat-row { display:flex; flex-wrap:wrap; gap:9px; margin-top:14px; }
    .stat-pill { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--line); border-radius:8px; background:#fff; color:#667085; padding:8px 11px; font-weight:730; }
    .pill-row { display:flex; flex-wrap:wrap; gap:5px; margin-top:10px; }
    .pill { display:inline-flex; border:1px solid #d5dde5; border-radius:999px; background:#fff; color:#475467; padding:3px 7px; font-size:11px; max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .playground { position:sticky; top:82px; border:1px solid var(--line); border-radius:0; background:#fff; overflow:hidden; }
    .playground-head { padding:15px 16px; border-bottom:1px solid var(--line); display:flex; align-items:center; justify-content:space-between; gap:12px; }
    .playground-head h2 { margin:0; font-size:20px; }
    .playground-body { display:grid; grid-template-columns:170px minmax(0,1fr); min-height:420px; }
    .endpoint-list { border-right:1px solid var(--line); background:#fbfcfe; padding:12px; display:grid; gap:8px; align-content:start; }
    .endpoint-item { border:1px solid var(--line); border-radius:0; background:#fff; padding:9px; font-size:12px; font-weight:780; }
    .endpoint-item.active { border-color:#222; background:#222; color:#fff; }
    .play-content { padding:14px; display:grid; gap:12px; align-content:start; }
    .kv { display:grid; grid-template-columns:94px minmax(0,1fr); gap:7px 10px; font-size:13px; }
    .kv div:nth-child(odd) { color:var(--muted); }
    .kv div:nth-child(even) { font-weight:720; overflow-wrap:anywhere; }
    .command-wrap { position:relative; }
    .copy-button { position:absolute; top:8px; right:8px; border:1px solid #555; color:#fff; background:#343434; border-radius:0; padding:6px 8px; font-size:12px; cursor:pointer; }
    .trust { font-weight:850; color:#111; }
    .muted { color:var(--muted); }
    .note { color:var(--muted); font-size:13px; line-height:1.45; }
    .footer { border-top:1px solid var(--line); color:var(--muted); padding:26px 0 36px; }
    @media (max-width:980px) {
      .nav { grid-template-columns:1fr auto; gap:12px; padding:10px 24px; }
      .top-search { grid-column:1 / -1; order:3; }
      .nav-tools { order:2; }
      .hero-grid, .hub-layout, .human-layout, .playground-body, .overview { grid-template-columns:1fr; }
      .landing-grid, .metrics, .search-row, .step-row { grid-template-columns:1fr; }
      .nav-links { display:none; }
      .app-title { display:grid; }
      .section-nav { min-width:0; }
      .playground { position:static; }
      .endpoint-list { border-right:0; border-bottom:1px solid var(--line); }
      .hero-search { grid-template-columns:1fr; }
      .hero-search button { min-height:48px; border:2px solid #252525; border-top:0; }
      .hero-center { padding-top:48px; }
      .dot-grid { height:72px; }
    }
  `;
}

function serviceClientScript() {
  return `
    ${sharedClientHelpers()}
    async function loadStats() {
      try { return await fetch("/agent-router/stats").then((res) => res.json()); }
      catch { return { registered_services: 0, verified_services: 0, total_calls: 0, services: [] }; }
    }
    function apiCard(service, options = {}) {
      const description = service.description_for_agent || "Agent-callable data API with verified response envelope.";
      const logo = initials(service.title || service.service_id);
      const selected = options.selected ? " selected" : "";
      return \`
        <article class="api-card\${selected}" data-service-id="\${escapeAttr(service.service_id)}">
          <div class="api-top"><span class="type-badge">Data</span><span class="heart">♡</span></div>
          <div class="api-main">
            <div class="logo">\${escapeHtml(logo)}</div>
            <div>
              <h3>\${escapeHtml(service.title || service.service_id)}</h3>
              <p>\${escapeHtml(truncate(description, 106))}</p>
              <div class="byline"><span>By \${escapeHtml(service.provider_id || "provider")}</span><span>Verified now</span></div>
              <div class="stat-row">
                <span class="stat-pill">↗ \${formatRating(service.trust_score)}</span>
                <span class="stat-pill">◷ \${service.total_calls ? "live" : "MVP"}</span>
                <span class="stat-pill">◌ \${service.verification_status === "verified" ? "99%" : "test"}</span>
              </div>
              <div class="pill-row">\${renderPills(service.capabilities || [])}</div>
              \${options.human ? '<div class="actions"><a class="button ghost" href="/studio">Edit</a><a class="button" href="/agent-router/stats">Analytics</a></div>' : ""}
            </div>
          </div>
        </article>
      \`;
    }
    function renderPills(tags) {
      const visible = tags.slice(0, 4);
      return visible.map((tag) => '<span class="pill">' + escapeHtml(tag) + '</span>').join("") +
        (tags.length > visible.length ? '<span class="pill">+' + (tags.length - visible.length) + '</span>' : "");
    }
    function serviceRevenue(service) { return Number(service.price || 0) * Number(service.total_calls || 0); }
    function formatRating(value) {
      if (value == null) return "--";
      return Math.min(10, Math.max(0, Number(value) * 10)).toFixed(1);
    }
    function initials(value) {
      return String(value || "API").split(/\\s|_|-/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "API";
    }
    function truncate(value, max) {
      const text = String(value || "");
      return text.length > max ? text.slice(0, max - 4) + "...." : text;
    }
    function escapeAttr(value) { return escapeHtml(value).replace(/'/g, "&#39;"); }
  `;
}

function sharedClientHelpers() {
  return `
    function formatUsdc(value) {
      const number = Number(value || 0);
      if (number === 0) return "0.00";
      if (number < 0.01) return number.toFixed(6);
      return number.toFixed(2);
    }
    function formatTrust(value) {
      if (value == null) return "--";
      return Number(value).toFixed(2);
    }
    function setText(id, value) {
      const node = document.getElementById(id);
      if (node) node.textContent = String(value);
    }
    function escapeHtml(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }
  `;
}

function html(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
