# Fig & Bloom email builder — container image for Render.com (and any Docker host).
# Node + a system Chromium so Puppeteer's "Render PNG" works without downloading its own.
FROM node:20-bookworm-slim

# Use the distro Chromium; tell Puppeteer not to download its own.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    CHROMIUM_PATH=/usr/bin/chromium \
    NODE_ENV=production

# chromium (apt pulls its runtime libs); fonts-liberation covers generic fallbacks.
# The brand fonts ship embedded in shell-preview.html, so no extra font install is needed.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium ca-certificates fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching.
COPY package*.json ./
RUN npm install --omit=dev

# App source (design-system, lib, public, server.js …). See .dockerignore for exclusions.
COPY . .

# Render injects $PORT; the server falls back to 4321 locally.
EXPOSE 4321
CMD ["node", "server.js"]
