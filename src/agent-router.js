import { invokePaidService, searchServices } from "./registry.js";
import { routeCapabilityRequest } from "./router.js";
import { createConsumerFeedbackRequest, verifyServiceResult } from "./verifier.js";

export async function askAgentRouter(store, {
  task = "",
  max_price: maxPrice = "0.05",
  currency = "USDC"
} = {}) {
  if (!String(task || "").trim()) {
    const error = new Error("task is required");
    error.statusCode = 422;
    throw error;
  }
  const clarification = detectClarification(task);
  if (clarification) return clarification;
  const intent = inferIntent(task);
  const structuredRequest = intentToCapabilityRequest(intent, { max_price: maxPrice });
  if (structuredRequest) {
    const routed = await routeCapabilityRequest(store, {
      ...structuredRequest,
      budget: { max_amount: maxPrice, currency }
    });
    return {
      ...routed,
      task,
      selected_service: routed.selected_service ? publicSelectedService(routed.selected_service) : routed.selected_service,
      input: routed.input,
      answer: routed.result ? summarize(task, routed.result) : undefined
    };
  }
  const candidates = searchCandidates(store, intent, maxPrice);
  if (!candidates.length) {
    return {
      ok: false,
      status: "no_service_found",
      task,
      tried: intent.search_queries
    };
  }
  const selected = selectService(candidates, intent);
  const record = store.services.get(selected.service_id);
  const preview = record?.manifest?.sample_response || null;
  const serviceInput = buildServiceAwareInput(intent, record?.manifest);
  const invocation = await invokePaidService(store, selected.service_id, serviceInput, {
    max_amount: maxPrice,
    currency
  });
  if (invocation.statusCode >= 400) {
    return {
      ok: false,
      status: "invoke_failed",
      task,
      selected_service: publicSelectedService(selected),
      input: serviceInput,
      error: invocation.body.error
    };
  }
  const verification = verifyServiceResult({
    result: invocation.body.result,
    manifest: record.manifest,
    intent: serviceInput,
    constraints: { max_price_usdc: maxPrice }
  });
  return {
    ok: true,
    task,
    selected_service: publicSelectedService(selected),
    input: serviceInput,
    preview_sample_type: preview?.sample_type || null,
    result: invocation.body.result,
    feedback: invocation.body.feedback,
    verification,
    consumer_feedback_request: createConsumerFeedbackRequest({
      request: { task, input: serviceInput },
      selectedService: selected,
      result: invocation.body.result,
      verification
    }),
    answer: summarize(task, invocation.body.result)
  };
}

export async function askAgentRouterRemote({
  baseUrl,
  task,
  max_price: maxPrice = "0.05",
  currency = "USDC"
}) {
  const clarification = detectClarification(task);
  if (clarification) return clarification;
  const intent = inferIntent(task);
  const structuredRequest = intentToCapabilityRequest(intent, { max_price: maxPrice });
  if (structuredRequest) {
    const routed = await post(baseUrl, "/agent-router/request", {
      ...structuredRequest,
      budget: { max_amount: maxPrice, currency }
    });
    return {
      ...routed,
      task,
      selected_service: routed.selected_service ? publicSelectedService(routed.selected_service) : routed.selected_service,
      input: routed.input,
      answer: routed.result ? summarize(task, routed.result) : undefined
    };
  }
  const candidates = await searchCandidatesRemote(baseUrl, intent, maxPrice);
  if (!candidates.length) {
    return {
      ok: false,
      status: "no_service_found",
      task,
      tried: intent.search_queries
    };
  }
  const selected = selectService(candidates, intent);
  const preview = await post(baseUrl, "/connector/preview_service", { service_id: selected.service_id });
  const serviceInput = buildServiceAwareInput(intent, selected);
  const invocation = await post(baseUrl, "/connector/invoke_paid_service", {
    service_id: selected.service_id,
    input: serviceInput,
    budget: {
      max_amount: maxPrice,
      currency
    }
  });
  return {
    ok: true,
    task,
    selected_service: publicSelectedService(selected),
    input: serviceInput,
    preview_sample_type: preview.sample_type || null,
    result: invocation.result,
    feedback: invocation.feedback,
    answer: summarize(task, invocation.result)
  };
}

export function inferIntent(task) {
  const tagMatch = task.match(/matrixport|binance|jump|wintermute|amber|okx|bybit/i);
  const tokenMatch = task.match(/\$?(ETH|BTC|USDC|HYPE|SOL)\b/i);
  const address = detectAddress(task);
  const chain = detectChain(task);
  const dynamicTerms = extractDynamicSearchTerms(task);
  const wantsSingle = /一个|一条|任意|first|\bone\b|single/i.test(task);
  const wantsAddress = /地址|钱包|address|wallet/i.test(task);
  const wantsRelatedWallets = /related[\s_-]?wallets?|关联钱包|相关钱包|wallet[\s_-]?cluster|cluster/i.test(task);
  const wantsLiquidation = /爆仓|清算|liquidation|max[\s-]?pain/i.test(task);
  const wantsSmartMoneyHoldings = /smart[\s_-]?money/i.test(task) && /holdings?|持仓/i.test(task);
  const wantsSmartMoneyNetflow = /smart[\s_-]?money/i.test(task) && /net[\s_-]?flow|netflow|净流入|净流出|资金流/i.test(task);
  const wantsNetflow = !wantsSmartMoneyNetflow && /net[\s_-]?flow|netflow|净流入|净流出/i.test(task);
  const hasKnownIntent = wantsAddress || wantsLiquidation || wantsSmartMoneyHoldings || wantsSmartMoneyNetflow || wantsNetflow;
  const limit = detectLimit(task, wantsSingle);
  const input = {
    limit,
    offset: 0
  };
  if (tagMatch) input.tag = tagMatch[0];
  if (tokenMatch) input.token = tokenMatch[1].toUpperCase();
  if (address) {
    input.address = address;
    input.chain = chain || "ethereum";
    input.pagination = { page: 1, per_page: limit };
    delete input.limit;
    delete input.offset;
  }
  if (wantsSmartMoneyHoldings) {
    delete input.limit;
    delete input.offset;
    input.chains = [chain || "ethereum"];
    input.pagination = { page: 1, per_page: limit };
  }
  if (wantsSmartMoneyNetflow) {
    delete input.limit;
    delete input.offset;
    input.chains = [chain || "ethereum"];
    input.pagination = { page: 1, per_page: limit };
  }
  if (wantsNetflow) {
    delete input.limit;
    delete input.offset;
    delete input.token;
    input.asset = tokenMatch ? tokenMatch[1].toUpperCase() : undefined;
    input.chain = chain || chainForAsset(input.asset) || "ethereum";
    input.chains = [input.chain];
    input.window = detectWindow(task) || "24h";
  }
  if (wantsLiquidation) {
    input.asset = tokenMatch ? tokenMatch[1].toUpperCase() : "BTC";
    input.market_type = "perpetual_futures";
    input.window = "current";
    delete input.limit;
    delete input.offset;
  }
  return {
    task,
    wants_address: wantsAddress,
    wants_related_wallets: wantsRelatedWallets,
    wants_liquidation: wantsLiquidation,
    wants_smart_money_holdings: wantsSmartMoneyHoldings,
    wants_smart_money_netflow: wantsSmartMoneyNetflow,
    wants_netflow: wantsNetflow,
    has_known_intent: hasKnownIntent,
    dynamic_terms: dynamicTerms,
    tag: input.tag,
    address,
    chain: input.chain || chain,
    token: input.token || input.asset,
    input,
    search_queries: [
      dynamicTerms.length ? dynamicTerms.join(" ") : "",
      task,
      wantsLiquidation ? "perp liquidation max pain" : "",
      wantsLiquidation ? "liquidation heatmap crypto derivatives" : "",
      wantsSmartMoneyHoldings ? "smart money holdings" : "",
      wantsSmartMoneyNetflow ? "smart money netflow" : "",
      wantsNetflow ? `${input.asset || input.chain || ""} netflow` : "",
      wantsNetflow ? "netflow" : "",
      wantsAddress && address ? `${address} related wallets address profile` : "",
      wantsAddress ? "related wallets address profile" : "",
      wantsRelatedWallets ? "wallet cluster related wallets" : "",
      wantsAddress ? "Lookonchain address wallet" : "",
      wantsAddress ? "address wallet" : "",
      wantsAddress ? "wallet_profile" : ""
    ].filter(Boolean)
  };
}

export function buildServiceAwareInput(intent, manifestOrService = {}) {
  const sample = manifestOrService.sample_request || {};
  const schemaProperties = manifestOrService.input_schema?.properties || {};
  const targetKeys = new Set([
    ...Object.keys(sample || {}),
    ...Object.keys(schemaProperties || {})
  ]);
  const inferred = intent.input || {};
  if (!targetKeys.size) return { ...inferred };

  const input = { ...sample };
  for (const [key, value] of Object.entries(inferred)) {
    if (value === undefined || value === null) continue;
    if (targetKeys.has(key)) input[key] = value;
  }

  if (targetKeys.has("chain") && input.chain == null) {
    input.chain = inferred.chain || inferred.chains?.[0] || intent.chain;
  }
  if (targetKeys.has("chains") && input.chains == null) {
    const chain = inferred.chain || inferred.chains?.[0] || intent.chain;
    if (chain) input.chains = [chain];
  }
  if (targetKeys.has("address") && input.address == null && intent.address) {
    input.address = intent.address;
  }
  if (targetKeys.has("pagination")) {
    input.pagination = {
      ...(sample.pagination || {}),
      ...(inferred.pagination || {})
    };
    const limit = inferred.limit || input.pagination.per_page;
    input.pagination.page = Number(input.pagination.page || 1);
    input.pagination.per_page = Number(limit || 5);
  }
  if (targetKeys.has("limit") && input.limit == null && inferred.pagination?.per_page) {
    input.limit = inferred.pagination.per_page;
  }
  if (targetKeys.has("offset") && input.offset == null) {
    input.offset = inferred.offset || 0;
  }

  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null));
}

function extractDynamicSearchTerms(task) {
  const stopwords = new Set([
    "agentrouter",
    "agent",
    "router",
    "use",
    "using",
    "query",
    "search",
    "find",
    "data",
    "service",
    "api",
    "with",
    "the",
    "to",
    "for",
    "from"
  ]);
  return [...new Set(String(task || "").toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) || [])]
    .filter((term) => !stopwords.has(term))
    .slice(0, 8);
}

function detectClarification(task) {
  const text = String(task || "").toLowerCase();
  const saysMaxPain = /最大痛点|max[\s-]?pain/.test(text);
  const saysLiquidation = /爆仓|清算|liquidation|perp|永续|合约/.test(text);
  const saysOptions = /期权|options?/.test(text);
  if (saysMaxPain && !saysLiquidation && !saysOptions) {
    return {
      ok: false,
      status: "needs_clarification",
      question: "你说的最大痛点，是永续合约爆仓集中区，还是期权 max pain？",
      options: [
        {
          label: "永续合约爆仓痛点",
          request: {
            capability: "perp_liquidation_max_pain",
            params: { asset: "BTC", market_type: "perpetual_futures", window: "current" }
          }
        },
        {
          label: "期权最大痛点",
          request: {
            capability: "options_max_pain",
            params: { asset: "BTC", expiry: "nearest" }
          }
        }
      ]
    };
  }
  return null;
}

function intentToCapabilityRequest(intent, { max_price: maxPrice } = {}) {
  if (intent.wants_smart_money_netflow) {
    return {
      capability: "smart_money_netflow",
      params: intent.input,
      constraints: {
        max_price_usdc: maxPrice || "0.05",
        freshness_seconds: 300
      }
    };
  }
  if (intent.wants_netflow) {
    return {
      capability: "netflow",
      params: intent.input,
      constraints: {
        max_price_usdc: maxPrice || "0.05",
        freshness_seconds: 300
      }
    };
  }
  if (intent.wants_smart_money_holdings) {
    return {
      capability: "smart_money_holdings",
      params: intent.input,
      constraints: {
        max_price_usdc: maxPrice || "0.05",
        freshness_seconds: 300
      }
    };
  }
  if (intent.wants_liquidation) {
    return {
      capability: "perp_liquidation_max_pain",
      params: {
        asset: intent.input.asset || intent.token || "BTC",
        market_type: "perpetual_futures",
        window: intent.input.window || "current"
      },
      constraints: {
        max_price_usdc: maxPrice || "0.05",
        freshness_seconds: 300,
        min_confidence: 0.7
      }
    };
  }
  return null;
}

function detectLimit(task, wantsSingle) {
  if (wantsSingle) return 1;
  const text = String(task || "").replace(/0x[a-fA-F0-9]{40}/g, " ");
  const match = text.match(/(?:前|top\s*)?(\d{1,3})\s*(?:条|个|rows?|records?|data)?/i);
  if (!match) return 5;
  return Math.max(1, Math.min(100, Number(match[1])));
}

function detectAddress(task) {
  return String(task || "").match(/0x[a-fA-F0-9]{40}/)?.[0]?.toLowerCase() || null;
}

function detectChain(task) {
  const text = String(task || "").toLowerCase();
  if (/\beth\b/.test(text) || text.includes("以太坊")) return "ethereum";
  for (const chain of ["ethereum", "base", "arbitrum", "optimism", "solana", "bsc"]) {
    if (text.includes(chain)) return chain;
  }
  return null;
}

function chainForAsset(asset) {
  if (asset === "ETH") return "ethereum";
  if (asset === "SOL") return "solana";
  if (asset === "BNB") return "bsc";
  return null;
}

function detectWindow(task) {
  const text = String(task || "").toLowerCase();
  const hourMatch = text.match(/(?:近|过去|last\s*)?(\d{1,3})\s*(?:小时|h|hours?)/i);
  if (hourMatch) return `${Number(hourMatch[1])}h`;
  const dayMatch = text.match(/(?:近|过去|last\s*)?(\d{1,3})\s*(?:天|d|days?)/i);
  if (dayMatch) return `${Number(dayMatch[1])}d`;
  if (/当前|现在|current|now|latest/.test(text)) return "current";
  return null;
}

function searchCandidates(store, intent, maxPrice) {
  const seen = new Map();
  for (const query of intent.search_queries) {
    const items = searchServices(store, {
      query,
      verifiedOnly: true,
      maxPrice
    });
    for (const item of items) seen.set(item.service_id, item);
  }
  return filterDynamicCandidates([...seen.values()], intent);
}

async function searchCandidatesRemote(baseUrl, intent, maxPrice) {
  const seen = new Map();
  for (const query of intent.search_queries) {
    const items = await post(baseUrl, "/connector/search_services", {
      query,
      verified_only: true,
      max_price: maxPrice
    });
    for (const item of items) seen.set(item.service_id, item);
  }
  return filterDynamicCandidates([...seen.values()], intent);
}

function filterDynamicCandidates(candidates, intent) {
  if (intent.has_known_intent) return candidates;
  const terms = intent.dynamic_terms || [];
  if (terms.length < 2) return candidates;
  return candidates.filter((service) => {
    const haystack = serviceSearchHaystack(service);
    return terms.every((term) => haystack.includes(term));
  });
}

export function selectService(candidates, intent) {
  const scored = candidates.map((service) => {
    const haystack = serviceSearchHaystack(service);
    let score = service.match_score || 0;
    if (intent.wants_address && /address|wallet/.test(haystack)) score += 3;
    if (intent.wants_related_wallets && /related[\s_-]?wallets?|wallet[\s_-]?cluster|cluster/.test(haystack)) score += 6;
    if (intent.wants_liquidation && /liquidation|max pain|max-pain|derivatives|perp/.test(haystack)) score += 4;
    if ((intent.wants_netflow || intent.wants_smart_money_netflow) && /net[\s_-]?flow|netflow|净流入|净流出/.test(haystack)) score += 4;
    if (intent.wants_related_wallets && /leaderboard|ranking|rank|points/.test(haystack)) score -= 4;
    if (intent.wants_address && (/^list/.test(service.service_id) || /listlookonchainaddresses/.test(service.service_id))) score += 2;
    if (/getlookonchainaddress/.test(service.service_id) && !intent.input.address) score -= 2;
    if (/lookonchain/.test(haystack)) score += 1;
    return { service, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0].service;
}

function serviceSearchHaystack(service) {
  return [
    service.service_id,
    service.title,
    service.description_for_agent,
    ...(service.capabilities || []),
    service.sample_response?.summary,
    JSON.stringify(service.sample_response?.data || {}),
    JSON.stringify(service.validation_result_preview || {})
  ].join(" ").toLowerCase();
}

export function summarize(_task, envelope) {
  const rows = Array.isArray(envelope?.data?.data) ? envelope.data.data : [];
  if (rows.length) {
    const first = rows[0];
    return [
      `Found ${rows.length} matching record${rows.length === 1 ? "" : "s"}.`,
      first.address ? `Address: ${first.address}.` : "",
      first.tag ? `Tag: ${first.tag}.` : "",
      Array.isArray(first.tokens) ? `Tokens: ${first.tokens.join(", ")}.` : ""
    ].filter(Boolean).join(" ");
  }
  if (envelope?.data?.max_liquidation_pain_price) {
    const data = envelope.data;
    return [
      `BTC perp liquidation max-pain is ${data.max_liquidation_pain_price}.`,
      data.direction ? `Direction: ${data.direction}.` : "",
      data.estimated_liquidation_notional_usd ? `Estimated notional: ${data.estimated_liquidation_notional_usd} USD.` : ""
    ].filter(Boolean).join(" ");
  }
  if (envelope?.data?.address) {
    return `Found address: ${envelope.data.address}${envelope.data.tag ? ` (${envelope.data.tag})` : ""}.`;
  }
  return envelope?.summary || "AgentRouter completed the request.";
}

function publicSelectedService(service) {
  return {
    service_id: service.service_id,
    title: service.title,
    price: service.pricing
  };
}

async function post(baseUrl, path, body) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.error?.code || `HTTP ${response.status}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}
