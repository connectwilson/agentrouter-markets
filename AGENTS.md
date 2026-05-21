# AgentRouter Project Context

This project is an MVP for an Agent Native Data Network: providers register API/data services, a router discovers the best service for an agent task, the selected service is invoked through a paid call, and feedback/verification metadata is returned.

## Core Loop

Provider Studio imports or creates a service -> registry validates and stores a manifest -> demand-side AgentRouter searches services -> router selects one and builds input -> connector invokes paid service -> result envelope plus verification feedback returns to the main agent.

## Key Files

- `src/server.js`: HTTP API, Provider Studio routes, connector routes, AgentRouter HTTP route.
- `src/studio.js`: Provider Studio GUI.
- `src/openapi-import.js`: OpenAPI endpoint discovery and service draft generation.
- `src/agent-router.js`: demand-side natural-language routing helper.
- `bin/agent-router.js`: CLI wrapper for remote/local AgentRouter calls.
- `bin/adn.js`: lower-level CLI for wallet, search, route, invoke, feedback.
- `claude-skills/agent-router/SKILL.md`: external Claude skill instructions.
- `codex-skills/agent-router-project/SKILL.md`: development collaboration skill.
- `docs/STATUS.md`: current state and next work.
- `docs/MVP_WORKFLOWS.md`: provider and demand-side flows.
- `docs/ARCHITECTURE.md`: system architecture and trust boundaries.

## Commands

```bash
npm start
npm test
PORT=8800 npm start
AGENT_ROUTER_URL=http://127.0.0.1:8800 node bin/agent-router.js ask "查询标记为 Matrixport 的地址"
```

## Product Principles

- The product is not just an API directory. Its wedge is agent-native capability routing plus post-call verification/trust feedback.
- MCP connects tools after humans install them; this MVP focuses on discovery, zero preconfiguration for the demand agent, paid invocation, and service quality feedback.
- Do not propose hardcoding provider API keys in deployment environment variables as the long-term or normal provider onboarding path. Provider-owned credentials must come through Provider Studio/onboarding and be stored as provider secrets in the registry/persistence layer. Environment variables are only acceptable for platform-level bootstrap/config or temporary local tests, not for adding each new provider service.
- Skills should stay short. Stable project context belongs in this file and `docs/`; transient run state belongs in `docs/STATUS.md`.
