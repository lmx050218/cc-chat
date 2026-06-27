FROM node:22-alpine

WORKDIR /app

COPY relay/package.json relay/package-lock.json* ./
RUN npm ci --omit=dev

COPY relay/server.js ./
COPY relay/public/ ./public/

EXPOSE 17389
CMD ["node", "server.js"]
