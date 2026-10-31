# 基础镜像可替换为国内加速源，例如 --build-arg BASE_IMAGE=docker.m.daocloud.io/library/node:22-alpine
ARG BASE_IMAGE=node:22-alpine
FROM ${BASE_IMAGE}

ARG NPM_REGISTRY=https://registry.npmjs.org

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm config set registry ${NPM_REGISTRY} \
    && (npm ci --omit=dev || npm install --omit=dev)

COPY server ./server
COPY public ./public

ENV DATA_DIR=/data \
    PORT=8787

RUN mkdir -p /data/drive /data/workspace /data/tmp && chown -R node:node /data /app

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1

CMD ["node", "server/index.js"]
