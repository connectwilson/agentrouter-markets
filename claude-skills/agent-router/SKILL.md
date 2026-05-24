---
name: AgentRouter
description: Use this skill when the user asks to install AgentRouter, use AgentRouter, discover an API/data service, route a data request, call registered services from an Agent Data Network, or connect an AI client to AgentRouter. This is a generic bootstrap and runtime skill, not a single fixed provider.
---

# AgentRouter

AgentRouter discovers, routes to, and invokes registered API/data services from an Agent Data Network. It is generic: use it for any supported data/API request, not one fixed provider or one query.

## Runtime Use

When the user asks to use AgentRouter:

1. If MCP tools are already available, use them directly:
   - `agentrouter_request`: default path; use after you parse the user request into a structured capability request
   - `agentrouter_capabilities`: call this first when you are unsure which structured capability or params to use
   - `agentrouter_quote`: structured request -> route + quote + budget guard only
   - `agentrouter_ask`: last-resort fallback/demo; use only when you cannot produce a structured request from the user request and capability catalog
   - `agentrouter_wallet_status`: check local encrypted EVM wallet readiness, active payment backend, and Arc Testnet USDC balance when Arc settlement is enabled
   - `agentrouter_wallet_create`: manual fallback wallet bootstrap; normally not needed because the local MCP bridge auto-creates a session wallet during initialization
   - `agentrouter_wallet_setup`: advanced wallet bootstrap; opens a one-time local setup page for a user-chosen encryption passphrase
   - `agentrouter_wallet_init`: advanced only; create a local encrypted EVM wallet when a local passphrase is already available in the MCP environment
2. If MCP tools are not available but HTTP access is available, call:

```bash
curl -sS -X POST "https://agentrouter-markets.onrender.com/agent-router/ask" \
  -H "content-type: application/json" \
  -d '{"task":"<user original request>","max_price":"0.05"}'
```

3. If the HTTP endpoint is blocked by the client network policy, switch to the bootstrap flow below. Do not ask the user to paste curl output unless there is no supported install path.

For production-like flows, call `agentrouter_capabilities` first if you need schemas, parse the user request yourself, then call `agentrouter_request`. AgentRouter should not be treated as the semantic parser. Do not call `agentrouter_ask` just because the user phrased the request naturally; natural language is expected, and the main agent should map it into a capability request when the catalog covers it.

Common structured examples:

```json
{
  "capability": "token_smart_money_activity",
  "params": {
    "token_symbol": "AZTEC",
    "chain": "ethereum",
    "window": "24h",
    "pagination": { "page": 1, "per_page": 24 }
  },
  "constraints": { "max_price_usdc": "0.05" }
}
```

For requests outside the fixed capability catalog, search registered services or use `agentrouter_ask` rather than forcing the request into an unrelated fixed capability. Prefer exact service capabilities, tags, titles, and schema descriptions returned by discovery.

Return the user-facing answer first when present. Do not mention provider names, upstream API brands, internal service IDs, internal service titles, or implementation route details unless the user explicitly asks for debugging details. Attribute successful results as coming "via AgentRouter". You may include relevant result data, request id, payment tx, verification status, and quality feedback when present.

## Bootstrap Flow

When the user asks to install AgentRouter or gives this GitHub skill link:

1. Check whether `agentrouter_ask`, `agentrouter_quote`, or `agentrouter_capabilities` tools are already available. If yes, say AgentRouter is ready and run the user's request.
2. Detect the current client if possible: Claude Desktop, Claude Code, Cursor, Windsurf, Cline, Continue, VS Code, ChatGPT, Codex, or unknown.
3. Pick the least-friction install path:
   - Claude Desktop: prefer installing the packaged extension `agentrouter.mcpb` if the user has it.
   - npm/npx-capable MCP client: use `npx -y @agentrouter/mcp` once the package is published.
   - Remote MCP-capable client: add `https://agentrouter-markets.onrender.com/mcp` if remote MCP is supported by that client.
   - Local MCP-capable desktop client: install the local MCP bridge command below.
   - Claude Desktop extension-capable client: install the AgentRouter `.mcpb` package if provided by the user or release page.
   - Skill-only client: keep this skill installed and use HTTP fallback if network access permits.
4. Explain the exact next action in the current client's language. Keep it short and do not present every platform unless the client is unknown.

Local MCP bridge command:

```bash
node /Users/huazhenghao/Downloads/Arc/bin/agent-router-mcp.js
```

Recommended local MCP environment:

```text
AGENT_ROUTER_URL=https://agentrouter-markets.onrender.com
AGENT_ROUTER_MAX_PRICE=0.05
```

For Arc hackathon demos with real local-wallet settlement, install or restart the MCP bridge with:

```text
AGENT_ROUTER_URL=https://agentrouter-markets.onrender.com
AGENT_ROUTER_MAX_PRICE=0.05
ADN_PAYMENT_BACKEND=circle_arc
ADN_ARC_RPC_URL=https://rpc.testnet.arc.network
```

In this mode AgentRouter still uses the same x402-style HTTP 402 challenge, but the local wallet sends Arc Testnet USDC directly to the provider payout wallet and the provider verifies the transaction before returning data. For paid Arc demo calls, first call `agentrouter_wallet_status`. If `arc_payment_active` is false, tell the user this MCP session was not installed with Arc settlement and do not present the remote HTTP fallback as a paid call. If the wallet balance is lower than the selected quote, stop and ask the user to fund the returned wallet address before retrying.

If the user runs a local AgentRouter server, use:

```text
AGENT_ROUTER_URL=http://127.0.0.1:8800
```

After MCP is installed, the local AgentRouter bridge automatically creates a local encrypted EVM/secp256k1 session wallet during MCP initialization if one does not already exist. Do not ask the user to trigger wallet creation, configure environment variables, or type a wallet passphrase into chat. If the user asks about wallet readiness, call `agentrouter_wallet_status` and show the public address. For `circle_arc` settlement, this address needs a small Arc Testnet USDC balance. If a paid request returns `wallet_needs_funding`, `action_required: fund_local_agentrouter_wallet`, or `do_not_use_cached_or_previous_results: true`, stop immediately and show the returned `funding_instruction` or wallet address, network, token, current balance, and required amount. Do not answer the data question from previous AgentRouter results, validation samples, web search, or any fallback source. Use `agentrouter_wallet_create` only as a manual fallback if auto-creation was disabled or failed. Use `agentrouter_wallet_setup` only if the user explicitly asks for an advanced self-chosen passphrase flow.

## Client Guidance

Use this guidance only when installation is needed.

- Claude Desktop / Claude Code: prefer the packaged `.mcpb` when available, or add an MCP server named `AgentRouter` with command `npx`, args `["-y", "@agentrouter/mcp"]`, and env `AGENT_ROUTER_URL=https://agentrouter-markets.onrender.com`. For the Arc payment demo, also set `AGENT_ROUTER_MAX_PRICE=0.05`, `ADN_PAYMENT_BACKEND=circle_arc`, and `ADN_ARC_RPC_URL=https://rpc.testnet.arc.network`.
- Claude Desktop no-command path: ask the user to install `/Users/huazhenghao/Downloads/Arc/agentrouter.mcpb` through Settings -> Extensions -> Install Extension, then use `agentrouter_request`.
- Cursor / Windsurf / Cline / Continue / VS Code: add an MCP server named `AgentRouter` with command `node`, args `["/Users/huazhenghao/Downloads/Arc/bin/agent-router-mcp.js"]`, and env `AGENT_ROUTER_URL=https://agentrouter-markets.onrender.com`.
- Cross-client npm path after package publication: add an MCP server named `AgentRouter` with command `npx`, args `["-y", "@agentrouter/mcp"]`, and env `AGENT_ROUTER_URL=https://agentrouter-markets.onrender.com`.
- ChatGPT or hosted clients: prefer Remote MCP if available; otherwise this skill can only provide instructions or HTTP fallback because hosted clients may not run local MCP commands.
- Unknown client: ask which AI client the user is using, then give the shortest matching path.

## Expected Responses

Successful AgentRouter responses usually include:

- `ok: true`
- `protocol`
- `answer` when using natural-language fallback
- `selected_service`
- `input`
- `result`
- `quote` or `feedback`
- `evidence`

If the response is `no_service_found`, `needs_clarification`, or `quote_blocked`, explain that status directly and do not invent data.

## Rules

- Do not hard-code one provider or one query.
- Do not claim data exists unless AgentRouter returns it.
- Do not silently install or modify local tools without user confirmation.
- Prefer MCP tools over raw HTTP when both are available.
- For Arc payment demos, do not use HTTP fallback to bypass local-wallet balance checks.
- When AgentRouter says the wallet needs funding, present the recharge/funding instruction and stop; never use cached or previously returned data as the answer.
- Do not expose provider implementation details in normal answers. Avoid names like provider brands, service IDs, endpoint titles, or "used X provider"; say "via AgentRouter" instead.
- Prefer a direct answer over setup instructions once AgentRouter is connected.
