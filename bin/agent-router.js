#!/usr/bin/env node
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { askAgentRouterRemote } from "../src/agent-router.js";

const [command = "ask", ...args] = process.argv.slice(2);
const baseUrl = (process.env.AGENT_ROUTER_URL || process.env.ADN_REGISTRY_URL || "https://agentrouter.network").replace(/\/$/, "");
const defaultAdnDir = path.join(os.homedir(), ".agentrouter", "adn");
if (!process.env.ADN_DIR) process.env.ADN_DIR = defaultAdnDir;
const { args: commandArgs, localWalletRequested, quoteOnlyRequested } = parseRuntimeFlags(args);

try {
  if (command === "ask" || command === "find") {
    const task = commandArgs.join(" ");
    if (!quoteOnlyRequested) {
      const readiness = localPaymentReadiness();
      if (!readiness.ready && !localWalletRequested) {
        print(localPaymentNotReadyResponse(readiness));
      } else {
        const { routeTaskWithLocalWallet } = await import("../src/local-route.js");
        print(await routeTaskWithLocalWallet({
          baseUrl,
          task,
          constraints: {
            max_price_usdc: process.env.AGENT_ROUTER_MAX_PRICE || "0.05"
          },
          budget: {
            max_amount: process.env.AGENT_ROUTER_MAX_PRICE || "0.05",
            currency: "USDC"
          }
        }));
      }
    } else {
      print(await askAgentRouterRemote({
        baseUrl,
        task,
        max_price: process.env.AGENT_ROUTER_MAX_PRICE || "0.05"
      }));
    }
  } else if (command === "quote-only" || command === "ask-quote") {
    print(await askAgentRouterRemote({
      baseUrl,
      task: commandArgs.join(" "),
      max_price: process.env.AGENT_ROUTER_MAX_PRICE || "0.05"
    }));
  } else if (command === "diagnose" || command === "doctor") {
    print(localDiagnostics());
  } else if (command === "pay-ask") {
      const { routeTaskWithLocalWallet } = await import("../src/local-route.js");
      print(await routeTaskWithLocalWallet({
        baseUrl,
        task: commandArgs.join(" "),
        constraints: {
          max_price_usdc: process.env.AGENT_ROUTER_MAX_PRICE || "0.05"
        },
        budget: {
          max_amount: process.env.AGENT_ROUTER_MAX_PRICE || "0.05",
          currency: "USDC"
        }
      }));
  } else if (command === "capabilities") {
    print(await get("/capabilities"));
  } else if (command === "request") {
    print(await post("/agent-router/request", JSON.parse(requireArg(commandArgs[0], "request_json"))));
  } else if (command === "quote") {
    print(await post("/agent-router/quote", JSON.parse(requireArg(commandArgs[0], "request_json"))));
  } else if (command === "search") {
    print(await post("/connector/search_services", {
      query: commandArgs.join(" "),
      verified_only: true,
      max_price: process.env.AGENT_ROUTER_MAX_PRICE || "0.05"
    }));
  } else if (command === "preview") {
    print(await post("/connector/preview_service", { service_id: requireArg(commandArgs[0], "service_id") }));
  } else if (command === "invoke") {
    print(await post("/connector/invoke_paid_service", {
      service_id: requireArg(commandArgs[0], "service_id"),
      input: commandArgs[1] ? JSON.parse(commandArgs[1]) : {},
      budget: {
        max_amount: process.env.AGENT_ROUTER_MAX_PRICE || "0.05",
        currency: "USDC"
      }
    }));
  } else {
    print({
      usage: [
        'agent-router ask "查询标记为 Matrixport 的地址"',
        'agent-router ask --local-wallet "BTC 当前最大爆仓痛点是多少"',
        'agent-router ask --quote-only "BTC 当前最大爆仓痛点是多少"',
        "agent-router doctor",
        "agent-router capabilities",
        'agent-router request \'{"capability":"perp_liquidation_max_pain","params":{"asset":"BTC","market_type":"perpetual_futures","window":"current"},"constraints":{"max_price_usdc":"0.05"}}\'',
        'agent-router quote \'{"capability":"perp_liquidation_max_pain","params":{"asset":"BTC","market_type":"perpetual_futures","window":"current"},"constraints":{"max_price_usdc":"0.05"}}\'',
        'agent-router search "Lookonchain address"',
        "agent-router preview listlookonchainaddresses",
        'agent-router invoke listlookonchainaddresses \'{"tag":"Matrixport","limit":1}\''
      ],
      base_url: baseUrl,
      local_payment: localDiagnostics()
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

function parseRuntimeFlags(values) {
  const parsed = {
    args: [],
    localWalletRequested: false,
    quoteOnlyRequested: false
  };
  for (const value of values) {
    if (value === "--local-wallet" || value === "--pay") {
      parsed.localWalletRequested = true;
    } else if (value === "--quote-only" || value === "--dry-run") {
      parsed.quoteOnlyRequested = true;
    } else {
      parsed.args.push(value);
    }
  }
  return parsed;
}

function localPaymentReadiness() {
  const walletPath = path.join(process.env.ADN_DIR || defaultAdnDir, "wallet.json");
  const walletFound = fsSync.existsSync(walletPath);
  return {
    ready: walletFound,
    wallet_path: walletPath,
    wallet_found: walletFound,
    payment_backend: process.env.ADN_PAYMENT_BACKEND || "circle_arc",
    agent_router_url: baseUrl
  };
}

function localDiagnostics() {
  const readiness = localPaymentReadiness();
  return {
    ok: readiness.ready,
    status: readiness.ready ? "local_payment_ready" : "local_payment_not_ready",
    local_payment: readiness,
    mcp_hint: {
      server_command: "npx",
      server_args: ["-y", "--package", "github:connectwilson/agentrouter-markets#main", "agent-router-mcp"]
    },
    repair_command: "npx -y github:connectwilson/agentrouter-markets#main --client all"
  };
}

function localPaymentNotReadyResponse(readiness) {
  return {
    ok: false,
    status: "local_payment_not_ready",
    final_answer_available: false,
    data_returned: false,
    stop_reason: "AgentRouter paid data calls require the local payment wallet/MCP bridge. The CLI did not fall back to quote-only mode.",
    local_payment: readiness,
    repair_command: "npx -y github:connectwilson/agentrouter-markets#main --client all",
    quote_only_command: 'agent-router ask --quote-only "<task>"',
    next_step: "Run the repair command once, restart or reload the AI client, then retry the same data question."
  };
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
