# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY ui ./ui

RUN npm run build


FROM node:22-bookworm-slim AS production-dependencies

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force


FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=8234 \
    PROJECT_ROOT=/app \
    ARTIFACT_ROOT=/app/artifacts

WORKDIR /app

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/ui ./ui
COPY --chown=node:node package.json package-lock.json LICENSE ./

RUN mkdir -p /app/artifacts/images /app/artifacts/reports \
    && chown -R node:node /app/artifacts

USER node

EXPOSE 8234

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8234/api/ready').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "dist/src/app.js"]
