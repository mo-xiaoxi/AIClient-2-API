# 快速开始

本指南帮助你在 5 分钟内完成 AIClient-2-API 的首次部署和运行。

## 前置要求

| 工具 | 最低版本 | 用途 |
|------|----------|------|
| Node.js | 20.0.0 | 运行时 |
| pnpm | 9.x | 包管理 |
| Git | 任意 | 拉取代码 |

验证环境：

```bash
node --version   # v20.x.x 或更高
pnpm --version   # 9.x.x
```

如果尚未安装 pnpm：

```bash
corepack enable
corepack prepare pnpm@9 --activate
```

## 安装步骤

**第一步：克隆仓库**

```bash
git clone <repository-url>
cd AIClient-2-API
```

**第二步：安装依赖**

```bash
pnpm install --frozen-lockfile
```

**第三步：创建配置文件**

```bash
cp configs/config.json.example configs/config.json
```

**第四步：编辑基础配置**

打开 `configs/config.json`，修改以下必填项：

```json
{
  "REQUIRED_API_KEY": "your-secret-key",
  "SERVER_PORT": 3000,
  "MODEL_PROVIDER": "gemini-cli-oauth"
}
```

`REQUIRED_API_KEY` 是客户端调用本服务时需要携带的鉴权密钥，请设置为安全的随机字符串。

**第五步：启动服务**

```bash
pnpm start
```

服务启动后输出类似：

```
[Info] Server listening on 0.0.0.0:3000
[Info] Model provider: gemini-cli-oauth
```

## 验证是否正常运行

发送一个测试请求：

```bash
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer your-secret-key"
```

如果返回模型列表，说明服务正常运行。

发送一个聊天请求：

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.0-flash",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": false
  }'
```

## 基础配置说明

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `REQUIRED_API_KEY` | `123456` | 客户端鉴权密钥，**生产环境务必修改** |
| `SERVER_PORT` | `3000` | 服务监听端口 |
| `HOST` | `0.0.0.0` | 监听地址，`0.0.0.0` 表示所有网卡 |
| `MODEL_PROVIDER` | `gemini-cli-oauth` | 默认使用的 AI 提供商 |
| `SYSTEM_PROMPT_MODE` | `append` | 系统提示词模式：`append`（追加）或 `overwrite`（覆盖） |
| `REQUEST_MAX_RETRIES` | `3` | 请求失败后最大重试次数 |
| `LOG_LEVEL` | `info` | 日志级别：`debug`、`info`、`warn`、`error` |

## 支持的提供商

在 `MODEL_PROVIDER` 中可以填写以下值：

| 值 | 说明 |
|----|------|
| `gemini-cli-oauth` | Gemini CLI OAuth（默认） |
| `gemini-antigravity` | Gemini Antigravity |
| `claude-custom` | Claude 自定义 API |
| `claude-kiro-oauth` | Claude Kiro OAuth |
| `openai-custom` | OpenAI 兼容 API |
| `openai-qwen-oauth` | Qwen OAuth |
| `openai-codex-oauth` | Codex OAuth |
| `grok-custom` | Grok |
| `forward-api` | 透传转发 |

多个提供商可以用数组指定，系统将使用第一个为默认，其余作为备选：

```json
{
  "MODEL_PROVIDER": ["gemini-cli-oauth", "gemini-antigravity"]
}
```

## 管理界面

服务启动后，访问 `http://localhost:3000` 可以打开 Web 管理界面。

默认管理密码：`admin123`（首次使用后请立即修改，密码存储于 `configs/pwd`）

## 下一步

- 了解完整配置选项：阅读 [部署指南](deployment.md)
- 了解开发调试方法：阅读 [开发指南](development.md)
- 了解如何新增提供商：阅读 [Provider 适配器指南](../PROVIDER_ADAPTER_GUIDE.md)
