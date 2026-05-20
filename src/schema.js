export function validateJsonSchema(value, schema, path = "$") {
  const errors = [];

  if (!schema || typeof schema !== "object") {
    return errors;
  }

  if (schema.type) {
    const actualType = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    if (actualType !== schema.type) {
      errors.push(`${path} expected ${schema.type}, got ${actualType}`);
      return errors;
    }
  }

  if (schema.type === "object") {
    const required = schema.required || [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${path}.${key} is required`);
      }
    }

    const properties = schema.properties || {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(...validateJsonSchema(value[key], childSchema, `${path}.${key}`));
      }
    }
  }

  if (schema.type === "array" && schema.items && Array.isArray(value)) {
    value.forEach((item, index) => {
      errors.push(...validateJsonSchema(item, schema.items, `${path}[${index}]`));
    });
  }

  return errors;
}

export function validateEnvelope(envelope) {
  const errors = validateJsonSchema(envelope, agentDataEnvelopeSchema);
  if (envelope?.status === "success" && !envelope.data) {
    errors.push("$.data is required for success responses");
  }
  if (envelope?.status === "error" && !envelope.error) {
    errors.push("$.error is required for error responses");
  }
  return errors;
}

export const agentDataEnvelopeSchema = {
  type: "object",
  required: ["schema_version", "service_id", "request_id", "status"],
  properties: {
    schema_version: { type: "string" },
    service_id: { type: "string" },
    request_id: { type: "string" },
    status: { type: "string" },
    query: { type: "object" },
    data: { type: "object" },
    metadata: {
      type: "object",
      required: ["data_sources", "generated_at", "freshness_seconds", "is_estimated", "confidence", "limitations"],
      properties: {
        data_sources: { type: "array", items: { type: "string" } },
        generated_at: { type: "string" },
        freshness_seconds: { type: "number" },
        is_estimated: { type: "boolean" },
        confidence: { type: "number" },
        limitations: { type: "array", items: { type: "string" } }
      }
    },
    agent_hints: { type: "object" },
    summary: { type: "string" },
    error: { type: "object" }
  }
};
