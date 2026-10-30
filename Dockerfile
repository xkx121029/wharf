FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

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
