import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "adn-mvp-test-"));
process.env.ADN_DIR = path.join(runtimeRoot, ".adn");
process.env.ADN_PROVIDER_DIR = path.join(runtimeRoot, "providers");
process.env.ADN_WALLET_PASSPHRASE = "test-passphrase";
process.env.ADN_ALLOW_SERVER_SIDE_DEV_PAYMENTS = "1";

const { createServer, seedDemoService } = await import("../src/server.js");
const { loadProviderConfigs, searchServices } = await import("../src/registry.js");
const { DiscoveryConnector, runConsumerDemo } = await import("../src/connector.js");
const { discoverApiServices } = await import("../src/openapi-import.js");
const { readPaymentLog, resetWalletForTests } = await import("../src/wallet.js");
const { readWallet } = await import("../src/wallet.js");
const { createWalletPaymentProof } = await import("../src/payment.js");
const { normalizeEndpoint } = await import("../src/http-utils.js");
const { createMemoryStore } = await import("../src/store.js");
const { keccak256Hex } = await import("../src/keccak.js");
const { currentPaymentBackend } = await import("../src/payment-adapter.js");

test.after(async () => {
  await fs.rm(runtimeRoot, { recursive: true, force: true });
});

async function withServer(fn) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await seedDemoService(baseUrl, server.store);
    await fn({ server, baseUrl });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("registry seeds and validates demo service", async () => {
  await withServer(async ({ server }) => {
    const record = server.store.services.get("chain_fund_flow_7d_base");
    assert.equal(record.verification_status, "verified");
    assert.equal(record.validation_runs.length, 1);
    assert.equal(record.validation_runs[0].ok, true);
  });
});

test("home page and Provider Studio render separately", async () => {
  await withServer(async ({ baseUrl }) => {
    const home = await fetch(`${baseUrl}/`);
    assert.equal(home.status, 200);
    const homeHtml = await home.text();
    assert.match(homeHtml, /Network snapshot/);
    assert.match(homeHtml, /Open provider dashboard/);
    assert.match(homeHtml, /Open agent API hub/);

    const human = await fetch(`${baseUrl}/human`);
    assert.equal(human.status, 200);
    const humanHtml = await human.text();
    assert.match(humanHtml, /Provider Dashboard/);
    assert.match(humanHtml, /Your API cards/);

    const agent = await fetch(`${baseUrl}/agent`);
    assert.equal(agent.status, 200);
    const agentHtml = await agent.text();
    assert.match(agentHtml, /API Hub for agents/);
    assert.match(agentHtml, /Available services/);
    assert.match(agentHtml, /claude mcp add AgentRouter/);

    const studio = await fetch(`${baseUrl}/studio`);
    assert.equal(studio.status, 200);
    const studioHtml = await studio.text();
    assert.match(studioHtml, /Provider Studio/);
    assert.match(studioHtml, /Verify & Publish Selected/);
    assert.doesNotMatch(studioHtml, /Buyer auth/);
  });
});

test("published services can bind an Arc payout wallet without re-registration", async () => {
  await withServer(async ({ baseUrl }) => {
    const payoutAddress = "0x1111111111111111111111111111111111111111";
    const update = await fetch(`${baseUrl}/services/chain_fund_flow_7d_base/payout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payout_address: payoutAddress })
    });
    assert.equal(update.status, 200);
    const payload = await update.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.payout_address, payoutAddress);
    assert.equal(payload.manifest.provider.payout_address, payoutAddress);
    assert.equal(payload.manifest.pricing.pay_to, payoutAddress);
    assert.equal(payload.manifest.pricing.settlement_model, "direct_provider_wallet");

    const manifestResponse = await fetch(`${baseUrl}/services/chain_fund_flow_7d_base/manifest`);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.provider.payout_address, payoutAddress);
    assert.equal(manifest.pricing.pay_to, payoutAddress);

    const invalid = await fetch(`${baseUrl}/services/chain_fund_flow_7d_base/payout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payout_address: "not-an-address" })
    });
    assert.equal(invalid.status, 422);
    const errorPayload = await invalid.json();
    assert.equal(errorPayload.error.code, "INVALID_PAYOUT_ADDRESS");
  });
});

test("discovery connector searches, previews, invokes, and records feedback", async () => {
  await withServer(async ({ baseUrl }) => {
    const connector = new DiscoveryConnector({ baseUrl });
    const services = await connector.searchServices({
      query: "Base 7d fund flow",
      capabilities: ["onchain_data", "fund_flow"],
      max_price: "0.05"
    });
    assert.equal(services.length, 1);
    assert.equal(services[0].service_id, "chain_fund_flow_7d_base");
    assert.deepEqual(services[0].request_data.example, { chain: "base", days: 7 });
    assert.ok(services[0].response_data.fields.includes("metrics.net_flow_usd"));
    assert.equal(services[0].pre_call_context.buyer_requirements.needs_buyer_api_key, false);
    assert.equal(services[0].pre_call_context.buyer_requirements.payment_protocol, "x402");
    assert.equal(services[0].pre_call_context.freshness.max_data_lag_seconds, 7200);
    assert.ok(services[0].pre_call_context.limitations.includes("Sample response is historical and not current."));

    const manifest = await connector.getManifest("chain_fund_flow_7d_base");
    assert.equal(manifest.title, "Base 7D Fund Flow");

    const preview = await connector.previewService("chain_fund_flow_7d_base", manifest.sample_request);
    assert.equal(preview.sample_type, "historical");
    assert.equal(preview.schema_version, "agent_data_envelope_v1");

    const invocation = await connector.invokePaidService(
      "chain_fund_flow_7d_base",
      { chain: "base", days: 7 },
      { max_amount: "0.05", currency: "USDC" }
    );
    assert.equal(invocation.result.status, "success");
    assert.equal(invocation.result.schema_version, "agent_data_envelope_v1");
    assert.equal(invocation.feedback.schema_valid, true);
    assert.match(invocation.feedback.payment_tx, /^0x[0-9a-f]{64}$/);

    const feedback = await connector.getFeedback("chain_fund_flow_7d_base");
    assert.equal(feedback.length, 1);

    const statsResponse = await fetch(`${baseUrl}/agent-router/stats`);
    assert.equal(statsResponse.status, 200);
    const stats = await statsResponse.json();
    assert.equal(stats.registered_services, 2);
    assert.equal(stats.total_calls, 1);
    assert.equal(stats.services.find((service) => service.service_id === "chain_fund_flow_7d_base").total_calls, 1);
    assert.equal(stats.services.find((service) => service.service_id === "chain_fund_flow_7d_base").health_status, "healthy");

    const detailResponse = await fetch(`${baseUrl}/agent-router/service?service_id=chain_fund_flow_7d_base`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(detail.service_detail_version, "agent_router_service_detail_v1");
    assert.equal(detail.service.source_provenance.source_provenance_level, "wrapped_api");
    assert.ok(detail.service.badges.some((badge) => badge.code === "verified_live_endpoint"));

    const qualityResponse = await fetch(`${baseUrl}/agent-router/quality?service_id=chain_fund_flow_7d_base`);
    assert.equal(qualityResponse.status, 200);
    const quality = await qualityResponse.json();
    assert.equal(quality.quality_feed_version, "agent_router_quality_events_v1");
    assert.equal(quality.count, 1);
    assert.equal(quality.events[0].business_error.detected, false);

    const healthCheckResponse = await fetch(`${baseUrl}/agent-router/health-check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service_id: "chain_fund_flow_7d_base" })
    });
    assert.equal(healthCheckResponse.status, 200);
    const healthCheck = await healthCheckResponse.json();
    assert.equal(healthCheck.event_version, "agent_service_health_check_v1");
    assert.equal(healthCheck.ok, true);
  });
});

test("consumer demo completes final analysis", async () => {
  await withServer(async ({ baseUrl }) => {
    const demo = await runConsumerDemo({ baseUrl });
    assert.equal(demo.selected_service.service_id, "chain_fund_flow_7d_base");
    assert.equal(demo.paid_result.status, "success");
    assert.equal(demo.feedback_count, 1);
    assert.match(demo.analysis, /Base shows a 7-day net inflow/);
  });
});

test("endpoint normalization treats bare hostnames as HTTPS URLs", () => {
  assert.equal(
    normalizeEndpoint("api.example.com/v1/data/market-flow", "http://127.0.0.1:8800"),
    "https://api.example.com/v1/data/market-flow"
  );
  assert.equal(
    normalizeEndpoint("/mock/api", "http://127.0.0.1:8800"),
    "http://127.0.0.1:8800/mock/api"
  );
});

test("keccak helper matches Ethereum address hashing vectors", () => {
  assert.equal(keccak256Hex(Buffer.alloc(0)), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccak256Hex(Buffer.from("hello")), "1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8");
});

test("payment backend aliases real mode to x402", () => {
  const previousBackend = process.env.ADN_PAYMENT_BACKEND;
  const previousMode = process.env.ADN_PAYMENT_MODE;
  delete process.env.ADN_PAYMENT_BACKEND;
  process.env.ADN_PAYMENT_MODE = "real";
  assert.equal(currentPaymentBackend(), "x402");
  if (previousBackend === undefined) delete process.env.ADN_PAYMENT_BACKEND;
  else process.env.ADN_PAYMENT_BACKEND = previousBackend;
  if (previousMode === undefined) delete process.env.ADN_PAYMENT_MODE;
  else process.env.ADN_PAYMENT_MODE = previousMode;
});

test("AgentRouter HTTP endpoint routes and invokes BTC liquidation task", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "BTC 当前最大爆仓痛点是多少",
        max_price: "0.05"
      })
    });
    assert.equal(response.status, 200);
    const routed = await response.json();
    assert.equal(routed.ok, true);
    assert.equal(routed.selected_service.service_id, "btc_liquidation_max_pain_demo");
    assert.equal(routed.input.asset, "BTC");
    assert.equal(routed.input.market_type, "perpetual_futures");
    assert.equal(routed.result.data.max_liquidation_pain_price, 103500);
    assert.equal(routed.feedback.schema_valid, true);
    assert.equal(routed.feedback.settlement_receipt.asset, "USDC");
    assert.equal(routed.feedback.settlement_receipt.payment_backend, "dev");
    assert.match(routed.feedback.settlement_receipt.tx_hash, /^0x[0-9a-f]{64}$/);
    assert.match(routed.answer, /103500/);
  });
});

test("AgentRouter capability catalog and structured request route deterministically", async () => {
  await withServer(async ({ baseUrl }) => {
    const catalogResponse = await fetch(`${baseUrl}/capabilities`);
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json();
    assert.equal(catalog.catalog_version, "agent_router_capability_catalog_v1");
    assert.ok(catalog.capabilities.some((item) => item.capability === "perp_liquidation_max_pain"));

    const routeResponse = await fetch(`${baseUrl}/agent-router/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "perp_liquidation_max_pain",
        params: {
          asset: "BTC",
          market_type: "perpetual_futures",
          window: "current"
        },
        constraints: {
          max_price_usdc: "0.05",
          freshness_seconds: 300,
          min_confidence: 0.7
        }
      })
    });
    assert.equal(routeResponse.status, 200);
    const routed = await routeResponse.json();
    assert.equal(routed.ok, true);
    assert.equal(routed.status, "routed");
    assert.equal(routed.request.capability, "perp_liquidation_max_pain");
    assert.equal(routed.selected_service.service_id, "btc_liquidation_max_pain_demo");
    assert.equal(routed.selected_service.trust_score, 0.7);
    assert.match(routed.selected_service.selection_reason, /trust=/);
    assert.equal(routed.quote.quote_version, "agent_router_payment_quote_v1");
    assert.equal(routed.quote.would_pay, true);
    assert.equal(routed.quote.payment_backend.backend, "dev");
    assert.equal(routed.verification.schema_valid, true);
    assert.equal(routed.feedback.settlement_receipt.protocol, "x402");
    assert.equal(routed.protocol.semantic_parser, "external_main_agent");
    assert.equal(routed.consumer_feedback_request.endpoint, "/agent-router/feedback");
    assert.equal(routed.consumer_feedback_request.service_id, "btc_liquidation_max_pain_demo");
    assert.equal(routed.consumer_feedback_request.request_id, routed.result.request_id);
    assert.equal(routed.evidence.evidence_version, "agent_router_evidence_v1");
    assert.equal(routed.evidence.route_type, "structured_capability_request");
    assert.equal(routed.evidence.service_id, "btc_liquidation_max_pain_demo");
    assert.match(routed.evidence.trace_hash, /^0x[0-9a-f]{64}$/);
    assert.match(routed.evidence.result_hash, /^0x[0-9a-f]{64}$/);
    assert.equal(routed.evidence.arc_anchor.network, "arc");
    assert.equal(routed.evidence.arc_anchor.status, "simulated_anchor");
    assert.equal(routed.observation.observation_version, "agent_router_route_observation_v1");
    assert.equal(routed.observation.status, "routed");
    assert.equal(routed.observation.selected_service_id, "btc_liquidation_max_pain_demo");
    assert.equal(routed.observation.score_model.name, "heuristic_weighted_ranker");
    assert.equal(routed.observation.outcome.evidence_trace_hash, routed.evidence.trace_hash);

    const evidenceResponse = await fetch(`${baseUrl}/agent-router/evidence?service_id=btc_liquidation_max_pain_demo`);
    assert.equal(evidenceResponse.status, 200);
    const evidenceEvents = await evidenceResponse.json();
    assert.equal(evidenceEvents.storage, "offchain_memory_db");
    assert.equal(evidenceEvents.chain_anchor, "simulated_arc_anchor");
    assert.equal(evidenceEvents.count, 1);
    assert.equal(evidenceEvents.events[0].trace_hash, routed.evidence.trace_hash);

    const trustResponse = await fetch(`${baseUrl}/agent-router/trust?service_id=btc_liquidation_max_pain_demo`);
    assert.equal(trustResponse.status, 200);
    const trust = await trustResponse.json();
    assert.equal(trust.trust_snapshot_version, "agent_router_trust_snapshot_v1");
    assert.equal(trust.services[0].provider_id, "provider_derivatives_bob");

    const feedbackResponse = await fetch(`${baseUrl}/agent-router/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service_id: routed.selected_service.service_id,
        request_id: routed.result.request_id,
        consumer_id: "test_main_agent",
        feedback: {
          intent_fit: "yes",
          answer_useful: "yes",
          data_quality_score: 0.95,
          used_in_final_answer: true,
          reason: "The result directly answered the requested liquidation max-pain task.",
          confidence: 0.9
        }
      })
    });
    assert.equal(feedbackResponse.status, 200);
    const feedbackPayload = await feedbackResponse.json();
    assert.equal(feedbackPayload.ok, true);
    assert.equal(feedbackPayload.trust.consumer_feedback_count, 1);
    assert.equal(feedbackPayload.trust.usefulness_rate, 1);

    const observationsResponse = await fetch(`${baseUrl}/agent-router/observations?service_id=btc_liquidation_max_pain_demo`);
    assert.equal(observationsResponse.status, 200);
    const observations = await observationsResponse.json();
    assert.equal(observations.observation_feed_version, "agent_router_route_observations_v1");
    assert.equal(observations.storage, "offchain_memory_db");
    assert.equal(observations.count, 1);
    assert.equal(observations.observations[0].observation_id, routed.observation.observation_id);
  });
});

test("AgentRouter services endpoint returns paginated lightweight service summaries", async () => {
  await withServer(async ({ baseUrl }) => {
    for (let index = 0; index < 3; index += 1) {
      const response = await fetch(`${baseUrl}/studio/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "static-json",
          title: `Paged Service ${index}`,
          provider_name: "Paged Provider",
          description_for_agent: "Use this service to test paginated agent hub loading.",
          capabilities: "data_service,paged_demo",
          price: "0.01",
          sample_request: "{}",
          sample_data: JSON.stringify({ records: [{ service: `paged_${index}`, score: index }] }),
          live_data: JSON.stringify({ records: [{ service: `paged_${index}`, score: index + 100 }] }),
          summary: "Paged service demo."
        })
      });
      assert.equal(response.status, 201, await response.text());
    }

    const pageResponse = await fetch(`${baseUrl}/agent-router/services?q=paged&limit=2&offset=0&verified_only=true`);
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.json();
    assert.equal(page.service_list_version, "agent_router_service_list_v2");
    assert.equal(page.total, 3);
    assert.equal(page.limit, 2);
    assert.equal(page.offset, 0);
    assert.equal(page.has_more, true);
    assert.equal(page.services.length, 2);
    assert.equal(page.services[0].latest_validation, undefined);
    assert.equal(page.services[0].sample_response, undefined);
    assert.equal(page.services[0].pre_call_context, undefined);

    const detailResponse = await fetch(`${baseUrl}/agent-router/services?q=paged&include_details=true`);
    assert.equal(detailResponse.status, 200);
    const detailPage = await detailResponse.json();
    assert.equal(detailPage.service_list_version, "agent_router_service_list_v1");
    assert.ok(detailPage.services[0].sample_response);
  });
});

test("AgentRouter quote simulates route and payment guards without invoking provider", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "perp_liquidation_max_pain",
        params: {
          asset: "BTC",
          market_type: "perpetual_futures",
          window: "current"
        },
        constraints: {
          max_price_usdc: "0.05",
          freshness_seconds: 300
        }
      })
    });
    assert.equal(response.status, 200);
    const quoted = await response.json();
    assert.equal(quoted.ok, true);
    assert.equal(quoted.status, "quoted");
    assert.equal(quoted.selected_service.service_id, "btc_liquidation_max_pain_demo");
    assert.equal(quoted.quote.would_pay, true);
    assert.equal(quoted.quote.guard_result, "pass");
    assert.equal(quoted.quote.payment_backend.backend, "dev");
    assert.equal(quoted.result, undefined);
    const feedback = await fetch(`${baseUrl}/services/btc_liquidation_max_pain_demo/feedback`).then((res) => res.json());
    assert.equal(feedback.length, 0);
  });
});

test("AgentRouter quote blocks payments above budget before invocation", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "perp_liquidation_max_pain",
        params: {
          asset: "BTC",
          market_type: "perpetual_futures",
          window: "current"
        },
        constraints: {
          max_price_usdc: "0.001"
        }
      })
    });
    assert.equal(response.status, 200);
    const quoted = await response.json();
    assert.equal(quoted.ok, false);
    assert.equal(quoted.status, "quote_blocked");
    assert.equal(quoted.quote.guard_result, "budget_too_low");
    assert.equal(quoted.quote.would_pay, false);
  });
});

test("public AgentRouter HTTP routes do not invoke paid services without protocol payment", async () => {
  const previous = process.env.ADN_ALLOW_SERVER_SIDE_DEV_PAYMENTS;
  delete process.env.ADN_ALLOW_SERVER_SIDE_DEV_PAYMENTS;
  try {
    await withServer(async ({ baseUrl }) => {
      const structured = await fetch(`${baseUrl}/agent-router/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capability: "perp_liquidation_max_pain",
          params: {
            asset: "BTC",
            market_type: "perpetual_futures",
            window: "current"
          },
          constraints: {
            max_price_usdc: "0.05"
          }
        })
      });
      assert.equal(structured.status, 200);
      const structuredPayload = await structured.json();
      assert.equal(structuredPayload.ok, false);
      assert.equal(structuredPayload.status, "payment_required");
      assert.equal("result" in structuredPayload, false);
      assert.equal(structuredPayload.protocol.invocation_policy, "quote_only_no_server_side_payment");

      const natural = await fetch(`${baseUrl}/agent-router/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          task: "BTC 当前最大爆仓痛点是多少",
          max_price: "0.05"
        })
      });
      assert.equal(natural.status, 200);
      const naturalPayload = await natural.json();
      assert.equal(naturalPayload.ok, false);
      assert.equal(naturalPayload.status, "payment_required");
      assert.equal("result" in naturalPayload, false);
      assert.match(naturalPayload.next_step, /payment-capable backend/);

      const connector = await fetch(`${baseUrl}/connector/invoke_paid_service`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          service_id: "btc_liquidation_max_pain_demo",
          input: {
            asset: "BTC",
            market_type: "perpetual_futures",
            window: "current"
          },
          budget: { max_amount: "0.05", currency: "USDC" }
        })
      });
      assert.equal(connector.status, 402);
      const connectorPayload = await connector.json();
      assert.equal(connectorPayload.ok, false);
      assert.equal(connectorPayload.status, "payment_required");
      assert.equal("result" in connectorPayload, false);
    });
  } finally {
    if (previous === undefined) process.env.ADN_ALLOW_SERVER_SIDE_DEV_PAYMENTS = "1";
    else process.env.ADN_ALLOW_SERVER_SIDE_DEV_PAYMENTS = previous;
  }
});

test("public provider endpoints reject dev payment mode even with direct endpoint access", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/provider/btc-liquidation-max-pain`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-host": "agentrouter-markets.onrender.com"
      },
      body: JSON.stringify({
        asset: "BTC",
        market_type: "perpetual_futures",
        window: "current"
      })
    });
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(payload.code, "PUBLIC_DEV_PAYMENT_DISABLED");
    assert.equal("result" in payload, false);
  });
});

test("AgentRouter MCP server exposes Claude-callable tools", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    const client = createMcpClient({ AGENT_ROUTER_URL: baseUrl, ADN_WALLET_PASSPHRASE: "" });
    try {
      const initialized = await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mvp-test", version: "0.1.0" }
      });
      assert.equal(initialized.serverInfo.name, "AgentRouter");
      assert.equal(initialized.agentrouter.auto_wallet.enabled, true);
      assert.equal(initialized.agentrouter.auto_wallet.created, true);
      assert.equal(initialized.agentrouter.auto_wallet.status, "wallet_ready");
      assert.equal(initialized.agentrouter.auto_wallet.key_management, "local_session_secret");
      assert.match(initialized.agentrouter.auto_wallet.address, /^0x[0-9a-f]{40}$/);

      const listed = await client.request("tools/list", {});
      assert.ok(listed.tools.some((tool) => tool.name === "agentrouter_ask"));
      assert.ok(listed.tools.some((tool) => tool.name === "agentrouter_request"));
      assert.ok(listed.tools.some((tool) => tool.name === "agentrouter_quote"));
      assert.ok(listed.tools.some((tool) => tool.name === "agentrouter_wallet_status"));
      assert.ok(listed.tools.some((tool) => tool.name === "agentrouter_wallet_create"));
      assert.ok(listed.tools.some((tool) => tool.name === "agentrouter_wallet_init"));
      assert.ok(listed.tools.some((tool) => tool.name === "agentrouter_wallet_setup"));

      const walletStatusCall = await client.request("tools/call", {
        name: "agentrouter_wallet_status",
        arguments: {}
      });
      const walletPayload = JSON.parse(walletStatusCall.content[0].text);
      assert.equal(walletPayload.initialized, true);
      assert.equal(walletPayload.address_type, "evm");
      assert.equal(walletPayload.key_management, "local_session_secret");
      assert.equal(walletPayload.payment_backend, "dev");
      assert.equal(walletPayload.arc_payment_active, false);
      assert.match(walletPayload.paid_request_behavior, /not using Arc local-wallet settlement/);
      assert.match(walletPayload.address, /^0x[0-9a-f]{40}$/);
      assert.equal("private_key_pem" in walletPayload, false);

      const called = await client.request("tools/call", {
        name: "agentrouter_request",
        arguments: {
          capability: "perp_liquidation_max_pain",
          params: {
            asset: "BTC",
            market_type: "perpetual_futures",
            window: "current"
          },
          constraints: {
            max_price_usdc: "0.05",
            freshness_seconds: 300
          }
        }
      });
      const routed = JSON.parse(called.content[0].text);
      assert.equal(routed.ok, true);
      assert.equal(routed.selected_service.service_id, "btc_liquidation_max_pain_demo");
      assert.equal(routed.protocol.semantic_parser, "external_main_agent");
      assert.equal(routed.result.data.max_liquidation_pain_price, 103500);
      assert.match(routed.evidence.trace_hash, /^0x[0-9a-f]{64}$/);
    } finally {
      client.close();
    }
  });
});

test("AgentRouter npm MCP package exposes the same structured tools", async () => {
  await withServer(async ({ baseUrl }) => {
    const client = createMcpClient(
      { AGENT_ROUTER_URL: baseUrl },
      "packages/agentrouter-mcp/bin/agentrouter-mcp.js"
    );
    try {
      const initialized = await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "npm-package-test", version: "0.1.0" }
      });
      assert.equal(initialized.serverInfo.name, "AgentRouter");

      const listed = await client.request("tools/list", {});
      assert.ok(listed.tools.some((tool) => tool.name === "agentrouter_request"));
      assert.ok(listed.tools.some((tool) => tool.name === "agentrouter_capabilities"));
    } finally {
      client.close();
    }
  });
});

test("AgentRouter structured request returns machine-readable validation errors", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "perp_liquidation_max_pain",
        params: {
          asset: "BTC",
          window: "current"
        }
      })
    });
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, "MISSING_REQUIRED_PARAM");
    assert.deepEqual(body.missing, ["market_type"]);
    assert.equal(body.expected_schema.type, "object");
  });
});

test("AgentRouter ask wrapper returns clarification for ambiguous max pain", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/agent-router/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "BTC 最大痛点是多少？"
      })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "needs_clarification");
    assert.equal(body.options[0].request.capability, "perp_liquidation_max_pain");
    assert.equal(body.options[1].request.capability, "options_max_pain");
  });
});

test("router routes ambiguous BTC liquidation task with explicit assumption and verifies result", async () => {
  await withServer(async ({ baseUrl }) => {
    const connector = new DiscoveryConnector({ baseUrl });
    const routed = await connector.routeTask({
      task: "BTC 当前最大爆仓痛点是多少",
      constraints: {
        max_price_usdc: "0.05",
        freshness_seconds: 300
      }
    });
    assert.equal(routed.status, "route_with_assumption");
    assert.equal(routed.normalized_intent.capability, "perp_liquidation_max_pain");
    assert.equal(routed.normalized_intent.asset, "BTC");
    assert.equal(routed.selected_service.service_id, "btc_liquidation_max_pain_demo");
    assert.match(routed.assumptions[0], /永续合约/);
    assert.equal(routed.verification.schema_valid, true);
    assert.equal(routed.verification.freshness_valid, true);
    assert.equal(routed.verification.coverage_valid, true);
    assert.equal(routed.result.data.max_liquidation_pain_price, 103500);
  });
});

test("router asks for clarification when max pain task omits market type", async () => {
  await withServer(async ({ baseUrl }) => {
    const connector = new DiscoveryConnector({ baseUrl });
    const routed = await connector.routeTask({
      task: "BTC 最大痛点是多少",
      constraints: {
        max_price_usdc: "0.05",
        freshness_seconds: 300
      }
    });
    assert.equal(routed.status, "needs_clarification");
    assert.equal(routed.ambiguities[0].field, "capability");
    assert.match(routed.ambiguities[0].question, /永续合约/);
  });
});

test("budget guard blocks paid invocation when service is too expensive", async () => {
  await withServer(async ({ baseUrl }) => {
    const connector = new DiscoveryConnector({ baseUrl });
    await assert.rejects(
      () => connector.invokePaidService("chain_fund_flow_7d_base", { chain: "base", days: 7 }, { max_amount: "0.001", currency: "USDC" }),
      /Service costs/
    );
  });
});

test("provider onboarding CLI creates config, registers, validates, and enables paid invocation", async () => {
  await withServer(async ({ baseUrl }) => {
    const onboard = await runCli(["provider", "onboard", "--yes"], {
      ADN_REGISTRY_URL: baseUrl
    });
    assert.equal(onboard.code, 0, onboard.stderr);
    const payload = JSON.parse(onboard.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.service_id, "community_sentiment_demo");
    assert.equal(payload.validation.ok, true);

    const connector = new DiscoveryConnector({ baseUrl });
    const services = await connector.searchServices({
      query: "sentiment demo",
      capabilities: ["sentiment_data"],
      max_price: "0.05"
    });
    assert.equal(services.length, 1);
    assert.equal(services[0].service_id, "community_sentiment_demo");

    const invocation = await connector.invokePaidService(
      "community_sentiment_demo",
      { asset: "ETH", window: "7d" },
      { max_amount: "0.05", currency: "USDC" }
    );
    assert.equal(invocation.result.status, "success");
    assert.equal(invocation.result.data.asset, "ETH");
    assert.equal(invocation.feedback.schema_valid, true);
  });
});

test("hosted-http onboarding stores provider secret privately and calls upstream after payment", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    const onboard = await runCli(["provider", "onboard", "--mode", "hosted-http", "--yes"], {
      ADN_REGISTRY_URL: baseUrl
    });
    assert.equal(onboard.code, 0, onboard.stderr);
    const payload = JSON.parse(onboard.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.service_id, "hosted_http_sentiment_demo");
    assert.equal(payload.validation.ok, true);

    const config = JSON.parse(await fs.readFile(path.join(process.env.ADN_PROVIDER_DIR, "hosted_http_sentiment_demo.json"), "utf8"));
    assert.equal(config.source.auth.secret_value, undefined);
    assert.equal(config.source.auth.secret_ref, "hosted_http_sentiment_demo:PROVIDER_SECRET");
    assert.equal(config.manifest.runtime_secrets.public, false);
    assert.equal(JSON.stringify(config.manifest).includes("demo-provider-secret"), false);
    assert.equal(JSON.stringify(config).includes("demo-provider-secret"), false);

    await runCli(["wallet", "init"], { ADN_REGISTRY_URL: baseUrl });
    const invoke = await runCli(["invoke", "hosted_http_sentiment_demo", "{\"asset\":\"ETH\",\"window\":\"7d\"}"], {
      ADN_REGISTRY_URL: baseUrl
    });
    assert.equal(invoke.code, 0, invoke.stderr);
    const invocation = JSON.parse(invoke.stdout);
    assert.equal(invocation.result.status, "success");
    assert.equal(invocation.result.data.source, "mock_upstream_sentiment");
    assert.equal(invocation.result.data.sentiment_score, 0.79);
  });
});

test("provider secret storage can bootstrap a local runtime key for Studio MVP", async () => {
  const previousProviderPassphrase = process.env.ADN_PROVIDER_SECRET_PASSPHRASE;
  const previousWalletPassphrase = process.env.ADN_WALLET_PASSPHRASE;
  delete process.env.ADN_PROVIDER_SECRET_PASSPHRASE;
  delete process.env.ADN_WALLET_PASSPHRASE;
  try {
    await withServer(async ({ baseUrl }) => {
      const studioResponse = await fetch(`${baseUrl}/studio/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "hosted-http",
          service_id: "studio_local_secret_key_demo",
          provider_id: "provider_studio",
          title: "Studio Local Secret Key Demo",
          description_for_agent: "Use this service to verify local secret key bootstrap.",
          capabilities: "sentiment_data,hosted_http,demo_data",
          price: "0.01",
          sample_request: "{\"asset\":\"ETH\",\"window\":\"7d\"}",
          sample_data: "{\"asset\":\"ETH\",\"sentiment_score\":0.61,\"sample\":true}",
          summary: "ETH sentiment from Provider Studio.",
          upstream_url: "/mock/upstream/sentiment",
          upstream_method: "POST",
          secret_name: "PROVIDER_SECRET",
          secret_value: "demo-provider-secret",
          auth_header: "authorization"
        })
      });
      assert.equal(studioResponse.status, 201);
      const payload = await studioResponse.json();
      assert.equal(payload.ok, true);
      const keyFile = await fs.readFile(path.join(process.env.ADN_DIR, "provider-secret.key"), "utf8");
      assert.ok(keyFile.trim().length >= 32);
      const config = JSON.parse(await fs.readFile(path.join(process.env.ADN_PROVIDER_DIR, "studio_local_secret_key_demo.json"), "utf8"));
      assert.equal(JSON.stringify(config).includes("demo-provider-secret"), false);
    });
  } finally {
    if (previousProviderPassphrase === undefined) delete process.env.ADN_PROVIDER_SECRET_PASSPHRASE;
    else process.env.ADN_PROVIDER_SECRET_PASSPHRASE = previousProviderPassphrase;
    if (previousWalletPassphrase === undefined) delete process.env.ADN_WALLET_PASSPHRASE;
    else process.env.ADN_WALLET_PASSPHRASE = previousWalletPassphrase;
  }
});

test("Provider Studio API creates and validates hosted-http service", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    const studioResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "hosted-http",
        service_id: "studio_hosted_sentiment_demo",
        provider_id: "provider_studio",
        title: "Studio Hosted Sentiment Demo",
        description_for_agent: "Use this service to fetch sentiment data through Provider Studio.",
        capabilities: "sentiment_data,hosted_http,demo_data",
        price: "0.01",
        sample_request: "{\"asset\":\"ETH\",\"window\":\"7d\"}",
        sample_data: "{\"asset\":\"ETH\",\"sentiment_score\":0.61,\"sample\":true}",
        summary: "ETH sentiment from Provider Studio is positive.",
        upstream_url: "/mock/upstream/sentiment",
        upstream_method: "POST",
        secret_name: "PROVIDER_SECRET",
        secret_value: "demo-provider-secret",
        auth_header: "authorization"
      })
    });
    assert.equal(studioResponse.status, 201);
    const payload = await studioResponse.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.service_id, "studio_hosted_sentiment_demo");
    assert.equal(payload.validation.ok, true);
    assert.equal(JSON.stringify(payload.manifest).includes("demo-provider-secret"), false);
    const config = JSON.parse(await fs.readFile(path.join(process.env.ADN_PROVIDER_DIR, "studio_hosted_sentiment_demo.json"), "utf8"));
    assert.equal(config.source.auth.secret_value, undefined);
    assert.equal(config.source.auth.secret_ref, "studio_hosted_sentiment_demo:PROVIDER_SECRET");

    await runCli(["wallet", "init"], { ADN_REGISTRY_URL: baseUrl });
    const invoke = await runCli(["invoke", "studio_hosted_sentiment_demo", "{\"asset\":\"ETH\",\"window\":\"7d\"}"], {
      ADN_REGISTRY_URL: baseUrl
    });
    assert.equal(invoke.code, 0, invoke.stderr);
    const invocation = JSON.parse(invoke.stdout);
    assert.equal(invocation.result.data.source, "mock_upstream_sentiment");
  });
});

test("Provider Studio auto-detects common API key headers during validation", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    const studioResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "hosted-http",
        service_id: "studio_auto_auth_header_demo",
        provider_id: "provider_studio",
        title: "Studio Auto Auth Header Demo",
        description_for_agent: "Use this service to fetch a generic provider dataset with automatic auth header detection.",
        capabilities: "data_service,provider_api_demo",
        price: "0.01",
        sample_request: "{}",
        sample_data: "{\"status\":\"success\",\"rows\":[{\"metric\":\"sample_metric\",\"value\":42}]}",
        summary: "Generic provider API returned one row.",
        upstream_url: "/mock/upstream/header-key",
        upstream_method: "GET",
        secret_name: "PROVIDER_SECRET",
        secret_value: "demo-provider-secret",
        auth_header: ""
      })
    });
    assert.equal(studioResponse.status, 201);
    const payload = await studioResponse.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.validation.ok, true);
    assert.equal(payload.validation.result_preview.rows[0].value, 42);
    const config = JSON.parse(await fs.readFile(path.join(process.env.ADN_PROVIDER_DIR, "studio_auto_auth_header_demo.json"), "utf8"));
    assert.equal(config.source.auth.header, "auto");
    assert.equal(JSON.stringify(config).includes("demo-provider-secret"), false);
  });
});

test("hosted HTTP providers honor agent limit and keep compact validation previews", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    const studioResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "hosted-http",
        service_id: "studio_limited_rows_demo",
        provider_id: "provider_studio",
        title: "Studio Limited Rows Demo",
        description_for_agent: "Use this service to fetch provider rows with a caller-specified limit.",
        capabilities: "data_service,provider_api_demo",
        price: "0.01",
        sample_request: "{\"limit\":2,\"total_rows\":7}",
        sample_data: "{\"status\":\"success\",\"rows\":[{\"metric\":\"sample_metric_1\",\"value\":42}]}",
        summary: "Generic provider API returned limited rows.",
        upstream_url: "/mock/upstream/header-key",
        upstream_method: "GET",
        secret_name: "PROVIDER_SECRET",
        secret_value: "demo-provider-secret",
        auth_header: ""
      })
    });
    assert.equal(studioResponse.status, 201);
    const payload = await studioResponse.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.validation.ok, true);
    assert.equal(payload.validation.result_preview.rows.length, 2);
    assert.equal(payload.validation.result_preview.agentrouter_page.total_available, 7);
    assert.equal(payload.validation.result_preview.agentrouter_page.truncated, true);

    const invokeResponse = await fetch(`${baseUrl}/connector/invoke_paid_service`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service_id: "studio_limited_rows_demo",
        input: { limit: 3, total_rows: 9 },
        budget: { max_amount: "0.05", currency: "USDC" }
      })
    });
    assert.equal(invokeResponse.status, 200);
    const invocation = await invokeResponse.json();
    assert.equal(invocation.result.data.rows.length, 3);
    assert.equal(invocation.result.data.agentrouter_page.total_available, 9);
    assert.equal(invocation.result.data.agentrouter_page.returned, 3);
  });
});

test("Provider Studio rejects duplicate or invalid service submissions", async () => {
  await withServer(async ({ baseUrl }) => {
    const invalid = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "static-json",
        service_id: "Bad Service",
        provider_id: "provider",
        title: "Bad",
        description_for_agent: "Bad service.",
        capabilities: "demo",
        price: "0",
        sample_request: "{}",
        sample_data: "{}",
        live_data: "{}",
        summary: "Bad"
      })
    });
    assert.equal(invalid.status, 422);
    const invalidBody = await invalid.json();
    assert.match(invalidBody.error.message, /price/);

    const duplicate = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "static-json",
        service_id: "chain_fund_flow_7d_base",
        provider_id: "provider",
        title: "Duplicate",
        description_for_agent: "Duplicate.",
        capabilities: "demo",
        price: "0.01",
        sample_request: "{}",
        sample_data: "{}",
        live_data: "{}",
        summary: "Duplicate"
      })
    });
    assert.equal(duplicate.status, 422);
    const duplicateBody = await duplicate.json();
    assert.match(duplicateBody.error.message, /already registered/);
  });
});

test("Provider Studio can auto-generate service and provider ids", async () => {
  await withServer(async ({ baseUrl }) => {
    const studioResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "static-json",
        title: "My Alpha Feed",
        provider_name: "Alice Data Lab",
        description_for_agent: "Use this service to fetch a simple alpha demo feed.",
        price: "0.01",
        sample_request: "{\"asset\":\"BTC\"}",
        sample_data: "{\"asset\":\"BTC\",\"score\":0.5,\"sample\":true}",
        live_data: "{\"asset\":\"BTC\",\"score\":0.8}",
        summary: "BTC alpha score is positive."
      })
    });
    assert.equal(studioResponse.status, 201);
    const payload = await studioResponse.json();
    assert.equal(payload.service_id, "my_alpha_feed");
    assert.equal(payload.manifest.provider.provider_id, "alice_data_lab");
    assert.deepEqual(payload.manifest.capabilities, ["data_service"]);
  });
});

test("Provider Studio can derive preview data from result data by default", async () => {
  await withServer(async ({ baseUrl }) => {
    const studioResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "static-json",
        title: "Derived Preview Feed",
        provider_name: "Alice Data Lab",
        description_for_agent: "Use this service to fetch a derived preview demo feed.",
        price: "0.01",
        sample_request: "{\"asset\":\"BTC\"}",
        sample_data: "{\"asset\":\"BTC\",\"score\":0.8}",
        live_data: "{\"asset\":\"BTC\",\"score\":0.8}",
        summary: "BTC score is positive."
      })
    });
    assert.equal(studioResponse.status, 201);
    const payload = await studioResponse.json();
    assert.deepEqual(payload.manifest.sample_response.data, { asset: "BTC", score: 0.8 });
  });
});

test("consumer feedback updates trust and affects later routing", async () => {
  await withServer(async ({ baseUrl }) => {
    for (const service of [
      {
        service_id: "alpha_signal_good_source",
        provider_id: "provider_alpha_good",
        title: "Alpha Signal Good Source",
        score: 0.91,
        summary: "Alpha signal from the good source."
      },
      {
        service_id: "alpha_signal_weak_source",
        provider_id: "provider_alpha_weak",
        title: "Alpha Signal Weak Source",
        score: 0.12,
        summary: "Alpha signal from the weak source."
      }
    ]) {
      const response = await fetch(`${baseUrl}/studio/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "static-json",
          service_id: service.service_id,
          provider_id: service.provider_id,
          title: service.title,
          description_for_agent: "Use this service to fetch generic alpha signal data.",
          capabilities: "data_service,alpha_signal",
          price: "0.01",
          sample_request: "{}",
          sample_data: JSON.stringify({ alpha_signal_score: service.score, source: service.service_id }),
          live_data: JSON.stringify({ alpha_signal_score: service.score, source: service.service_id }),
          summary: service.summary
        })
      });
      assert.equal(response.status, 201);
    }

    const goodFeedback = await fetch(`${baseUrl}/agent-router/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service_id: "alpha_signal_good_source",
        request_id: "manual_eval_good",
        consumer_id: "test_main_agent",
        feedback: {
          intent_fit: "yes",
          answer_useful: "yes",
          data_quality_score: 0.95,
          used_in_final_answer: true,
          reason: "The data was directly usable for the alpha signal task.",
          confidence: 0.9
        }
      })
    }).then((res) => res.json());
    assert.equal(goodFeedback.ok, true);

    const weakFeedback = await fetch(`${baseUrl}/agent-router/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service_id: "alpha_signal_weak_source",
        request_id: "manual_eval_weak",
        consumer_id: "test_main_agent",
        feedback: {
          intent_fit: "partial",
          answer_useful: "no",
          data_quality_score: 0.2,
          used_in_final_answer: false,
          reason: "The data was related but not useful enough for the answer.",
          confidence: 0.8
        }
      })
    }).then((res) => res.json());
    assert.equal(weakFeedback.ok, true);
    assert.ok(goodFeedback.trust.trust_score > weakFeedback.trust.trust_score);

    const routeResponse = await fetch(`${baseUrl}/agent-router/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "alpha_signal",
        params: {},
        constraints: { max_price_usdc: "0.05" }
      })
    });
    assert.equal(routeResponse.status, 200);
    const routed = await routeResponse.json();
    assert.equal(routed.ok, true);
    assert.equal(routed.selected_service.service_id, "alpha_signal_good_source");
    assert.match(routed.selected_service.selection_reason, /consumer_feedback=1/);
  });
});

test("AgentRouter routes generic netflow requests to dynamic registered services", async () => {
  await withServer(async ({ baseUrl }) => {
    const studioResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "static-json",
        title: "ETH Spot Netflow 24h",
        provider_name: "Flow Data Lab",
        description_for_agent: "Use this service to fetch ETH spot netflow data for recent windows.",
        price: "0.01",
        sample_request: "{\"asset\":\"ETH\",\"window\":\"24h\"}",
        sample_data: "{\"asset\":\"ETH\",\"window\":\"24h\",\"netflow_usd\":12345}",
        live_data: "{\"asset\":\"ETH\",\"window\":\"24h\",\"netflow_usd\":23456}",
        summary: "ETH 24h spot netflow is positive."
      })
    });
    assert.equal(studioResponse.status, 201);
    const provider = await studioResponse.json();
    assert.ok(provider.manifest.capabilities.includes("netflow"));

    const askResponse = await fetch(`${baseUrl}/agent-router/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "查询ETH的近24小时的netflow",
        max_price: "0.05"
      })
    });
    assert.equal(askResponse.status, 200);
    const routed = await askResponse.json();
    assert.equal(routed.ok, true);
    assert.equal(routed.request.capability, "netflow");
    assert.equal(routed.selected_service.service_id, "eth_spot_netflow_24h");
    assert.deepEqual(routed.input, { asset: "ETH", window: "24h" });
    assert.equal(routed.result.data.netflow_usd, 23456);
  });
});

test("AgentRouter resolves token symbols before invoking token-address services", async () => {
  await withServer(async ({ baseUrl }) => {
    const newsSearchResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "static-json",
        service_id: "article_news_search",
        title: "Search articles and news",
        provider_name: "News Lab",
        description_for_agent: "Use this service to search articles and news by keyword.",
        capabilities: "data_service,news_data,article_data",
        price: "0.01",
        sample_request: "{\"name\":\"AZTEC\"}",
        sample_data: "{\"articles\":[{\"title\":\"AZTEC news\"}]}",
        live_data: "{\"articles\":[{\"title\":\"AZTEC news\"}]}",
        summary: "Search article and news content."
      })
    });
    assert.equal(newsSearchResponse.status, 201);

    const searchResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "static-json",
        service_id: "token_search_resolver",
        title: "Token Search Resolver",
        provider_name: "Token Directory Lab",
        description_for_agent: "Use this service to search token symbols and resolve contract addresses by chain.",
        capabilities: "data_service,token_search,entity_search,token_metadata",
        price: "0.01",
        sample_request: "{\"search_query\":\"AZTEC\",\"result_type\":\"token\",\"chain\":\"ethereum\",\"limit\":5}",
        sample_data: "{\"data\":[{\"symbol\":\"AZTEC\",\"name\":\"Aztec\",\"token_address\":\"0x1234567890abcdef1234567890abcdef12345678\",\"chain\":\"ethereum\"}]}",
        live_data: "{\"data\":[{\"symbol\":\"AZTEC\",\"name\":\"Aztec\",\"token_address\":\"0x1234567890abcdef1234567890abcdef12345678\",\"chain\":\"ethereum\"}]}",
        summary: "Resolve token symbols to token contract addresses."
      })
    });
    assert.equal(searchResponse.status, 201);

    const dexTradesResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "static-json",
        service_id: "token_dex_trades",
        title: "Token God Mode DEX Trades",
        provider_name: "Token Flow Lab",
        description_for_agent: "Use this service for token-level DEX trades and token swap activity.",
        capabilities: "data_service,token_god_mode,token_data,dex_trades,token_activity",
        price: "0.01",
        sample_request: "{\"chain\":\"ethereum\",\"token_address\":\"0x0000000000000000000000000000000000000000\",\"timeframe\":\"1d\"}",
        sample_data: "{\"token_symbol\":\"AZTEC\",\"token_address\":\"0x1234567890abcdef1234567890abcdef12345678\",\"trades\":[]}",
        live_data: "{\"token_symbol\":\"AZTEC\",\"token_address\":\"0x1234567890abcdef1234567890abcdef12345678\",\"trades\":[]}",
        summary: "Token-level DEX trades."
      })
    });
    assert.equal(dexTradesResponse.status, 201);

    const flowResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "static-json",
        service_id: "token_flow_intelligence",
        title: "Token God Mode Flow Intelligence",
        provider_name: "Token Flow Lab",
        description_for_agent: "Use this service for token-level smart money activity, token flow intelligence, buyer seller movement, and recent token flow analysis.",
        capabilities: "data_service,token_god_mode,token_data,flow_intelligence,token_flow,buyer_seller_flow,smart_money",
        price: "0.01",
        sample_request: "{\"chain\":\"ethereum\",\"token_address\":\"0x0000000000000000000000000000000000000000\",\"timeframe\":\"1d\"}",
        sample_data: "{\"token_symbol\":\"AZTEC\",\"token_address\":\"0x1234567890abcdef1234567890abcdef12345678\",\"window\":\"24h\",\"smart_money_netflow_usd\":120000}",
        live_data: "{\"token_symbol\":\"AZTEC\",\"token_address\":\"0x1234567890abcdef1234567890abcdef12345678\",\"window\":\"24h\",\"smart_money_netflow_usd\":220000}",
        summary: "Token-level smart money flow intelligence."
      })
    });
    assert.equal(flowResponse.status, 201);

    const askResponse = await fetch(`${baseUrl}/agent-router/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "通过 AgentRouter 查询 AZTEC 的聪明钱近24小时的动向",
        max_price: "0.05"
      })
    });
    assert.equal(askResponse.status, 200);
    const routed = await askResponse.json();
    assert.equal(routed.ok, true);
    assert.equal(routed.selected_service.service_id, "token_flow_intelligence");
    assert.equal(routed.token_resolution.status, "resolved");
    assert.equal(routed.token_resolution.resolver_service_id, "token_search_resolver");
    assert.equal(routed.input.token_address, "0x1234567890abcdef1234567890abcdef12345678");
    assert.equal(routed.input.chain, "ethereum");
    assert.equal(routed.input.timeframe, "1d");
    assert.equal(routed.result.data.smart_money_netflow_usd, 220000);

    const structuredResponse = await fetch(`${baseUrl}/agent-router/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "token_smart_money_activity",
        params: {
          token_symbol: "AZTEC",
          chain: "ethereum",
          window: "24h",
          pagination: { page: 1, per_page: 24 }
        },
        constraints: { max_price_usdc: "0.05" }
      })
    });
    assert.equal(structuredResponse.status, 200);
    const structured = await structuredResponse.json();
    assert.equal(structured.ok, true);
    assert.equal(structured.protocol.semantic_parser, "external_main_agent");
    assert.equal(structured.selected_service.service_id, "token_flow_intelligence");
    assert.equal(structured.token_resolution.status, "resolved");
    assert.equal(structured.token_resolution.resolver_service_id, "token_search_resolver");
    assert.equal(structured.input.token_address, "0x1234567890abcdef1234567890abcdef12345678");
    assert.equal(structured.result.data.smart_money_netflow_usd, 220000);
  });
});

test("AgentRouter builds service-aware input for address profile endpoints", async () => {
  await withServer(async ({ baseUrl }) => {
    const studioResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "static-json",
        title: "Address Related Wallets",
        provider_name: "Wallet Intel Lab",
        description_for_agent: "Use this service to fetch related wallets for an EVM address by chain.",
        capabilities: "data_service,wallet_profile,address_intelligence,related_wallets,wallet_cluster",
        price: "0.01",
        sample_request: "{\"address\":\"0x0000000000000000000000000000000000000000\",\"chain\":\"ethereum\",\"pagination\":{\"page\":1,\"per_page\":10}}",
        sample_data: "{\"data\":[],\"pagination\":{\"page\":1,\"per_page\":10,\"is_last_page\":true}}",
        live_data: "{\"data\":[{\"address\":\"0x1111111111111111111111111111111111111111\",\"relation\":\"Deployed Contract\"}],\"pagination\":{\"page\":1,\"per_page\":3,\"is_last_page\":true}}",
        summary: "Related wallet data for address due diligence."
      })
    });
    assert.equal(studioResponse.status, 201);

    const distractorResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "static-json",
        title: "Address Points Leaderboard",
        provider_name: "Wallet Intel Lab",
        description_for_agent: "Use this service to fetch points leaderboard rows for addresses.",
        capabilities: "data_service,wallet_profile,leaderboard_data,points",
        price: "0.01",
        sample_request: "{\"address\":\"0x0000000000000000000000000000000000000000\",\"pagination\":{\"page\":1,\"per_page\":10}}",
        sample_data: "{\"results\":[],\"page\":1}",
        live_data: "{\"results\":[{\"address\":\"0x2222222222222222222222222222222222222222\",\"rank\":1}],\"page\":1}",
        summary: "Address points leaderboard."
      })
    });
    assert.equal(distractorResponse.status, 201);

    const askResponse = await fetch(`${baseUrl}/agent-router/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "查询地址 0xbbfb6566ad064c233af6314aeb1eee4c26a5f921 在 Arbitrum 的 related wallets 前 3 条",
        max_price: "0.05"
      })
    });
    assert.equal(askResponse.status, 200);
    const routed = await askResponse.json();
    assert.equal(routed.ok, true);
    assert.equal(routed.selected_service.service_id, "address_related_wallets");
    assert.deepEqual(routed.input, {
      address: "0xbbfb6566ad064c233af6314aeb1eee4c26a5f921",
      chain: "arbitrum",
      pagination: { page: 1, per_page: 3 }
    });
    assert.equal(routed.result.data.data[0].relation, "Deployed Contract");
  });
});

test("hosted publish requires persistent storage when the deployment requires it", async () => {
  const previousRequired = process.env.ADN_REQUIRE_PERSISTENT_REGISTRY;
  const previousDatabase = process.env.DATABASE_URL;
  const previousPassphrase = process.env.ADN_PROVIDER_SECRET_PASSPHRASE;
  process.env.ADN_REQUIRE_PERSISTENT_REGISTRY = "true";
  delete process.env.DATABASE_URL;
  process.env.ADN_PROVIDER_SECRET_PASSPHRASE = "stable-test-passphrase";
  try {
    await withServer(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/studio/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "hosted-http",
          service_id: "persistent_required_demo",
          provider_id: "provider_studio",
          title: "Persistent Required Demo",
          description_for_agent: "Use this service to verify hosted publish persistence guards.",
          capabilities: "persistent_required_demo,data_service",
          price: "0.01",
          sample_request: "{}",
          sample_data: "{\"ok\":true}",
          summary: "Persistent required demo.",
          upstream_url: "/mock/upstream/sentiment",
          upstream_method: "POST",
          secret_name: "PROVIDER_SECRET",
          secret_value: "provider-owned-secret",
          auth_header: "authorization"
        })
      });
      assert.equal(response.status, 503);
      const payload = await response.json();
      assert.equal(payload.error.code, "PERSISTENT_REGISTRY_REQUIRED");
    });
  } finally {
    if (previousRequired === undefined) delete process.env.ADN_REQUIRE_PERSISTENT_REGISTRY;
    else process.env.ADN_REQUIRE_PERSISTENT_REGISTRY = previousRequired;
    if (previousDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabase;
    if (previousPassphrase === undefined) delete process.env.ADN_PROVIDER_SECRET_PASSPHRASE;
    else process.env.ADN_PROVIDER_SECRET_PASSPHRASE = previousPassphrase;
  }
});

test("AgentRouter ask does not route partial token-only matches to unrelated services", async () => {
  await withServer(async ({ baseUrl }) => {
    const askResponse = await fetch(`${baseUrl}/agent-router/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "用 AgentRouter 查询 BTC custom metric 数据",
        max_price: "0.05"
      })
    });
    assert.equal(askResponse.status, 200);
    const routed = await askResponse.json();
    assert.equal(routed.ok, false);
    assert.equal(routed.status, "no_service_found");
    assert.equal(routed.selected_service, undefined);
  });
});

test("Provider Studio imports OpenAPI data endpoints into multiple services", async () => {
  await withServer(async ({ server, baseUrl }) => {
    const discoverResponse = await fetch(`${baseUrl}/studio/import/discover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_url: `${baseUrl}/mock/api`,
        default_price: "0.01"
      })
    });
    assert.equal(discoverResponse.status, 200);
    const discovered = await discoverResponse.json();
    assert.equal(discovered.ok, true);
    assert.equal(discovered.drafts.length, 2);
    assert.equal(discovered.skipped.length, 2);
    assert.deepEqual(
      discovered.drafts.map((draft) => draft.service_id).sort(),
      ["get_funding_rate", "get_liquidation_max_pain"]
    );
    assert.deepEqual(
      discovered.drafts.find((draft) => draft.service_id === "get_funding_rate").preview_data,
      { asset: "BTC", funding_rate: 0.00018, venue: "Binance" }
    );

    const publishResponse = await fetch(`${baseUrl}/studio/import/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ drafts: discovered.drafts, publish_scope: "local_only" })
    });
    assert.equal(publishResponse.status, 201);
    const published = await publishResponse.json();
    assert.equal(published.ok, true);
    assert.equal(published.published.length, 2);

    const duplicateDraft = {
      ...discovered.drafts.find((draft) => draft.service_id === "get_funding_rate"),
      service_id: "get_funding_rate_copy"
    };
    const duplicateResponse = await fetch(`${baseUrl}/studio/import/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ drafts: [duplicateDraft], publish_scope: "local_only" })
    });
    assert.equal(duplicateResponse.status, 201);
    const duplicate = await duplicateResponse.json();
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.published[0].already_registered, true);
    assert.equal(duplicate.published[0].duplicate_reason, "same_provider_source");
    assert.equal(duplicate.published[0].service_id, "get_funding_rate");
    assert.equal(server.store.services.has("get_funding_rate_copy"), false);

    const connector = new DiscoveryConnector({ baseUrl });
    const services = await connector.searchServices({
      query: "funding rate",
      max_price: "0.05",
      verified_only: true
    });
    assert.ok(services.some((service) => service.service_id === "get_funding_rate"));

    const invocation = await connector.invokePaidService(
      "get_funding_rate",
      { asset: "BTC" },
      { max_amount: "0.05", currency: "USDC" }
    );
    assert.equal(invocation.result.status, "success");
    assert.equal(invocation.result.data.asset, "BTC");
    assert.equal(invocation.result.data.source, "mock_openapi");

    const dynamicResponse = await fetch(`${baseUrl}/agent-router/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "funding_rate",
        params: { asset: "BTC" },
        constraints: { max_price_usdc: "0.05" }
      })
    });
    assert.equal(dynamicResponse.status, 200);
    const dynamicRouted = await dynamicResponse.json();
    assert.equal(dynamicRouted.ok, true);
    assert.equal(dynamicRouted.request.capability, "funding_rate");
    assert.equal(dynamicRouted.selected_service.service_id, "get_funding_rate");
    assert.deepEqual(dynamicRouted.input, { asset: "BTC" });
    assert.equal(dynamicRouted.result.data.source, "mock_openapi");

    const askResponse = await fetch(`${baseUrl}/agent-router/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "BTC 当前最大爆仓痛点是多少",
        max_price: "0.05"
      })
    });
    assert.equal(askResponse.status, 200);
    const routed = await askResponse.json();
    assert.equal(routed.ok, true);
    assert.equal(routed.request.capability, "perp_liquidation_max_pain");
    assert.equal(routed.selected_service.service_id, "get_liquidation_max_pain");
    assert.equal(routed.result.data.source, "mock_openapi");
    assert.equal(routed.feedback.schema_valid, true);
  });
});

test("Provider Studio imports a direct API endpoint when no OpenAPI document exists", async () => {
  await withServer(async ({ baseUrl }) => {
    const endpointUrl = `${baseUrl}/api/v1/data/market-snapshot`;
    const discoverResponse = await fetch(`${baseUrl}/studio/import/discover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_url: endpointUrl,
        default_price: "0.01",
        secret_value: "provider-owned-secret"
      })
    });
    assert.equal(discoverResponse.status, 200);
    const discovered = await discoverResponse.json();
    assert.equal(discovered.ok, true);
    assert.equal(discovered.mode, "direct_endpoint");
    assert.equal(discovered.drafts.length, 1);
    const draft = discovered.drafts[0];
    assert.equal(draft.upstream_url, endpointUrl);
    assert.equal(draft.method, "POST");
    assert.equal(draft.auth_header, "auto");
    assert.equal(draft.secret_name, "PROVIDER_SECRET");
    assert.ok(draft.capabilities.includes("data_service"));
    assert.deepEqual(draft.sample_request, {});
    assert.deepEqual(draft.preview_data, { ok: true });

    const publishResponse = await fetch(`${baseUrl}/studio/import/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ drafts: discovered.drafts, publish_scope: "local_only" })
    });
    assert.equal(publishResponse.status, 422);
    const published = await publishResponse.json();
    assert.equal(published.ok, false);
    assert.equal(published.published.length, 0);
    assert.equal(published.failed[0].service_id, "post_api_v1_data_market_snapshot");
    assert.equal(published.failed[0].error, "VALIDATION_FAILED");
    assert.equal(published.failed[0].validation.ok, false);

    const routeResponse = await fetch(`${baseUrl}/agent-router/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "smart_money_holdings",
        params: {
          chains: ["ethereum"],
          pagination: { page: 1, per_page: 10 }
        },
        constraints: { max_price_usdc: "0.05" }
      })
    });
    assert.equal(routeResponse.status, 200);
    const routed = await routeResponse.json();
    assert.equal(routed.ok, false);
    assert.equal(routed.status, "no_match");
    assert.equal(routed.observation.observation_version, "agent_router_route_observation_v1");
    assert.equal(routed.observation.status, "no_match");
    assert.equal(routed.observation.request.capability, "smart_money_holdings");
    assert.equal(routed.observation.candidates_considered, 0);

    const observationsResponse = await fetch(`${baseUrl}/agent-router/observations?status=no_match`);
    assert.equal(observationsResponse.status, 200);
    const observations = await observationsResponse.json();
    assert.ok(observations.observations.some((event) => event.observation_id === routed.observation.observation_id));
  });
});

test("Provider Studio publish replaces an unverified duplicate service and retries validation", async () => {
  await withServer(async ({ server, baseUrl }) => {
    const serviceId = "get_api_v1_data_header_key_retry";
    server.store.services.set(serviceId, {
      manifest: {
        service_id: serviceId,
        provider: { provider_id: "api_pro_example" },
        registration: { source_fingerprint: "stale_unverified_source" }
      },
      verification_status: "pending",
      validation_runs: [{ ok: false, error: "previous validation failed" }],
      feedback_events: [],
      quality_events: [],
      health_checks: []
    });

    const publishResponse = await fetch(`${baseUrl}/studio/import/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publish_scope: "local_only",
        drafts: [{
          selected: true,
          service_id: serviceId,
          provider_id: "api_pro_example",
          provider_name: "API Pro Example",
          title: "Header key retry",
          description_for_agent: "Use this service to fetch header-key protected data.",
          capabilities: ["data_service", "header_key_retry"],
          price: "0.01",
          method: "GET",
          path: "/api/v1/data/header-key",
          upstream_url: `${baseUrl}/mock/upstream/header-key`,
          auth_header: "auto",
          secret_name: "PROVIDER_SECRET",
          secret_value: "demo-provider-secret",
          sample_request: {},
          preview_data: { status: "success", rows: [{ metric: "sample_metric_1", value: 42 }] },
          summary: "Header key retry returns one row."
        }]
      })
    });
    assert.equal(publishResponse.status, 201);
    const published = await publishResponse.json();
    assert.equal(published.ok, true);
    assert.equal(published.failed.length, 0);
    assert.equal(published.published[0].service_id, serviceId);
    assert.equal(published.published[0].validation.ok, true);
    assert.equal(server.store.services.get(serviceId).verification_status, "verified");
  });
});

test("Provider Studio imports endpoint drafts from a Skill document", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/blockbeats-skill") {
      res.writeHead(200, { "content-type": "text/markdown" });
      res.end(`# BlockBeats API Skill

Base URL: \`http://127.0.0.1:${upstream.address().port}\` Auth: All requests require Header \`api-key: $BLOCKBEATS_API_KEY\`

# 1. BTC ETF net inflow
curl -s -H "api-key: $BLOCKBEATS_API_KEY" \\
  "http://127.0.0.1:${upstream.address().port}/v1/data/btc_etf"

### Data Endpoints
BTC ETF net inflow \`GET /v1/data/btc_etf\` none
Top 10 on-chain net inflow \`GET /v1/data/top10_netflow\` \`network=solana/base/ethereum\`
`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: 0, message: "", data: { rows: [{ value: 1 }] } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
    const discovered = await discoverApiServices({
      api_url: `${baseUrl}/blockbeats-skill`,
      default_price: "0.01",
      secret_value: "bbp_test_key"
    }, baseUrl);
    assert.equal(discovered.mode, "skill_document");
    assert.equal(discovered.provider.provider_name, "BlockBeats");
    assert.ok(discovered.drafts.some((draft) => draft.path === "/v1/data/btc_etf"));
    const netflow = discovered.drafts.find((draft) => draft.path === "/v1/data/top10_netflow");
    assert.equal(netflow.auth_header, "api-key");
    assert.equal(netflow.sample_request.network, "solana");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Provider Studio imports loose endpoint references from a Skill document", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/loose-skill") {
      res.writeHead(200, { "content-type": "text/markdown" });
      res.end(`# Loose Market Skill

Base URL: http://127.0.0.1:${upstream.address().port}
Auth: Header x-api-key: $MARKET_API_KEY

## Available data calls

Name: Exchange overview
Endpoint: GET /api/market/exchanges

The ticker endpoint is also available at http://127.0.0.1:${upstream.address().port}/api/market/ticker?symbol=BTC
`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "success", data: [{ symbol: "BTC", price: 1 }] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
    const discovered = await discoverApiServices({
      api_url: `${baseUrl}/loose-skill`,
      default_price: "0.01",
      secret_value: "market_test_key"
    }, baseUrl);
    assert.equal(discovered.mode, "skill_document");
    assert.ok(discovered.drafts.some((draft) => draft.path === "/api/market/exchanges"));
    const ticker = discovered.drafts.find((draft) => draft.path === "/api/market/ticker");
    assert.equal(ticker.sample_request.symbol, "BTC");
    assert.equal(ticker.auth_header, "x-api-key");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Provider Studio imports ClawHub-style HTML embedded Skill readme", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/clawhub-skill") {
      const readme = `---\r\nname: blockbeats-skill\r\n---\r\n\r\n# BlockBeats API Skill\r\n\r\n**Base URL**: \`http://127.0.0.1:${upstream.address().port}\`\r\n**Auth**: All requests require Header \`api-key: $BLOCKBEATS_API_KEY\`\r\n\r\n### Data Endpoints\r\n\r\n| Endpoint | URL | Key Parameters |\r\n|----------|-----|----------------|\r\n| BTC ETF net inflow | \`GET /v1/data/btc_etf\` | none |\r\n| Top 10 on-chain net inflow | \`GET /v1/data/top10_netflow\` | \`network=solana/base/ethereum\` |\r\n`;
      const escaped = readme
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n")
        .replace(/</g, "\\x3C");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><html><body><script>window.__SSR={readme:"${escaped}",ssr:!0}</script></body></html>`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: 0, message: "", data: { rows: [{ value: 1 }] } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
    const discovered = await discoverApiServices({
      api_url: `${baseUrl}/clawhub-skill`,
      default_price: "0.01",
      secret_value: "bbp_test_key"
    }, baseUrl);
    assert.equal(discovered.mode, "skill_document");
    assert.ok(discovered.drafts.some((draft) => draft.path === "/v1/data/btc_etf"));
    const netflow = discovered.drafts.find((draft) => draft.path === "/v1/data/top10_netflow");
    assert.equal(netflow.auth_header, "api-key");
    assert.equal(netflow.sample_request.network, "solana");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Provider Studio normalizes endpoint-aware Skill titles and tags", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/blockbeats-skill") {
      res.writeHead(200, { "content-type": "text/markdown" });
      res.end(`# BlockBeats API Skill

Base URL: \`http://127.0.0.1:${upstream.address().port}\`
Auth: Header \`api-key: $BLOCKBEATS_API_KEY\`

### Data Endpoints

| Endpoint | URL | Key Parameters |
|----------|-----|----------------|
| All articles | \`GET /v1/article\` | none |
| All articles | \`GET /v1/article/24h\` | none |
| up to 50) | \`GET /v1/article/important\` | none |
| Original | \`GET /v1/newsflash/onchain\` | none |
| (no pagination) | \`GET /v1/newsflash/original\` | none |
| Request example (AI newsflash) | \`GET /v1/newsflash/ai\` | \`page=1\` |
| Triggers : search [keyword], find [keyword], [keyword] news, what&#x27;s happening with [keyword] | \`GET /v1/search\` | \`name=BTC\` |
`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: 0, message: "", data: { rows: [{ value: 1 }] } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
    const discovered = await discoverApiServices({
      api_url: `${baseUrl}/blockbeats-skill`,
      default_price: "0.01",
      secret_value: "bbp_test_key"
    }, baseUrl);
    const byPath = Object.fromEntries(discovered.drafts.map((draft) => [draft.path, draft]));
    assert.equal(byPath["/v1/article"].title, "All articles");
    assert.equal(byPath["/v1/article/24h"].title, "Articles from last 24h");
    assert.equal(byPath["/v1/article/important"].title, "Important articles");
    assert.equal(byPath["/v1/newsflash/onchain"].title, "On-chain newsflashes");
    assert.equal(byPath["/v1/newsflash/original"].title, "Original newsflashes");
    assert.equal(byPath["/v1/newsflash/ai"].title, "AI newsflashes");
    assert.equal(byPath["/v1/search"].title, "Search articles and news");
    assert.ok(byPath["/v1/article/important"].capabilities.includes("article_data"));
    assert.ok(byPath["/v1/newsflash/onchain"].capabilities.includes("news_data"));
    assert.ok(byPath["/v1/newsflash/onchain"].capabilities.includes("onchain_data"));
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Provider Studio explains CLI-only Skill documents instead of treating them as HTTP APIs", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/cli-data-skill") {
      res.writeHead(200, { "content-type": "text/markdown" });
      res.end(`---
name: market-data-cli
allowed-tools: Bash(marketdata:*)
---

# Market Data

All commands: \`marketdata research flows <sub> [options]\`

\`\`\`bash
marketdata research flows netflow --chain solana --limit 10
marketdata research flows holdings --chain solana --limit 10
\`\`\`
`);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
    await assert.rejects(
      discoverApiServices({
        api_url: `${baseUrl}/cli-data-skill`,
        default_price: "0.01",
        secret_value: "provider_test_key"
      }, baseUrl),
      (error) => {
        assert.equal(error.statusCode, 422);
        assert.equal(error.code, "CLI_SKILL_NOT_HTTP_API");
        assert.match(error.message, /CLI-based Skill/);
        assert.ok(error.validation.detected_cli_commands.some((command) => command.includes("marketdata research flows")));
        return true;
      }
    );
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Provider Studio imports generic API docs overview into POST API drafts", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/api/overview") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html>
        <a href="/api/market/netflows">Netflows</a>
        <a href="/api/market/holdings">Holdings</a>
        <a href="/api/changelog">Changelog</a>
      `);
      return;
    }
    if (req.url === "/api/market/netflows") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><main>
        <h1>Netflows</h1>
        <p>Get aggregated token flow analysis.</p>
        <p>post</p>
        <p>https://api.example.com/api/v1/market/netflow</p>
        <p>Authorizations</p><p>ApiKeyAuth</p><p>apiKey string Required</p>
        <pre>POST /api/v1/market/netflow HTTP/1.1
Host: api.example.com
apiKey: YOUR_API_KEY
Content-Type: application/json
{
  "chains": ["ethereum", "solana"],
  "pagination": {"page": 1, "per_page": 10},
  "order_by": [{"field": "net_flow_24h_usd", "direction": "DESC"}]
}</pre>
        <pre>{
  "data": [{"token_symbol": "ETH", "net_flow_24h_usd": 1}],
  "pagination": {"page": 1, "per_page": 10, "is_last_page": true}
}</pre>
      </main>`);
      return;
    }
    if (req.url === "/api/market/holdings") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><main>
        <h1>Holdings</h1>
        <p>https://api.example.com/api/v1/market/holdings</p>
        <pre>POST /api/v1/market/holdings HTTP/1.1
Host: api.example.com
apiKey: YOUR_API_KEY
Content-Type: application/json
{
  "chains": ["ethereum"],
  "pagination": {"page": 1, "per_page": 10}
}</pre>
        <pre>{"data":[{"token_symbol":"ETH","value_usd":1}]}</pre>
      </main>`);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
    const discovered = await discoverApiServices({
      api_url: `${baseUrl}/api/overview`,
      default_price: "0.01",
      provider_name: "Example Data",
      secret_value: "provider_test_key"
    }, baseUrl);
    assert.equal(discovered.mode, "api_docs");
    assert.equal(discovered.provider.provider_name, "Example Data");
    assert.equal(discovered.api_url, "https://api.example.com");
    assert.equal(discovered.docs.auth_header, "apiKey");
    assert.equal(discovered.drafts.length, 2);
    const netflow = discovered.drafts.find((draft) => draft.path === "/api/v1/market/netflow");
    assert.equal(netflow.method, "POST");
    assert.equal(netflow.auth_header, "apiKey");
    assert.equal(netflow.upstream_url, "https://api.example.com/api/v1/market/netflow");
    assert.deepEqual(netflow.sample_request.chains, ["ethereum", "solana"]);
    assert.equal(netflow.preview_data.data[0].token_symbol, "ETH");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Provider Studio decodes encoded path templates from API docs", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/api/overview") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html>
        <a href="/api/points-leaderboard/%7Baddress%7D">Points Leaderboard</a>
      `);
      return;
    }
    if (req.url === "/api/points-leaderboard/%7Baddress%7D") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><main>
        <h1>Points Leaderboard</h1>
        <p>https://api.example.com/api/points-leaderboard/%7Baddress%7D</p>
        <pre>GET /api/points-leaderboard/%7Baddress%7D HTTP/1.1
Host: api.example.com
apiKey: YOUR_API_KEY</pre>
        <pre>{"data":[{"rank":1,"points":100}]}</pre>
      </main>`);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
    const discovered = await discoverApiServices({
      api_url: `${baseUrl}/api/overview`,
      default_price: "0.01",
      provider_name: "Example Data"
    }, baseUrl);
    assert.equal(discovered.ok, true);
    assert.equal(discovered.drafts.length, 1);
    const draft = discovered.drafts[0];
    assert.equal(draft.title, "Points Leaderboard");
    assert.equal(draft.path, "/api/points-leaderboard/{address}");
    assert.equal(draft.upstream_url, "https://api.example.com/api/points-leaderboard/{address}");
    assert.equal(draft.sample_request.address, "0x0000000000000000000000000000000000000000");
    assert.equal(draft.service_id.includes("7baddress"), false);
    assert.equal(draft.summary.includes("%7B"), false);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Provider Studio generates routing-rich endpoint summaries and tags", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/api/overview") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        openapi: "3.0.0",
        servers: [{ url: "https://api.example.com" }],
        paths: {
          "/api/v1/tgm/transfers": {
            post: {
              summary: "Get Token God Mode transfers data",
              description: "Returns token transfer activity for a token address, chain, date range, filters, and pagination.",
              security: [{ apiKey: [] }],
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        chain: { type: "string" },
                        token_address: { type: "string" },
                        date: { type: "string" },
                        pagination: { type: "object" },
                        filters: { type: "object" },
                        order_by: { type: "string" }
                      }
                    }
                  }
                }
              },
              responses: {
                200: {
                  content: {
                    "application/json": {
                      example: {
                        data: [{ wallet_address: "0xabc", amount: "1.2", tx_hash: "0x123" }],
                        pagination: { page: 1, per_page: 10 }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        components: {
          securitySchemes: {
            apiKey: { type: "apiKey", in: "header", name: "apiKey" }
          }
        }
      }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
    const discovered = await discoverApiServices({
      api_url: `${baseUrl}/api/overview`,
      default_price: "0.01",
      provider_name: "Example Data"
    }, baseUrl);
    assert.equal(discovered.ok, true);
    const draft = discovered.drafts[0];
    assert.match(draft.summary, /Endpoint: POST \/api\/v1\/tgm\/transfers/);
    assert.match(draft.summary, /Inputs: chain, token_address, date, pagination, filters, order_by/);
    assert.match(draft.summary, /Returns JSON fields such as data/);
    assert.match(draft.summary, /Routing keywords:/);
    assert.deepEqual(draft.data_contract.request_data.fields, ["chain", "token_address", "date", "pagination", "filters", "order_by"]);
    assert.equal(draft.data_contract.request_data.example.token_address, "0x0000000000000000000000000000000000000000");
    assert.ok(draft.data_contract.response_data.fields.includes("data.wallet_address"));
    assert.equal(draft.data_contract.response_data.preview.data[0].tx_hash, "0x123");
    assert.equal(draft.data_contract.pre_call_context.buyer_requirements.needs_buyer_api_key, false);
    assert.match(draft.data_contract.pre_call_context.validation_hint, /JSON/);
    assert.ok(draft.capabilities.includes("token_god_mode"));
    assert.ok(draft.capabilities.includes("token_transfers"));
    assert.ok(draft.capabilities.includes("wallet_activity"));
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Provider Studio preserves text around angle brackets in HTML docs", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/api/overview") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><a href="/api/research-fast">Research Fast</a>`);
      return;
    }
    if (req.url === "/api/research-fast") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><main>
        <h1>Interact with the Nan<span>s</span>en Research Agent in "fa<span>s</span>t" mode</h1>
        <p>https://api.example.com/api/v1/agent/fast</p>
        <p>A<span>s</span>k the Nan<span>s</span>en AI agent a research question and receive a stream<span>ed</span> an<span>s</span>wer backed by on-chain data. The **fast** variant u<span>s</span>es quick mode.</p>
        <p>Use text like value < string and ask a question.</p>
        <pre>POST /api/v1/agent/fast HTTP/1.1
Host: api.example.com
apiKey: YOUR_API_KEY
Content-Type: application/json
{"text":"What are ETH smart money flows?","conversation_id":"abc"}</pre>
        <pre>{"data":{"answer":"example"}}</pre>
      </main>`);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
    const discovered = await discoverApiServices({
      api_url: `${baseUrl}/api/overview`,
      default_price: "0.01",
      provider_name: "Example Data"
    }, baseUrl);
    assert.equal(discovered.ok, true);
    const draft = discovered.drafts[0];
    assert.match(draft.summary, /Nansen Research Agent/);
    assert.match(draft.summary, /Ask the Nansen AI agent a research question/);
    assert.equal(draft.summary.includes("Nan en"), false);
    assert.equal(draft.summary.includes("fa t"), false);
    assert.equal(draft.summary.includes("A k"), false);
    assert.equal(draft.summary.includes("stream ed"), false);
    assert.equal(draft.summary.includes("an wer"), false);
    assert.equal(draft.summary.includes("u es"), false);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Provider Studio uses endpoint-local signals for capabilities", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/api/overview") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        openapi: "3.0.0",
        servers: [{ url: "https://api.example.com" }],
        paths: {
          "/api/v1/agent/fast": {
            post: {
              summary: "Interact with the Nansen Research Agent in fast mode",
              description: "Ask a research question and receive an answer backed by on-chain data and token context.",
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        text: { type: "string" },
                        conversation_id: { type: "string" }
                      }
                    }
                  }
                }
              },
              responses: { 200: { content: { "application/json": { example: { data: { answer: "ok" } } } } } }
            }
          },
          "/api/v1/tgm/transfers": {
            post: {
              summary: "Get Token God Mode transfers data",
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        chain: { type: "string" },
                        token_address: { type: "string" }
                      }
                    }
                  }
                }
              },
              responses: { 200: { content: { "application/json": { example: { data: [{ tx_hash: "0x1" }] } } } } }
            }
          },
          "/api/v1/smart-money/netflow": {
            post: {
              summary: "Get Smart Money Netflow Data",
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        chain: { type: "string" },
                        date: { type: "string" }
                      }
                    }
                  }
                }
              },
              responses: { 200: { content: { "application/json": { example: { data: [{ inflow: 1, outflow: 2 }] } } } } }
            }
          }
        }
      }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
    const discovered = await discoverApiServices({
      api_url: `${baseUrl}/api/overview`,
      default_price: "0.01",
      provider_name: "Example Data"
    }, baseUrl);
    const agent = discovered.drafts.find((draft) => draft.path === "/api/v1/agent/fast");
    const transfers = discovered.drafts.find((draft) => draft.path === "/api/v1/tgm/transfers");
    const netflow = discovered.drafts.find((draft) => draft.path === "/api/v1/smart-money/netflow");
    assert.ok(agent);
    assert.ok(transfers);
    assert.ok(netflow);
    assert.ok(transfers.capabilities.includes("token_transfers"));
    assert.equal(agent.capabilities.includes("token_transfers"), false);
    assert.ok(netflow.capabilities.includes("smart_money_netflow"));
    assert.equal(netflow.capabilities.includes("etf_data"), false);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Provider Studio published direct endpoints are immediately routable by validation data", async () => {
  await withServer(async ({ baseUrl }) => {
    const discoverResponse = await fetch(`${baseUrl}/studio/import/discover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_url: `${baseUrl}/api/v1/data/header-key`,
        default_price: "0.01",
        default_method: "GET",
        secret_value: "demo-provider-secret",
        auth_header: ""
      })
    });
    assert.equal(discoverResponse.status, 200);
    const discovered = await discoverResponse.json();
    assert.equal(discovered.ok, true);
    assert.equal(discovered.drafts[0].auth_header, "auto");

    const publishResponse = await fetch(`${baseUrl}/studio/import/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ drafts: discovered.drafts, publish_scope: "local_only" })
    });
    assert.equal(publishResponse.status, 201);
    const published = await publishResponse.json();
    assert.equal(published.ok, true);
    assert.equal(published.published[0].service_id, "get_api_v1_data_header_key");

    const askResponse = await fetch(`${baseUrl}/agent-router/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "Use AgentRouter to query header key sample metric data",
        max_price: "0.05"
      })
    });
    assert.equal(askResponse.status, 200);
    const routed = await askResponse.json();
    assert.equal(routed.ok, true);
    assert.equal(routed.selected_service.service_id, "get_api_v1_data_header_key");
    assert.equal(routed.result.data.rows[0].value, 42);
  });
});

test("AgentRouter refuses to publish unreachable direct endpoint services", async () => {
  await withServer(async ({ server, baseUrl }) => {
    const endpointUrl = `${baseUrl}/api/v1/data/market-flow`;
    const discoverResponse = await fetch(`${baseUrl}/studio/import/discover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_url: endpointUrl,
        default_price: "0.01",
        secret_value: "provider-owned-secret"
      })
    });
    assert.equal(discoverResponse.status, 200);
    const discovered = await discoverResponse.json();
    assert.equal(discovered.ok, true);
    assert.equal(discovered.drafts.length, 1);
    assert.ok(discovered.drafts[0].capabilities.includes("data_service"));

    const publishResponse = await fetch(`${baseUrl}/studio/import/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ drafts: discovered.drafts, publish_scope: "local_only" })
    });
    assert.equal(publishResponse.status, 422);
    const published = await publishResponse.json();
    assert.equal(published.ok, false);
    assert.equal(published.failed[0].service_id, "post_api_v1_data_market_flow");
    assert.equal(published.failed[0].error, "VALIDATION_FAILED");

    const search = searchServices(server.store, { query: "market flow", verifiedOnly: false });
    assert.equal(search.some((service) => service.service_id === "post_api_v1_data_market_flow"), false);

    const askResponse = await fetch(`${baseUrl}/agent-router/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "通过 AgentRouter 查询 ETH 的近 24 小时 netflow",
        max_price: "0.05"
      })
    });
    assert.equal(askResponse.status, 200);
    const routed = await askResponse.json();
    assert.equal(routed.ok, false);
    assert.equal(routed.status, "no_match");
  });
});

test("Provider Studio surfaces hosted HTTP upstream failures during validation", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    const studioResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "hosted-http",
        service_id: "studio_bad_secret_demo",
        provider_id: "provider_studio",
        title: "Studio Bad Secret Demo",
        description_for_agent: "Use this service to verify upstream errors are visible.",
        capabilities: "sentiment_data,hosted_http,demo_data",
        price: "0.01",
        sample_request: "{\"asset\":\"ETH\",\"window\":\"7d\"}",
        sample_data: "{\"asset\":\"ETH\",\"sentiment_score\":0.61,\"sample\":true}",
        summary: "ETH sentiment from Provider Studio.",
        upstream_url: "/mock/upstream/sentiment",
        upstream_method: "POST",
        secret_name: "PROVIDER_SECRET",
        secret_value: "wrong-secret",
        auth_header: "authorization"
      })
    });
    assert.equal(studioResponse.status, 422);
    const payload = await studioResponse.json();
    assert.equal(payload.error.code, "VALIDATION_FAILED");
    assert.equal(payload.validation.status, 502);
    assert.equal(payload.validation.ok, false);
    assert.ok(payload.validation.schema_errors.length);

    const searchResponse = await fetch(`${baseUrl}/services/search?query=bad%20secret`);
    assert.equal(searchResponse.status, 200);
    const services = await searchResponse.json();
    assert.equal(services.some((service) => service.service_id === "studio_bad_secret_demo"), false);
  });
});

test("Provider runtime reports non-JSON upstream responses clearly", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    const studioResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "hosted-http",
        service_id: "html_upstream_demo",
        provider_id: "provider_studio",
        title: "HTML Upstream Demo",
        description_for_agent: "Use this service to verify non JSON upstream errors are visible.",
        capabilities: "html_upstream_demo,data_service",
        price: "0.01",
        sample_request: "{}",
        sample_data: "{\"ok\":true}",
        summary: "HTML upstream demo.",
        upstream_url: "/mock/upstream/html-error",
        upstream_method: "POST",
        secret_name: "PROVIDER_SECRET",
        secret_value: "",
        auth_header: "authorization"
      })
    });
    assert.equal(studioResponse.status, 422);
    const payload = await studioResponse.json();
    assert.equal(payload.error.code, "VALIDATION_FAILED");
    assert.equal(payload.validation.status, 502);
    assert.match(JSON.stringify(payload.validation), /UPSTREAM_NON_JSON_RESPONSE/);
  });
});

test("Provider Studio rejects JSON application-level upstream errors", async () => {
  await resetWalletForTests();
  await withServer(async ({ server, baseUrl }) => {
    const studioResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "hosted-http",
        service_id: "application_error_demo",
        provider_id: "provider_studio",
        title: "Application Error Demo",
        description_for_agent: "Use this service to verify JSON application errors are not publishable.",
        capabilities: "application_error_demo,data_service",
        price: "0.01",
        sample_request: "{}",
        sample_data: "{\"ok\":true}",
        summary: "Application error demo.",
        upstream_url: "/mock/upstream/app-error",
        upstream_method: "GET",
        secret_name: "PROVIDER_SECRET",
        secret_value: "",
        auth_header: "authorization"
      })
    });
    assert.equal(studioResponse.status, 422);
    const payload = await studioResponse.json();
    assert.equal(payload.error.code, "VALIDATION_FAILED");
    assert.equal(payload.validation.status, 502);
    assert.match(JSON.stringify(payload.validation), /UPSTREAM_APPLICATION_ERROR/);
    assert.equal(payload.validation.provider_error.code, "UPSTREAM_ERROR");
    const search = searchServices(server.store, { query: "application error demo", verifiedOnly: false });
    assert.equal(search.some((service) => service.service_id === "application_error_demo"), false);
  });
});

test("provider configs can be reloaded into a fresh registry after restart", async () => {
  await withServer(async ({ baseUrl }) => {
    const onboard = await runCli(["provider", "onboard", "--mode", "hosted-http", "--yes"], {
      ADN_REGISTRY_URL: baseUrl
    });
    assert.equal(onboard.code, 0, onboard.stderr);

    const freshServer = createServer();
    await new Promise((resolve) => freshServer.listen(0, "127.0.0.1", resolve));
    const freshBaseUrl = `http://127.0.0.1:${freshServer.address().port}`;
    try {
      await loadProviderConfigs(freshServer.store, freshBaseUrl, { validate: false });
      const record = freshServer.store.services.get("hosted_http_sentiment_demo");
      assert.ok(record);
      assert.equal(record.manifest.title, "Hosted HTTP Sentiment Demo");
    } finally {
      await new Promise((resolve) => freshServer.close(resolve));
    }
  });
});

test("failed provider configs are not persisted or loaded after failed registration", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    const studioResponse = await fetch(`${baseUrl}/studio/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "hosted-http",
        service_id: "failed_reload_demo",
        provider_id: "provider_studio",
        title: "Failed Reload Demo",
        description_for_agent: "Use this service to verify failed configs are not persisted.",
        capabilities: "reload_failure_demo,data_service",
        price: "0.01",
        sample_request: "{\"asset\":\"ETH\"}",
        sample_data: "{\"asset\":\"ETH\",\"sample\":true}",
        summary: "Failed reload demo.",
        upstream_url: "/missing/upstream",
        upstream_method: "POST",
        secret_name: "PROVIDER_SECRET",
        secret_value: "demo-provider-secret",
        auth_header: "authorization"
      })
    });
    assert.equal(studioResponse.status, 422);
    await assert.rejects(
      fs.readFile(path.join(process.env.ADN_PROVIDER_DIR, "failed_reload_demo.json"), "utf8")
    );

    const freshServer = createServer();
    await new Promise((resolve) => freshServer.listen(0, "127.0.0.1", resolve));
    const freshBaseUrl = `http://127.0.0.1:${freshServer.address().port}`;
    try {
      await loadProviderConfigs(freshServer.store, freshBaseUrl, { validate: true });
      assert.equal(freshServer.store.services.has("failed_reload_demo"), false);
    } finally {
      await new Promise((resolve) => freshServer.close(resolve));
    }
  });
});

test("CLI wallet signs local payment automatically within policy", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    const init = await runCli(["wallet", "init"], {
      ADN_REGISTRY_URL: baseUrl
    });
    assert.equal(init.code, 0, init.stderr);
    const wallet = JSON.parse(init.stdout);
    assert.match(wallet.address, /^0x[0-9a-f]{40}$/);
    const walletFile = await fs.readFile(path.join(process.env.ADN_DIR, "wallet.json"), "utf8");
    assert.equal(walletFile.includes("private_key_pem"), false);
    assert.equal(walletFile.includes("encrypted_private_key"), true);
    const unlockedWallet = await readWallet();
    assert.match(unlockedWallet.private_key_hex, /^0x[0-9a-f]{64}$/);

    const invoke = await runCli(["invoke", "chain_fund_flow_7d_base", "{\"chain\":\"base\",\"days\":7}"], {
      ADN_REGISTRY_URL: baseUrl
    });
    assert.equal(invoke.code, 0, invoke.stderr);
    const payload = JSON.parse(invoke.stdout);
    assert.equal(payload.result.status, "success");
    assert.equal(payload.local_payment.status, "success");
    assert.equal(payload.local_payment.amount, "0.01");
    assert.equal(payload.local_payment.currency, "USDC");

    const log = await readPaymentLog();
    assert.equal(log.length, 1);
    assert.equal(log[0].service_id, "chain_fund_flow_7d_base");
  });
});

test("CLI route resolves service and pays with local wallet", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    await runCli(["wallet", "init"], { ADN_REGISTRY_URL: baseUrl });
    const routed = await runCli(["route", "BTC 当前最大爆仓痛点是多少", "--max-price", "0.05", "--freshness", "300"], {
      ADN_REGISTRY_URL: baseUrl
    });
    assert.equal(routed.code, 0, routed.stderr);
    const payload = JSON.parse(routed.stdout);
    assert.equal(payload.status, "route_with_assumption");
    assert.equal(payload.selected_service.service_id, "btc_liquidation_max_pain_demo");
    assert.equal(payload.local_payment.status, "success");
    assert.equal(payload.local_payment.amount, "0.02");
    assert.equal(payload.verification.schema_valid, true);
    const log = await readPaymentLog();
    assert.equal(log.at(-1).service_id, "btc_liquidation_max_pain_demo");
  });
});

test("CLI route returns clarification before payment for unclear max pain task", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    await runCli(["wallet", "init"], { ADN_REGISTRY_URL: baseUrl });
    const routed = await runCli(["route", "BTC 最大痛点是多少", "--max-price", "0.05", "--freshness", "300"], {
      ADN_REGISTRY_URL: baseUrl
    });
    assert.equal(routed.code, 0, routed.stderr);
    const payload = JSON.parse(routed.stdout);
    assert.equal(payload.status, "needs_clarification");
    assert.equal(payload.ambiguities[0].field, "capability");
    const log = await readPaymentLog();
    assert.equal(log.length, 0);
  });
});

test("CLI invoke cannot unlock wallet without passphrase", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    await runCli(["wallet", "init"], { ADN_REGISTRY_URL: baseUrl });
    const invoke = await runCli(
      ["invoke", "chain_fund_flow_7d_base", "{\"chain\":\"base\",\"days\":7}"],
      { ADN_REGISTRY_URL: baseUrl, ADN_WALLET_PASSPHRASE: "" }
    );
    assert.equal(invoke.code, 1);
    assert.match(invoke.stderr, /ADN_WALLET_PASSPHRASE or a local AgentRouter session wallet secret is required/);
  });
});

test("CLI wallet policy blocks payment above per-call limit", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    await runCli(["wallet", "init"], { ADN_REGISTRY_URL: baseUrl });
    await runCli(["wallet", "policy", "set", "--per-call", "0.001"], { ADN_REGISTRY_URL: baseUrl });
    const invoke = await runCli(["invoke", "chain_fund_flow_7d_base", "{\"chain\":\"base\",\"days\":7}"], {
      ADN_REGISTRY_URL: baseUrl
    });
    assert.equal(invoke.code, 1);
    assert.match(invoke.stderr, /exceeds per-call policy limit/);
  });
});

test("CLI wallet lock disables automatic signing", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    await runCli(["wallet", "init"], { ADN_REGISTRY_URL: baseUrl });
    await runCli(["wallet", "lock"], { ADN_REGISTRY_URL: baseUrl });
    const invoke = await runCli(["invoke", "chain_fund_flow_7d_base", "{\"chain\":\"base\",\"days\":7}"], {
      ADN_REGISTRY_URL: baseUrl
    });
    assert.equal(invoke.code, 1);
    assert.match(invoke.stderr, /Wallet policy is disabled/);
  });
});

test("provider rejects replayed wallet payment challenge", async () => {
  await resetWalletForTests();
  await withServer(async ({ baseUrl }) => {
    await runCli(["wallet", "init"], { ADN_REGISTRY_URL: baseUrl });
    const wallet = await readWallet();
    const firstResponse = await fetch(`${baseUrl}/provider/chain-fund-flow`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chain: "base", days: 7 })
    });
    assert.equal(firstResponse.status, 402);
    const challenge = await firstResponse.json();
    const proof = createWalletPaymentProof({
      wallet,
      serviceId: "chain_fund_flow_7d_base",
      amount: challenge.payment.amount,
      currency: challenge.payment.asset,
      network: challenge.payment.network,
      payTo: challenge.payment.pay_to,
      challenge: challenge.payment
    });

    const paidOnce = await fetch(`${baseUrl}/provider/chain-fund-flow`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-payment": proof },
      body: JSON.stringify({ chain: "base", days: 7 })
    });
    assert.equal(paidOnce.status, 200);
    const paidTwice = await fetch(`${baseUrl}/provider/chain-fund-flow`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-payment": proof },
      body: JSON.stringify({ chain: "base", days: 7 })
    });
    assert.equal(paidTwice.status, 402);
    const body = await paidTwice.json();
    assert.equal(body.code, "UNKNOWN_OR_REPLAYED_PAYMENT_CHALLENGE");
  });
});

test("circle_arc backend verifies x402-style Arc USDC payment before returning provider data", async () => {
  await resetWalletForTests();
  const previousBackend = process.env.ADN_PAYMENT_BACKEND;
  const previousProviderReceive = process.env.ADN_PROVIDER_RECEIVE_ADDRESS;
  const previousTransferMode = process.env.ADN_ARC_TRANSFER_MODE;
  const previousVerifyMode = process.env.ADN_ARC_VERIFY_MODE;
  const previousBalanceMock = process.env.ADN_ARC_BALANCE_MOCK;
  process.env.ADN_PROVIDER_RECEIVE_ADDRESS = "0x1111111111111111111111111111111111111111";
  process.env.ADN_ARC_TRANSFER_MODE = "mock";
  process.env.ADN_ARC_VERIFY_MODE = "mock";
  process.env.ADN_ARC_BALANCE_MOCK = "1";
  try {
    await withServer(async ({ baseUrl }) => {
      process.env.ADN_PAYMENT_BACKEND = "circle_arc";
      await runCli(["wallet", "init"], { ADN_REGISTRY_URL: baseUrl });
      const invoke = await runCli(["invoke", "chain_fund_flow_7d_base", "{\"chain\":\"base\",\"days\":7}"], {
        ADN_REGISTRY_URL: baseUrl,
        ADN_PAYMENT_BACKEND: "circle_arc",
        ADN_ARC_TRANSFER_MODE: "mock",
        ADN_ARC_VERIFY_MODE: "mock"
      });
      assert.equal(invoke.code, 0, invoke.stderr);
      const payload = JSON.parse(invoke.stdout);
      assert.equal(payload.result.status, "success");
      assert.equal(payload.local_payment.backend, "circle_arc");
      assert.equal(payload.local_payment.network, "arc-testnet");
      assert.equal(payload.local_payment.pay_to, "0x1111111111111111111111111111111111111111");
      assert.match(payload.local_payment.payment_tx, /^0x[0-9a-f]{64}$/);
      assert.match(payload.local_payment.event_hash, /^0x[0-9a-f]{64}$/);
      assert.equal(payload.feedback.settlement_receipt.payment_backend, "circle_arc");
      assert.equal(payload.feedback.settlement_receipt.chain_id, 5042002);
      assert.equal(payload.feedback.settlement_receipt.settlement_model, "direct_provider_wallet");
      assert.match(payload.feedback.feedback_hash, /^0x[0-9a-f]{64}$/);
    });
  } finally {
    if (previousBackend === undefined) delete process.env.ADN_PAYMENT_BACKEND;
    else process.env.ADN_PAYMENT_BACKEND = previousBackend;
    if (previousProviderReceive === undefined) delete process.env.ADN_PROVIDER_RECEIVE_ADDRESS;
    else process.env.ADN_PROVIDER_RECEIVE_ADDRESS = previousProviderReceive;
    if (previousTransferMode === undefined) delete process.env.ADN_ARC_TRANSFER_MODE;
    else process.env.ADN_ARC_TRANSFER_MODE = previousTransferMode;
    if (previousVerifyMode === undefined) delete process.env.ADN_ARC_VERIFY_MODE;
    else process.env.ADN_ARC_VERIFY_MODE = previousVerifyMode;
    if (previousBalanceMock === undefined) delete process.env.ADN_ARC_BALANCE_MOCK;
    else process.env.ADN_ARC_BALANCE_MOCK = previousBalanceMock;
  }
});

test("circle_arc local wallet returns funding guidance before payment when USDC balance is too low", async () => {
  await resetWalletForTests();
  const previousBackend = process.env.ADN_PAYMENT_BACKEND;
  const previousProviderReceive = process.env.ADN_PROVIDER_RECEIVE_ADDRESS;
  const previousTransferMode = process.env.ADN_ARC_TRANSFER_MODE;
  const previousVerifyMode = process.env.ADN_ARC_VERIFY_MODE;
  const previousBalanceMock = process.env.ADN_ARC_BALANCE_MOCK;
  process.env.ADN_PROVIDER_RECEIVE_ADDRESS = "0x1111111111111111111111111111111111111111";
  process.env.ADN_ARC_TRANSFER_MODE = "mock";
  process.env.ADN_ARC_VERIFY_MODE = "mock";
  process.env.ADN_ARC_BALANCE_MOCK = "0";
  try {
    await withServer(async ({ baseUrl }) => {
      process.env.ADN_PAYMENT_BACKEND = "circle_arc";
      await runCli(["wallet", "init"], { ADN_REGISTRY_URL: baseUrl });
      const invoke = await runCli(["invoke", "chain_fund_flow_7d_base", "{\"chain\":\"base\",\"days\":7}"], {
        ADN_REGISTRY_URL: baseUrl,
        ADN_PAYMENT_BACKEND: "circle_arc",
        ADN_ARC_TRANSFER_MODE: "mock",
        ADN_ARC_VERIFY_MODE: "mock",
        ADN_ARC_BALANCE_MOCK: "0"
      });
      assert.notEqual(invoke.code, 0);
      assert.match(invoke.stderr, /Arc Testnet USDC balance is 0/);
    });
  } finally {
    if (previousBackend === undefined) delete process.env.ADN_PAYMENT_BACKEND;
    else process.env.ADN_PAYMENT_BACKEND = previousBackend;
    if (previousProviderReceive === undefined) delete process.env.ADN_PROVIDER_RECEIVE_ADDRESS;
    else process.env.ADN_PROVIDER_RECEIVE_ADDRESS = previousProviderReceive;
    if (previousTransferMode === undefined) delete process.env.ADN_ARC_TRANSFER_MODE;
    else process.env.ADN_ARC_TRANSFER_MODE = previousTransferMode;
    if (previousVerifyMode === undefined) delete process.env.ADN_ARC_VERIFY_MODE;
    else process.env.ADN_ARC_VERIFY_MODE = previousVerifyMode;
    if (previousBalanceMock === undefined) delete process.env.ADN_ARC_BALANCE_MOCK;
    else process.env.ADN_ARC_BALANCE_MOCK = previousBalanceMock;
  }
});

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["bin/adn.js", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ADN_WALLET_PASSPHRASE: "test-passphrase", ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function createMcpClient(env = {}, serverPath = "bin/agent-router-mcp.js") {
  const child = spawn(process.execPath, [path.join(process.cwd(), serverPath)], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let nextId = 1;
  let buffer = Buffer.alloc(0);
  const pending = new Map();

  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (const message of readMcpMessages()) {
      const callbacks = pending.get(message.id);
      if (!callbacks) continue;
      pending.delete(message.id);
      if (message.error) callbacks.reject(new Error(message.error.message));
      else callbacks.resolve(message.result);
    }
  });

  child.stderr.on("data", (chunk) => {
    if (!pending.size) return;
    const error = new Error(chunk.toString("utf8"));
    for (const callbacks of pending.values()) callbacks.reject(error);
    pending.clear();
  });

  child.on("exit", (code) => {
    if (!pending.size) return;
    const error = new Error(`MCP server exited with code ${code}`);
    for (const callbacks of pending.values()) callbacks.reject(error);
    pending.clear();
  });

  function readMcpMessages() {
    const messages = [];
    while (buffer.length) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const match = header.match(/content-length:\s*(\d+)/i);
      if (!match) throw new Error("Missing Content-Length header");
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (buffer.length < bodyEnd) break;
      messages.push(JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8")));
      buffer = buffer.subarray(bodyEnd);
    }
    return messages;
  }

  return {
    request(method, params) {
      const id = nextId++;
      const message = { jsonrpc: "2.0", id, method, params };
      const body = JSON.stringify(message);
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    },
    close() {
      child.kill();
    }
  };
}
