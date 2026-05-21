# Status

Last updated: 2026-05-18

## Current MVP

- Provider Studio supports manual service creation and OpenAPI import.
- OpenAPI import can discover multiple endpoints, preview generated cards, select many drafts, and publish them.
- Registered services expose manifests, preview data, paid invocation, and feedback events.
- AgentRouter can search registered services, select a likely service, construct simple input, invoke through the connector, and summarize the result.
- AgentRouter is available as:
  - CLI: `node bin/agent-router.js ask "<task>"`
  - HTTP: `POST /agent-router/ask`
- AgentRouter currently recognizes address lookup and BTC/perp liquidation max-pain demo intents.
- Local provider configs using `/provider/custom/...` are rebound to the current server port at startup, so old generated JSON does not pin the app to a stale local port.
- Wallet/payment is still dev-mode x402-style proof, not production USDC settlement.
- Agora hackathon positioning is captured in `docs/PRD_AGORA_HACKATHON.md`: AgentRouter Markets, a paid market-intelligence routing layer for trading agents.
- The PRD now treats `/agent-router/request` as the formal structured protocol endpoint and `/agent-router/ask` as a demo/fallback wrapper.
- Implemented `GET /capabilities` for a machine-readable capability catalog.
- Implemented `POST /agent-router/request` for deterministic structured routing.
- Implemented `/agent-router/demo` as the demand-side hackathon console.
- Paid invocation feedback now includes an `agent_router_settlement_receipt_v1` settlement receipt with USDC amount, mode, network, payee, and tx hash.
- Search results now expose `trust_score`; structured routing returns provider selection reasons.
- Verified the full provider-to-demand flow: Provider Studio OpenAPI import publishes `get_liquidation_max_pain`; AgentRouter `/ask` compiles natural language into a structured `perp_liquidation_max_pain` request, selects the uploaded service, pays, validates, and returns data.
- OpenAPI capability inference now enriches imported liquidation services with the standard `perp_liquidation`, `liquidation_heatmap`, and `perp_liquidation_max_pain` capabilities.
- Deployed AgentRouter Markets to Railway at `https://agentrouter-markets.onrender.com`.
- Claude Skill now points to the Railway endpoint instead of the temporary Cloudflare tunnel.
- Added payment backend abstraction: `dev`, `x402`, `omniagentpay`, and `circle_arc`.
- Added `POST /agent-router/quote` so agents can inspect selected service, input, price, and guard result before paying.
- Product positioning updated: AgentRouter is not a payment SDK; OmniAgentPay/Circle/x402 can be payment execution backends.
- Added `bin/agent-router-mcp.js`, a zero-dependency MCP stdio server for Claude/Desktop-style clients. This is now the preferred Claude integration because hosted Claude may block outbound access to `trycloudflare.com` and `railway.app`.
- Updated the AgentRouter skill into a GitHub-distributable bootstrap skill: it checks for existing AgentRouter MCP tools, chooses the best client-specific install path, and falls back to HTTP only when appropriate.
- Tightened protocol boundaries: `/agent-router/request` and MCP `agentrouter_request` are the preferred production-like paths; `/agent-router/ask` is only a demo/fallback natural-language wrapper.
- Structured requests now return `agent_router_evidence_v1`, including `trace_hash`, `result_hash`, `verification_hash`, payment receipt metadata, and a simulated Arc anchor.
- Added `GET /agent-router/evidence` and `GET /agent-router/trust` so the MVP shows where offchain trust state lives and what can later be anchored on Arc.
- Added lightweight `agent_router_route_observation_v1` records and `GET /agent-router/observations` so structured routing accumulates candidate, score, selection, verification, and feedback data for future learned routing without adding a heavy training system.
- Added Claude Desktop Extension package source in `mcpb/agentrouter` and generated `/Users/huazhenghao/Downloads/Arc/agentrouter.mcpb` for no-command local installation.
- `mcpb validate mcpb/agentrouter` passes and `mcpb pack mcpb/agentrouter` succeeds.
- Added publish-ready npm/npx MCP package source in `packages/agentrouter-mcp` with target package name `@agentrouter/mcp`.
- Added `npm run mcp:npm:check` and `npm run mcp:npm:pack` to validate the npm package before publication.

## Known Useful Local Flow

```bash
PORT=8800 npm start
curl -fsSL -X POST http://127.0.0.1:8800/agent-router/ask \
  -H "content-type: application/json" \
  -d '{"task":"BTC当前最大爆仓痛点是多少","max_price":"0.05"}'
```

For Claude or another agent client, prefer the MCP server:

```bash
claude mcp add AgentRouter \
  -e AGENT_ROUTER_URL=https://agentrouter-markets.onrender.com \
  -- node /Users/huazhenghao/Downloads/Arc/bin/agent-router-mcp.js
```

Temporary tunnels and some hosted domains may be blocked by Claude's remote network policy.

The Matrixport address demo depends on the upstream Lookonchain-style API at `127.0.0.1:3456`. If that upstream is not running, the service can remain registered but fail validation/invocation.

## Next Decisions

- Keep heuristic natural-language handling only as `/agent-router/ask` demo/fallback logic.
- Use route observations as the first lightweight dataset for improving provider ranking before considering graph models or learned rankers.
- Decide whether provider trust is registry-local first or anchored to ERC-8004-style attestations in the MVP.
- Decide how much payment UX to keep in dev x402 mode before integrating a real facilitator.
- Add a one-command provider onboarding path after the GUI stabilizes.
- For the hackathon build, decide whether to prioritize real Arc/Circle settlement or a polished Arc-compatible settlement adapter in the demo.
