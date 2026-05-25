export async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function sendJson(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body, null, 2));
}

export function sendHtml(res, statusCode, body) {
  res.writeHead(statusCode, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

export function sendNotFound(res, code) {
  sendJson(res, 404, { error: { code } });
}

export function normalizeEndpoint(endpoint, baseUrl) {
  if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) return endpoint;
  if (!endpoint.startsWith("/") && /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(\/|$)/i.test(endpoint)) {
    return `https://${endpoint}`;
  }
  return new URL(endpoint, baseUrl).toString();
}

export function getRequestBaseUrl(req) {
  const configured = process.env.AGENT_ROUTER_PUBLIC_URL || process.env.ADN_PUBLIC_BASE_URL;
  if (configured) return String(configured).replace(/\/$/, "");
  const host = firstHeader(req, "x-forwarded-host")
    || firstHeader(req, "host")
    || process.env.RENDER_EXTERNAL_HOSTNAME
    || "127.0.0.1";
  const protocol = firstHeader(req, "x-forwarded-proto")
    || (process.env.RENDER_EXTERNAL_HOSTNAME ? "https" : "http");
  return `${protocol}://${host}`;
}

function firstHeader(req, name) {
  const value = req.headers?.[name];
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw || "").split(",")[0].trim();
}

export function parseCapabilities(value) {
  if (Array.isArray(value)) return value;
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function parseMaybeJson(value, label) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(value || "{}");
  } catch (error) {
    const wrapped = new Error(`${label} must be valid JSON: ${error.message}`);
    wrapped.statusCode = 422;
    throw wrapped;
  }
}
