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

  const agentFriendlyScore = computeAgentFriendlyScore(result, issues);
  return {
    schema_valid: schemaErrors.length === 0 && envelopeErrors.length === 0,
    freshness_valid: freshnessValid,
    coverage_valid: coverageIssues.length === 0,
    agent_friendly_score: agentFriendlyScore,
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
