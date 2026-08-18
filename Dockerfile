# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage: compile TypeScript -> build/*.js
# ---------------------------------------------------------------------------
FROM node:22-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime stage: Chromium + production deps + compiled server
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production

# Chromium and the minimal font/cert set headless Lighthouse needs. The
# chromium package pulls in its own shared-library dependencies.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       chromium \
       fonts-liberation \
       ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production dependencies only (lighthouse, chrome-launcher, MCP SDK).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled server from the build stage.
COPY --from=builder /app/build ./build

# CHROME_PATH pins the browser chrome-launcher should start; the HTTP server
# binds to $HOST:$PORT (see src/http.ts).
ENV CHROME_PATH=/usr/bin/chromium \
    PORT=8080 \
    HOST=0.0.0.0 \
    LIGHTHOUSE_CHROME_FLAGS="--disable-software-rasterizer"

EXPOSE 8080

CMD ["node", "build/http.js"]
