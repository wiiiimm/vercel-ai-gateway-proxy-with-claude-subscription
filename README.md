# vercel-ai-gateway-proxy-with-claude-subscription

**Get [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) observability and
tracking for any Anthropic-compatible tool, billed to your Claude
subscription** (Max recommended; Pro/Team/Enterprise also work).

No Vercel token charges. Your existing Claude plan foots the bill. Vercel just
watches.

Zero-dependency Node.js proxy (~200 lines). Drop-in sidecar.

## The problem

[Vercel's "With Claude Code Max"
flow](https://vercel.com/docs/agent-resources/coding-agents/claude-code#with-claude-code-max)
lets you use your Claude subscription through the AI Gateway instead of paying
Vercel's per-token rates. It relies on two environment variables:

```bash
export ANTHROPIC_BASE_URL=https://ai-gateway.vercel.sh
export ANTHROPIC_CUSTOM_HEADERS="x-ai-gateway-api-key: Bearer <vck-key>"
```

**But `ANTHROPIC_CUSTOM_HEADERS` only works in Claude Code CLI.** The Anthropic
SDK doesn't read it. OpenClaw doesn't read it. aider, Cline, and most other
third-party Anthropic clients don't read it. Some tools even *strip*
`ANTHROPIC_BASE_URL` before spawning subprocesses.

## The fix

Run this proxy as a sidecar. Point your tool at `ANTHROPIC_BASE_URL=http://proxy:3456`.
The proxy injects `x-ai-gateway-api-key` at the network layer, so any
Anthropic client works:

```
┌────────┐   http    ┌────────────┐   https    ┌──────────────────────┐
│ client │──────────▶│    proxy   │───────────▶│ ai-gateway.vercel.sh │──▶ Anthropic
│        │           │  this repo │            │                      │   (bills your
└────────┘           └────────────┘            └──────────────────────┘    subscription)
 Authorization:       preserves Auth            validates gateway key,
 Bearer <oauth>       adds x-ai-gateway-         proxies through with
                      api-key header,            your OAuth intact
                      adds tags to body
```

## Quick start

### Docker

```bash
docker run -d --name vercel-ai-gateway-proxy \
  -p 127.0.0.1:3456:3456 \
  -e PROXY_GATEWAY_KEY=vck_... \
  -e PROXY_USER=my-app \
  -e PROXY_TAGS=production \
  ghcr.io/wiiiimm/vercel-ai-gateway-proxy-with-claude-subscription:latest
```

### Docker Compose

```yaml
services:
  vercel-ai-gateway-proxy:
    image: ghcr.io/wiiiimm/vercel-ai-gateway-proxy-with-claude-subscription:latest
    environment:
      PROXY_GATEWAY_KEY: ${PROXY_GATEWAY_KEY}
      PROXY_USER: my-service
      PROXY_TAGS: my-service,prod

  my-app:
    image: my-app:latest
    environment:
      ANTHROPIC_BASE_URL: http://vercel-ai-gateway-proxy:3456
    depends_on: [vercel-ai-gateway-proxy]
```

### From source

```bash
git clone https://github.com/wiiiimm/vercel-ai-gateway-proxy-with-claude-subscription.git
cd vercel-ai-gateway-proxy-with-claude-subscription
cp .env.example .env   # fill in PROXY_GATEWAY_KEY
node --env-file=.env proxy.mjs
```

## Authenticating your client

Your Anthropic client still needs an OAuth token issued via a Vercel-aware login.
For **Claude Code CLI**, this is automatic — just set `ANTHROPIC_BASE_URL` before
running `claude login`:

```bash
export ANTHROPIC_BASE_URL=http://localhost:3456
claude /logout && claude       # OAuth callback routes through Vercel,
                                # binding this token to your subscription
```

Other tools can reuse the resulting token stored in `~/.claude/.credentials.json`.

## Client examples

### OpenClaw

[OpenClaw](https://docs.openclaw.ai) (fka Clawdbot) was the project that
motivated this proxy. It can reuse a local Claude Code CLI login via its
`claude-cli` auth mode, which delegates LLM calls to `claude -p` as a
subprocess.

**Step 1 — switch OpenClaw to the `claude-cli` backend.** Run this once in
the gateway container or on the host:

```bash
openclaw onboard --non-interactive --accept-risk --auth-choice anthropic-cli --flow manual
```

That changes the primary model to `claude-cli/claude-sonnet-4-6` (or similar),
which routes all LLM calls through `claude -p`.

**Step 2 — point Claude Code at this proxy.** OpenClaw explicitly strips
`ANTHROPIC_BASE_URL` from the child environment before spawning `claude -p`,
so the env var approach doesn't work. Use Claude Code's own `settings.json`
instead — Claude reads it after spawn and applies the env vars itself:

```json
// ~/.claude/settings.json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://vercel-ai-gateway-proxy:3456"
  }
}
```

If you're running OpenClaw in Docker alongside this proxy as a sidecar, mount
`~/.claude/settings.json` into the OpenClaw container so the setting survives
container rebuilds.

**Step 3 — verify.** Send OpenClaw a message and watch the proxy logs
(`docker logs -f vercel-ai-gateway-proxy`). You should see `POST /v1/messages`
entries with your tags attached.

### Anthropic SDK (Node)

```js
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ baseURL: "http://localhost:3456" });
```

### aider / generic CLIs

```bash
export ANTHROPIC_BASE_URL=http://localhost:3456
aider ...
```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `PROXY_GATEWAY_KEY` | ✅ | — | Vercel AI Gateway key (`vck_...`) |
| `PROXY_USER` | | — | Injected as `providerOptions.gateway.user` |
| `PROXY_TAGS` | | — | Comma-separated tags |
| `PROXY_PORT` | | `3456` | Listen port |
| `PROXY_BIND` | | `0.0.0.0` | Bind address |
| `PROXY_UPSTREAM_URL` | | `https://ai-gateway.vercel.sh` | Upstream |
| `PROXY_KEY_HEADER` | | `x-ai-gateway-api-key` | Gateway key header name |
| `PROXY_BILLING` | | `subscription` | See [Billing modes](#billing-modes) |
| `PROXY_LOG_BODY` | | `1` | Log request body summaries |
| `PROXY_LOG_HEADERS` | | `0` | Log full headers (redacted) |
| `PROXY_PASSTHROUGH_HOST` | | `api.anthropic.com` | Hostname for split-routed requests (only used when `PROXY_PASSTHROUGH_PATHS` is non-empty). See [Split routing](#split-routing-opt-in). |
| `PROXY_PASSTHROUGH_PATHS` | | *empty (disabled)* | Comma-separated path prefixes to forward direct to Anthropic. Opt-in — see below. |
| `CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK` | | `1` | Downstream: unlocks Claude Code `/fast`. See [Fast mode](#fast-mode-claude-code). |

## Split routing (opt-in)

**Off by default.** The whole point of this proxy is routing traffic *through*
Vercel for observability; silently bypassing some paths would be surprising.
But a small number of Anthropic endpoints aren't proxied by Vercel — most
notably `/api/oauth/usage`, which powers Claude Code's rate-limit display in
tools like [claude-hud](https://github.com/jarrodwatts/claude-hud). When the
caller's OAuth token hits Vercel's gateway on that path, Vercel doesn't know
what to do and Anthropic never sees it → rate-limit data comes back empty.

If you want the rate-limit display to work, opt in to split routing:

```yaml
services:
  vercel-ai-gateway-proxy:
    image: ghcr.io/wiiiimm/vercel-ai-gateway-proxy-with-claude-subscription:latest
    environment:
      PROXY_GATEWAY_KEY: ${PROXY_GATEWAY_KEY}
      PROXY_PASSTHROUGH_PATHS: "/api/oauth/,/api/claude_code/"
```

When enabled, requests whose path starts with any of `PROXY_PASSTHROUGH_PATHS`
are forwarded direct to `PROXY_PASSTHROUGH_HOST` (default `api.anthropic.com`):

- The caller's `Authorization` header is preserved intact
- No Vercel gateway key is injected
- No `providerOptions.gateway` body rewrite happens
- Log line reads `[passthrough→api.anthropic.com]` vs `[gateway]` for clarity

Regular inference traffic (`/v1/messages`, `/v1/messages/count_tokens`, etc.)
continues through Vercel with full observability + tagging regardless. Split
routing only affects the explicitly listed prefixes.

**Trade-off:** anything passthrough-routed doesn't appear in your Vercel
dashboard. That's fine for OAuth/usage endpoints (no interesting billing data)
but worth knowing before adding arbitrary prefixes to the list.

## Fast mode (Claude Code)

[Fast mode](https://code.claude.com/docs/en/fast-mode) runs Claude Opus 4.6
about 2.5x faster at a higher per-token rate. Billed separately as "extra usage"
at $30/$150 per Mtok in/out — even if you have remaining plan usage. Falls back
to standard speed/pricing when the fast rate limit hits.

Per [Vercel's docs](https://vercel.com/docs/agent-resources/coding-agents/claude-code#enabling-fast-mode),
Claude Code needs `CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK=1` in its environment
to allow `/fast` over the AI Gateway (the org check fails for gateway-routed
requests since they come from a different Anthropic org).

**This image sets it to `1` by default.** The flag only *unlocks* the
capability — users still have to type `/fast` inside Claude Code to actually
enable it. Override to `0` if you want to force-lock it:

```yaml
services:
  vercel-ai-gateway-proxy:
    image: ghcr.io/wiiiimm/vercel-ai-gateway-proxy-with-claude-subscription:latest
    environment:
      CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: "0"
```

**Note:** The env var is consumed by **Claude Code CLI / Agent SDK**, not by
this proxy. It's set here as a Dockerfile default so docker-compose setups
using `env_file: .env` on both this proxy and a paired Claude Code container
get fast-mode-unlocked out of the box. If your Claude Code runs in a container
that doesn't share env with the proxy, set it there directly — or add it to
`~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK": "1"
  }
}
```

## Observability tags

With `PROXY_USER` and/or `PROXY_TAGS` set, the proxy injects them into every
request body as `providerOptions.gateway.{user, tags}`. These surface in
Vercel's [Custom
Reporting](https://vercel.com/docs/ai-gateway/capabilities/custom-reporting)
dashboard — group by tag or user to slice cost and volume across apps,
environments, or features.

Cost: `$0.075 per 1,000 unique tag values` — negligible for stable tags
(`production`, `staging`, app names).

## Billing modes

There are two modes via `PROXY_BILLING`. The default is `subscription` —
that's the whole point of this proxy.

| Mode | Billing | When to use |
|---|---|---|
| `subscription` (default) | Claude Max / Pro subscription | You want subscription billing + observability |
| `vercel` | Vercel tokens or dashboard BYOK | You're already paying Vercel and just want the proxy for tag injection / logging / centralized key management |

In `vercel` mode the proxy replaces the caller's `Authorization` with your Vercel
key. Useful if you'd rather keep the key out of client config, but offers no
billing advantage over calling Vercel directly.

## Logs

Example output:

```
[proxy] listening http://0.0.0.0:3456 → https://ai-gateway.vercel.sh (billing=subscription, user=my-app, tags=[production])
[proxy] → POST /v1/messages (auth=Bearer sk-...VgAA, injected=true)
[proxy]   body: {"model":"claude-sonnet-4-6","messages":1,"system":"[3 blocks]","tools":12,"stream":true,"providerOptions":{"gateway":{"user":"my-app","tags":["production"]}}}
[proxy] ← 200 in 1842ms (id=cle1::abc123)
```

## Why this flow needs a proxy (deep dive)

Vercel's "Claude Max" flow works because:

1. When you run `claude login` with `ANTHROPIC_BASE_URL` pointed at Vercel,
   the OAuth token exchange routes through Vercel's server
2. Vercel records a binding: "this OAuth token belongs to subscription X"
3. Future API requests carrying that token + a gateway key get
   subscription-billed

Native Claude Code CLI sets both headers via `ANTHROPIC_CUSTOM_HEADERS`. Other
Anthropic clients don't support custom headers — so Vercel never sees the
gateway key, rejects the request with 401, and the flow breaks.

This proxy fills the gap by adding `x-ai-gateway-api-key` at the network
layer. The client only needs to point at `ANTHROPIC_BASE_URL`, which every
Anthropic client supports.

## Contributing / Releasing

Docker images are built and published automatically via GitHub Actions.

**Every push to `main`** → multi-arch build (amd64+arm64) pushed as `:latest`,
`:main`, and `:sha-<commit>` to both ghcr.io and Docker Hub.

**Cutting a versioned release:**

```bash
git tag v0.2.0
git push origin v0.2.0
```

That triggers:
1. Multi-arch build pushed as `:v0.2.0`, `:0.2.0`, `:0.2`, `:0`, and `:latest`
2. A GitHub Release auto-created at the tag, with generated notes and pull
   commands in the body

No manual steps after pushing the tag. Delete + re-push a tag if you need to
rebuild an existing version.

## License

MIT — see [LICENSE](./LICENSE).
