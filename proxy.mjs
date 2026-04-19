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
//   PROXY_GATEWAY_KEY        required     Vercel AI Gateway key (vck_...)
//   PROXY_BILLING            default: subscription  (subscription|vercel)
//   PROXY_UPSTREAM_URL       default: https://ai-gateway.vercel.sh
//   PROXY_KEY_HEADER         default: x-ai-gateway-api-key (subscription mode)
//   PROXY_PORT               default: 3456
//   PROXY_BIND               default: 0.0.0.0
//   PROXY_USER               optional     providerOptions.gateway.user
//   PROXY_TAGS               optional     comma-separated; providerOptions.gateway.tags
//   PROXY_LOG_BODY           default: 1   set to 0 to disable body summaries
//   PROXY_LOG_HEADERS        default: 0   set to 1 to dump all headers
//
//   Split routing (paths forwarded direct to Anthropic, bypassing Vercel):
//   PROXY_PASSTHROUGH_PATHS  default: ""  (disabled)
//                            comma-separated path prefixes. When set, matching
//                            paths are forwarded direct to PROXY_PASSTHROUGH_HOST
//                            (default api.anthropic.com) with the caller's
//                            Authorization preserved — no Vercel key added,
//                            no providerOptions.gateway injection. Use for
//                            endpoints Vercel's gateway doesn't proxy, e.g.
//                            /api/oauth/usage (rate-limit reporting for
//                            Claude Code / claude-hud). Opt-in because the
//                            primary value of this proxy is Vercel observability;
//                            silent bypass is surprising unless requested.
//   PROXY_PASSTHROUGH_HOST   default: api.anthropic.com  (only used when
//                                                         PASSTHROUGH_PATHS is set)

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

// Split routing (opt-in): paths matching PASSTHROUGH_PATHS are forwarded direct
// to PASSTHROUGH_HOST (default api.anthropic.com) instead of the Vercel gateway.
// Caller's Authorization is preserved; no gateway key is injected. Default is
// empty (disabled) — set PROXY_PASSTHROUGH_PATHS=/api/oauth/ to unlock
// Claude Code rate-limit fetching via claude-hud.
const PASSTHROUGH_HOST = process.env.PROXY_PASSTHROUGH_HOST || "api.anthropic.com";
const PASSTHROUGH_PATHS = (process.env.PROXY_PASSTHROUGH_PATHS ?? "")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

function shouldPassthrough(reqPath) {
  if (PASSTHROUGH_PATHS.length === 0) return false;
  return PASSTHROUGH_PATHS.some((prefix) => reqPath.startsWith(prefix));
}

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
  const passthrough = shouldPassthrough(req.url);
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const originalBody = Buffer.concat(chunks).toString("utf8");
    // Skip body injection on passthrough — Anthropic doesn't know about
    // providerOptions.gateway and would 400 on unknown fields.
    const rewrittenBody =
      !passthrough && req.method === "POST" && originalBody
        ? injectGatewayOptions(originalBody)
        : originalBody;
    const payload = Buffer.from(rewrittenBody, "utf8");

    const headers = { ...req.headers };
    // Strip any gateway key header the caller may have sent (defensive).
    delete headers[KEY_HEADER];

    if (passthrough) {
      // Direct-to-Anthropic: preserve caller's Authorization exactly,
      // no Vercel key, no body rewrites, no tag injection.
      headers.host = PASSTHROUGH_HOST;
    } else if (MODE === "subscription") {
      // keep caller's Authorization; add Vercel key as a side-channel header
      headers.host = UPSTREAM.hostname;
      headers[KEY_HEADER] = `Bearer ${GATEWAY_KEY}`;
    } else {
      // vercel: Vercel key owns Authorization (dashboard BYOK applies if enabled)
      headers.host = UPSTREAM.hostname;
      headers.authorization = `Bearer ${GATEWAY_KEY}`;
    }
    delete headers["content-length"];
    if (payload.length > 0) headers["content-length"] = String(payload.length);

    const incomingAuth = req.headers["authorization"];
    const route = passthrough ? `passthrough→${PASSTHROUGH_HOST}` : "gateway";
    console.log(
      `[proxy] → ${req.method} ${req.url} [${route}] (auth=${redactAuth(incomingAuth)}, injected=${!passthrough && !!(USER || TAGS.length)})`,
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

    // Passthrough always uses HTTPS (Anthropic is HTTPS); gateway uses whatever
    // the UPSTREAM URL says.
    const requestFn = passthrough ? httpsRequest : upstreamRequest;
    const targetPort = passthrough ? 443 : upstreamPort;
    const proxyReq = requestFn(
      {
        hostname: passthrough ? PASSTHROUGH_HOST : UPSTREAM.hostname,
        port: targetPort,
        path: req.url,
        method: req.method,
        headers,
      },
      (proxyRes) => {
        const elapsed = Date.now() - started;
        const id = passthrough
          ? proxyRes.headers["request-id"] || "?"
          : proxyRes.headers["x-gateway-request-id"] ||
            proxyRes.headers["x-vercel-id"] ||
            "?";
        console.log(`[proxy] ← ${proxyRes.statusCode} in ${elapsed}ms [${route}] (id=${id})`);
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
  const passthroughSummary =
    PASSTHROUGH_PATHS.length > 0
      ? `passthrough=[${PASSTHROUGH_PATHS.join(",")}]→${PASSTHROUGH_HOST}`
      : "passthrough=off";
  console.log(
    `[proxy] listening http://${BIND}:${PORT} → ${UPSTREAM.origin} ` +
      `(billing=${MODE}, user=${USER || "-"}, tags=[${TAGS.join(",")}], ${passthroughSummary})`,
  );
});
