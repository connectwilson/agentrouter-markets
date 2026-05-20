#!/usr/bin/env node

const baseUrl = (process.env.AGENT_ROUTER_URL || process.env.ADN_REGISTRY_URL || "https://agentrouter-markets-production.up.railway.app").replace(/\/$/, "");

const tools = [
  {
    name: "agentrouter_ask",
    description: "Fallback/demo tool: route a natural-language data/API request to the best registered AgentRouter service, invoke it if allowed by budget, and return the verified result.",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: { type: "string", description: "The user's original data/API request." },
        max_price: { type: "string", description: "Maximum USDC price allowed for this call.", default: "0.05" },
        currency: { type: "string", description: "Payment currency.", default: "USDC" }
      }
    }
  },
  {
    name: "agentrouter_request",
    description: "Preferred tool: send a structured capability request that the main agent has already parsed, then route, quote, invoke, verify, and return evidence.",
    inputSchema: {
      type: "object",
      required: ["capability", "params"],
      properties: {
        capability: { type: "string", description: "Structured capability name, for example perp_liquidation_max_pain." },
        params: { type: "object", description: "Capability-specific input parameters." },
        constraints: { type: "object", description: "Routing and payment constraints, for example max_price_usdc and freshness_seconds." },
        budget: { type: "object", description: "Optional budget object." },
        consumer_context: { type: "object", description: "Optional caller context, parser metadata, or session id." }
      }
    }
  },
  {
    name: "agentrouter_quote",
    description: "Preview AgentRouter service selection, request input, price, and payment guard result without invoking the provider.",
    inputSchema: {
      type: "object",
      required: ["capability", "params"],
      properties: {
        capability: { type: "string", description: "Structured capability name, for example perp_liquidation_max_pain." },
        params: { type: "object", description: "Capability-specific input parameters." },
        constraints: { type: "object", description: "Routing and payment constraints, for example max_price_usdc." },
        budget: { type: "object", description: "Optional budget object." }
      }
    }
  },
  {
    name: "agentrouter_capabilities",
    description: "List the AgentRouter capability catalog and expected structured request schemas.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  }
];

let buffer = Buffer.alloc(0);

process.stdin.on("data", async (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (const message of readMessages()) {
    await handleMessage(message);
  }
});

process.stdin.on("end", () => process.exit(0));

function readMessages() {
  const messages = [];
  while (buffer.length) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd === -1) break;
      const line = buffer.subarray(0, lineEnd).toString("utf8").trim();
      buffer = buffer.subarray(lineEnd + 1);
      if (line) messages.push(JSON.parse(line));
      continue;
    }

    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = header.match(/content-length:\s*(\d+)/i);
    if (!match) throw new Error("Missing Content-Length header");

    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) break;

    const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.subarray(bodyEnd);
    messages.push(JSON.parse(body));
  }
  return messages;
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  if (message.method?.startsWith("notifications/")) return;
  if (!Object.hasOwn(message, "id")) return;

  try {
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "AgentRouter", version: "0.1.0" }
        }
      });
      return;
    }

    if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools } });
      return;
    }

    if (message.method === "tools/call") {
      const result = await callTool(message.params?.name, message.params?.arguments || {});
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ],
          isError: result?.ok === false && ["transport_error", "http_error"].includes(result.status)
        }
      });
      return;
    }

    sendError(message.id, -32601, `Unknown method: ${message.method}`);
  } catch (error) {
    sendError(message.id, -32000, error.message);
  }
}

async function callTool(name, args) {
  if (name === "agentrouter_ask") {
    return post("/agent-router/ask", {
      task: args.task,
      max_price: args.max_price || "0.05",
      currency: args.currency || "USDC"
    });
  }

  if (name === "agentrouter_request") {
    return post("/agent-router/request", {
      capability: args.capability,
      params: args.params || {},
      constraints: args.constraints || {},
      budget: args.budget || {},
      consumer_context: args.consumer_context || {}
    });
  }

  if (name === "agentrouter_quote") {
    return post("/agent-router/quote", {
      capability: args.capability,
      params: args.params || {},
      constraints: args.constraints || {},
      budget: args.budget || {}
    });
  }

  if (name === "agentrouter_capabilities") {
    return get("/capabilities");
  }

  return {
    ok: false,
    status: "unknown_tool",
    tool: name,
    available_tools: tools.map((tool) => tool.name)
  };
}

async function get(path) {
  return request(path, { method: "GET" });
}

async function post(path, body) {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function request(path, options) {
  try {
    const response = await fetch(`${baseUrl}${path}`, options);
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      return {
        ok: false,
        status: "http_error",
        http_status: response.status,
        base_url: baseUrl,
        payload
      };
    }
    return payload;
  } catch (error) {
    return {
      ok: false,
      status: "transport_error",
      base_url: baseUrl,
      message: error.message
    };
  }
}

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function sendError(id, code, message) {
  send({
    jsonrpc: "2.0",
    id,
    error: { code, message }
  });
}
