FROM node:22-alpine

LABEL org.opencontainers.image.source="https://github.com/wiiiimm/vercel-ai-gateway-proxy-with-claude-subscription"
LABEL org.opencontainers.image.description="Use your Claude subscription with any Anthropic-compatible tool through Vercel AI Gateway"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY proxy.mjs /app/proxy.mjs

# Unlock Claude Code fast mode (https://code.claude.com/docs/en/fast-mode) for
# downstream Claude Code CLI / Agent SDK consumers of this proxy. The env var is
# consumed by claude-cli (usually running in a neighbour container), not by this
# proxy, so setting it here is a default/signal for docker-compose setups that
# share env via env_file. The flag just UNLOCKS /fast — user still has to type
# /fast to actually enable it. Override to 0 to lock it back.
ENV CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK=1

EXPOSE 3456
CMD ["node", "/app/proxy.mjs"]
