# Remote browser worker. Base image ships Node 24 + Playwright 1.64.0 browsers
# (PLAYWRIGHT_BROWSERS_PATH is preset; npm ci must not download browsers).
# RBA_WORKER_TEST_MODE / RBA_WORKER_TEST_PROXY_URL are test-only and are never set here.

# --- build stage: install dev deps and compile TypeScript
FROM apify/actor-node-playwright-chrome:24-1.64.0 AS builder
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY --chown=myuser:myuser package*.json ./
RUN npm ci --include=dev --audit=false --fund=false
COPY --chown=myuser:myuser tsconfig.json ./
COPY --chown=myuser:myuser src ./src
RUN npm run build

# --- runtime stage: production deps + compiled output only
FROM apify/actor-node-playwright-chrome:24-1.64.0
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY --chown=myuser:myuser package*.json ./
RUN npm --quiet set progress=false \
    && npm ci --omit=dev --omit=optional --audit=false --fund=false \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" && node --version \
    && echo "NPM version:" && npm --version \
    && rm -rf ~/.npm
COPY --from=builder --chown=myuser:myuser /home/myuser/dist ./dist
COPY --chown=myuser:myuser .actor ./.actor
CMD ["node", "dist/main.js"]
