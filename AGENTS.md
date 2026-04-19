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
- **`CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK=1`** is set as a Dockerfile ENV default. This env var is NOT read by `proxy.mjs` — it's consumed by Claude Code CLI / Agent SDK in a neighbouring container that shares `.env` via `env_file`. It unlocks the `/fast` command. See the "Fast mode (Claude Code)" section in `README.md`. Do not remove the ENV line; it's deliberately a signal/default for downstream consumers.

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

`.github/workflows/publish.yml` handles everything. Two jobs:

1. **`build-and-push`** — builds multi-arch (amd64+arm64) and pushes to:
   - `ghcr.io/wiiiimm/vercel-ai-gateway-proxy-with-claude-subscription` (auto-auth via `GITHUB_TOKEN`)
   - `docker.io/<DOCKERHUB_USERNAME>/vercel-ai-gateway-proxy-with-claude-subscription` (needs `DOCKERHUB_USERNAME` var + `DOCKERHUB_TOKEN` secret)
2. **`release`** — runs only on `v*.*.*` tags. Creates a GitHub Release with auto-generated notes and `docker pull` commands.

### Triggers and tag matrix

| Trigger | Docker tags produced | GitHub Release |
|---|---|---|
| Push to `main` | `:latest`, `:main`, `:sha-<commit>` | No |
| Push tag `vX.Y.Z` | `:vX.Y.Z`, `:X.Y.Z`, `:X.Y`, `:X`, `:latest` | Yes |
| Push tag `vX.Y.Z-rc.N` | `:vX.Y.Z-rc.N`, `:X.Y.Z-rc.N` (no `:latest`) | Yes |
| Manual dispatch | Whatever matches current ref | Only if tag ref |

### Cutting a release

```bash
git tag v0.2.0
git push origin v0.2.0
```

Nothing else. The workflow builds, pushes to both registries, and creates the GitHub Release.

### Re-releasing a bad tag

Don't amend history on main. Delete and re-push the tag:

```bash
git tag -d v0.1.0
git push origin :refs/tags/v0.1.0
# fix the commit if needed
git tag v0.1.0
git push origin v0.1.0
```

GitHub's Release object also needs deletion if it was created (`gh release delete v0.1.0 --yes`) — the workflow won't overwrite it.

### Secrets / variables required

One-time setup in repo settings:

- **`DOCKERHUB_USERNAME`** (Actions → Variables) — your Docker Hub username
- **`DOCKERHUB_TOKEN`** (Actions → Secrets) — a Docker Hub access token with `Read, Write, Delete` scope

If either is missing, Docker Hub publishing is skipped (workflow still succeeds for ghcr.io).

### Versioning conventions

- Start at `v0.1.0`. Minor bumps for new features, patch for bug fixes.
- No pre-v1 stability guarantees.
- Breaking changes in config (env var renames, mode changes) bump the minor while in `0.x`, major once at `1.0+`.

## Commit style

Short, action-oriented messages. Examples:
- `Add PROXY_LOG_HEADERS env var`
- `Fix: redact Authorization in logs when empty`
- `Docs: clarify subscription vs vercel mode`

Reference issues/PRs where relevant (`Fixes #12`).
