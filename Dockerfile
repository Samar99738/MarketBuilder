# Multi-stage Docker build for MPC-enabled trading server

# Build stage
FROM node:18-alpine AS builder

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Production stage
FROM node:18-alpine AS production

# Install production dependencies
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S trader -u 1001

# Set working directory
WORKDIR /app

# Copy built application from builder stage
COPY --from=builder --chown=trader:nodejs /app/dist ./dist
COPY --from=builder --chown=trader:nodejs /app/package*.json ./
COPY --from=builder --chown=trader:nodejs /app/start-server.js ./

# Create directories for MPC credentials and logs
RUN mkdir -p /app/mpc-credentials /app/logs && \
    chown -R trader:nodejs /app/mpc-credentials /app/logs

# Install production dependencies only
RUN npm ci --only=production && npm cache clean --force

# Switch to non-root user
USER trader

# Environment variables (can be overridden at runtime)
ENV NODE_ENV=production
ENV MPC_ENABLED=false
ENV MPC_PROVIDER=mock

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "const http=require('http');const req=http.request({hostname:'localhost',port:process.env.PORT||3000,path:'/health'},res=>{process.exit(res.statusCode===200?0:1)});req.on('error',()=>process.exit(1));req.end();"

# Use dumb-init for proper signal handling
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Start the application
CMD ["node", "start-server.js"]
