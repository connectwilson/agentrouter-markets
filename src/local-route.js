import { DiscoveryConnector } from "./connector.js";
import { inferIntent } from "./agent-router.js";
import { invokePaidServiceWithLocalWallet } from "./local-invoke.js";
import { verifyServiceResult } from "./verifier.js";

export async function routeTaskWithLocalWallet({ baseUrl, task, constraints = {}, budget = {} }) {
  const connector = new DiscoveryConnector({ baseUrl });
  const timing = createRouteTiming();
  const inferred = inferIntent(task);
  if (inferred.wants_smart_money_activity) {
    return routeTokenSmartMoneyActivityWithLocalWallet({
      baseUrl,
      connector,
      task,
      intent: inferred,
      constraints,
      budget,
      timing
    });
  }
  const resolved = await timing.measure("resolve_route_ms", () => connector.resolveRoute({ task, constraints }));
  if (resolved.status === "needs_clarification" || resolved.status === "no_match") {
    return { ...resolved, timing: timing.snapshot() };
  }

  let invocation;
  try {
    invocation = await timing.measure("local_paid_invoke_ms", () => invokePaidServiceWithLocalWallet({
      baseUrl,
      serviceId: resolved.selected_service.service_id,
      input: resolved.input,
      budget: {
        max_amount: constraints.max_price_usdc || budget.max_amount || "0.05",
        currency: budget.currency || "USDC"
      },
      request: {
        capability: resolved.intent?.capability || "natural_language_route",
        params: resolved.intent || { task },
        constraints,
        consumer_context: {
          source: "agentrouter_mcp_local_wallet",
          task
        }
      }
    }));
  } catch (error) {
    return {
      ...resolved,
      ok: false,
      status: error.code || "local_paid_invocation_failed",
      data_returned: false,
      error: error.message,
      retryable: Boolean(error.retryable),
      upstream_status: error.upstreamStatus || null,
      timing: timing.snapshot()
    };
  }
  const manifest = await timing.measure("get_manifest_ms", () => connector.getManifest(resolved.selected_service.service_id));
  const verification = timing.measureSync("verify_result_ms", () => verifyServiceResult({
    result: invocation.result,
    manifest,
    intent: resolved.intent,
    constraints
  }));

  return {
    ...resolved,
    result: invocation.result,
    local_payment: invocation.local_payment,
    evidence_recording: invocation.evidence_recording,
    consumer_feedback_request: invocation.evidence_recording?.consumer_feedback_request || null,
    verification,
    timing: timing.snapshot(),
    routing_event: {
      event_version: "agent_route_event_v1",
      task,
      normalized_intent: resolved.intent,
      service_id: resolved.selected_service.service_id,
      provider_id: resolved.selected_service.provider_id,
      verification,
      score: resolved.selected_service.routing_score,
      created_at: new Date().toISOString()
    }
  };
}

async function routeTokenSmartMoneyActivityWithLocalWallet({ baseUrl, connector, task, intent, constraints, budget, timing }) {
  const maxAmount = constraints.max_price_usdc || budget.max_amount || "0.05";
  const currency = budget.currency || "USDC";
  const tokenResolution = await resolveTokenWithLocalWallet({
    connector,
    baseUrl,
    task,
    intent,
    maxAmount,
    currency,
    timing
  });
  if (tokenResolution?.ok === false) {
    return {
      ok: false,
      status: tokenResolution.status,
      task,
      token_resolution: tokenResolution,
      data_returned: false,
      timing: timing.snapshot()
    };
  }

  const params = {
    ...intent.input,
    token_address: tokenResolution.token_address,
    chain: tokenResolution.chain || intent.input.chain
  };
  const request = {
    capability: "token_smart_money_activity",
    params,
    constraints: {
      ...constraints,
      max_price_usdc: maxAmount,
      freshness_seconds: constraints.freshness_seconds || 300
    },
    budget: {
      max_amount: maxAmount,
      currency
    },
    consumer_context: {
      source: "agentrouter_mcp_local_wallet",
      task,
      token_resolution: publicTokenResolution(tokenResolution)
    }
  };
  const attempted = [];
  const excluded = [];
  let quote;
  let invocation;
  while (attempted.length < 3) {
    quote = await timing.measure(`quote_route_attempt_${attempted.length + 1}_ms`, () => postJson(baseUrl, "/agent-router/quote", {
      ...request,
      constraints: {
        ...request.constraints,
        exclude_service_ids: excluded
      }
    }));
    if (!quote.ok) {
      return {
        ...quote,
        task,
        token_resolution: publicTokenResolution(tokenResolution),
        attempted_services: attempted,
        data_returned: false,
        timing: timing.snapshot()
      };
    }

    const serviceId = quote.selected_service.service_id;
    try {
      invocation = await timing.measure(`local_paid_invoke_attempt_${attempted.length + 1}_ms`, () => invokePaidServiceWithLocalWallet({
        baseUrl,
        serviceId,
        input: quote.input,
        budget: {
          max_amount: maxAmount,
          currency
        },
        request
      }));
      break;
    } catch (error) {
      const failure = {
        service_id: serviceId,
        status: error.code || "local_paid_invocation_failed",
        error: error.message,
        retryable: Boolean(error.retryable),
        upstream_status: error.upstreamStatus || null
      };
      attempted.push(failure);
      if (!error.retryable || excluded.includes(serviceId)) {
        return {
          ...quote,
          ok: false,
          status: failure.status,
          task,
          token_resolution: publicTokenResolution(tokenResolution),
          attempted_services: attempted,
          data_returned: false,
          error: error.message,
          retryable: Boolean(error.retryable),
          upstream_status: error.upstreamStatus || null,
          timing: timing.snapshot()
        };
      }
      excluded.push(serviceId);
    }
  }
  if (!invocation) {
    return {
      ...quote,
      ok: false,
      status: "all_candidate_services_failed",
      task,
      token_resolution: publicTokenResolution(tokenResolution),
      attempted_services: attempted,
      data_returned: false,
      timing: timing.snapshot()
    };
  }

  const manifest = await timing.measure("get_manifest_ms", () => connector.getManifest(quote.selected_service.service_id));
  const verification = timing.measureSync("verify_result_ms", () => verifyServiceResult({
    result: invocation.result,
    manifest,
    intent: params,
    constraints
  }));

  return {
    ok: true,
    status: "paid_with_local_wallet",
    task,
    request: quote.request,
    selected_service: quote.selected_service,
    candidates_considered: quote.candidates_considered,
    candidates: quote.candidates,
    input: quote.input,
    quote: quote.quote,
    token_resolution: publicTokenResolution(tokenResolution),
    result: invocation.result,
    local_payment: invocation.local_payment,
    attempted_services: attempted,
    evidence_recording: invocation.evidence_recording,
    consumer_feedback_request: invocation.evidence_recording?.consumer_feedback_request || null,
    verification,
    timing: timing.snapshot()
  };
}

async function resolveTokenWithLocalWallet({ connector, baseUrl, task, intent, maxAmount, currency, timing }) {
  if (intent.input.token_address) return null;
  const tokenSymbol = intent.input.token_symbol || intent.token;
  if (!tokenSymbol) {
    return {
      ok: false,
      status: "token_symbol_required",
      message: "token_smart_money_activity requires token_symbol or token_address."
    };
  }
  const services = await timing.measure("token_resolver_search_ms", () => connector.searchServices({
    query: "token search",
    verified_only: true,
    max_price: maxAmount
  }));
  const resolver = pickTokenResolver(services);
  if (!resolver) {
    return {
      ok: false,
      status: "token_resolver_not_found",
      token_symbol: tokenSymbol,
      message: "No token resolver service is registered."
    };
  }
  const chain = normalizeProviderChain(intent.input.chain || intent.chain || "ethereum");
  const resolverInput = {
    search_query: tokenSymbol,
    result_type: "token",
    chain,
    limit: 5
  };
  let invocation;
  try {
    invocation = await timing.measure("token_resolve_invoke_ms", () => invokePaidServiceWithLocalWallet({
      baseUrl,
      serviceId: resolver.service_id,
      input: resolverInput,
      budget: {
        max_amount: maxAmount,
        currency
      },
      request: {
        capability: "token_resolution",
        params: resolverInput,
        constraints: {
          max_price_usdc: maxAmount,
          currency
        },
        consumer_context: {
          source: "agentrouter_mcp_local_wallet",
          parent_task: task,
          parent_capability: "token_smart_money_activity"
        }
      }
    }));
  } catch (error) {
    return {
      ok: false,
      status: error.code || "token_resolution_failed",
      token_symbol: tokenSymbol,
      resolver_service_id: resolver.service_id,
      resolver_input: resolverInput,
      error: error.message,
      retryable: Boolean(error.retryable),
      upstream_status: error.upstreamStatus || null
    };
  }
  const match = findTokenMatch(invocation.result?.data, { tokenSymbol, chain });
  if (!match?.address) {
    return {
      ok: false,
      status: "token_not_found",
      token_symbol: tokenSymbol,
      resolver_service_id: resolver.service_id,
      resolver_input: resolverInput,
      message: "Token resolver did not return a matching contract address."
    };
  }
  const resolution = describeTokenResolution({
    requestedSymbol: tokenSymbol,
    matchedSymbol: match.symbol,
    matchedName: match.name,
    chain: match.chain || chain
  });
  if (!resolution.auto_pay_allowed) {
    return {
      ok: false,
      status: "token_resolution_ambiguous",
      token_symbol: tokenSymbol,
      token_address: match.address,
      chain: match.chain || chain,
      matched_name: match.name || null,
      matched_symbol: match.symbol || null,
      asset_resolution: resolution,
      requested_symbol: resolution.requested_symbol,
      resolved_symbol: resolution.resolved_symbol,
      resolution_type: resolution.resolution_type,
      auto_pay_allowed: resolution.auto_pay_allowed,
      blocking_reason: resolution.blocking_reason,
      requires_disclosure: resolution.requires_disclosure,
      disclosure: resolution.disclosure,
      resolver_service_id: resolver.service_id,
      resolver_input: resolverInput,
      message: resolution.blocking_reason
    };
  }
  return {
    ok: true,
    status: "resolved",
    token_symbol: tokenSymbol,
    token_address: match.address,
    chain: match.chain || chain,
    matched_name: match.name || null,
    matched_symbol: match.symbol || null,
    asset_resolution: resolution,
    requested_symbol: resolution.requested_symbol,
    resolved_symbol: resolution.resolved_symbol,
    resolution_type: resolution.resolution_type,
    requires_disclosure: resolution.requires_disclosure,
    disclosure: resolution.disclosure,
    resolver_service_id: resolver.service_id,
    resolver_input: resolverInput,
    resolver_evidence_recording: invocation.evidence_recording
  };
}

function pickTokenResolver(services) {
  return [...(services || [])]
    .map((service) => ({ service, score: tokenResolverScore(service) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.service || null;
}

function tokenResolverScore(service) {
  const text = serviceSearchHaystack(service);
  let score = 0;
  if (/token[_\s-]?search|entity[_\s-]?search|resolver/.test(text)) score += 5;
  if (/token[_\s-]?metadata|token[_\s-]?data/.test(text)) score += 2;
  if (/search/.test(text)) score += 1;
  return score;
}

function serviceSearchHaystack(service) {
  return [
    service?.service_id,
    service?.title,
    service?.description_for_agent,
    ...(service?.capabilities || [])
  ].filter(Boolean).join(" ").toLowerCase();
}

function findTokenMatch(data, { tokenSymbol, chain }) {
  const candidates = flattenObjects(data)
    .map((item) => ({
      address: item.token_address || item.address || item.contract_address || item.contract,
      symbol: item.symbol || item.token_symbol || item.ticker,
      name: item.name || item.token_name,
      chain: normalizeProviderChain(item.chain || item.network || chain)
    }))
    .filter((item) => item.address);
  const normalized = String(tokenSymbol || "").toLowerCase();
  const targetChain = normalizeProviderChain(chain);
  const sameChain = candidates.filter((item) => !item.chain || item.chain === targetChain);
  return sameChain.find((item) => String(item.symbol || "").toLowerCase() === normalized)
    || sameChain.find((item) => String(item.symbol || "").toLowerCase() === `w${normalized}`)
    || sameChain.find((item) => String(item.name || "").toLowerCase().includes(normalized))
    || sameChain[0]
    || candidates[0]
    || null;
}

function describeTokenResolution({ requestedSymbol, matchedSymbol, matchedName, chain }) {
  const requested = String(requestedSymbol || "").toUpperCase();
  const resolved = String(matchedSymbol || "").toUpperCase() || null;
  const name = String(matchedName || "");
  const exact = Boolean(requested && resolved && requested === resolved);
  const wrappedLike = Boolean(
    requested &&
    !exact &&
    (
      resolved === `W${requested}` ||
      /\bwrapped\b/i.test(name) ||
      new RegExp(`\\bw${escapeRegExp(requested)}\\b`, "i").test(`${resolved} ${name}`)
    )
  );
  const resolutionType = exact
    ? "exact_symbol"
    : wrappedLike
      ? "wrapped_token_substitution"
      : "symbol_substitution";
  const requiresDisclosure = resolutionType !== "exact_symbol";
  const scope = resolutionType === "wrapped_token_substitution"
    ? "wrapped-token / EVM contract data, not native asset, CEX, or perpetual-market data"
    : "a substituted token match, not an exact ticker match";
  return {
    requested_symbol: requested || null,
    resolved_symbol: resolved,
    matched_name: name || null,
    chain: chain || null,
    resolution_type: resolutionType,
    auto_pay_allowed: exact || wrappedLike,
    blocking_reason: exact || wrappedLike
      ? null
      : `Token resolver matched ${resolved || name || "a different token"} for requested ${requested || "token"}. AgentRouter will not auto-pay for symbol substitutions.`,
    requires_disclosure: requiresDisclosure,
    disclosure: requiresDisclosure
      ? `Requested ${requested || "token"}; resolver selected ${resolved || name || "a token candidate"}${chain ? ` on ${chain}` : ""}. Treat the result as ${scope}.`
      : null
  };
}

function publicTokenResolution(tokenResolution) {
  if (!tokenResolution) return null;
  return {
    ok: tokenResolution.ok,
    status: tokenResolution.status,
    token_symbol: tokenResolution.token_symbol,
    token_address: tokenResolution.token_address,
    chain: tokenResolution.chain,
    matched_name: tokenResolution.matched_name || null,
    matched_symbol: tokenResolution.matched_symbol || null,
    asset_resolution: tokenResolution.asset_resolution || null,
    requested_symbol: tokenResolution.requested_symbol || tokenResolution.token_symbol || null,
    resolved_symbol: tokenResolution.resolved_symbol || tokenResolution.matched_symbol || null,
    resolution_type: tokenResolution.resolution_type || null,
    auto_pay_allowed: tokenResolution.asset_resolution?.auto_pay_allowed ?? null,
    blocking_reason: tokenResolution.asset_resolution?.blocking_reason || null,
    requires_disclosure: Boolean(tokenResolution.requires_disclosure),
    disclosure: tokenResolution.disclosure || null,
    resolver_service_id: tokenResolution.resolver_service_id || null,
    resolver_request_id: tokenResolution.resolver_evidence_recording?.request_id || null,
    resolver_input: tokenResolution.resolver_input || null
  };
}

function normalizeProviderChain(chain) {
  const normalized = String(chain || "").toLowerCase();
  if (normalized === "bsc") return "bnb";
  if (["hyperliquid", "hyper-evm", "hyper evm", "hype"].includes(normalized)) return "hyperevm";
  return normalized || "ethereum";
}

function flattenObjects(value, out = []) {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) flattenObjects(item, out);
    return out;
  }
  out.push(value);
  for (const child of Object.values(value)) flattenObjects(child, out);
  return out;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function postJson(baseUrl, path, body) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.error?.code || `HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function createRouteTiming() {
  const started = Date.now();
  const spans = {};
  return {
    async measure(name, fn) {
      const spanStarted = Date.now();
      try {
        return await fn();
      } finally {
        spans[name] = Date.now() - spanStarted;
      }
    },
    measureSync(name, fn) {
      const spanStarted = Date.now();
      try {
        return fn();
      } finally {
        spans[name] = Date.now() - spanStarted;
      }
    },
    snapshot() {
      return {
        ...spans,
        total_ms: Date.now() - started
      };
    }
  };
}
