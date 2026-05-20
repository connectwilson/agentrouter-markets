import { invokePaidService, searchServices } from "./registry.js";
import { verifyServiceResult } from "./verifier.js";
import { createPaymentQuote } from "./payment-adapter.js";
import { createEvidenceEnvelope } from "./evidence.js";

export const ROUTER_STATUSES = {
  READY: "ready_to_route",
  NEEDS_CLARIFICATION: "needs_clarification",
  ROUTE_WITH_ASSUMPTION: "route_with_assumption",
  NO_MATCH: "no_match"
};

const CAPABILITY_ALIASES = [
  {
    capability: "perp_liquidation_max_pain",
    capabilities: ["perp_liquidation_max_pain", "liquidation_heatmap", "perp_liquidation", "crypto_derivatives"],
    keywords: ["爆仓", "清算", "liquidation", "liq", "heatmap", "合约", "永续", "perp", "perpetual"],
    agent_description: "Use this when the user asks for perpetual futures liquidation clusters, liquidation max-pain, or forced liquidation risk.",
    not_for: ["options max pain", "spot support/resistance"],
    input_schema: {
      type: "object",
      required: ["asset", "market_type", "window"],
      properties: {
        asset: { type: "string", enum: ["BTC", "ETH", "SOL"] },
        market_type: { type: "string", enum: ["perpetual_futures"] },
        window: { type: "string", enum: ["current", "1h", "4h"] }
      }
    },
    examples: [
      {
        user_query: "BTC 当前最大爆仓痛点是多少？",
        request: {
          capability: "perp_liquidation_max_pain",
          params: { asset: "BTC", market_type: "perpetual_futures", window: "current" }
        }
      }
    ],
    defaultInput: (intent) => ({ asset: intent.asset || "BTC", market_type: intent.market_type || "perpetual_futures", window: intent.window || "current" })
  },
  {
    capability: "options_max_pain",
    capabilities: ["options_max_pain", "options_data"],
    keywords: ["期权", "options", "option", "max pain", "最大痛点"],
    agent_description: "Use this when the user explicitly asks for options max pain.",
    not_for: ["perpetual futures liquidation max-pain"],
    input_schema: {
      type: "object",
      required: ["asset", "expiry"],
      properties: {
        asset: { type: "string", enum: ["BTC", "ETH", "SOL"] },
        expiry: { type: "string" }
      }
    },
    examples: [
      {
        user_query: "BTC 期权最大痛点是多少？",
        request: {
          capability: "options_max_pain",
          params: { asset: "BTC", expiry: "nearest" }
        }
      }
    ],
    defaultInput: (intent) => ({ asset: intent.asset || "BTC", expiry: intent.expiry || "nearest" })
  },
  {
    capability: "onchain_fund_flow",
    capabilities: ["onchain_data", "fund_flow"],
    keywords: ["资金流", "fund flow", "inflow", "outflow", "链上", "onchain"],
    agent_description: "Use this when the user asks for chain-level inflow, outflow, or fund-flow analysis.",
    not_for: ["derivatives liquidation clusters"],
    input_schema: {
      type: "object",
      required: ["chain", "days"],
      properties: {
        chain: { type: "string", enum: ["base", "ethereum", "arbitrum", "optimism", "solana", "bsc"] },
        days: { type: "number" }
      }
    },
    examples: [
      {
        user_query: "Base 过去 7 天链上资金流向如何？",
        request: {
          capability: "onchain_fund_flow",
          params: { chain: "base", days: 7 }
        }
      }
    ],
    defaultInput: (intent) => ({ chain: intent.chain || "base", days: intent.days || 7 })
  }
];

export function getCapabilityCatalog() {
  return [
    ...CAPABILITY_ALIASES.map((entry) => ({
    capability: entry.capability,
    agent_description: entry.agent_description,
    provider_capabilities: entry.capabilities,
    input_schema: entry.input_schema,
    not_for: entry.not_for,
    examples: entry.examples,
    ambiguity_notes: ambiguityNotesFor(entry.capability)
    })),
    {
      capability: "<dynamic_data_capability>",
      agent_description: "Use any registered API/data service by naming the desired capability in snake_case, for example smart_money_holdings or funding_rate. AgentRouter will match it against registered service ids, titles, descriptions, tags, and sample shapes.",
      provider_capabilities: ["data_service"],
      input_schema: {
        type: "object",
        required: [],
        additionalProperties: true,
        description: "Pass the provider API request body directly as params. AgentRouter merges params over the service sample_request."
      },
      not_for: ["Ambiguous financial terms that need a domain-specific schema."],
      examples: [
        {
          user_query: "Query Nansen Smart Money Holdings for Ethereum, first 10 rows.",
          request: {
            capability: "smart_money_holdings",
            params: { chains: ["ethereum"], pagination: { page: 1, per_page: 10 } }
          }
        }
      ],
      ambiguity_notes: ["If the main agent is unsure which dynamic capability name to use, call agentrouter_ask or search by natural-language task instead."]
    }
  ];
}

export async function routeTask(store, { task = "", intent: providedIntent, constraints = {}, budget = {} } = {}) {
  const resolved = resolveRoute(store, { task, intent: providedIntent, constraints });
  if (resolved.status === ROUTER_STATUSES.NEEDS_CLARIFICATION || resolved.status === ROUTER_STATUSES.NO_MATCH) {
    return resolved;
  }

  const selected = resolved.selected_service;
  const record = store.services.get(selected.service_id);
  const invocation = await invokePaidService(
    store,
    selected.service_id,
    resolved.input,
    { max_amount: constraints.max_price_usdc || budget.max_amount || "0.05", currency: budget.currency || "USDC" }
  );
  if (invocation.statusCode >= 400) {
    return {
      ...resolved,
      status: "route_failed",
      selected_service: selected,
      error: invocation.body.error
    };
  }

  const verification = verifyServiceResult({
    result: invocation.body.result,
    manifest: record.manifest,
    intent: resolved.intent,
    constraints
  });

  const routingEvent = {
    event_version: "agent_route_event_v1",
    task,
    normalized_intent: resolved.intent,
    service_id: selected.service_id,
    provider_id: record.manifest.provider.provider_id,
    verification,
    score: selected.routing_score,
    created_at: new Date().toISOString()
  };
  record.feedback_events.push({
    event_version: "agent_service_feedback_v1",
    request_id: invocation.body.result.request_id || `route_${Date.now()}`,
    service_id: selected.service_id,
    provider_id: record.manifest.provider.provider_id,
    consumer_id: "router_agent",
    payment_tx: invocation.body.feedback?.payment_tx || null,
    status: invocation.body.result.status === "success" ? "success" : "error",
    schema_valid: verification.schema_valid,
    latency_ms: invocation.body.feedback?.latency_ms || null,
    consumer_rating: verification.schema_valid && verification.coverage_valid ? 1 : 0,
    verification,
    created_at: new Date().toISOString()
  });
  store.feedbackEvents.push(routingEvent);

  return {
    ...resolved,
    result: invocation.body.result,
    payment_feedback: invocation.body.feedback,
    verification,
    routing_event: routingEvent
  };
}

export async function routeCapabilityRequest(store, {
  capability,
  params = {},
  constraints = {},
  budget = {},
  consumer_context: consumerContext = {}
} = {}) {
  const validation = validateCapabilityRequest({ capability, params });
  if (!validation.ok) {
    return {
      ok: false,
      status: "invalid_request",
      ...validation
    };
  }

  const intent = {
    capability,
    ...params,
    consumer_context: consumerContext
  };
  const normalizedConstraints = normalizeRequestConstraints(constraints, budget);
  const candidates = rankCandidates(store, intent, normalizedConstraints);
  if (!candidates.length) {
    return {
      ok: false,
      status: ROUTER_STATUSES.NO_MATCH,
      request: { capability, params, constraints: normalizedConstraints },
      candidates_considered: 0,
      message: "No verified service matched the structured capability request and constraints."
    };
  }

  const selected = candidates[0];
  const record = store.services.get(selected.service_id);
  const input = buildInput(record.manifest, intent);
  const quote = createPaymentQuote({
    manifest: record.manifest,
    constraints: normalizedConstraints,
    selectedService: selected
  });
  const invocation = await invokePaidService(
    store,
    selected.service_id,
    input,
    { max_amount: normalizedConstraints.max_price_usdc || "0.05", currency: budget.currency || "USDC" }
  );
  if (invocation.statusCode >= 400) {
    return {
      ok: false,
      status: "route_failed",
      request: { capability, params, constraints: normalizedConstraints },
      selected_service: selected,
      input,
      quote,
      error: invocation.body.error || invocation.body.result?.error || invocation.body
    };
  }

  const verification = verifyServiceResult({
    result: invocation.body.result,
    manifest: record.manifest,
    intent,
    constraints: normalizedConstraints
  });
  const request = { capability, params, constraints: normalizedConstraints, consumer_context: consumerContext };
  const evidence = createEvidenceEnvelope({
    request,
    input,
    selectedService: selected,
    manifest: record.manifest,
    quote,
    result: invocation.body.result,
    feedback: invocation.body.feedback,
    verification
  });
  store.evidenceEvents.push(evidence);

  return {
    ok: true,
    status: "routed",
    protocol: {
      protocol_version: "agent_router_request_v1",
      semantic_parser: "external_main_agent",
      router_responsibility: "schema_validation_routing_quote_payment_invocation_verification_evidence"
    },
    request,
    selected_service: selected,
    candidates_considered: candidates.length,
    candidates: summarizeCandidates(candidates),
    quote,
    input,
    result: invocation.body.result,
    feedback: invocation.body.feedback,
    verification,
    evidence
  };
}

export function quoteCapabilityRequest(store, {
  capability,
  params = {},
  constraints = {},
  budget = {},
  consumer_context: consumerContext = {}
} = {}) {
  const validation = validateCapabilityRequest({ capability, params });
  if (!validation.ok) {
    return {
      ok: false,
      status: "invalid_request",
      ...validation
    };
  }

  const intent = {
    capability,
    ...params,
    consumer_context: consumerContext
  };
  const normalizedConstraints = normalizeRequestConstraints(constraints, budget);
  const candidateConstraints = constraintsWithoutBudgetGuard(normalizedConstraints);
  const candidates = rankCandidates(store, intent, candidateConstraints);
  if (!candidates.length) {
    return {
      ok: false,
      status: ROUTER_STATUSES.NO_MATCH,
      request: { capability, params, constraints: normalizedConstraints, consumer_context: consumerContext },
      candidates_considered: 0,
      message: "No verified service matched the structured capability request and constraints."
    };
  }

  const selected = candidates[0];
  const record = store.services.get(selected.service_id);
  const input = buildInput(record.manifest, intent);
  const quote = createPaymentQuote({
    manifest: record.manifest,
    constraints: normalizedConstraints,
    selectedService: selected
  });
  return {
    ok: quote.would_pay,
    status: quote.would_pay ? "quoted" : "quote_blocked",
    request: { capability, params, constraints: normalizedConstraints, consumer_context: consumerContext },
    selected_service: selected,
    candidates_considered: candidates.length,
    candidates: summarizeCandidates(candidates),
    input,
    quote
  };
}

export function resolveRoute(store, { task = "", intent: providedIntent, constraints = {} } = {}) {
  const normalized = normalizeTaskIntent({ task, providedIntent, constraints });
  if (normalized.status === ROUTER_STATUSES.NEEDS_CLARIFICATION) {
    return normalized;
  }

  const candidates = rankCandidates(store, normalized.intent, constraints);
  if (!candidates.length) {
    return {
      ...normalized,
      status: ROUTER_STATUSES.NO_MATCH,
      candidates_considered: 0,
      candidates: [],
      message: "No verified service matched the normalized intent and constraints."
    };
  }

  const selected = candidates[0];
  const record = store.services.get(selected.service_id);
  return {
    ...normalized,
    selected_service: selected,
    candidates_considered: candidates.length,
    candidates: summarizeCandidates(candidates),
    input: buildInput(record.manifest, normalized.intent)
  };
}

export function normalizeTaskIntent({ task = "", providedIntent, constraints = {} } = {}) {
  const text = String(task || "").toLowerCase();
  const intent = sanitizeProvidedIntent(providedIntent);
  const detected = detectIntent(text);
  const merged = {
    ...detected.intent,
    ...intent
  };

  const ambiguities = detectAmbiguities(text, merged);
  const status = chooseStatus({ text, intent: merged, ambiguities, constraints });
  return {
    status,
    task,
    normalized_intent: merged,
    intent: merged,
    intent_confidence: confidenceFor(status, detected.score, ambiguities),
    assumptions: assumptionsFor(status, text, merged, ambiguities),
    ambiguities,
    parse_reasoning_summary: summarizeParse({ text, intent: merged, status, ambiguities })
  };
}

export function rankCandidates(store, intent, constraints = {}) {
  const requiredCapabilities = capabilityRequirements(intent.capability);
  const searchResults = searchServices(store, {
    query: buildSearchQuery(intent),
    capabilities: [],
    maxPrice: constraints.max_price_usdc,
    verifiedOnly: true
  });

  return searchResults
    .map((service) => scoreCandidate(store.services.get(service.service_id), intent, requiredCapabilities, constraints, service.match_score))
    .filter((candidate) => candidate.routing_score > 0)
    .sort((a, b) => b.routing_score - a.routing_score);
}

function detectIntent(text) {
  const asset = detectAsset(text);
  const chain = detectChain(text);
  const days = detectDays(text);
  const matches = CAPABILITY_ALIASES.map((entry) => {
    const keywordHits = entry.keywords.filter((keyword) => text.includes(keyword.toLowerCase())).length;
    return { entry, keywordHits };
  }).sort((a, b) => b.keywordHits - a.keywordHits);

  const best = matches[0];
  const capability = best?.keywordHits ? best.entry.capability : null;
  return {
    score: best?.keywordHits || 0,
    intent: {
      capability,
      asset,
      chain,
      days,
      market_type: capability === "perp_liquidation_max_pain" ? "perpetual_futures" : undefined,
      time_sensitivity: /当前|现在|实时|latest|current|now/.test(text) ? "realtime" : undefined
    }
  };
}

function detectAmbiguities(text, intent) {
  const ambiguities = [];
  const saysMaxPain = text.includes("最大痛点") || text.includes("max pain");
  const saysLiquidation = text.includes("爆仓") || text.includes("清算") || text.includes("liquidation");
  const saysOptions = text.includes("期权") || text.includes("options");

  if (saysMaxPain && !saysLiquidation && !saysOptions) {
    ambiguities.push({
      field: "capability",
      question: "你说的最大痛点，是永续合约爆仓集中区，还是期权 max pain？",
      options: [
        { value: "perp_liquidation_max_pain", label: "合约/永续合约爆仓集中区" },
        { value: "options_max_pain", label: "期权最大痛点" }
      ],
      default_if_no_answer: "perp_liquidation_max_pain",
      blocking: true
    });
  }

  if (intent.capability === "perp_liquidation_max_pain" && !intent.asset) {
    ambiguities.push({
      field: "asset",
      question: "需要查询哪个资产的爆仓集中区？",
      options: [{ value: "BTC", label: "BTC" }, { value: "ETH", label: "ETH" }],
      blocking: true
    });
  }

  return ambiguities;
}

function chooseStatus({ text, intent, ambiguities }) {
  if (!intent.capability) return ROUTER_STATUSES.NEEDS_CLARIFICATION;
  if (ambiguities.some((item) => item.blocking)) return ROUTER_STATUSES.NEEDS_CLARIFICATION;
  if ((text.includes("爆仓") || text.includes("liquidation")) && text.includes("痛点")) {
    return ROUTER_STATUSES.ROUTE_WITH_ASSUMPTION;
  }
  return ROUTER_STATUSES.READY;
}

function assumptionsFor(status, text, intent) {
  if (status !== ROUTER_STATUSES.ROUTE_WITH_ASSUMPTION) return [];
  const assumptions = [];
  if (intent.capability === "perp_liquidation_max_pain") {
    assumptions.push("将“爆仓痛点”理解为永续合约/合约清算集中价格，而不是期权 max pain。");
  }
  if (intent.time_sensitivity === "realtime") {
    assumptions.push("按实时或最近可用数据处理。");
  }
  return assumptions;
}

function confidenceFor(status, score, ambiguities) {
  if (status === ROUTER_STATUSES.NEEDS_CLARIFICATION) return 0.45;
  if (status === ROUTER_STATUSES.ROUTE_WITH_ASSUMPTION) return 0.74;
  return Math.min(0.95, 0.7 + score * 0.08 - ambiguities.length * 0.1);
}

function summarizeParse({ intent, status, ambiguities }) {
  if (status === ROUTER_STATUSES.NEEDS_CLARIFICATION) {
    return `Router could not safely normalize the task without clarification: ${ambiguities[0]?.question || "capability is unclear"}`;
  }
  if (intent.capability === "perp_liquidation_max_pain") {
    return "Router mapped the request to perpetual futures liquidation max-pain because the task uses liquidation/burst-position language.";
  }
  if (intent.capability === "onchain_fund_flow") {
    return "Router mapped the request to on-chain fund flow based on fund-flow and chain language.";
  }
  return "Router normalized the task with the configured capability taxonomy.";
}

function sanitizeProvidedIntent(intent) {
  if (!intent || typeof intent !== "object") return {};
  const allowedCapabilities = new Set(CAPABILITY_ALIASES.map((entry) => entry.capability));
  return {
    capability: allowedCapabilities.has(intent.capability) ? intent.capability : undefined,
    asset: intent.asset,
    chain: intent.chain,
    days: intent.days,
    market_type: intent.market_type,
    time_sensitivity: intent.time_sensitivity
  };
}

function capabilityRequirements(capability) {
  return CAPABILITY_ALIASES.find((entry) => entry.capability === capability)?.capabilities || ["data_service"];
}

function buildSearchQuery(intent) {
  if (intent.capability === "perp_liquidation_max_pain") return `${intent.asset || "BTC"} liquidation max pain`;
  if (intent.capability === "options_max_pain") return `${intent.asset || "BTC"} options max pain`;
  if (intent.capability === "onchain_fund_flow") return `${intent.chain || ""} fund flow`;
  return [
    String(intent.capability || "").replace(/[_-]/g, " "),
    ...Object.values(intent).flatMap((value) => searchableValues(value))
  ].filter(Boolean).join(" ");
}

function scoreCandidate(record, intent, requiredCapabilities, constraints, matchScore) {
  const manifest = record.manifest;
  const capabilityHits = requiredCapabilities.filter((capability) => manifest.capabilities.includes(capability)).length;
  if (!capabilityHits) return { service_id: manifest.service_id, routing_score: 0 };

  const sampleText = JSON.stringify(manifest.sample_request || {}).toLowerCase() + JSON.stringify(manifest.sample_response || {}).toLowerCase();
  const surfaceText = [
    manifest.service_id,
    manifest.title,
    manifest.description_for_agent,
    ...(manifest.capabilities || []),
    sampleText
  ].join(" ").toLowerCase();
  if (!serviceCoversCapability(surfaceText, intent.capability)) {
    return { service_id: manifest.service_id, routing_score: 0 };
  }
  const assetFit = intent.asset ? Number(sampleText.includes(String(intent.asset).toLowerCase())) : 1;
  const trustScore = record.feedback_events?.length
    ? record.feedback_events.filter((event) => event.status === "success" && event.schema_valid !== false).length / record.feedback_events.length
    : Number(record.verification_status === "verified") * 0.7;
  const freshnessLimit = Number(constraints.freshness_seconds || 0);
  const serviceFreshness = Number(manifest.freshness?.max_data_lag_seconds || 0);
  const freshnessFit = !freshnessLimit || (serviceFreshness && serviceFreshness <= freshnessLimit) ? 1 : 0.35;
  const maxPrice = Number(constraints.max_price_usdc || 0);
  const price = Number(manifest.pricing.amount);
  const priceFit = !maxPrice ? 1 : Math.max(0, 1 - price / Math.max(maxPrice, price));
  const score =
    (capabilityHits / requiredCapabilities.length) * 0.35 +
    assetFit * 0.15 +
    trustScore * 0.2 +
    freshnessFit * 0.15 +
    priceFit * 0.1 +
    matchScore * 0.05;

  return {
    service_id: manifest.service_id,
    title: manifest.title,
    provider_id: manifest.provider.provider_id,
    pricing: manifest.pricing,
    trust_score: Number(trustScore.toFixed(4)),
    routing_score: Number(score.toFixed(4)),
    selection_reason: `Matched ${capabilityHits}/${requiredCapabilities.length} required capabilities, verification=${record.verification_status}, trust=${trustScore.toFixed(2)}, price=${manifest.pricing.amount} ${manifest.pricing.currency}.`
  };
}

function serviceCoversCapability(surfaceText, capability) {
  if (capability === "perp_liquidation_max_pain") {
    return /liquidation|max_liquidation|max[\s_-]?pain|爆仓|清算/.test(surfaceText);
  }
  if (capability === "options_max_pain") {
    return /options?|期权/.test(surfaceText) && /max[\s_-]?pain|最大痛点/.test(surfaceText);
  }
  if (capability === "onchain_fund_flow") {
    return /fund[\s_-]?flow|inflow|outflow|资金流|onchain|链上/.test(surfaceText);
  }
  const terms = dynamicCapabilityTerms(capability);
  return terms.length > 0 && terms.every((term) => surfaceText.includes(term));
}

function summarizeCandidates(candidates) {
  return candidates.map(({ service_id, title, provider_id, pricing, trust_score, routing_score, selection_reason }) => ({
    service_id,
    title,
    provider_id,
    pricing,
    trust_score,
    routing_score,
    selection_reason
  }));
}

function buildInput(manifest, intent) {
  const entry = CAPABILITY_ALIASES.find((item) => item.capability === intent.capability);
  if (!entry) {
    return {
      ...(manifest.sample_request || {}),
      ...dynamicInputParams(intent, manifest.sample_request || {})
    };
  }
  return {
    ...(manifest.sample_request || {}),
    ...(entry ? entry.defaultInput(intent) : {})
  };
}

function validateCapabilityRequest({ capability, params }) {
  const entry = CAPABILITY_ALIASES.find((item) => item.capability === capability);
  if (!entry) {
    if (isSafeDynamicCapability(capability) && params && typeof params === "object" && !Array.isArray(params)) {
      return { ok: true, dynamic: true };
    }
    return {
      ok: false,
      error: "UNSUPPORTED_CAPABILITY",
      supported_capabilities: [
        ...CAPABILITY_ALIASES.map((item) => item.capability),
        "<dynamic_data_capability>"
      ],
      dynamic_capability_hint: "For registered API/data services, pass a snake_case capability such as smart_money_holdings and put the provider request body in params."
    };
  }
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return {
      ok: false,
      error: "INVALID_PARAMS",
      expected_schema: entry.input_schema
    };
  }
  const missing = (entry.input_schema.required || []).filter((field) => params[field] === undefined || params[field] === null || params[field] === "");
  if (missing.length) {
    return {
      ok: false,
      error: "MISSING_REQUIRED_PARAM",
      missing,
      expected_schema: entry.input_schema
    };
  }
  const invalid = [];
  for (const [field, schema] of Object.entries(entry.input_schema.properties || {})) {
    const value = params[field];
    if (value === undefined || value === null) continue;
    if (schema.enum && !schema.enum.includes(value)) {
      invalid.push({ field, value, allowed: schema.enum });
    }
    if (schema.type === "number" && typeof value !== "number") {
      invalid.push({ field, value, expected_type: "number" });
    }
  }
  if (invalid.length) {
    return {
      ok: false,
      error: "INVALID_PARAM_VALUE",
      invalid,
      expected_schema: entry.input_schema
    };
  }
  return { ok: true };
}

function isKnownCapability(capability) {
  return CAPABILITY_ALIASES.some((entry) => entry.capability === capability);
}

function isSafeDynamicCapability(capability) {
  return /^[a-z][a-z0-9_-]{2,80}$/.test(String(capability || ""));
}

function dynamicCapabilityTerms(capability) {
  return String(capability || "")
    .toLowerCase()
    .split(/[_\-\s/]+/)
    .filter((term) => term.length > 1);
}

function dynamicInputParams(intent, sampleRequest = {}) {
  const ignored = new Set(["capability", "consumer_context"]);
  const entries = Object.entries(intent || {}).filter(([key, value]) => !ignored.has(key) && value !== undefined);
  const sampleKeys = new Set(Object.keys(sampleRequest || {}));
  if (!sampleKeys.size) return Object.fromEntries(entries);
  return Object.fromEntries(
    entries.filter(([key]) => sampleKeys.has(key))
  );
}

function searchableValues(value) {
  if (value === undefined || value === null) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap((item) => searchableValues(item));
  if (typeof value === "object") return Object.values(value).flatMap((item) => searchableValues(item));
  return [];
}

function normalizeRequestConstraints(constraints = {}, budget = {}) {
  return {
    ...constraints,
    max_price_usdc: constraints.max_price_usdc || constraints.max_price || budget.max_amount,
    freshness_seconds: constraints.freshness_seconds,
    min_confidence: constraints.min_confidence
  };
}

function constraintsWithoutBudgetGuard(constraints = {}) {
  const relaxed = { ...constraints };
  delete relaxed.max_price_usdc;
  delete relaxed.max_price;
  delete relaxed.max_amount;
  return relaxed;
}

function ambiguityNotesFor(capability) {
  if (capability === "perp_liquidation_max_pain") {
    return ["If the user only says max pain without liquidation/perp context, ask whether they mean options max pain."];
  }
  if (capability === "options_max_pain") {
    return ["Use only when the user explicitly mentions options or confirms options max pain."];
  }
  return [];
}

function detectAsset(text) {
  const match = text.match(/\b(btc|eth|sol|bnb|xrp|doge)\b/i);
  return match ? match[1].toUpperCase() : undefined;
}

function detectChain(text) {
  for (const chain of ["base", "ethereum", "arbitrum", "optimism", "solana", "bsc"]) {
    if (text.includes(chain)) return chain;
  }
  if (text.includes("链")) return "base";
  return undefined;
}

function detectDays(text) {
  const match = text.match(/(\d+)\s*(d|day|days|天|日)/i);
  return match ? Number(match[1]) : undefined;
}
