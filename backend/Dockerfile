# Multi-stage lightweight Node.js Dockerfile — see docs/Deployment.md
FROM node:20-alpine

# Install curl for container health check
RUN apk add --no-cache curl

WORKDIR /app

ENV NODE_ENV=production

# Install production dependencies first to leverage Docker layer caching
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source code
COPY src/ ./src/

# Run as unprivileged non-root user for container security
USER node

EXPOSE 3000

# Docker health check querying the /health endpoint
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "src/server.js"]
