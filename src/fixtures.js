export const baseFundFlowManifest = {
  manifest_version: "agent_data_service_manifest_v1",
  service_id: "chain_fund_flow_7d_base",
  provider: {
    provider_id: "provider_bob",
    agent_identity: {
      standard: "erc-8004-compatible",
      agent_registry: "eip155:8453:0xDemoIdentityRegistry",
      agent_id: "1",
      agent_uri: "https://provider.example/.well-known/erc8004.json"
    }
  },
  title: "Base 7D Fund Flow",
  description_for_agent: "Use this service to fetch recent fund flow metrics for Base.",
  capabilities: ["onchain_data", "fund_flow", "stablecoin_flow", "bridge_flow"],
  not_for: ["CEX order book data", "token price prediction"],
  input_schema: {
    type: "object",
    required: ["chain", "days"],
    properties: {
      chain: { type: "string" },
      days: { type: "number" }
    }
  },
  output_schema: {
    type: "object",
    required: ["schema_version", "service_id", "request_id", "status", "query", "data", "metadata"],
    properties: {
      schema_version: { type: "string" },
      service_id: { type: "string" },
      request_id: { type: "string" },
      status: { type: "string" },
      query: { type: "object" },
      data: { type: "object" },
      metadata: { type: "object" }
    }
  },
  sample_request: {
    chain: "base",
    days: 7
  },
  sample_response: {
    sample_type: "historical",
    schema_version: "agent_data_envelope_v1",
    service_id: "chain_fund_flow_7d_base",
    request_id: "sample_req",
    status: "success",
    query: {
      chain: "base",
      days: 7
    },
    data: {
      metrics: {
        inflow_usd: 100000000,
        outflow_usd: 87000000,
        net_flow_usd: 13000000,
        stablecoin_net_flow_usd: 9200000
      },
      breakdowns: {
        top_sources: [{ label: "Ethereum bridge", amount_usd: 42000000 }],
        top_destinations: [{ label: "DeFi protocols", amount_usd: 38000000 }],
        top_protocol_changes: [{ protocol: "Aerodrome", net_flow_usd: 6200000 }]
      }
    },
    metadata: {
      data_sources: ["demo_fixture"],
      generated_at: "2026-05-15T00:00:00Z",
      freshness_seconds: 86400,
      is_estimated: true,
      confidence: 0.74,
      limitations: ["Sample response is historical and not current."]
    },
    agent_hints: {
      good_for: ["schema inspection", "field compatibility checks"],
      warnings: ["Sample is not live data."],
      suggested_followups: ["Pay for current data before final analysis."]
    },
    summary: "Historical sample shows positive Base net flow."
  },
  pricing: {
    amount: "0.01",
    currency: "USDC",
    network: "base",
    protocol: "x402"
  },
  endpoint: {
    url: "/provider/chain-fund-flow",
    method: "POST"
  },
  data_source_claim: {
    source_type: "api_wrapper",
    authorization_status: "provider_declared",
    redistribution_status: "provider_declared"
  },
  freshness: {
    update_frequency: "hourly",
    max_data_lag_seconds: 7200
  }
};

export const btcLiquidationMaxPainManifest = {
  manifest_version: "agent_data_service_manifest_v1",
  service_id: "btc_liquidation_max_pain_demo",
  provider: {
    provider_id: "provider_derivatives_bob",
    agent_identity: {
      standard: "erc-8004-compatible",
      agent_registry: "eip155:8453:0xDemoIdentityRegistry",
      agent_id: "2",
      agent_uri: "https://provider.example/.well-known/derivatives-bob.json"
    }
  },
  title: "BTC Perp Liquidation Max Pain",
  description_for_agent: "Use this service to fetch current BTC perpetual futures liquidation max-pain and liquidation cluster data.",
  capabilities: ["crypto_derivatives", "perp_liquidation", "liquidation_heatmap", "perp_liquidation_max_pain"],
  not_for: ["options max pain", "spot order execution", "investment advice"],
  input_schema: {
    type: "object",
    required: ["asset", "market_type"],
    properties: {
      asset: { type: "string" },
      market_type: { type: "string" },
      window: { type: "string" }
    }
  },
  output_schema: {
    type: "object",
    required: ["schema_version", "service_id", "request_id", "status", "query", "data", "metadata"],
    properties: {
      schema_version: { type: "string" },
      service_id: { type: "string" },
      request_id: { type: "string" },
      status: { type: "string" },
      query: { type: "object" },
      data: { type: "object" },
      metadata: { type: "object" }
    }
  },
  sample_request: {
    asset: "BTC",
    market_type: "perpetual_futures",
    window: "current"
  },
  sample_response: {
    sample_type: "historical",
    schema_version: "agent_data_envelope_v1",
    service_id: "btc_liquidation_max_pain_demo",
    request_id: "sample_req",
    status: "success",
    query: {
      asset: "BTC",
      market_type: "perpetual_futures",
      window: "current"
    },
    data: {
      max_liquidation_pain_price: 103500,
      direction: "downside",
      estimated_liquidation_notional_usd: 820000000,
      clusters: [
        { price: 103500, side_at_risk: "longs", notional_usd: 820000000 },
        { price: 108800, side_at_risk: "shorts", notional_usd: 610000000 }
      ]
    },
    metadata: {
      data_sources: ["demo_derivatives_fixture"],
      generated_at: "2026-05-15T00:00:00Z",
      freshness_seconds: 86400,
      is_estimated: true,
      confidence: 0.7,
      limitations: ["Historical sample for schema inspection only."]
    },
    agent_hints: {
      good_for: ["derivatives risk analysis", "liquidation cluster inspection"],
      warnings: ["This is not options max pain."],
      suggested_followups: ["Compare across venues.", "Check funding and open interest."]
    },
    summary: "Historical sample shows the largest BTC liquidation cluster below spot."
  },
  pricing: {
    amount: "0.02",
    currency: "USDC",
    network: "base",
    protocol: "x402"
  },
  endpoint: {
    url: "/provider/btc-liquidation-max-pain",
    method: "POST"
  },
  data_source_claim: {
    source_type: "api_wrapper",
    authorization_status: "provider_declared",
    redistribution_status: "provider_declared"
  },
  freshness: {
    update_frequency: "minute",
    max_data_lag_seconds: 120
  }
};

export function createLiveFundFlowEnvelope(input = {}) {
  const days = Number(input.days || 7);
  const chain = input.chain || "base";
  const now = new Date();
  const end = now.toISOString();
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  return {
    schema_version: "agent_data_envelope_v1",
    service_id: "chain_fund_flow_7d_base",
    request_id: `req_${cryptoRandomId()}`,
    status: "success",
    query: {
      chain,
      days,
      time_range: { start, end }
    },
    data: {
      metrics: {
        inflow_usd: 123000000,
        outflow_usd: 98000000,
        net_flow_usd: 25000000,
        stablecoin_net_flow_usd: 18000000
      },
      breakdowns: {
        top_sources: [
          { label: "Ethereum canonical bridge", amount_usd: 51000000 },
          { label: "CEX-labeled wallets", amount_usd: 22000000 }
        ],
        top_destinations: [
          { label: "Base DeFi protocols", amount_usd: 47000000 },
          { label: "DEX liquidity pools", amount_usd: 26000000 }
        ],
        top_protocol_changes: [
          { protocol: "Aerodrome", net_flow_usd: 8100000 },
          { protocol: "Aave Base", net_flow_usd: 5400000 }
        ]
      }
    },
    metadata: {
      data_sources: ["demo_provider_fixture"],
      generated_at: end,
      freshness_seconds: 60,
      is_estimated: false,
      confidence: 0.82,
      limitations: [
        "Demo provider uses deterministic fixture data for MVP validation.",
        "Do not use this output as investment advice."
      ]
    },
    agent_hints: {
      good_for: ["trend analysis", "chain comparison", "market research"],
      warnings: ["Net flow should not be interpreted as direct buy pressure without market context."],
      suggested_followups: ["Compare stablecoin supply change.", "Check exchange inflow/outflow."]
    },
    summary: "Base shows positive 7-day net flow, led by stablecoin inflows and DeFi protocol deposits."
  };
}

export function createLiveBtcLiquidationEnvelope(input = {}) {
  const asset = String(input.asset || "BTC").toUpperCase();
  const now = new Date().toISOString();
  return {
    schema_version: "agent_data_envelope_v1",
    service_id: "btc_liquidation_max_pain_demo",
    request_id: `req_${cryptoRandomId()}`,
    status: "success",
    query: {
      asset,
      market_type: input.market_type || "perpetual_futures",
      window: input.window || "current"
    },
    data: {
      max_liquidation_pain_price: 103500,
      direction: "downside",
      estimated_liquidation_notional_usd: 820000000,
      reference_price: 106200,
      clusters: [
        {
          price: 103500,
          side_at_risk: "longs",
          estimated_liquidation_notional_usd: 820000000,
          venues: ["Binance", "OKX", "Bybit"]
        },
        {
          price: 108800,
          side_at_risk: "shorts",
          estimated_liquidation_notional_usd: 610000000,
          venues: ["Binance", "OKX", "Bybit"]
        }
      ],
      open_interest_context: {
        aggregate_open_interest_usd: 31500000000,
        funding_bias: "slightly_positive"
      }
    },
    metadata: {
      data_sources: ["demo_derivatives_provider_fixture"],
      generated_at: now,
      freshness_seconds: 45,
      is_estimated: false,
      confidence: 0.78,
      limitations: [
        "Demo provider uses deterministic fixture data for MVP validation.",
        "Liquidation clusters are estimates and should not be used as trading advice."
      ]
    },
    agent_hints: {
      good_for: ["derivatives risk analysis", "liquidation heatmap summary"],
      warnings: ["This result is perpetual futures liquidation max-pain, not options max pain."],
      suggested_followups: ["Check options max pain separately if the user meant options.", "Compare with order-book liquidity walls."]
    },
    summary: "BTC's largest current liquidation max-pain cluster is estimated near 103,500 USDT, mainly affecting long positions."
  };
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 10);
}
