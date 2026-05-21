# Architecture

## Components

- Provider Studio: human-facing service onboarding GUI.
- Registry: stores service manifests, provider metadata, validation status, and feedback events.
- Persistent Registry: Postgres-backed provider config and encrypted secret storage, enabled by `DATABASE_URL`. Hosted Provider Studio deployments should require this so registered services survive restarts.
- Connector API: agent-facing primitives for search, manifest, preview, paid invocation, and feedback.
- AgentRouter: higher-level routing endpoint that accepts a natural-language task and performs search -> selection -> invocation -> summary.
- Route Observations: lightweight offchain records of structured routing decisions, candidate scores, selected service, verification outcome, and feedback hashes for future ranking improvements.
- Provider Runtime: local provider endpoints that return preview or paid agent data envelopes.
- Wallet/Payment: dev-mode x402-style challenge and signed proof.

## Trust Boundaries

- Demand agents should not choose payment target or amount directly. Invocation derives those from the service manifest and provider challenge.
- Provider secrets stay server-side in provider config/runtime. They should not be exposed to demand agents or Skill files.
- Hosted provider credentials are encrypted before persistence. `ADN_PROVIDER_SECRET_PASSPHRASE` is the deployment key and must remain stable across restarts.
- Provider-owned upstream API keys must not be hardcoded into hosted deployment environment variables for normal onboarding. Provider Studio collects provider credentials and stores encrypted secret records in the persistent registry.
- AgentRouter returns routing metadata so the main agent can inspect which service was selected, what input was used, and whether schema validation passed.
- Public Skills should call an HTTP endpoint, not a local filesystem path, when used from hosted Claude-like environments.

## Agent-Friendly Response Shape

Paid results should return an `agent_data_envelope_v1`-style object:

- `status`
- `service_id`
- `request_id`
- `query`
- `data`
- `metadata`
- `limitations`

The exact provider data can vary by service, but the envelope gives the calling agent stable places to inspect freshness, confidence, limitations, and source metadata.
