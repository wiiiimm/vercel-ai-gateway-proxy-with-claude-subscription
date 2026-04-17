FROM node:22-alpine

LABEL org.opencontainers.image.source="https://github.com/wiiiimm/vercel-ai-gateway-proxy-with-claude-subscription"
LABEL org.opencontainers.image.description="Use your Claude subscription with any Anthropic-compatible tool through Vercel AI Gateway"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY proxy.mjs /app/proxy.mjs
EXPOSE 3456
CMD ["node", "/app/proxy.mjs"]
