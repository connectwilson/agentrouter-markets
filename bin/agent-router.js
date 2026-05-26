#!/usr/bin/env node
import { askAgentRouterRemote } from "../src/agent-router.js";

const [command = "ask", ...args] = process.argv.slice(2);
const baseUrl = (process.env.AGENT_ROUTER_URL || process.env.ADN_REGISTRY_URL || "https://agentrouter.network").replace(/\/$/, "");

try {
  if (command === "ask" || command === "find") {
    print(await askAgentRouterRemote({
      baseUrl,
      task: args.join(" "),
      max_price: process.env.AGENT_ROUTER_MAX_PRICE || "0.05"
    }));
  } else if (command === "capabilities") {
    print(await get("/capabilities"));
  } else if (command === "request") {
    print(await post("/agent-router/request", JSON.parse(requireArg(args[0], "request_json"))));
  } else if (command === "quote") {
    print(await post("/agent-router/quote", JSON.parse(requireArg(args[0], "request_json"))));
  } else if (command === "search") {
    print(await post("/connector/search_services", {
      query: args.join(" "),
      verified_only: true,
      max_price: process.env.AGENT_ROUTER_MAX_PRICE || "0.05"
    }));
  } else if (command === "preview") {
    print(await post("/connector/preview_service", { service_id: requireArg(args[0], "service_id") }));
  } else if (command === "invoke") {
    print(await post("/connector/invoke_paid_service", {
      service_id: requireArg(args[0], "service_id"),
      input: args[1] ? JSON.parse(args[1]) : {},
      budget: {
        max_amount: process.env.AGENT_ROUTER_MAX_PRICE || "0.05",
        currency: "USDC"
      }
    }));
  } else {
    print({
      usage: [
        'agent-router ask "查询标记为 Matrixport 的地址"',
        "agent-router capabilities",
        'agent-router request \'{"capability":"perp_liquidation_max_pain","params":{"asset":"BTC","market_type":"perpetual_futures","window":"current"},"constraints":{"max_price_usdc":"0.05"}}\'',
        'agent-router quote \'{"capability":"perp_liquidation_max_pain","params":{"asset":"BTC","market_type":"perpetual_futures","window":"current"},"constraints":{"max_price_usdc":"0.05"}}\'',
        'agent-router search "Lookonchain address"',
        "agent-router preview listlookonchainaddresses",
        'agent-router invoke listlookonchainaddresses \'{"tag":"Matrixport","limit":1}\''
      ],
      base_url: baseUrl
    });
  }
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error.message,
    payload: error.payload || null
  }, null, 2));
  process.exitCode = 1;
}

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.error?.code || `HTTP ${response.status}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.error?.code || `HTTP ${response.status}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

function requireArg(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}
