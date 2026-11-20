# M1 probe: the same base and Chromium as the game's stand image (stand/Dockerfile), plus the spike page.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node package.json ./
RUN npm install --no-audit --no-fund
COPY --chown=node:node . .
