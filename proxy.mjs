// BYOA proxy — sits between any Anthropic-compatible client and Vercel AI
// Gateway, injecting the gateway key + observability tags. Two billing modes:
//   - subscription (default): keep client's OAuth Authorization; add Vercel
//                              key as x-ai-gateway-api-key. Bills to Max plan.
//   - vercel:                  replace Authorization with Vercel key. Bills
//                              to Vercel (or dashboard-configured BYOK if
//                              enabled on the team).
//
// For dashboard-configured BYOK (Anthropic API key), use mode=vercel — the
// key is applied automatically by Vercel to all gateway traffic.
//
// Env vars:
//   PROXY_GATEWAY_KEY     required     Vercel AI Gateway key (vck_...)
//   PROXY_BILLING            default: subscription  (subscription|vercel)
//   PROXY_UPSTREAM_URL    default: https://ai-gateway.vercel.sh
//   PROXY_KEY_HEADER      default: x-ai-gateway-api-key (subscription mode)
//   PROXY_PORT            default: 3456
//   PROXY_BIND            default: 0.0.0.0
//   PROXY_USER            optional     providerOptions.gateway.user
//   PROXY_TAGS            optional     comma-separated; providerOptions.gateway.tags
//   PROXY_LOG_BODY        default: 1   set to 0 to disable body summaries
//   PROXY_LOG_HEADERS     default: 0   set to 1 to dump all headers

import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

const GATEWAY_KEY = process.env.PROXY_GATEWAY_KEY || process.env.VERCEL_AI_GATEWAY_KEY;
const MODE = (process.env.PROXY_BILLING || "subscription").toLowerCase();
const UPSTREAM = new URL(process.env.PROXY_UPSTREAM_URL || "https://ai-gateway.vercel.sh");
const KEY_HEADER = (process.env.PROXY_KEY_HEADER || "x-ai-gateway-api-key").toLowerCase();

const VALID_MODES = ["subscription", "vercel"];
if (!VALID_MODES.includes(MODE)) {
  console.error(`[proxy] invalid PROXY_BILLING "${MODE}" (valid: ${VALID_MODES.join(", ")})`);
  process.exit(1);
}
const PORT = Number(process.env.PROXY_PORT) || 3456;
const BIND = process.env.PROXY_BIND || "0.0.0.0";
const USER = process.env.PROXY_USER || process.env.OPENCLAW_USER || "";
const TAGS = (process.env.PROXY_TAGS || process.env.OPENCLAW_TAGS || "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const LOG_BODY = process.env.PROXY_LOG_BODY !== "0";
const LOG_HEADERS = process.env.PROXY_LOG_HEADERS === "1";

if (!GATEWAY_KEY) {
  console.error("[proxy] PROXY_GATEWAY_KEY not set; refusing to start");
  process.exit(1);
}

function injectGatewayOptions(body) {
  if (!USER && TAGS.length === 0) return body;
  try {
    const obj = JSON.parse(body);
    obj.providerOptions = obj.providerOptions || {};
    obj.providerOptions.gateway = {
      ...(obj.providerOptions.gateway || {}),
      ...(USER ? { user: USER } : {}),
      ...(TAGS.length > 0 ? { tags: TAGS } : {}),
    };
    return JSON.stringify(obj);
  } catch {
    return body;
  }
}

function redactAuth(value) {
  if (!value) return value;
  const str = String(value);
  return str.length > 14 ? str.slice(0, 10) + "..." + str.slice(-4) : "***";
}

function summarizeBody(body) {
  try {
    const obj = JSON.parse(body);
    return {
      model: obj.model,
      max_tokens: obj.max_tokens,
      messages: Array.isArray(obj.messages) ? obj.messages.length : undefined,
      system: obj.system
        ? Array.isArray(obj.system)
          ? `[${obj.system.length} blocks]`
          : `[${String(obj.system).length} chars]`
        : undefined,
      tools: Array.isArray(obj.tools) ? obj.tools.length : undefined,
      stream: obj.stream,
      providerOptions: obj.providerOptions,
    };
  } catch {
    return { raw_bytes: body.length };
  }
}

const upstreamIsHttps = UPSTREAM.protocol === "https:";
const upstreamRequest = upstreamIsHttps ? httpsRequest : httpRequest;
const upstreamPort = Number(UPSTREAM.port) || (upstreamIsHttps ? 443 : 80);

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        upstream: UPSTREAM.origin,
        user: USER || null,
        tags: TAGS,
      }),
    );
    return;
  }

  const chunks = [];
  const started = Date.now();
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const originalBody = Buffer.concat(chunks).toString("utf8");
    const rewrittenBody =
      req.method === "POST" && originalBody
        ? injectGatewayOptions(originalBody)
        : originalBody;
    const payload = Buffer.from(rewrittenBody, "utf8");

    const headers = { ...req.headers };
    headers.host = UPSTREAM.hostname;
    if (MODE === "subscription") {
      // keep caller's Authorization; add Vercel key as a side-channel header
      headers[KEY_HEADER] = `Bearer ${GATEWAY_KEY}`;
    } else {
      // vercel: Vercel key owns Authorization (dashboard BYOK applies if enabled)
      headers.authorization = `Bearer ${GATEWAY_KEY}`;
    }
    delete headers["content-length"];
    if (payload.length > 0) headers["content-length"] = String(payload.length);

    const incomingAuth = req.headers["authorization"];
    console.log(
      `[proxy] → ${req.method} ${req.url} (auth=${redactAuth(incomingAuth)}, injected=${!!(USER || TAGS.length)})`,
    );
    if (LOG_BODY && req.method === "POST" && originalBody) {
      console.log("[proxy]   body:", JSON.stringify(summarizeBody(rewrittenBody)));
    }
    if (LOG_HEADERS) {
      const safe = { ...headers };
      if (safe.authorization) safe.authorization = redactAuth(safe.authorization);
      if (safe[KEY_HEADER]) safe[KEY_HEADER] = redactAuth(safe[KEY_HEADER]);
      console.log("[proxy]   headers:", JSON.stringify(safe));
    }

    const proxyReq = upstreamRequest(
      {
        hostname: UPSTREAM.hostname,
        port: upstreamPort,
        path: req.url,
        method: req.method,
        headers,
      },
      (proxyRes) => {
        const elapsed = Date.now() - started;
        const id =
          proxyRes.headers["x-gateway-request-id"] ||
          proxyRes.headers["x-vercel-id"] ||
          "?";
        console.log(`[proxy] ← ${proxyRes.statusCode} in ${elapsed}ms (id=${id})`);
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on("error", (err) => {
      console.error("[proxy] upstream error:", err.message);
      if (!res.headersSent) res.writeHead(502);
      res.end("proxy error");
    });

    if (payload.length > 0) proxyReq.write(payload);
    proxyReq.end();
  });
});

server.listen(PORT, BIND, () => {
  console.log(
    `[proxy] listening http://${BIND}:${PORT} → ${UPSTREAM.origin} ` +
      `(billing=${MODE}, user=${USER || "-"}, tags=[${TAGS.join(",")}])`,
  );
});
