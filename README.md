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

OpenClaw strips `ANTHROPIC_BASE_URL` before spawning `claude -p`, so set it in
Claude Code's own settings file instead:

```json
// ~/.claude/settings.json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://vercel-ai-gateway-proxy:3456"
  }
}
```

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

## License

MIT — see [LICENSE](./LICENSE).
