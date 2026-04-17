# AGENTS.md

Context for AI coding agents (Claude Code, Cursor, aider, etc.) working on this repo.

## What this is

A ~200 line Node.js HTTP proxy that sits between an Anthropic-compatible
client and `ai-gateway.vercel.sh`. It injects Vercel's gateway key at the
network layer so clients that can't set custom headers natively can still use
the [Vercel AI Gateway "With Claude Max"](https://vercel.com/docs/agent-resources/coding-agents/claude-code#with-claude-code-max)
subscription-billing flow.

## Code layout

- `proxy.mjs` — the whole proxy. Single file. Keep it that way unless there's a strong reason to split.
- `Dockerfile` — `node:22-alpine` + one `COPY`. Kept minimal on purpose.
- `.env.example` — documents every supported env var with defaults.
- `README.md` — user-facing docs.
- `LICENSE` — MIT.

## Design principles

1. **Zero dependencies.** Only Node built-ins (`http`, `https`, `url`). Do not add npm packages. The value of this project is its simplicity; dependencies undermine that.
2. **Env-var driven config.** No config file. Everything via `PROXY_*` env vars. Every env var must have a sensible default where possible, and a documented reason if not.
3. **Never log secrets.** Auth headers are redacted before logging. If you add new header logging, use `redactAuth()` and test it.
4. **Fail loudly at startup, gracefully at runtime.** Invalid `PROXY_BILLING` → exit 1 on startup. Upstream errors at runtime → 502 response, log the error, keep serving.
5. **Subscription mode is the primary use case.** The whole point of this proxy is enabling subscription-billed Claude subscription traffic through Vercel. `vercel` mode exists as a secondary feature.

## Key concepts for agents

- **Billing modes** (`PROXY_BILLING`): `subscription` (default) preserves the caller's `Authorization` and adds `x-ai-gateway-api-key` on the side. `vercel` replaces `Authorization` with the Vercel key.
- **The OAuth token must be Vercel-registered.** Vercel creates the OAuth↔subscription binding at login time when `ANTHROPIC_BASE_URL` points through Vercel's gateway. A fresh OAuth token obtained without Vercel in the login flow will 401.
- **Tag injection** modifies the JSON request body — only for POSTs with parseable bodies. If the body isn't valid JSON, it's passed through unchanged. This is intentional — don't try to handle non-JSON bodies.
- **Streaming responses** are piped through unchanged. Don't buffer them; that breaks streaming.

## What NOT to do

- Do not add a logging framework — `console.log` is fine.
- Do not add request validation beyond what Vercel already does.
- Do not add retry logic — clients handle that.
- Do not add caching — the proxy should be stateless.
- Do not add TLS termination — use a real reverse proxy (Caddy, nginx) for that.
- Do not rename env vars without updating `.env.example`, `README.md`, and keeping backwards-compat aliases (like the existing `VERCEL_AI_GATEWAY_KEY` → `PROXY_GATEWAY_KEY` fallback in proxy.mjs).

## Testing

There are no automated tests yet. If you add any:
- No test framework dependency — use `node:test` (built into Node 22+).
- Mock the upstream with a local HTTP server; don't hit real Vercel.
- Test the `injectGatewayOptions()` and `redactAuth()` functions individually.

## Making changes

- Edit `proxy.mjs` directly.
- Build: `docker build -t vercel-ai-gateway-proxy-with-claude-subscription .`
- Run: `docker run --rm -e PROXY_GATEWAY_KEY=vck_... -p 3456:3456 vercel-ai-gateway-proxy-with-claude-subscription`
- Test: `curl -v http://localhost:3456/healthz`

## Release / CI

`.github/workflows/publish.yml` builds multi-arch (amd64+arm64) and publishes to:
- `ghcr.io/wiiiimm/vercel-ai-gateway-proxy-with-claude-subscription`
- `docker.io/wiiiimm/vercel-ai-gateway-proxy-with-claude-subscription` (if `DOCKERHUB_USERNAME` var + `DOCKERHUB_TOKEN` secret are configured)

Triggers:
- Push to `main` → `:latest`, `:main`, `:sha-<commit>`
- Tag `vX.Y.Z` → `:vX.Y.Z`, `:X.Y.Z`, `:X.Y`, `:X`, `:latest`

To cut a release:
```
git tag v0.2.0 && git push origin v0.2.0
```

## Commit style

Short, action-oriented messages. Examples:
- `Add PROXY_LOG_HEADERS env var`
- `Fix: redact Authorization in logs when empty`
- `Docs: clarify subscription vs vercel mode`

Reference issues/PRs where relevant (`Fixes #12`).
