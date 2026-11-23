# Bookworm keeps the native Chromium/impit runtime on a known Debian release.
FROM node:24-bookworm-slim AS builder
WORKDIR /usr/src/microsoft-rewards-script
ENV PLAYWRIGHT_BROWSERS_PATH=0
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim AS runtime
WORKDIR /usr/src/microsoft-rewards-script
ENV NODE_ENV=production TZ=Asia/Shanghai PLAYWRIGHT_BROWSERS_PATH=0 FORCE_HEADLESS=1 NODE_OPTIONS=--disable-warning=ExperimentalWarning
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash cron gettext-base jq tzdata ca-certificates \
    fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/src/microsoft-rewards-script/dist ./dist
COPY --from=builder /usr/src/microsoft-rewards-script/node_modules ./node_modules
COPY package.json package-lock.json ./
RUN npx --no-install patchright install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
COPY config.example.json ./config.example.json
COPY scripts/api ./scripts/api
COPY scripts/main ./scripts/main
COPY scripts/env.js scripts/utils.js scripts/package.json ./scripts/
COPY --chmod=755 scripts/docker ./scripts/docker
COPY --chmod=644 src/crontab.template /etc/cron.d/microsoft-rewards-cron.template
COPY --chmod=755 scripts/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN find scripts/api -name '*.test.js' -delete
EXPOSE 3010
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
