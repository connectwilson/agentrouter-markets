export function createMemoryStore() {
  return {
    providers: new Map(),
    services: new Map(),
    validationRuns: [],
    invocationLogs: [],
    feedbackEvents: [],
    evidenceEvents: [],
    routeObservations: []
  };
}

export function publicServiceRecord(record) {
  return {
    service_id: record.manifest.service_id,
    title: record.manifest.title,
    description_for_agent: record.manifest.description_for_agent,
    capabilities: record.manifest.capabilities,
    pricing: record.manifest.pricing,
    verification_status: record.verification_status,
    trust: summarizeTrust(record),
    sample_response: record.manifest.sample_response,
    validation_result_preview: record.validation_runs?.at(-1)?.result_preview || null,
    quality_profile: summarizeQuality(record)
  };
}

export function summarizeTrust(record) {
  const events = record.feedback_events || [];
  const successful = events.filter((event) => event.status === "success").length;
  const schemaValid = events.filter((event) => event.schema_valid).length;
  const freshnessValid = events.filter((event) => event.verification?.freshness_valid === true).length;
  const coverageValid = events.filter((event) => event.verification?.coverage_valid === true).length;
  const agentFriendlyEvents = events
    .map((event) => event.verification?.agent_friendly_score)
    .filter((score) => typeof score === "number");
  const successRate = events.length ? successful / events.length : null;
  const schemaValidRate = events.length ? schemaValid / events.length : null;
  const freshnessValidRate = events.length ? freshnessValid / events.length : null;
  const coverageValidRate = events.length ? coverageValid / events.length : null;
  const averageAgentFriendlyScore = agentFriendlyEvents.length
    ? agentFriendlyEvents.reduce((sum, score) => sum + score, 0) / agentFriendlyEvents.length
    : null;
  const latencyEvents = events.filter((event) => typeof event.latency_ms === "number");
  const averageLatencyMs = latencyEvents.length
    ? latencyEvents.reduce((sum, event) => sum + event.latency_ms, 0) / latencyEvents.length
    : null;
  const verificationScore = record.verification_status === "verified" ? 1 : 0.2;
  const trustScore = events.length
    ? (
        (successRate ?? 0) * 0.3 +
        (schemaValidRate ?? 0) * 0.25 +
        (coverageValidRate ?? schemaValidRate ?? 0) * 0.15 +
        (freshnessValidRate ?? schemaValidRate ?? 0) * 0.1 +
        (averageAgentFriendlyScore ?? 0.7) * 0.1 +
        latencyScore(averageLatencyMs) * 0.05 +
        verificationScore * 0.05
      )
    : verificationScore * 0.7;
  return {
    provider_id: record.manifest.provider.provider_id,
    feedback_count: events.length,
    success_rate: successRate,
    schema_valid_rate: schemaValidRate,
    freshness_valid_rate: freshnessValidRate,
    coverage_valid_rate: coverageValidRate,
    average_agent_friendly_score: averageAgentFriendlyScore == null ? null : Number(averageAgentFriendlyScore.toFixed(2)),
    average_latency_ms: averageLatencyMs == null ? null : Number(averageLatencyMs.toFixed(2)),
    verification_status: record.verification_status,
    trust_score: Number(trustScore.toFixed(4))
  };
}

export function summarizeQuality(record) {
  const events = record.feedback_events || [];
  const verificationEvents = events.map((event) => event.verification).filter(Boolean);
  const latestValidation = record.validation_runs?.at(-1) || null;
  const latestVerification = verificationEvents.at(-1) || null;
  const upstreamErrors = events.filter((event) => event.status === "error").length;
  return {
    profile_version: "agent_data_quality_profile_v1",
    verification_status: record.verification_status,
    latest_validation_ok: latestValidation?.ok ?? null,
    latest_validation_error: latestValidation?.error || null,
    feedback_count: events.length,
    upstream_error_count: upstreamErrors,
    latest_verification: latestVerification,
    declared_freshness_seconds: record.manifest.freshness?.max_data_lag_seconds ?? null,
    result_contract: {
      envelope_required: true,
      deterministic_checks: ["http_status", "schema", "envelope", "freshness", "coverage", "empty_result"],
      semantic_checks: ["agent_friendliness", "intent_fit_summary"]
    }
  };
}

function latencyScore(averageLatencyMs) {
  if (averageLatencyMs == null) return 0.8;
  if (averageLatencyMs <= 250) return 1;
  if (averageLatencyMs <= 1000) return 0.75;
  if (averageLatencyMs <= 3000) return 0.45;
  return 0.2;
}
