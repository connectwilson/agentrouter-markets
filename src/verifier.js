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

export function createConsumerFeedbackRequest({
  request = {},
  selectedService = {},
  result = {},
  verification = {}
} = {}) {
  return {
    feedback_request_version: "agent_consumer_feedback_request_v1",
    endpoint: "/agent-router/feedback",
    method: "POST",
    service_id: selectedService.service_id || result.service_id,
    request_id: result.request_id,
    instructions: [
      "Submit this after the main agent has inspected whether the returned data helped answer the user's task.",
      "Do not infer domain truth beyond the returned data. Judge intent fit, usefulness, and parseability for this call.",
      "Use unknown when the main agent cannot reasonably judge a field."
    ],
    schema: {
      type: "object",
      required: ["service_id", "request_id", "feedback"],
      properties: {
        service_id: { type: "string" },
        request_id: { type: "string" },
        consumer_id: { type: "string" },
        feedback: {
          type: "object",
          required: ["intent_fit", "answer_useful", "reason"],
          properties: {
            intent_fit: { enum: ["yes", "partial", "no", "unknown"] },
            answer_useful: { enum: ["yes", "partial", "no", "unknown"] },
            data_quality_score: { type: "number", minimum: 0, maximum: 1 },
            used_in_final_answer: { type: "boolean" },
            reason: { type: "string" },
            missing_fields: { type: "array", items: { type: "string" } },
            confidence: { type: "number", minimum: 0, maximum: 1 }
          }
        }
      }
    },
    rubric: {
      intent_fit: "yes if the data directly matches the requested capability and parameters; partial if it is related but incomplete; no if it is the wrong data; unknown if the agent cannot judge.",
      answer_useful: "yes if the data can support a final answer; partial if it needs another source or transformation; no if it cannot be used; unknown if unclear.",
      data_quality_score: "0..1 score for non-empty, fresh, parseable, complete, and relevant data.",
      reason: "One short sentence grounded in the returned data, not provider reputation."
    },
    suggested_feedback: suggestConsumerFeedback({ request, result, verification })
  };
}

export function normalizeConsumerFeedback(input = {}) {
  const feedback = input.feedback && typeof input.feedback === "object" ? input.feedback : input;
  const normalized = {
    intent_fit: normalizeAssessment(feedback.intent_fit),
    answer_useful: normalizeAssessment(feedback.answer_useful),
    data_quality_score: normalizeScore(feedback.data_quality_score),
    used_in_final_answer: typeof feedback.used_in_final_answer === "boolean" ? feedback.used_in_final_answer : null,
    reason: String(feedback.reason || "").trim().slice(0, 500),
    missing_fields: Array.isArray(feedback.missing_fields)
      ? feedback.missing_fields.map((item) => String(item).trim()).filter(Boolean).slice(0, 20)
      : [],
    confidence: normalizeScore(feedback.confidence)
  };
  const componentScores = [
    assessmentScore(normalized.intent_fit),
    assessmentScore(normalized.answer_useful),
    normalized.data_quality_score,
    normalized.used_in_final_answer === null ? null : Number(normalized.used_in_final_answer)
  ].filter((score) => typeof score === "number");
  if (!componentScores.length) {
    const error = new Error("feedback must include at least one judgeable signal");
    error.statusCode = 422;
    error.code = "INVALID_CONSUMER_FEEDBACK";
    throw error;
  }
  if (!normalized.reason) {
    const error = new Error("feedback.reason is required");
    error.statusCode = 422;
    error.code = "INVALID_CONSUMER_FEEDBACK";
    throw error;
  }
  normalized.consumer_score = Number((componentScores.reduce((sum, score) => sum + score, 0) / componentScores.length).toFixed(4));
  return normalized;
}

function suggestConsumerFeedback({ result = {}, verification = {} }) {
  const score = typeof verification.overall_quality_score === "number" ? verification.overall_quality_score : null;
  const hasBlockingIssues = (verification.issues || []).some((issue) => ["EMPTY_RESULT", "STATUS_NOT_SUCCESS", "SCHEMA_ERROR", "ENVELOPE_ERROR"].includes(issue.code));
  return {
    intent_fit: verification.coverage_valid === false ? "partial" : "unknown",
    answer_useful: hasBlockingIssues ? "no" : "unknown",
    data_quality_score: score,
    used_in_final_answer: null,
    reason: result?.summary || (hasBlockingIssues ? "Deterministic checks found blocking quality issues." : "Main agent should judge usefulness against the user task."),
    missing_fields: (verification.issues || []).map((issue) => issue.code).slice(0, 8),
    confidence: 0.5
  };
}

function normalizeAssessment(value) {
  if (value === true) return "yes";
  if (value === false) return "no";
  const normalized = String(value || "unknown").trim().toLowerCase();
  return ["yes", "partial", "no", "unknown"].includes(normalized) ? normalized : "unknown";
}

function assessmentScore(value) {
  if (value === "yes") return 1;
  if (value === "partial") return 0.5;
  if (value === "no") return 0;
  return null;
}

function normalizeScore(value) {
  if (value === undefined || value === null || value === "") return null;
  const score = Number(value);
  if (!Number.isFinite(score)) return null;
  return Math.max(0, Math.min(1, Number(score.toFixed(4))));
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
