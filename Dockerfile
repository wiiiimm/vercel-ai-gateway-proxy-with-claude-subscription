FROM node:22-alpine
WORKDIR /app
COPY proxy.mjs /app/proxy.mjs
EXPOSE 3456
CMD ["node", "/app/proxy.mjs"]
