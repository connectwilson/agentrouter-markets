# AgentRouter Claude Desktop Extension

AgentRouter connects Claude Desktop to the Agent Native Data Network through MCP.

## Tools

- `agentrouter_request`: preferred structured capability request path. Use this first whenever the main agent can parse the user request.
- `agentrouter_quote`: route and quote without invoking a provider.
- `agentrouter_capabilities`: list capability schemas.
- `agentrouter_ask`: last-resort natural-language fallback for demos.

## Configuration

- `AgentRouter URL`: defaults to `https://agentrouter-markets.onrender.com`.
- `Default Max Price`: defaults to `0.05` USDC.

The main agent should parse user language into structured requests whenever possible. AgentRouter handles routing, quote, invocation, verification, and evidence.
