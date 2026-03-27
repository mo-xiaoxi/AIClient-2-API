# ── Stage 1: 编译 Go TLS sidecar ──
FROM golang:1.22-alpine AS sidecar-builder

RUN apk add --no-cache git

WORKDIR /build
COPY tls-sidecar/go.mod tls-sidecar/go.sum* ./
RUN go mod download || true

COPY tls-sidecar/ ./
RUN go mod tidy && CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o tls-sidecar .

# ── Stage 2: 安装依赖 ──
FROM node:20-alpine AS deps

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ── Stage 3: 运行时 ──
FROM node:20-alpine

LABEL maintainer="AIClient2API Team"
LABEL description="Docker image for AIClient2API server"

# tar 用于更新功能，git 用于版本检查，procps 用于系统监控
RUN apk add --no-cache tar git procps

WORKDIR /app

# 从 deps 阶段复制 node_modules
COPY --from=deps /app/node_modules ./node_modules

# 复制源代码
COPY package.json ./
COPY src/ ./src/
COPY static/ ./static/
COPY configs/*.example configs/*.json ./configs/
COPY healthcheck.js ./

# 从 sidecar 构建阶段复制二进制
COPY --from=sidecar-builder /build/tls-sidecar /app/tls-sidecar/tls-sidecar
RUN chmod +x /app/tls-sidecar/tls-sidecar

# 创建目录并设置权限
RUN mkdir -p /app/logs /app/configs && \
    addgroup -S appgroup && adduser -S appuser -G appgroup && \
    chown -R appuser:appgroup /app/logs /app/configs

USER appuser

EXPOSE 3000 8085 8086 19876-19880

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node healthcheck.js || exit 1

CMD ["sh", "-c", "node src/core/master.js $ARGS"]
