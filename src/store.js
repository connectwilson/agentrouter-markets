export function createMemoryStore() {
  return {
    providers: new Map(),
    services: new Map(),
    validationRuns: [],
    invocationLogs: [],
    feedbackEvents: [],
    qualityEvents: [],
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
    source_provenance: summarizeProvenance(record),
    quality_profile: summarizeQuality(record),
    health: summarizeHealth(record),
    badges: summarizeBadges(record)
  };
}

export function summarizeTrust(record) {
  const events = record.feedback_events || [];
  const operationalEvents = events.filter((event) => event.status !== "consumer_feedback_only");
  const successful = operationalEvents.filter((event) => event.status === "success").length;
  const schemaValid = operationalEvents.filter((event) => event.schema_valid).length;
  const freshnessValid = operationalEvents.filter((event) => event.verification?.freshness_valid === true).length;
  const coverageValid = operationalEvents.filter((event) => event.verification?.coverage_valid === true).length;
  const agentFriendlyEvents = operationalEvents
    .map((event) => event.verification?.agent_friendly_score)
    .filter((score) => typeof score === "number");
  const consumerFeedbackEvents = events
    .map((event) => event.consumer_feedback)
    .filter(Boolean);
  const intentFitScores = consumerFeedbackEvents
    .map((feedback) => assessmentScore(feedback.intent_fit))
    .filter((score) => typeof score === "number");
  const usefulScores = consumerFeedbackEvents
    .map((feedback) => assessmentScore(feedback.answer_useful))
    .filter((score) => typeof score === "number");
  const consumerScores = consumerFeedbackEvents
    .map((feedback) => feedback.consumer_score)
    .filter((score) => typeof score === "number");
  const successRate = operationalEvents.length ? successful / operationalEvents.length : null;
  const schemaValidRate = operationalEvents.length ? schemaValid / operationalEvents.length : null;
  const freshnessValidRate = operationalEvents.length ? freshnessValid / operationalEvents.length : null;
  const coverageValidRate = operationalEvents.length ? coverageValid / operationalEvents.length : null;
  const averageAgentFriendlyScore = agentFriendlyEvents.length
    ? agentFriendlyEvents.reduce((sum, score) => sum + score, 0) / agentFriendlyEvents.length
    : null;
  const intentFitRate = intentFitScores.length
    ? intentFitScores.reduce((sum, score) => sum + score, 0) / intentFitScores.length
    : null;
  const usefulnessRate = usefulScores.length
    ? usefulScores.reduce((sum, score) => sum + score, 0) / usefulScores.length
    : null;
  const averageConsumerScore = consumerScores.length
    ? consumerScores.reduce((sum, score) => sum + score, 0) / consumerScores.length
    : null;
  const latencyEvents = operationalEvents.filter((event) => typeof event.latency_ms === "number");
  const recentOperationalEvents = operationalEvents.slice(-10);
  const recentFailures = recentOperationalEvents.filter((event) => event.status !== "success").length;
  const averageLatencyMs = latencyEvents.length
    ? latencyEvents.reduce((sum, event) => sum + event.latency_ms, 0) / latencyEvents.length
    : null;
  const verificationScore = record.verification_status === "verified" ? 1 : 0.2;
  const subjectiveScore = averageConsumerScore ?? usefulnessRate ?? intentFitRate ?? null;
  const hasTrustEvents = operationalEvents.length || consumerFeedbackEvents.length;
  const trustScore = hasTrustEvents
    ? (
        (successRate ?? verificationScore) * 0.22 +
        (schemaValidRate ?? verificationScore) * 0.18 +
        (coverageValidRate ?? schemaValidRate ?? 0) * 0.12 +
        (freshnessValidRate ?? schemaValidRate ?? 0) * 0.08 +
        (averageAgentFriendlyScore ?? 0.7) * 0.08 +
        (subjectiveScore ?? (schemaValidRate ?? verificationScore)) * 0.22 +
        latencyScore(averageLatencyMs) * 0.05 +
        verificationScore * 0.05
      )
    : verificationScore * 0.7;
  return {
    provider_id: record.manifest.provider.provider_id,
    feedback_count: events.length,
    operational_feedback_count: operationalEvents.length,
    consumer_feedback_count: consumerFeedbackEvents.length,
    recent_failure_rate: recentOperationalEvents.length ? Number((recentFailures / recentOperationalEvents.length).toFixed(2)) : null,
    success_rate: successRate,
    schema_valid_rate: schemaValidRate,
    freshness_valid_rate: freshnessValidRate,
    coverage_valid_rate: coverageValidRate,
    intent_fit_rate: intentFitRate == null ? null : Number(intentFitRate.toFixed(2)),
    usefulness_rate: usefulnessRate == null ? null : Number(usefulnessRate.toFixed(2)),
    average_consumer_score: averageConsumerScore == null ? null : Number(averageConsumerScore.toFixed(2)),
    average_agent_friendly_score: averageAgentFriendlyScore == null ? null : Number(averageAgentFriendlyScore.toFixed(2)),
    average_latency_ms: averageLatencyMs == null ? null : Number(averageLatencyMs.toFixed(2)),
    verification_status: record.verification_status,
    trust_score: Number(trustScore.toFixed(4))
  };
}

function assessmentScore(value) {
  if (value === "yes") return 1;
  if (value === "partial") return 0.5;
  if (value === "no") return 0;
  return null;
}

export function summarizeQuality(record) {
  const events = record.feedback_events || [];
  const verificationEvents = events.map((event) => event.verification).filter(Boolean);
  const qualityEvents = record.quality_events || [];
  const latestValidation = record.validation_runs?.at(-1) || null;
  const latestVerification = verificationEvents.at(-1) || null;
  const upstreamErrors = events.filter((event) => event.status === "error").length;
  const businessErrors = qualityEvents.filter((event) => event.business_error?.detected).length;
  return {
    profile_version: "agent_data_quality_profile_v1",
    verification_status: record.verification_status,
    latest_validation_ok: latestValidation?.ok ?? null,
    latest_validation_error: latestValidation?.error || null,
    feedback_count: events.length,
    quality_event_count: qualityEvents.length,
    upstream_error_count: upstreamErrors,
    business_error_count: businessErrors,
    latest_verification: latestVerification,
    latest_quality_event: qualityEvents.at(-1) || null,
    declared_freshness_seconds: record.manifest.freshness?.max_data_lag_seconds ?? null,
    result_contract: {
      envelope_required: true,
      deterministic_checks: ["http_status", "schema", "envelope", "freshness", "coverage", "empty_result"],
      semantic_checks: ["agent_friendliness", "intent_fit_summary"]
    }
  };
}

export function summarizeHealth(record) {
  const latestValidation = record.validation_runs?.at(-1) || null;
  const operationalEvents = (record.feedback_events || []).filter((event) => event.status !== "consumer_feedback_only");
  const latestOperational = operationalEvents.at(-1) || null;
  const recent = operationalEvents.slice(-10);
  const recentFailures = recent.filter((event) => event.status !== "success").length;
  return {
    health_version: "agent_service_health_v1",
    status: latestValidation?.ok === false || recentFailures >= 3 ? "degraded" : record.verification_status === "verified" ? "healthy" : "unknown",
    last_validation_at: latestValidation?.created_at || null,
    last_validation_ok: latestValidation?.ok ?? null,
    last_success_at: [...operationalEvents].reverse().find((event) => event.status === "success")?.created_at || null,
    last_failure_at: [...operationalEvents].reverse().find((event) => event.status !== "success")?.created_at || null,
    latest_http_status: latestOperational?.http_status || null,
    recent_failure_rate: recent.length ? Number((recentFailures / recent.length).toFixed(2)) : null
  };
}

export function summarizeProvenance(record) {
  const claim = record.manifest.data_source_claim || {};
  const level = claim.source_provenance_level || inferProvenanceLevel(claim);
  return {
    provenance_version: "agent_data_source_provenance_v1",
    source_provenance_level: level,
    source_type: claim.source_type || "unknown",
    authorization_status: claim.authorization_status || "unknown",
    redistribution_status: claim.redistribution_status || "unknown",
    credential_custody: claim.credential_custody || "unknown",
    platform_stores_credentials: Boolean(claim.platform_stores_credentials),
    verified_by_platform: level === "official_verified"
  };
}

export function summarizeBadges(record) {
  const trust = summarizeTrust(record);
  const quality = summarizeQuality(record);
  const health = summarizeHealth(record);
  const provenance = summarizeProvenance(record);
  const badges = [];
  if (record.verification_status === "verified") {
    badges.push({ code: "verified_live_endpoint", label: "Verified live endpoint", level: "positive" });
  }
  if (health.status === "healthy") {
    badges.push({ code: "healthy", label: "Healthy", level: "positive" });
  }
  if ((record.manifest.freshness?.max_data_lag_seconds || 0) > 0 && record.manifest.freshness.max_data_lag_seconds <= 3600) {
    badges.push({ code: "fresh_data", label: "Fresh data", level: "positive" });
  }
  if (provenance.source_provenance_level && provenance.source_provenance_level !== "unknown") {
    badges.push({ code: "source_declared", label: "Source declared", level: "neutral" });
  }
  if (provenance.source_provenance_level === "official_verified") {
    badges.push({ code: "official_verified", label: "Official verified", level: "positive" });
  }
  if (trust.consumer_feedback_count > 0 && (trust.average_consumer_score ?? trust.usefulness_rate ?? 0) >= 0.8) {
    badges.push({ code: "agent_useful", label: "Agent useful", level: "positive" });
  }
  if (quality.business_error_count > 0 || health.status === "degraded") {
    badges.push({ code: "needs_attention", label: "Needs attention", level: "warning" });
  }
  return badges;
}

export function summarizeRegistryStats(store) {
  const services = [...store.services.values()].map((record) => {
    const trust = summarizeTrust(record);
    const publicRecord = publicServiceRecord(record);
    return {
      service_id: record.manifest.service_id,
      title: record.manifest.title,
      description_for_agent: record.manifest.description_for_agent,
      provider_id: record.manifest.provider.provider_id,
      capabilities: record.manifest.capabilities || [],
      sample_request: record.manifest.sample_request || {},
      endpoint_url: record.manifest.endpoint?.url || null,
      price: record.manifest.pricing?.amount || "0",
      currency: record.manifest.pricing?.currency || "USDC",
      verification_status: record.verification_status,
      total_calls: trust.operational_feedback_count,
      consumer_feedback_count: trust.consumer_feedback_count,
      trust_score: trust.trust_score,
      source_provenance_level: summarizeProvenance(record).source_provenance_level,
      health_status: summarizeHealth(record).status,
      badges: publicRecord.badges
    };
  });
  return {
    stats_version: "agent_router_registry_stats_v1",
    registered_services: services.length,
    verified_services: services.filter((service) => service.verification_status === "verified").length,
    total_calls: services.reduce((sum, service) => sum + service.total_calls, 0),
    total_consumer_feedback: services.reduce((sum, service) => sum + service.consumer_feedback_count, 0),
    route_observations: store.routeObservations?.length || 0,
    evidence_events: store.evidenceEvents?.length || 0,
    services
  };
}

function inferProvenanceLevel(claim = {}) {
  if (claim.source_provenance_level) return claim.source_provenance_level;
  if (claim.authorization_status === "official_verified") return "official_verified";
  if (claim.authorization_status === "provider_owned") return "provider_owned";
  if (claim.authorization_status === "authorized_reseller") return "authorized_reseller";
  if (/scrap|crawl/i.test(claim.source_type || "")) return "scraped";
  if (claim.source_type === "static_dataset") return "provider_owned";
  if (claim.source_type === "provider_declared_data_service" || claim.source_type === "api_wrapper") return "wrapped_api";
  return "unknown";
}

function latencyScore(averageLatencyMs) {
  if (averageLatencyMs == null) return 0.8;
  if (averageLatencyMs <= 250) return 1;
  if (averageLatencyMs <= 1000) return 0.75;
  if (averageLatencyMs <= 3000) return 0.45;
  return 0.2;
}
