#!/usr/bin/env node
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { askAgentRouterRemote } from "../src/agent-router.js";

const [command = "ask", ...args] = process.argv.slice(2);
const baseUrl = (process.env.AGENT_ROUTER_URL || process.env.ADN_REGISTRY_URL || "https://agentrouter.network").replace(/\/$/, "");
const defaultAdnDir = path.join(os.homedir(), ".agentrouter", "adn");
if (!process.env.ADN_DIR) process.env.ADN_DIR = defaultAdnDir;
const { args: commandArgs, localWalletRequested } = parseRuntimeFlags(args);

try {
  if (command === "ask" || command === "find") {
    const task = commandArgs.join(" ");
    if (shouldUseLocalWallet({ localWalletRequested })) {
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
    } else {
      print(await askAgentRouterRemote({
        baseUrl,
        task,
        max_price: process.env.AGENT_ROUTER_MAX_PRICE || "0.05"
      }));
    }
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
        "agent-router capabilities",
        'agent-router request \'{"capability":"perp_liquidation_max_pain","params":{"asset":"BTC","market_type":"perpetual_futures","window":"current"},"constraints":{"max_price_usdc":"0.05"}}\'',
        'agent-router quote \'{"capability":"perp_liquidation_max_pain","params":{"asset":"BTC","market_type":"perpetual_futures","window":"current"},"constraints":{"max_price_usdc":"0.05"}}\'',
        'agent-router search "Lookonchain address"',
        "agent-router preview listlookonchainaddresses",
        'agent-router invoke listlookonchainaddresses \'{"tag":"Matrixport","limit":1}\''
      ],
      base_url: baseUrl,
      local_wallet: localWalletStatus()
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
    localWalletRequested: false
  };
  for (const value of values) {
    if (value === "--local-wallet" || value === "--pay") {
      parsed.localWalletRequested = true;
    } else {
      parsed.args.push(value);
    }
  }
  return parsed;
}

function shouldUseLocalWallet({ localWalletRequested }) {
  if (localWalletRequested) return true;
  if (["circle_arc", "x402"].includes(String(process.env.ADN_PAYMENT_BACKEND || "").toLowerCase())) return true;
  return fsSync.existsSync(path.join(process.env.ADN_DIR || defaultAdnDir, "wallet.json"));
}

function localWalletStatus() {
  const walletPath = path.join(process.env.ADN_DIR || defaultAdnDir, "wallet.json");
  return {
    enabled_for_ask: shouldUseLocalWallet({ localWalletRequested }),
    wallet_path: walletPath,
    wallet_found: fsSync.existsSync(walletPath),
    payment_backend: process.env.ADN_PAYMENT_BACKEND || null
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
