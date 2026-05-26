# AgentRouter Routing Stability Optimization PRD

Last updated: 2026-05-26

## Objective

Make AgentRouter reliable enough for production demand-side agents that need paid, real-time, specialized data. The product should avoid long trial-and-error tool chains, prevent wrong token/service matches before payment, and expose enough tracing and feedback data to improve routing over time.

This PRD covers the current priority areas:

1. Shorten the route/payment chain.
2. Improve token resolver quality and safety.
3. Make capability coverage explicit.
4. Enforce stricter service schemas.
5. Productize payment readiness and funding UX.
6. Add provider health monitoring and circuit breaking.
7. Support multi-source data planning and synthesis.
8. Close the feedback flywheel.
9. Add production observability.

## Problem Statement

The current MVP can route, pay, invoke, verify, and record feedback, but real agent usage shows four production blockers:

- Agents spend too much time checking payment state, quote state, and fallback paths before returning data.
- Token resolution can return a near match, for example `GENIUS -> GNUS`, and downstream agents may continue as if it were exact.
- Capability discovery is too coarse. A service may support smart-money data generally but not a requested token, chain, market, or time window.
- Operators cannot quickly see whether latency comes from token resolution, quote/ranking, Arc payment, provider response, verification, or feedback anchoring.

## Goals

- P95 successful local-wallet route under 5 seconds with real network payment, and under 500ms in mock/local tests.
- Ambiguous token substitutions must stop before target-service payment.
- Services with explicit enum coverage must not be selected for unsupported assets/chains/markets.
- Every paid or blocked route returns a stable `trace_id`, phase timing, selected/attempted service list, and blocking reason.
- Failed providers are automatically penalized and retried only when doing so is safe before payment.
- Multi-capability user requests should run as a bounded plan rather than unstructured repeated `ask` calls.
- Feedback events must directly affect future provider selection.

## Non-Goals

- AgentRouter is not the main trading agent and should not create investment advice by itself.
- AgentRouter does not replace provider-owned API credentials or store provider secrets in public client config.
- AgentRouter should not hide token substitutions. It may allow wrapped-token substitutions only when explicitly disclosed.

## Personas

- Demand-side agent: needs live paid data with minimal steps and clear failure modes.
- End user: expects a clear answer or a clear funding/coverage error, not internal command retries.
- Data provider: needs health, revenue, feedback, and service coverage visibility.
- Operator: needs request tracing, provider failure alerts, and deploy health metrics.

## Requirements

### 1. Shorten Route And Payment Chain

Current chain:

`intent parse -> token resolver -> quote -> target invoke -> verify -> feedback request`

Target behavior:

- Provide one high-level local-wallet call that performs plan, safe token resolution, quote, payment, invoke, verification, and evidence recording.
- Avoid separate quote calls unless the caller explicitly asks for quote-only mode.
- Retry next provider only if failure happens before payment or if the payment proof was not sent.
- Return compact route phases:
  - `intent_parse`
  - `token_resolution`
  - `route_quote`
  - `provider_payment_challenge`
  - `local_payment`
  - `provider_invoke`
  - `verification`
  - `evidence_feedback`

Acceptance:

- HYPE token smart-money local smoke path finishes in one `agentrouter_ask`/`agentrouter_request` tool call.
- Provider 503 before payment causes one retry to next candidate without charging the failed provider.
- Result includes `trace_id`, `timing.total_ms`, and attempted services.

### 2. Token Resolver Quality

Token resolution must return:

- `requested_symbol`
- `resolved_symbol`
- `resolution_type`: `exact_symbol`, `wrapped_token_substitution`, `symbol_substitution`, `address_match`, `no_match`
- `confidence`
- `auto_pay_allowed`
- `blocking_reason`
- `candidate_count`
- `resolver_input`

Rules:

- Exact symbol is auto-pay allowed.
- Wrapped-token substitutions are auto-pay allowed only when symbol and name clearly indicate wrapping.
- Symbol substitutions are not auto-pay allowed.
- If multiple plausible candidates exist with no exact/wrapped match, stop before target payment.

Acceptance:

- `GENIUS -> GNUS` returns `token_resolution_ambiguous` and no target quote/invoke.
- `HYPE -> WHYPE` returns `wrapped_token_substitution`, `auto_pay_allowed: true`, and disclosure text.

### 3. Capability Coverage

Every route should distinguish:

- Capability exists.
- Capability supports requested chain.
- Capability supports requested asset/token.
- Capability supports requested market type.
- Capability supports requested time window.

Rules:

- If a service schema has enum constraints, the router must enforce them before selection.
- If a service only exposes sample values and no enum, rank it lower unless validation data proves broader support.
- Coverage failures should return `coverage_not_supported`, not fabricated fallback data.

Acceptance:

- A BTC/ETH/SOL-only liquidation service is never selected for GENIUS.
- Generic smart-money netflow cannot be presented as token-level GENIUS exchange netflow when verification says coverage is false.

### 4. Stricter Service Schemas

Provider Studio should encourage or require:

- Supported chains.
- Supported assets or token address mode.
- Supported markets, for example spot, perp, options.
- Required request fields.
- Result coverage fields.

Rules:

- Imported services should infer enums when docs clearly show limited support.
- Provider-created services should expose coverage metadata in the manifest.
- Missing coverage metadata should lower routing confidence.

Acceptance:

- Published services expose machine-readable coverage in service details.
- Router ranking penalizes services with unknown coverage for specific-token requests.

### 5. Payment Readiness And Funding UX

Target user flow:

1. Install AgentRouter.
2. `doctor` confirms skill, MCP config, wallet, backend, and network.
3. If balance is low, the agent returns funding address and stops.
4. After funding, retry same request without changing config.

Rules:

- Do not ask users to manually configure MCP after one-command install unless doctor says config is missing.
- Do not let agents answer paid data questions from stale/free fallback when funding is required.
- Include `wallet_address`, `network`, `token`, `required_amount`, and `retry_instruction`.

Acceptance:

- Low balance returns `wallet_needs_funding` with a copyable address.
- Successful funding path does not require reinstall.

### 6. Provider Health Monitoring

Health model:

- Validation health: does sample invocation work?
- Runtime health: do paid calls succeed recently?
- Payment health: does 402 challenge work?
- Data quality health: does verification pass?

Rules:

- A provider with repeated pre-payment 5xx failures enters a temporary circuit-breaker window.
- Circuit-broken services are excluded from selection unless no alternatives exist.
- Health events are persisted and visible in Provider Studio.

Acceptance:

- Two or more recent runtime failures degrade routing score.
- A failed provider can recover after a passing health check.

### 7. Multi-Source Planning And Synthesis

A user may ask for multiple data domains, for example:

`GENIUS whale/smart money + exchange netflow + liquidation pain`

Planner behavior:

- Split the task into capability requests.
- Run independent data calls with a max budget and max call count.
- Stop unsupported subrequests with clear reasons.
- Return a synthesis object:
  - `answered_parts`
  - `unsupported_parts`
  - `paid_calls`
  - `coverage_warnings`
  - `final_data_confidence`

Acceptance:

- Unsupported liquidation pain for non-BTC/ETH/SOL returns a limitation, not fake data.
- Available token smart-money data can still be returned if other subrequests are unsupported.

### 8. Feedback Flywheel

Feedback should affect:

- Service trust score.
- Intent fit score.
- Coverage reliability.
- Provider ranking.
- Circuit-breaker recovery.

Feedback sources:

- Deterministic verification.
- Main-agent post-call feedback.
- User-visible answer usefulness.
- Provider health checks.

Acceptance:

- Negative feedback for intent fit lowers future rank for similar requests.
- Positive feedback increases rank only for matching capability/coverage, not globally.

### 9. Observability

Each request should expose:

- `trace_id`
- `route_id`
- `request_id`
- `phase_timings`
- `selected_service`
- `attempted_services`
- `blocking_reason`
- `payment_state`
- `verification_summary`

Operator views:

- Request trace by `trace_id`.
- Provider failure rate.
- Payment failure rate.
- P50/P95 latency by phase.
- Top unsupported capability requests.

Acceptance:

- A single trace can explain why a request took 5 minutes or 500ms.
- Production logs can be correlated with user-visible errors without exposing secrets.

## Milestones

### M1: Safety And Traceability

- Token resolver confidence and auto-pay gating.
- Unified trace IDs and phase timing.
- Enum-based capability coverage enforcement.
- Provider pre-payment failure recording.

### M2: Chain Shortening

- One-call local-wallet plan/invoke path.
- MCP tool returns compact plan/invoke result.
- Quote-only remains explicit.

### M3: Health And Feedback

- Circuit breaker window.
- Health dashboard fields.
- Feedback-to-ranking by capability and coverage.

### M4: Multi-Source Planner

- Capability decomposition for common market intelligence bundles.
- Bounded parallel calls.
- Synthesis envelope.

### M5: Production Observability

- Request trace endpoint.
- Latency aggregates.
- Provider failure alerts.

## Metrics

- Route success rate.
- Unsupported-with-clear-reason rate.
- Wrong-token-payment rate, target 0.
- P50/P95 total route time.
- P50/P95 by phase.
- Provider pre-payment failure rate.
- Feedback completion rate.
- Repeat provider selection after negative feedback.

## Immediate Implementation Plan

1. Add trace IDs and normalized phase timing to local route results.
2. Add confidence fields to token resolution responses.
3. Enforce enum coverage before candidate selection.
4. Add a compact local plan/invoke result shape.
5. Add tests for ambiguous token blocking, enum coverage, provider retry, and timing.
6. Add provider health/circuit-breaker in the next slice.
