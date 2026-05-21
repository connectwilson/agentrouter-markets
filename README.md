# Agent Native Data Network MVP

Local MVP for an Agent-native paid data service network.

It demonstrates:

- Discovery Connector bootstrap entry for Codex / Claude / Cursor-style agents
- Service Registry
- Provider service manifest
- Sample response preview
- Provider onboarding validation
- Hosted HTTP Provider Runtime with private Provider Secret
- x402-style HTTP 402 payment challenge and retry flow
- Local Alice Agent Wallet with budget policy
- Agent-friendly `agent_data_envelope_v1` response
- ERC-8004-compatible identity metadata fields
- Feedback event generation after paid invocation

## Run Tests

```bash
npm test
```

The test suite starts local HTTP servers, uses temporary runtime directories for wallet/provider state, validates services, performs discovery, previews sample responses, completes paid invocations, checks feedback, and verifies provider configs can be reloaded after restart.

## Project Structure

```text
bin/adn.js                 CLI entrypoint
src/server.js              HTTP routing shell and bootstrap
src/registry.js            service registry, search, validation, invocation
src/provider-runtime.js    built-in and configurable provider endpoints
src/provider-config.js     provider config generation/loading
src/openapi-import.js      OpenAPI/Swagger discovery and batch service drafts
src/studio.js              Provider Studio GUI and form handler
src/router.js              task intent normalization and service routing
src/verifier.js            post-call result verification
src/wallet.js              local Alice Agent Wallet and policy
src/payment.js             dev x402-compatible payment proof
src/local-invoke.js        CLI paid invocation through local wallet
src/local-route.js         CLI route flow through local wallet
src/id-utils.js            ID and capability suggestion helpers
src/schema.js              JSON schema and envelope validation
src/http-utils.js          shared HTTP helpers
bin/agent-router-mcp.js    MCP stdio server for Claude/Desktop-style clients
test/mvp.test.js           end-to-end MVP coverage
```

## Run Demo

```bash
npm run demo
```

Expected flow:

```text
Discovery Connector -> Registry search -> Manifest -> Preview -> 402 challenge -> dev x402 payment proof -> paid result -> feedback event -> final analysis
```

## Start Server

```bash
npm start
```

The server binds to `127.0.0.1:8787` by default and seeds the demo service.

Open the Provider Studio GUI:

```text
http://127.0.0.1:8787/studio
```

## CLI Connector

With the server running:

```bash
node bin/adn.js wallet init
node bin/adn.js search "Base 7d fund flow"
node bin/adn.js manifest chain_fund_flow_7d_base
node bin/adn.js preview chain_fund_flow_7d_base
node bin/adn.js invoke chain_fund_flow_7d_base '{"chain":"base","days":7}'
node bin/adn.js route "BTC 当前最大爆仓痛点是多少" --max-price 0.05 --freshness 300
node bin/adn.js feedback chain_fund_flow_7d_base
```

Set a custom registry URL:

```bash
ADN_REGISTRY_URL=http://127.0.0.1:8787 node bin/adn.js search "Base 7d fund flow"
```

## Agent Router

The router is the MVP version of the Agent capability routing layer. The formal protocol is structured: the main agent parses the user's request, asks `/capabilities` for supported schemas when needed, then sends a capability request to `/agent-router/request`. AgentRouter validates the schema, selects a matching service, quotes the payment, performs a paid invocation, verifies the result, and returns an evidence envelope.

`/agent-router/ask` remains a demo fallback for natural-language testing. It is not the core protocol and should not be treated as the semantic parser in production.

Example:

```bash
ADN_REGISTRY_URL=http://127.0.0.1:8787 \
node bin/adn.js route "BTC 当前最大爆仓痛点是多少" --max-price 0.05 --freshness 300
```

For this ambiguous crypto query, the router returns `route_with_assumption` and explicitly states that it interpreted "爆仓痛点" as perpetual futures liquidation max-pain, not options max pain. If the task only says "BTC 最大痛点是多少", the router returns `needs_clarification` instead of guessing.

Router response fields include:

- `protocol`
- `request`
- `normalized_intent`
- `intent_confidence`
- `assumptions`
- `ambiguities`
- `selected_service`
- `candidates_considered`
- `verification`
- `evidence`
- `result`

Structured request example:

```bash
curl -fsSL -X POST http://127.0.0.1:8787/agent-router/request \
  -H "content-type: application/json" \
  -d '{"capability":"perp_liquidation_max_pain","params":{"asset":"BTC","market_type":"perpetual_futures","window":"current"},"constraints":{"max_price_usdc":"0.05","freshness_seconds":300}}'
```

The returned `evidence` object includes `trace_hash`, `result_hash`, `verification_hash`, payment receipt metadata, and a simulated Arc anchor. Trust scores are computed offchain from feedback events; evidence hashes are the audit surface that can later be pinned on Arc.

## Alice Wallet

The MVP supports scheme A from the product discussion: Alice gets a local Agent Wallet controlled by the CLI.

Initialize it once:

```bash
export ADN_WALLET_PASSPHRASE="choose-a-local-demo-passphrase"
node bin/adn.js wallet init
node bin/adn.js wallet address
node bin/adn.js wallet status
```

Set local spend limits:

```bash
node bin/adn.js wallet policy set --per-call 0.05 --daily 2
```

View local payment history:

```bash
node bin/adn.js wallet log
node bin/adn.js payment plan
```

When Claude / Codex calls `adn invoke`, the CLI:

1. Fetches the service manifest
2. Requests the provider endpoint
3. Receives HTTP 402 payment requirements
4. Checks Alice's local policy
5. Signs a dev x402 payment proof with Alice's local Agent Wallet
6. Retries the provider request
7. Records the payment in `.adn/payments.log`

No manual signature is required for payments inside policy limits. Payments above policy limits are rejected instead of prompting, which keeps CLI use safe inside Agent workflows.

### Wallet Safety Guardrails

The MVP treats Alice's wallet as a local Agent hot wallet with policy checks. The AI never chooses `pay_to` or `amount`; `adn invoke` derives those from the service manifest and the provider's HTTP 402 challenge.

Implemented guardrails:

- `.adn/` is gitignored
- wallet private key is encrypted at rest with `ADN_WALLET_PASSPHRASE`
- payments require a complete HTTP 402 challenge
- payment proof binds `service_id`, `amount`, `network`, `asset`, `pay_to`, `nonce`, expiry, and resource hash
- provider rejects replayed challenge nonces
- wallet policy enforces per-call and daily limits
- wallet policy can restrict services, providers, and payment targets
- `adn wallet lock` disables automatic signing
- wallet payment log records challenge nonce and payment target

Useful commands:

```bash
node bin/adn.js wallet lock
node bin/adn.js wallet unlock
node bin/adn.js wallet policy set --service-allowlist chain_fund_flow_7d_base
node bin/adn.js wallet policy set --provider-allowlist provider_bob
node bin/adn.js wallet policy set --pay-to-allowlist 0xProviderDemoWallet000000000000000000000000
```

Still TODO for production:

- OS keychain integration
- separate signer daemon
- session wallet / spending-cap smart account
- real x402 settlement

## Payment Modes

The MVP defaults to:

```bash
ADN_PAYMENT_BACKEND=dev
```

In dev mode, the provider still returns an x402-style HTTP 402 challenge, but the CLI signs a local development payment proof instead of settling real USDC.

AgentRouter treats payment as an adapter boundary. It is not intended to compete with full payment SDKs such as OmniAgentPay; those can become execution backends while AgentRouter remains responsible for capability discovery, provider selection, result verification, and trust feedback.

Supported backend names:

```bash
ADN_PAYMENT_BACKEND=dev
ADN_PAYMENT_BACKEND=x402
ADN_PAYMENT_BACKEND=omniagentpay
ADN_PAYMENT_BACKEND=circle_arc
```

Quote a route before paying:

```bash
node bin/agent-router.js quote '{"capability":"perp_liquidation_max_pain","params":{"asset":"BTC","market_type":"perpetual_futures","window":"current"},"constraints":{"max_price_usdc":"0.05"}}'
```

## Claude MCP Integration

Hosted Claude environments may block outbound access to temporary tunnels or platform domains such as `trycloudflare.com` and `railway.app`. The preferred integration is a local MCP server: Claude calls the MCP tool locally, and the MCP server forwards requests to either the Railway deployment or your local AgentRouter server.

### No-Command Claude Desktop Install

Claude Desktop users should install the packaged extension:

```text
/Users/huazhenghao/Downloads/Arc/agentrouter.mcpb
```

In Claude Desktop:

```text
Settings -> Extensions -> Install Extension -> choose agentrouter.mcpb
```

When prompted, keep:

```text
AgentRouter URL = https://agentrouter-markets.onrender.com
Default Max Price = 0.05
```

Build or rebuild the package:

```bash
npm run mcpb:pack
```

Validate the extension manifest:

```bash
mcpb validate mcpb/agentrouter
```

Register the MCP server with Claude:

```bash
claude mcp add AgentRouter \
  -e AGENT_ROUTER_URL=https://agentrouter-markets.onrender.com \
  -- node /Users/huazhenghao/Downloads/Arc/bin/agent-router-mcp.js
```

If you are using a local AgentRouter server instead:

```bash
PORT=8800 npm start
claude mcp add AgentRouter \
  -e AGENT_ROUTER_URL=http://127.0.0.1:8800 \
  -- node /Users/huazhenghao/Downloads/Arc/bin/agent-router-mcp.js
```

The MCP server exposes:

- `agentrouter_request`: structured request -> route -> invoke -> verify -> evidence
- `agentrouter_ask`: natural-language fallback -> route -> invoke -> verify
- `agentrouter_quote`: structured request -> quote and budget guard only
- `agentrouter_capabilities`: capability catalog and schemas

## Universal npm / npx MCP Install

For Cursor, Windsurf, Cline, Continue, VS Code, and other MCP-capable clients, the portable install path is npm/npx.

Package source:

```text
packages/agentrouter-mcp
```

Target package name:

```text
@agentrouter/mcp
```

MCP config:

```json
{
  "mcpServers": {
    "AgentRouter": {
      "command": "npx",
      "args": ["-y", "@agentrouter/mcp"],
      "env": {
        "AGENT_ROUTER_URL": "https://agentrouter-markets.onrender.com",
        "AGENT_ROUTER_MAX_PRICE": "0.05"
      }
    }
  }
}
```

Local development config before publishing:

```json
{
  "mcpServers": {
    "AgentRouter": {
      "command": "node",
      "args": ["/Users/huazhenghao/Downloads/Arc/packages/agentrouter-mcp/bin/agentrouter-mcp.js"],
      "env": {
        "AGENT_ROUTER_URL": "http://127.0.0.1:8800",
        "AGENT_ROUTER_MAX_PRICE": "0.05"
      }
    }
  }
}
```

Validate the npm package:

```bash
npm run mcp:npm:check
npm run mcp:npm:pack
```

## GitHub Skill Bootstrap

The installable skill in `claude-skills/agent-router/SKILL.md` is intentionally written as a universal bootstrap:

1. It first checks whether AgentRouter MCP tools are already available.
2. If not, it detects the current AI client where possible.
3. It picks the best install path for that client: Remote MCP, local MCP bridge, Desktop Extension, or HTTP fallback.
4. Once connected, it uses AgentRouter generically for any registered API/data service.

After publishing the skill folder to GitHub, users can ask their AI client:

```text
请从这个 GitHub 链接安装 AgentRouter Skill，并用 AgentRouter 帮我查询数据：
<YOUR_GITHUB_SKILL_URL>
```

For best results, the GitHub URL should point directly to the `agent-router` skill folder or a repo whose root contains `SKILL.md`.

Inspect the production migration checklist:

```bash
node bin/adn.js payment plan
```

Production x402 integration should replace:

- buyer-side `createWalletPaymentProof` with an official x402 exact EVM client payment authorization
- seller-side `verifyDevPaymentProof` with facilitator `/verify` and `/settle`
- demo payment requirements with official x402 payment requirements
- fake tx hashes with real settlement hashes

Relevant runtime configuration:

```bash
ADN_PAYMENT_BACKEND=dev
ADN_PROVIDER_RECEIVE_ADDRESS=0x...
ADN_X402_FACILITATOR_URL=https://x402.org/facilitator
```

## Provider Onboarding

Start the server first:

```bash
npm start
```

### GUI

Open:

```text
http://127.0.0.1:8787/studio
```

The form supports:

- `static-json`
- `hosted-http`
- OpenAPI / Swagger import

Provider Studio generates service IDs, provider IDs, and default capability tags from the service title, provider name, and agent-facing description. These fields remain editable under advanced settings for stable integrations.

Click **Create, Register, Validate** to generate provider config, register the service, run validation, and get next-step CLI commands.

Use **Fill Hosted Demo** to populate a working hosted HTTP example that calls the local mock upstream endpoint.

Use **Import API Collection** when one provider API has many data endpoints. Paste one API base URL and Studio will try the direct URL plus `/openapi.json`, `/swagger.json`, and `/.well-known/openapi.json`.

The importer generates one service draft per data endpoint, skips operational endpoints such as `/auth`, `/health`, `/metrics`, and `/debug`, then lets Bob review or edit the drafts before publishing. The local demo API is:

```text
http://127.0.0.1:8787/mock/api
```

This creates separate services, such as funding-rate and liquidation max-pain, instead of hiding many endpoints behind one large service.

### CLI

In another terminal, run the guided onboarding flow:

```bash
node bin/adn.js provider onboard
```

Default mode is `static-json`. The CLI asks for:

- title
- provider name
- agent-facing description
- capability tags, suggested automatically from the title and description
- price
- example request JSON
- preview data JSON
- paid result data JSON
- paid response summary

Then it automatically:

1. Generates `providers/<service_id>.json`
2. Builds a service manifest
3. Registers the service with the local Registry
4. Runs Validator against the generated endpoint
5. Returns next-step commands for search, preview, and invoke

For a non-interactive smoke test:

```bash
node bin/adn.js provider onboard --yes
node bin/adn.js search "sentiment demo"
node bin/adn.js preview community_sentiment_demo
node bin/adn.js wallet init
node bin/adn.js invoke community_sentiment_demo '{"asset":"ETH","window":"7d"}'
```

### Hosted HTTP Mode

Hosted HTTP mode lets Bob publish a paid service without running his own public endpoint. The platform-hosted Provider Runtime calls Bob's configured upstream endpoint after payment.

Smoke test:

```bash
node bin/adn.js provider onboard --mode hosted-http --yes
node bin/adn.js search "hosted http sentiment"
node bin/adn.js preview hosted_http_sentiment_demo
node bin/adn.js wallet init
node bin/adn.js invoke hosted_http_sentiment_demo '{"asset":"ETH","window":"7d"}'
```

In hosted HTTP mode, the submitted Provider Secret is moved into the local encrypted Provider Secret store:

```text
.adn/provider-secrets.json
```

It is encrypted with `ADN_PROVIDER_SECRET_PASSPHRASE`, falling back to `ADN_WALLET_PASSPHRASE` for local MVP demos.

The generated provider config only includes a secret reference:

```json
{
  "source": {
    "type": "hosted_http",
    "auth": {
      "secret_name": "PROVIDER_SECRET",
      "secret_ref": "hosted_http_sentiment_demo:PROVIDER_SECRET"
    }
  }
}
```

That secret is runtime config only. It is not copied into the public manifest:

```json
{
  "runtime_secrets": {
    "required": true,
    "custody": "hosted_runtime_config",
    "public": false
  }
}
```

This keeps the product framing as “publish a paid data capability service” rather than “publish an API key.” The current MVP uses a local encrypted secret store as a stand-in for a production vault.

The current configurable provider runtime supports `static_json` and `hosted_http`. The next source adapters should be `cli_command`, `mcp_tool`, and production vault-backed `hosted_http`.

## Important MVP Note

The payment implementation is a local development x402-compatible handshake: the Provider returns HTTP 402, the CLI creates a wallet-signed dev payment proof, then retries the request. This validates the product flow without requiring real USDC settlement. The production version should replace `src/payment.js` with a real x402 SDK / facilitator integration and use an actual Base USDC-funded wallet or session wallet.
