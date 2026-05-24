# @agentrouter/mcp

Universal MCP server for AgentRouter.

AgentRouter routes AI agents to paid API/data services, supports quote-before-pay, invokes providers, verifies returned data, and returns an evidence envelope with trace hashes.

## Usage

Run with npx:

```bash
npx -y @agentrouter/mcp
```

Most AI clients configure MCP like this:

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

For a local AgentRouter server:

```json
{
  "mcpServers": {
    "AgentRouter": {
      "command": "npx",
      "args": ["-y", "@agentrouter/mcp"],
      "env": {
        "AGENT_ROUTER_URL": "http://127.0.0.1:8800",
        "AGENT_ROUTER_MAX_PRICE": "0.05"
      }
    }
  }
}
```

## Tools

- `agentrouter_request`: preferred structured capability request path. Use this first whenever the main agent can parse the user request.
- `agentrouter_quote`: route and quote without invoking a provider.
- `agentrouter_capabilities`: list capability schemas.
- `agentrouter_ask`: last-resort natural-language fallback for demos.

## Protocol Boundary

The main agent should parse user language into a structured capability request whenever possible. AgentRouter handles routing, quote, provider invocation, verification, payment metadata, and evidence.
