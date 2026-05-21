---
name: AgentRouter
description: Use this skill when the user asks to install AgentRouter, use AgentRouter, discover an API/data service, route a data request, call registered services from an Agent Data Network, or connect an AI client to AgentRouter. This is a generic bootstrap and runtime skill, not a single fixed provider.
---

# AgentRouter

AgentRouter discovers, routes to, and invokes registered API/data services from an Agent Data Network. It is generic: use it for any supported data/API request, not one fixed provider or one query.

## Runtime Use

When the user asks to use AgentRouter:

1. If MCP tools are already available, use them directly:
   - `agentrouter_request`: preferred; use after the main agent has parsed the user request into a structured capability request
   - `agentrouter_ask`: fallback/demo; use only when the client cannot produce a structured request
   - `agentrouter_quote`: structured request -> route + quote + budget guard only
   - `agentrouter_capabilities`: list supported capability schemas
2. If MCP tools are not available but HTTP access is available, call:

```bash
curl -sS -X POST "https://agentrouter-markets.onrender.com/agent-router/ask" \
  -H "content-type: application/json" \
  -d '{"task":"<user original request>","max_price":"0.05"}'
```

3. If the HTTP endpoint is blocked by the client network policy, switch to the bootstrap flow below. Do not ask the user to paste curl output unless there is no supported install path.

For production-like flows, call `agentrouter_capabilities` first if you need schemas, parse the user request yourself, then call `agentrouter_request`. AgentRouter should not be treated as the semantic parser.

For requests outside the fixed capability catalog, search registered services or use `agentrouter_ask` rather than forcing the request into an unrelated fixed capability. Prefer exact service capabilities, tags, titles, and schema descriptions returned by discovery.

Return the `answer` field first when present. Then include selected service, input, relevant result data, evidence trace hash, quote or settlement receipt, and verification/feedback status when present.

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
```

If the user runs a local AgentRouter server, use:

```text
AGENT_ROUTER_URL=http://127.0.0.1:8800
```

## Client Guidance

Use this guidance only when installation is needed.

- Claude Desktop / Claude Code: prefer local MCP bridge or `.mcpb`; if a CLI is available, the command is `claude mcp add AgentRouter -e AGENT_ROUTER_URL=https://agentrouter-markets.onrender.com -- node /Users/huazhenghao/Downloads/Arc/bin/agent-router-mcp.js`.
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
- Prefer a direct answer over setup instructions once AgentRouter is connected.
