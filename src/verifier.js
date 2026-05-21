import { validateEnvelope, validateJsonSchema } from "./schema.js";

export function verifyServiceResult({ result, manifest, intent = {}, constraints = {} }) {
  const schemaErrors = validateJsonSchema(result, manifest.output_schema);
  const envelopeErrors = validateEnvelope(result);
  const issues = [];

  if (schemaErrors.length) issues.push(...schemaErrors.map((message) => ({ code: "SCHEMA_ERROR", message })));
  if (envelopeErrors.length) issues.push(...envelopeErrors.map((message) => ({ code: "ENVELOPE_ERROR", message })));
  if (result?.status !== "success") issues.push({ code: "STATUS_NOT_SUCCESS", message: "Result status is not success." });
  if (result?.sample_type) issues.push({ code: "SAMPLE_RETURNED", message: "Provider returned a sample response instead of paid live data." });

  const freshnessSeconds = Number(result?.metadata?.freshness_seconds);
  const freshnessLimit = Number(constraints.freshness_seconds || manifest.freshness?.max_data_lag_seconds || 0);
  const freshnessValid = Number.isFinite(freshnessSeconds) && (!freshnessLimit || freshnessSeconds <= freshnessLimit);
  if (!freshnessValid) {
    issues.push({
      code: "FRESHNESS_NOT_VERIFIABLE",
      message: "Result freshness is missing or above the requested limit."
    });
  }

  const coverageIssues = checkCoverage(result, intent);
  issues.push(...coverageIssues);
  const dataShape = inspectDataShape(result?.data);
  if (dataShape.empty) {
    issues.push({
      code: "EMPTY_RESULT",
      message: "Provider returned a structurally valid response, but the data payload is empty."
    });
  }
  const confidence = Number(result?.metadata?.confidence);
  if (Number.isFinite(confidence) && constraints.min_confidence && confidence < Number(constraints.min_confidence)) {
    issues.push({
      code: "CONFIDENCE_BELOW_REQUEST",
      message: `Result confidence ${confidence} is below requested minimum ${constraints.min_confidence}.`
    });
  }

  const agentFriendlyScore = computeAgentFriendlyScore(result, issues);
  const deterministicScore = computeDeterministicScore({
    schemaValid: schemaErrors.length === 0 && envelopeErrors.length === 0,
    statusSuccess: result?.status === "success",
    freshnessValid,
    coverageValid: coverageIssues.length === 0,
    dataNonEmpty: !dataShape.empty
  });
  const overallScore = Number((deterministicScore * 0.8 + agentFriendlyScore * 0.2).toFixed(2));
  return {
    schema_valid: schemaErrors.length === 0 && envelopeErrors.length === 0,
    freshness_valid: freshnessValid,
    coverage_valid: coverageIssues.length === 0,
    data_non_empty: !dataShape.empty,
    agent_friendly_score: agentFriendlyScore,
    deterministic_score: deterministicScore,
    overall_quality_score: overallScore,
    data_shape: dataShape,
    quality_model: {
      name: "deterministic_first_data_quality_v1",
      weights: {
        deterministic: 0.8,
        agent_friendly: 0.2
      }
    },
    issues
  };
}

function checkCoverage(result, intent) {
  const issues = [];
  const queryText = JSON.stringify(result?.query || {}).toLowerCase();
  const dataText = JSON.stringify(result?.data || {}).toLowerCase();
  if (intent.asset && !queryText.includes(String(intent.asset).toLowerCase()) && !dataText.includes(String(intent.asset).toLowerCase())) {
    issues.push({ code: "ASSET_NOT_COVERED", message: `Result does not clearly cover ${intent.asset}.` });
  }
  if (intent.capability === "perp_liquidation_max_pain") {
    const hasLiquidationSignal = /liquidation|max_pain|cluster|notional/.test(dataText);
    if (!hasLiquidationSignal) {
      issues.push({ code: "LIQUIDATION_FIELDS_MISSING", message: "Result does not include liquidation max-pain fields." });
    }
  }
  if (intent.capability === "onchain_fund_flow") {
    const hasFundFlowSignal = /inflow|outflow|net_flow/.test(dataText);
    if (!hasFundFlowSignal) {
      issues.push({ code: "FUND_FLOW_FIELDS_MISSING", message: "Result does not include fund-flow fields." });
    }
  }
  if (intent.capability === "smart_money_netflow") {
    const hasNetflowSignal = /netflow|net_flow|inflow|outflow|net.*usd|flow/.test(dataText);
    if (!hasNetflowSignal) {
      issues.push({ code: "SMART_MONEY_NETFLOW_FIELDS_MISSING", message: "Result does not include recognizable smart-money netflow fields." });
    }
  }
  if (intent.capability === "smart_money_holdings") {
    const hasHoldingsSignal = /holding|holdings|balance|token|symbol|value_usd|amount/.test(dataText);
    if (!hasHoldingsSignal) {
      issues.push({ code: "SMART_MONEY_HOLDINGS_FIELDS_MISSING", message: "Result does not include recognizable smart-money holdings fields." });
    }
  }
  return issues;
}

function computeAgentFriendlyScore(result, issues) {
  let score = 1;
  if (!result?.summary) score -= 0.15;
  if (!result?.metadata?.data_sources?.length) score -= 0.15;
  if (!result?.metadata?.generated_at) score -= 0.1;
  if (!result?.agent_hints) score -= 0.1;
  score -= Math.min(0.4, issues.length * 0.08);
  return Math.max(0, Number(score.toFixed(2)));
}

function inspectDataShape(data) {
  if (data === undefined || data === null) return { type: data === null ? "null" : "undefined", empty: true, top_level_keys: [] };
  if (Array.isArray(data)) return { type: "array", empty: data.length === 0, item_count: data.length, top_level_keys: [] };
  if (typeof data === "object") {
    const keys = Object.keys(data);
    const nestedArrays = Object.entries(data)
      .filter(([, value]) => Array.isArray(value))
      .map(([key, value]) => ({ key, item_count: value.length }));
    const hasRows = nestedArrays.some((item) => item.item_count > 0);
    return {
      type: "object",
      empty: keys.length === 0 || (nestedArrays.length > 0 && !hasRows && keys.length <= 2),
      top_level_keys: keys.slice(0, 20),
      nested_arrays: nestedArrays.slice(0, 10)
    };
  }
  return { type: typeof data, empty: data === "", top_level_keys: [] };
}

function computeDeterministicScore({ schemaValid, statusSuccess, freshnessValid, coverageValid, dataNonEmpty }) {
  const score =
    Number(schemaValid) * 0.3 +
    Number(statusSuccess) * 0.2 +
    Number(freshnessValid) * 0.2 +
    Number(coverageValid) * 0.2 +
    Number(dataNonEmpty) * 0.1;
  return Number(score.toFixed(2));
}
