FROM node:22-slim AS builder

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
COPY shared/package.json shared/
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Production image
FROM node:22-slim

WORKDIR /app

COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/web/dist ./web/dist
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server/node_modules ./server/node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/server/package.json ./server/

# Create logs directory
RUN mkdir -p /app/logs /app/runs

EXPOSE 8243

ENV NODE_ENV=production
ENV OPENCODE_SERVER_PASSWORD=change-me
ENV SERVER_PORT=8243

CMD ["node", "server/dist/index.js"]