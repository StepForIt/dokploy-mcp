# ----- Build Stage -----
FROM node:lts-alpine AS builder
WORKDIR /app

# Install pnpm v9 (stable for Docker)
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Copy package and configuration
COPY package.json pnpm-lock.yaml tsconfig.json ./

# Copy source code and generation scripts
COPY src ./src
COPY scripts ./scripts

# Install dependencies, regenerate tool descriptions, then compile
RUN pnpm install --frozen-lockfile && \
    pnpm run generate && \
    pnpm run build

# ----- Production Stage -----
FROM node:lts-alpine
WORKDIR /app

# Install pnpm v9
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Copy built artifacts
COPY --from=builder /app/build ./build

# Copy package.json and lockfile
COPY package.json pnpm-lock.yaml ./

# Install production dependencies
RUN pnpm install --prod --frozen-lockfile

# Expose port
EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD if [ "$MCP_TRANSPORT" = "http" ] || [ "$MCP_TRANSPORT" = "sse" ]; then \
        wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1; \
      else \
        exit 0; \
      fi

# Start app
CMD ["node", "build/index.js"]
