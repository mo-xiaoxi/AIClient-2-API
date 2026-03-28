# 部署指南

本文档覆盖 AIClient-2-API 的生产环境部署方案，包括 Docker 部署和直接部署两种方式。

## Docker 部署（推荐）

Docker 是最简单的部署方式，无需在宿主机安装 Node.js 或 Go 环境。

### 使用官方镜像

```bash
docker run -d \
  --name aiclient-2-api \
  -p 3000:3000 \
  -v /path/to/your/configs:/app/configs \
  --restart unless-stopped \
  justlikemaki/aiclient-2-api
```

`/path/to/your/configs` 替换为宿主机上存放配置文件的目录，该目录必须包含 `config.json`。

### 使用 Docker Compose

创建 `docker-compose.yml`：

```yaml
version: '3.8'
services:
  aiclient-2-api:
    image: justlikemaki/aiclient-2-api
    container_name: aiclient-2-api
    ports:
      - "3000:3000"
    volumes:
      - ./configs:/app/configs
    environment:
      - ARGS=--log-prompts console
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "healthcheck.js"]
      interval: 30s
      timeout: 3s
      retries: 3
      start_period: 5s
```

启动：

```bash
docker compose up -d
```

### 本地构建镜像

```bash
docker build -t aiclient-2-api .
docker run -d -p 3000:3000 -v "$(pwd)/configs:/app/configs" --name aiclient-2-api aiclient-2-api
```

或使用 Makefile：

```bash
make docker-build
make docker-run
```

## 直接部署

适用于需要更细粒度控制的场景。

### 环境准备

```bash
# 安装 Node.js 20+（推荐使用 nvm）
nvm install 20
nvm use 20

# 安装 pnpm
corepack enable && corepack prepare pnpm@9 --activate
```

### 安装与启动

```bash
pnpm install --frozen-lockfile --prod
cp configs/config.json.example configs/config.json
# 编辑 configs/config.json
pnpm start
```

### 使用进程管理器（PM2）

```bash
npm install -g pm2
pm2 start src/core/master.js --name aiclient-2-api
pm2 startup
pm2 save
```

注意：`master.js` 本身已经管理 worker 进程并提供崩溃重启，PM2 用于管理 master 进程本身。

## 配置文件说明

所有配置文件存放于 `configs/` 目录：

| 文件 | 说明 |
|------|------|
| `config.json` | 主配置文件 |
| `provider_pools.json` | 多账号池配置 |
| `token-store.json` | OAuth 令牌缓存（自动生成） |
| `input_system_prompt.txt` | 全局系统提示词（可选） |
| `pwd` | 管理界面密码（自动生成） |

`configs/` 目录不纳入 Git 版本控制，部署时需手动准备或通过 CI/CD 注入。

## 生产配置建议

### 安全配置

```json
{
  "REQUIRED_API_KEY": "使用随机生成的长字符串",
  "LOGIN_MAX_ATTEMPTS": 5,
  "LOGIN_LOCKOUT_DURATION": 1800,
  "LOGIN_MIN_INTERVAL": 5000,
  "LOGIN_EXPIRY": 3600
}
```

生成安全密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 日志配置

```json
{
  "LOG_ENABLED": true,
  "LOG_OUTPUT_MODE": "file",
  "LOG_LEVEL": "info",
  "LOG_DIR": "logs",
  "LOG_MAX_FILE_SIZE": 10485760,
  "LOG_MAX_FILES": 10
}
```

`LOG_OUTPUT_MODE` 可选值：`all`（控制台+文件）、`file`（仅文件）、`console`（仅控制台）

### 提供商故障转移

```json
{
  "MODEL_PROVIDER": ["gemini-cli-oauth", "gemini-antigravity"],
  "providerFallbackChain": {
    "gemini-cli-oauth": ["gemini-antigravity"],
    "gemini-antigravity": ["gemini-cli-oauth"]
  }
}
```

### 代理配置

```json
{
  "PROXY_URL": "http://127.0.0.1:7890",
  "PROXY_ENABLED_PROVIDERS": ["gemini-cli-oauth", "gemini-antigravity"]
}
```

支持 `http://`、`https://`、`socks5://` 三种格式。

### TLS Sidecar（Grok 等需要绕过 Cloudflare）

```json
{
  "TLS_SIDECAR_ENABLED": true,
  "TLS_SIDECAR_ENABLED_PROVIDERS": ["grok-custom"],
  "TLS_SIDECAR_PORT": 9090
}
```

直接部署时需要先编译 Go 二进制：

```bash
cd tls-sidecar && go build -o tls-sidecar .
```

## 版本升级

**Docker 部署升级：**

```bash
docker pull justlikemaki/aiclient-2-api
docker stop aiclient-2-api && docker rm aiclient-2-api
# 重新运行 docker run 命令
```

**直接部署升级：**

```bash
git pull origin main
pnpm install --frozen-lockfile --prod
pm2 restart aiclient-2-api
```

## 健康检查

```bash
# Docker 内置
node healthcheck.js

# HTTP 端点
curl http://localhost:3000/health
```
