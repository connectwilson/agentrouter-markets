# AgentRouter for Agora Agents Hackathon PRD

## 1. One-Liner

AgentRouter is a paid market-intelligence routing layer for trading agents: when an agent needs niche market data, it can discover the best provider, pay per call in USDC on Arc, receive an agent-friendly verified result, and feed that result back into its market decision.

## 2. Hackathon Fit

Agora is about agents that trade, invest, create, and interface with markets, settled instantly on Arc with USDC.

AgentRouter should not be submitted as a generic API marketplace. For this hackathon, it should be positioned as infrastructure for market agents:

> Trading agents are only as good as the private and specialized signals they can access at runtime. Today, every trading agent depends on pre-installed tools, manually configured API keys, and hard-coded data sources. AgentRouter lets a market agent dynamically source specialized intelligence, pay per call, verify quality, and build a trust graph over providers.

The important boundary:

> AgentRouter is not the market agent, semantic parser, or prediction-market creator. It is the capability router and evidence layer. The main agent decides what the user means and what to do next; AgentRouter supplies verified market intelligence and an auditable trace.

## 3. Target Track / RFB

Primary fit:

- Perpetual futures trading agent
- Market intelligence for autonomous trading/investment agents
- Agent-to-agent commerce and nanopayments

Recommended demo query:

```text
BTC 当前最大爆仓痛点是多少？如果我现在有 3x long，要不要降杠杆？
```

This query is strong because it requires specialized derivatives data that a generic model or web search cannot reliably answer. It also naturally leads to a market decision.

## 4. Problem

Market agents currently face four bottlenecks:

1. Data discovery is manual.
   Agents do not know which niche data service exists unless a human installs/configures it.

2. Credentials are human-centric.
   Most valuable data services require accounts, API keys, subscriptions, and manual setup.

3. Tool routing is local and brittle.
   A main agent can choose among tools it already has, but it cannot easily source a new external capability at runtime.

4. Provider trust is not portable.
   Even if a data service returns something, the calling agent needs to know whether the result was schema-valid, fresh, fast, relevant, and useful.

## 5. Core Product Hypothesis

AI creates a new primitive that was not very useful before:

> A calling agent can understand a task, outsource missing market intelligence to a specialized provider, verify the returned data shape and usefulness, and use post-call feedback to improve future routing.

The new value is not just "paid API access." The new value is:

- agent-native discovery
- standardized capability requests
- deterministic provider routing
- pay-per-call settlement
- result verification
- provider trust accumulation

Important product stance:

> AgentRouter should not make natural-language understanding its core protocol responsibility. Natural-language parsing is useful for demos and consumer UX, but the durable protocol should route structured capability requests.

This keeps AgentRouter closer to infrastructure than to a chatbot. The main agent, UI, or client SDK can translate user language into structured requests; AgentRouter then does deterministic matching, payment, invocation, and verification.

## 6. MVP Scope

The hackathon MVP should prove one complete loop:

```text
Main Agent
  -> AgentRouter
  -> service discovery
  -> provider selection
  -> verified USDC payment on Arc
  -> market data provider
  -> agent_data_envelope_v1 result
  -> verification + evidence envelope + feedback event
  -> main agent market decision
```

## 7. Demo Scenario

### User Story

As a crypto trader using a main AI agent, I want to ask a market question in natural language, so that my agent can source the specialized data it lacks and give me a risk-aware answer.

### Demo Flow

1. User asks:

```text
BTC 当前最大爆仓痛点是多少？如果我现在有 3x long，要不要降杠杆？
```

2. Main agent reads the AgentRouter capability catalog and constructs a structured request:

```http
GET /capabilities
```

Example capability:

```json
{
  "capability": "perp_liquidation_max_pain",
  "description": "Get liquidation max-pain for perpetual futures.",
  "input_schema": {
    "type": "object",
    "required": ["asset", "market_type", "window"],
    "properties": {
      "asset": { "type": "string", "enum": ["BTC", "ETH", "SOL"] },
      "market_type": { "type": "string", "enum": ["perpetual_futures"] },
      "window": { "type": "string", "enum": ["current", "1h", "4h"] }
    }
  }
}
```

3. Main agent calls the formal protocol endpoint:

```http
POST /agent-router/request
```

Request:

```json
{
  "capability": "perp_liquidation_max_pain",
  "params": {
    "asset": "BTC",
    "market_type": "perpetual_futures",
    "window": "current"
  },
  "constraints": {
    "max_price_usdc": "0.05",
    "freshness_seconds": 300,
    "min_confidence": 0.7
  },
  "consumer_context": {
    "position": {
      "direction": "long",
      "leverage": 3
    }
  }
}
```

4. For demo convenience, AgentRouter may also expose a natural-language wrapper:

```http
POST /agent-router/ask
```

This endpoint converts the natural-language task into the same structured request, then internally calls `/agent-router/request`. It should not be treated as the core protocol.

5. AgentRouter validates the structured request:

```json
{
  "capability": "perp_liquidation_max_pain",
  "asset": "BTC",
  "market_type": "perpetual_futures",
  "window": "current"
}
```

6. AgentRouter searches registered providers.

7. AgentRouter selects:

```text
btc_liquidation_max_pain_demo
```

8. AgentRouter pays the provider.

9. Provider returns:

```json
{
  "schema_version": "agent_data_envelope_v1",
  "status": "success",
  "data": {
    "max_liquidation_pain_price": 103500,
    "direction": "downside",
    "estimated_liquidation_notional_usd": 820000000,
    "reference_price": 106200
  },
  "metadata": {
    "freshness_seconds": 45,
    "confidence": 0.78,
    "limitations": [
      "Liquidation clusters are estimates and should not be used as trading advice."
    ]
  }
}
```

10. AgentRouter emits feedback:

```json
{
  "schema_valid": true,
  "latency_ms": 11,
  "status": "success",
  "consumer_rating": 1
}
```

11. AgentRouter returns an evidence envelope:

```json
{
  "evidence_version": "agent_router_evidence_v1",
  "service_id": "btc_liquidation_max_pain_demo",
  "trace_hash": "0x...",
  "result_hash": "0x...",
  "verification_hash": "0x...",
  "payment": {
    "settlement_receipt": {}
  },
  "arc_anchor": {
    "network": "arc",
    "status": "simulated_anchor",
    "event_type": "AgentRouterEvidence"
  }
}
```

12. Main agent answers:

```text
当前 BTC 永续合约最大爆仓痛点约在 103,500，主要影响多头。你当前是 3x long，如果价格接近该区域，强平和流动性踩踏风险会上升。建议降低杠杆或设置明确止损。该数据来自 AgentRouter 选择的 btc_liquidation_max_pain_demo 服务，schema 校验通过，freshness 45 秒。
```

13. If a Market Agent exists, it may use the evidence to propose or create a prediction market. This is downstream of AgentRouter, not AgentRouter's core responsibility.

## 8. User Personas

### Alice: Demand-Side Trader

- Uses Claude/Codex or another main agent.
- Wants market decisions, not raw API docs.
- Does not want to apply for API keys or configure 10 data providers.
- Has USDC and is willing to pay small amounts for useful signals.

### Bob: Data Provider

- Has a niche market data endpoint, model, private dashboard, or dataset.
- Wants to monetize it per call.
- Does not want to build a full SaaS subscription platform.
- Can publish an agent-friendly service manifest through Provider Studio.

### Main Agent

- Receives the user task.
- Knows when it lacks specialized data.
- Calls AgentRouter to source missing capability.
- Uses the returned data and trust metadata in its reasoning.

## 9. Core Features

### 9.1 Provider Studio

Provider Studio lets Bob publish a market data service.

Required fields:

- service title
- service description for agents
- capabilities
- endpoint URL or imported OpenAPI endpoint
- sample request
- preview response
- paid response shape
- price in USDC

Hackathon demo services:

1. BTC liquidation max-pain
2. Funding rate / venue comparison
3. Whale or smart-money address signal

### 9.2 AgentRouter Discovery

AgentRouter should expose two layers:

1. Formal protocol endpoint:

```http
POST /agent-router/request
```

2. Natural-language demo wrapper:

```http
POST /agent-router/ask
```

`/agent-router/request` is the durable product interface. It receives structured capability requests and performs deterministic matching.

Input:

```json
{
  "capability": "perp_liquidation_max_pain",
  "params": {
    "asset": "BTC",
    "market_type": "perpetual_futures",
    "window": "current"
  },
  "constraints": {
    "max_price_usdc": "0.05",
    "freshness_seconds": 300,
    "min_confidence": 0.7
  }
}
```

Output:

```json
{
  "ok": true,
  "protocol": {},
  "selected_service": {},
  "request": {},
  "result": {},
  "feedback": {},
  "evidence": {}
}
```

`/agent-router/ask` is a convenience layer for demos and human-friendly clients.

Input:

```json
{
  "task": "BTC 当前最大爆仓痛点是多少？",
  "max_price": "0.05",
  "currency": "USDC"
}
```

Output:

```json
{
  "ok": true,
  "answer": "...",
  "selected_service": {},
  "input": {},
  "result": {},
  "feedback": {}
}
```

### 9.3 Capability Catalog

AgentRouter should expose a capability catalog so main agents do not have to guess what structured requests are valid.

Endpoint:

```http
GET /capabilities
```

Each capability should include:

- capability id
- human description
- agent description
- input schema
- required fields
- constraints supported
- example user queries
- example structured requests
- related capabilities
- ambiguity notes

Example:

```json
{
  "capability": "perp_liquidation_max_pain",
  "agent_description": "Use this when the user asks for perpetual futures liquidation clusters, liquidation pain, or forced liquidation risk.",
  "not_for": [
    "options max pain",
    "spot support/resistance"
  ],
  "input_schema": {
    "type": "object",
    "required": ["asset", "market_type", "window"]
  },
  "examples": [
    {
      "user_query": "BTC 当前最大爆仓痛点是多少？",
      "request": {
        "capability": "perp_liquidation_max_pain",
        "params": {
          "asset": "BTC",
          "market_type": "perpetual_futures",
          "window": "current"
        }
      }
    }
  ]
}
```

### 9.4 Routing

Formal routing should be deterministic:

- exact capability match
- JSON schema validation
- required parameter validation
- budget filtering
- freshness filtering
- provider trust ranking
- output schema compatibility check
- paid invocation
- post-call verification

Natural-language routing can exist as a wrapper:

- rule-based intent detection for the demo
- capability taxonomy
- service search and scoring
- clear fallback when ambiguous

Required behaviors:

- Prefer `/agent-router/request` for agent-to-protocol calls.
- Do not guess silently for ambiguous market terms.
- If the task asks for "最大痛点" without market type, ask whether the user means options max pain or perpetual futures liquidation max-pain.
- Prefer verified services within budget.
- Return selected service and constructed input transparently.

Error example:

```json
{
  "ok": false,
  "error": "MISSING_REQUIRED_PARAM",
  "missing": ["market_type"],
  "expected_schema": {}
}
```

### 9.5 USDC Payment

For the hackathon, the product should visibly represent each data call as a paid agent-to-agent service invocation.

AgentRouter is not a payment SDK. It is the capability discovery, routing, verification, and trust layer for agents buying external data/services. Payment systems such as OmniAgentPay, Circle wallets, or official x402 clients should be treated as execution backends.

Payment backend abstraction:

```text
AgentRouter
  capability routing
  provider ranking
  result verification
  trust feedback
      |
      v
Payment Adapter
  dev
  x402
  omniagentpay
  circle_arc
```

MVP payment backends:

1. Dev mode:
   - x402-style HTTP 402 challenge
   - local signed payment proof
   - mock tx hash

2. x402 mode:
   - official x402 client and facilitator
   - real payment verification and settlement

3. OmniAgentPay mode:
   - delegate wallet, guards, ledger, and payment execution to OmniAgentPay
   - keep AgentRouter responsible for provider selection and result verification

4. Circle Arc mode:
   - Arc-compatible payment adapter
   - USDC-denominated price
   - tx hash or settlement receipt displayed in the result

Recommended long-term flow:

```text
quote
-> authorize / reserve budget
-> provider returns data
-> verify schema, freshness, and coverage
-> capture payment if valid
-> release payment if invalid
```

The current MVP still does pay-then-verify in dev mode, but it now exposes a quote step so agents can inspect route, price, and guard result before paying.

### 9.5.1 Quote Before Pay

AgentRouter should expose:

```http
POST /agent-router/quote
```

This endpoint performs deterministic routing and payment guard simulation without invoking the provider or spending funds.

Quote response:

```json
{
  "ok": true,
  "status": "quoted",
  "selected_service": {},
  "input": {},
  "quote": {
    "quote_version": "agent_router_payment_quote_v1",
    "payment_backend": {
      "backend": "circle_arc",
      "real_settlement": true
    },
    "pricing": {
      "amount": "0.02",
      "currency": "USDC"
    },
    "guard_result": "pass",
    "would_pay": true
  }
}
```

### 9.6 Verification and Trust

Each paid call should create a feedback event.

Minimum feedback fields:

- service_id
- provider_id
- request_id
- payment_tx
- status
- schema_valid
- latency_ms
- freshness_valid
- consumer_rating
- created_at

Trust score can initially be simple:

```text
trust_score =
  schema_valid_rate * 0.35
  + success_rate * 0.30
  + freshness_score * 0.20
  + latency_score * 0.15
```

The key is not to overbuild reputation. The demo only needs to show that every call improves future routing.

### 9.7 Evidence and Arc Anchor

Each successful structured invocation should return an evidence envelope:

```json
{
  "evidence_version": "agent_router_evidence_v1",
  "route_type": "structured_capability_request",
  "service_id": "btc_liquidation_max_pain_demo",
  "provider_id": "provider_derivatives_bob",
  "trace_hash": "0x...",
  "result_hash": "0x...",
  "input_hash": "0x...",
  "verification_hash": "0x...",
  "payment": {
    "quote": {},
    "settlement_receipt": {},
    "payment_tx": "0x..."
  },
  "arc_anchor": {
    "anchor_version": "agent_router_arc_anchor_v1",
    "network": "arc",
    "status": "simulated_anchor",
    "event_type": "AgentRouterEvidence"
  }
}
```

MVP stance:

- Trust scores are computed offchain in the AgentRouter database.
- Evidence hashes are the audit surface.
- The hackathon demo can show simulated Arc anchors first.
- Production can later pin evidence on Arc and/or publish ERC-8004-style attestations.

This directly addresses the "reasoning trace as product" idea without making AgentRouter responsible for all reasoning. AgentRouter produces evidence traces for service calls; the main agent or market agent owns reasoning and market creation.

## 10. Important MVP Gaps

The current MVP is directionally correct but still missing several important pieces for a strong hackathon submission.

Implementation status as of 2026-05-18:

- Done: `GET /capabilities`
- Done: `POST /agent-router/request`
- Done: `/agent-router/demo`
- Done: machine-readable invalid request errors
- Done: dev settlement receipt in paid invocation feedback
- Done: basic trust score and provider selection reason
- Done: `POST /agent-router/quote`
- Done: payment backend abstraction with `dev`, `x402`, `omniagentpay`, and `circle_arc` backend names
- Done: `agent_router_evidence_v1` envelope with trace/result/verification hashes and simulated Arc anchor
- Done: `GET /agent-router/evidence`
- Done: `GET /agent-router/trust`
- Done: MCP `agentrouter_request` preferred structured tool
- Still pending: real Arc/Circle settlement
- Still pending: real OmniAgentPay adapter
- Still pending: more than one strong market data provider for the same capability
- Still pending: onchain trust anchoring or ERC-8004-style attestations

### P0: Formal Structured Request Endpoint

Current `/agent-router/ask` is useful for demos, but it still puts too much responsibility on natural-language parsing.

Needed:

- `POST /agent-router/request`
- strict request schema
- deterministic routing
- machine-readable validation errors
- tests for missing fields, unsupported capability, budget too low, and no provider found

### P0: Capability Catalog

Main agents need a way to know what structured requests AgentRouter supports.

Needed:

- `GET /capabilities`
- capability ids and input schemas
- examples for main agents
- `not_for` and ambiguity notes

This is the engineering answer to low natural-language parsing accuracy.

### P0: Hackathon Demo Console

The current product has Provider Studio, but the demand-side story needs a polished screen.

Needed:

- user task
- structured request
- selected provider
- price
- payment receipt
- returned data
- verification result
- trust event
- final answer

### P0: Arc/Circle Settlement Adapter

Current payment is dev-mode x402-style proof. For Agora, the demo should visibly connect to Arc/USDC.

Needed:

- payment mode label: `dev`, `arc_simulated`, or `arc_testnet`
- Arc/Circle transaction receipt or clearly marked settlement placeholder
- USDC amount and receiver
- tx hash shown in the UI

### P1: More Than One Market Data Provider

Routing is more convincing when there is a real choice.

Needed:

- at least two providers for the same capability, or
- three market capabilities:
  - perp liquidation max-pain
  - funding rate comparison
  - whale/smart money address signal

### P1: Provider Trust Ranking

The MVP records feedback but does not yet make trust ranking central to selection.

Needed:

- simple trust score
- route result should explain why a provider won
- trust feed UI

### P1: Clarification Protocol

Even with structured requests, the natural-language wrapper needs safe fallback.

Needed:

- return `needs_clarification`
- include options
- let main agent resubmit a structured request after user confirmation

### P2: Real Main-Agent Integration

The demo is stronger if Claude/Codex can call AgentRouter through a Skill/MCP/HTTP endpoint.

Needed:

- stable Skill instructions
- public tunnel or hosted endpoint
- one-line install/use flow
- no hard-coded local filesystem path

### P2: Provider Rights and Safety Language

The product should avoid foregrounding "API key resale" in the hackathon story.

Needed:

- position providers as publishing their own data endpoints
- keep upstream credential language generic
- add provider-declared authorization fields
- leave formal compliance workflow out of MVP

## 11. Out of Scope for Hackathon

- Full decentralized governance
- General-purpose API marketplace
- Token launch
- Permissionless provider dispute arbitration
- Production API resale compliance
- Full ERC-8004 onchain trust registry
- Real trading execution with user funds

## 12. Technical Architecture

```text
Claude / Codex / Main Agent
        |
        | GET /capabilities
        | POST /agent-router/request
        v
AgentRouter
        |
        | search + score
        v
Service Registry
        |
        | selected service manifest
        v
Payment Adapter
        |
        | USDC payment proof / Arc receipt
        v
Provider Runtime
        |
        | agent_data_envelope_v1
        v
Verifier + Feedback Store
        |
        | result + trust metadata + evidence envelope
        v
Main Agent
```

Natural-language clients can call `/agent-router/ask`, but that should compile down to the same structured request path.

## 13. Data Model

### Service Manifest

```json
{
  "manifest_version": "agent_data_service_manifest_v1",
  "service_id": "btc_liquidation_max_pain_demo",
  "provider": {
    "provider_id": "provider_derivatives_bob"
  },
  "title": "BTC Perp Liquidation Max Pain",
  "description_for_agent": "Use this service to fetch current BTC perpetual futures liquidation max-pain and liquidation cluster data.",
  "capabilities": [
    "crypto_derivatives",
    "perp_liquidation",
    "liquidation_heatmap",
    "perp_liquidation_max_pain"
  ],
  "pricing": {
    "amount": "0.02",
    "currency": "USDC",
    "network": "arc",
    "protocol": "x402"
  }
}
```

### Agent Result Envelope

```json
{
  "schema_version": "agent_data_envelope_v1",
  "service_id": "btc_liquidation_max_pain_demo",
  "request_id": "req_123",
  "status": "success",
  "query": {},
  "data": {},
  "metadata": {
    "data_sources": [],
    "generated_at": "",
    "freshness_seconds": 45,
    "confidence": 0.78,
    "limitations": []
  },
  "agent_hints": {
    "good_for": [],
    "warnings": [],
    "suggested_followups": []
  },
  "summary": ""
}
```

### Structured Capability Request

```json
{
  "capability": "perp_liquidation_max_pain",
  "params": {
    "asset": "BTC",
    "market_type": "perpetual_futures",
    "window": "current"
  },
  "constraints": {
    "max_price_usdc": "0.05",
    "freshness_seconds": 300,
    "min_confidence": 0.7
  },
  "consumer_context": {
    "position": {
      "direction": "long",
      "leverage": 3
    }
  }
}
```

### Evidence Envelope

```json
{
  "evidence_version": "agent_router_evidence_v1",
  "route_type": "structured_capability_request",
  "service_id": "btc_liquidation_max_pain_demo",
  "provider_id": "provider_derivatives_bob",
  "request": {},
  "input": {},
  "trace_hash": "0x...",
  "result_hash": "0x...",
  "verification_hash": "0x...",
  "payment": {
    "quote": {},
    "settlement_receipt": {}
  },
  "verification": {},
  "arc_anchor": {}
}
```

## 14. Demo UI / Screens

### Screen 1: Demand Agent Console

Shows:

- user question
- structured request
- selected service
- USDC price
- payment status
- answer
- raw result
- schema/freshness validation

### Screen 2: Provider Studio

Shows:

- Bob publishing a market data service
- endpoint import or manual service creation
- service price
- preview data
- validation status

### Screen 3: Trust Feed

Shows:

- recent paid invocations
- provider success rate
- schema validation rate
- latency
- cumulative calls

## 15. Success Metrics for Demo

MVP demo success:

- User can ask one natural-language market question.
- Main agent or demo wrapper can generate a structured capability request.
- AgentRouter selects the right service.
- Payment step is visible and denominated in USDC.
- Provider returns structured data.
- Verification passes.
- Main agent gives a market-relevant answer.
- Feedback event is recorded.

Hackathon traction metrics to collect:

- number of demo queries run
- number of paid service invocations
- number of registered services
- average route latency
- schema valid rate
- number of testers

## 16. Pitch Narrative

### Problem

Trading agents are trapped inside pre-installed tools. When they need specialized intelligence, a human must find a provider, create an account, configure an API key, and wire the tool into the agent.

### Solution

AgentRouter lets market agents source intelligence at runtime. Agents read a capability catalog, submit structured requests, pay per call in USDC, receive structured data, and use verification feedback to improve future routing.

### Why Now

AI agents can now reason over tasks, tool descriptions, schemas, and returned data. Arc and USDC make tiny, high-frequency market-intelligence payments economically viable. Together, these create a new primitive: paid intelligence calls between autonomous agents.

### Why Arc

Market agents need settlement that is fast, predictable, and dollar-denominated. Arc/USDC is a natural settlement layer for per-call data purchases because the cost is small, understandable, and aligned with agent commerce.

### Why This Wins

Most teams will build one trading agent. AgentRouter is infrastructure for many trading agents. It turns market intelligence into a composable, paid, verified agent capability.

## 17. 3-Minute Demo Script

### 0:00-0:25 Problem

"Trading agents fail when they hit missing data. They cannot apply for API keys, negotiate subscriptions, or install tools mid-task."

### 0:25-1:20 Demand-Side Demo

Ask:

```text
BTC 当前最大爆仓痛点是多少？如果我现在有 3x long，要不要降杠杆？
```

Show AgentRouter:

- receives structured capability request from the main agent
- finds provider
- pays USDC
- gets structured result
- returns verified evidence envelope

Then say:

"AgentRouter does not need to be the semantic parser. The main agent owns interpretation; AgentRouter owns routing, payment, verification, and attribution."

### 1:20-2:00 Supply-Side Demo

Open Provider Studio and publish a market data endpoint.

Show:

- endpoint
- capabilities
- price
- preview
- validation

### 2:00-2:35 Trust Layer

Show feedback event:

- schema valid
- success
- latency
- payment tx
- provider trust

### 2:35-3:00 Arc Close

"This works because Arc makes tiny USDC payments between agents fast and cheap enough to happen inside every data call."

## 18. Build Plan

### Day 1

- Finalize PRD and demo narrative.
- Add `/capabilities` and `/agent-router/request`.
- Keep `/agent-router/ask` as demo wrapper.
- Confirm BTC liquidation demo route works end-to-end.

### Day 2

- Add hackathon landing/demo UI.
- Show payment, selected service, and trust metadata clearly.
- Show the structured request before routing.

### Day 3

- Add at least one more market data service:
  - funding rate comparison, or
  - whale/smart money signal.

### Day 4

- Add Arc/Circle payment adapter or visible Arc settlement placeholder.
- Make tx hash/receipt prominent.

### Day 5

- Polish Provider Studio flow.
- Record demo script.

### Day 6

- Collect tester feedback.
- Fix rough edges.

### Day 7

- Submit video, repo, and written pitch.

## 19. Open Questions

1. Can we complete a real Arc testnet USDC payment before submission?
2. Should the demo use one very polished service or three services to prove routing?
3. Should the main UI look like a trading-agent terminal or an infrastructure dashboard?
4. How much compliance language should be included around provider data rights?
5. Should trust events stay local for MVP or be anchored onchain as attestations?
6. Should `/agent-router/ask` be powered by rules only for the demo, or should it call a model with strict JSON schema output?
7. Should capability ids be project-defined first or aligned with an external emerging standard later?

## 20. Recommended Hackathon Submission Name

Options:

- AgentRouter
- AgentRouter Markets
- AgoraRouter
- SignalRouter
- ArcSignal Router

Recommended:

```text
AgentRouter Markets
```

It keeps the original product identity while making the hackathon wedge obvious.
