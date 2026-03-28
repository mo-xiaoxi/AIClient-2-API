# 数据流文档

## 请求处理完整流程

### 整体流程图

```mermaid
flowchart TD
    A[客户端请求] --> B{静态文件\n或 UI 路径?}
    B -->|是| C[serveStaticFiles\n返回前端资源]
    B -->|否| D{插件路由\n匹配?}
    D -->|是| E[插件处理并返回]
    D -->|否| F{UI 管理 API\n匹配?}
    F -->|是| G[handleUIApiRequests]
    F -->|否| H[记录请求日志]
    H --> I{内置端点\n/health /provider_health?}
    I -->|是| J[直接返回 JSON]
    I -->|否| K{解析 Model-Provider\n请求头 / URL 路径段}
    K --> L[执行认证插件\ntype=auth]
    L -->|未授权| M[返回 401]
    L -->|已授权| N[执行普通中间件插件]
    N -->|已处理| O[返回响应]
    N -->|继续| P{count_tokens\n请求?}
    P -->|是| Q[countTokensAnthropic\n返回 token 数]
    P -->|否| R[handleAPIRequests\n端点路由]
    R --> S{端点类型判断}
    S -->|/v1/chat/completions| T1[OPENAI_CHAT]
    S -->|/v1/responses| T2[OPENAI_RESPONSES]
    S -->|/v1beta/models/:model:generateContent| T3[GEMINI_CONTENT]
    S -->|/v1/messages| T4[CLAUDE_MESSAGE]
    S -->|GET /v1/models| T5[OPENAI_MODEL_LIST]
    T1 & T2 & T3 & T4 --> U[handleContentGenerationRequest]
    U --> V[从 ProviderPoolManager\n选取健康账号]
    V --> W[getServiceAdapter\n获取/创建适配器实例]
    W --> X[ConverterFactory.getConverter\n获取请求转换器]
    X --> Y[converter.convertRequest\n转换请求格式]
    Y --> Z{stream?}
    Z -->|否| AA[adapter.generateContent\n一次性请求]
    Z -->|是| AB[adapter.generateContentStream\n流式请求]
    AA --> AC[converter.convertResponse\n转换响应格式]
    AB --> AD[converter.convertStreamChunk\n逐块转换]
    AC --> AE[返回 JSON 响应]
    AD --> AF[SSE 逐块推送\n至客户端]
```

### 关键步骤说明

#### 步骤 1：提供商选择

请求到达时，系统按以下优先级确定使用哪个提供商：

1. URL 路径第一段（如 `/gemini-cli-oauth/v1/chat/completions`）
2. `Model-Provider` 请求头
3. 配置文件中的 `MODEL_PROVIDER` 默认值

只有在 `adapterRegistry` 中已注册的提供商才被接受；使用 `auto` 时由账号池自动选择。

#### 步骤 2：认证

认证由插件系统处理（`type=auth` 的插件）。内置 `default-auth` 插件校验 Bearer Token，支持三种传入方式：

- `Authorization: Bearer <key>` 请求头
- `x-goog-api-key` 请求头
- `?key=<key>` URL 查询参数

#### 步骤 3：协议转换（请求方向）

`ConverterFactory` 根据目标提供商的协议前缀（通过 `getProtocolPrefix(provider)` 获取）取得对应转换器，将入站请求体转换为提供商原生格式。

#### 步骤 4：账号池选取

`ProviderPoolManager` 维护每个提供商的账号健康状态。每次请求时轮询选取健康账号，并将对应的 `uuid` 写入 `currentConfig`，以便 `getServiceAdapter` 定位到正确的适配器单例。

#### 步骤 5：协议转换（响应方向）

适配器返回提供商原生响应后，再由同一转换器将其转换为客户端期望的格式（取决于入站端点类型 `ENDPOINT_TYPE`）。

---

## SSE 流式响应处理

```mermaid
sequenceDiagram
    participant 客户端
    participant RequestHandler
    participant Converter
    participant Adapter
    participant 上游 AI API

    客户端->>RequestHandler: POST /v1/chat/completions\n{"stream": true}
    RequestHandler->>RequestHandler: 设置响应头\nContent-Type: text/event-stream\nCache-Control: no-cache\nConnection: keep-alive
    RequestHandler->>Converter: convertRequest(body, targetProtocol)
    Converter-->>RequestHandler: 转换后的请求体
    RequestHandler->>Adapter: generateContentStream(model, body)
    Adapter->>上游 AI API: 流式 HTTP 请求
    loop 每个 SSE chunk
        上游 AI API-->>Adapter: data: {...}\n\n
        Adapter-->>RequestHandler: yield chunk（原始格式）
        RequestHandler->>Converter: convertStreamChunk(chunk, targetProtocol, model)
        Converter-->>RequestHandler: 转换后的 OpenAI chunk
        RequestHandler-->>客户端: data: {"choices":[{"delta":...}]}\n\n
    end
    上游 AI API-->>Adapter: [DONE]
    Adapter-->>RequestHandler: yield stop chunk
    RequestHandler-->>客户端: data: [DONE]\n\n
```

**关键实现细节：**

- HTTP Server 禁用 `requestTimeout`（设为 0），确保长流式响应不超时
- `keepAliveTimeout` 设为 65 秒，略大于负载均衡器的通常配置
- Worker 进程异步生成器（`async function*`）通过 `yield*` 传递流，零拷贝
- 流中断时（客户端关闭连接）`EPIPE` 等网络错误被 `isRetryableNetworkError` 拦截，不触发进程退出

---

## 协议转换流程

### 转换器注册与查找

```mermaid
flowchart LR
    subgraph 启动时
        R1[register-converters.js] -->|registerConverter| CF[ConverterFactory\n#converterClasses Map]
    end
    subgraph 请求时
        P[provider: gemini-cli-oauth] -->|getProtocolPrefix| PP[gemini]
        PP -->|ConverterFactory.getConverter| CI{缓存命中?}
        CI -->|是| CV[返回缓存实例]
        CI -->|否| NC[new GeminiConverter\n存入 #converters Map]
    end
```

### 支持的转换矩阵

| 入站端点类型 | 目标提供商协议 | 转换器 | 转换方向 |
|-------------|---------------|--------|---------|
| `openai_chat` | `gemini` | GeminiConverter | OpenAI → Gemini 请求；Gemini → OpenAI 响应 |
| `openai_chat` | `claude` | ClaudeConverter | OpenAI → Claude 请求；Claude → OpenAI 响应 |
| `openai_chat` | `openai` | OpenAIConverter | 透传（格式相同） |
| `openai_chat` | `grok` | GrokConverter | OpenAI → Grok 请求；Grok → OpenAI 响应 |
| `openai_chat` | `codex` | CodexConverter | OpenAI → Codex 请求；Codex → OpenAI 响应 |
| `gemini_content` | `gemini` | GeminiConverter | Gemini 原生格式透传 |
| `claude_message` | `claude` | ClaudeConverter | Claude 原生格式透传 |
| `openai_responses` | `openaiResponses` | OpenAIResponsesConverter | Responses API 格式处理 |

---

## 进程间通信（IPC）流程

```mermaid
sequenceDiagram
    participant Master :3100
    participant Worker :3000

    Master->>Worker: fork() + IS_WORKER_PROCESS=true
    Worker-->>Master: IPC: {type: "ready", pid: 1234}
    loop 心跳（每 CRON_NEAR_MINUTES 分钟）
        Worker->>Worker: heartbeatAndRefreshToken()
        Worker->>Worker: 刷新各提供商 OAuth Token
    end
    Note over Master,Worker: 异常场景
    Worker-->>Master: IPC: {type: "restart_request"}
    Master->>Worker: SIGTERM + {type: "shutdown"}
    Worker->>Worker: gracefulShutdown()\n关闭 HTTP Server
    Worker-->>Master: exit(0)
    Master->>Worker: setTimeout → fork() 重新拉起
```

---

## OAuth Token 刷新流程

```mermaid
flowchart TD
    T[定时器\n每 N 分钟触发] --> H[heartbeatAndRefreshToken]
    H --> L[遍历所有 serviceInstances]
    L --> C{配置了 uuid\n且有 PoolManager?}
    C -->|是| E[poolManager._enqueueRefresh\n委托给池管理器处理]
    C -->|否| R[serviceAdapter.refreshToken]
    R --> NE{isExpiryDateNear?}
    NE -->|是| F[initializeAuth\n向提供商刷新 token]
    NE -->|否| Skip[跳过，token 仍有效]
    F --> Store[更新 configs/token-store.json]
```
