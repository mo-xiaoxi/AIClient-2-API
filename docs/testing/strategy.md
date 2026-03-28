# 测试策略

本文档描述 AIClient-2-API 的测试体系架构、各层测试的职责划分、编写规范和 CI 集成方式。

## 测试金字塔

```
           ┌──────────┐
           │  UI 测试  │  Playwright（人工/按需）
          ┌┴──────────┴┐
          │  E2E 测试   │  HTTP 端到端（CI 自动）
         ┌┴────────────┴┐
         │   集成测试    │  Mock 上游（CI 自动）
        ┌┴──────────────┴┐
        │    单元测试     │  纯逻辑（CI 自动 + 覆盖率）
        └────────────────┘
```

## 测试层级详解

### 单元测试（`tests/unit/`）

- **职责**：验证单个模块、函数、类的逻辑正确性
- **特点**：完全隔离，不访问网络，不依赖外部服务
- **运行命令**：`pnpm test` 或 `make test-unit`
- **CI 触发**：推送到 `main` / `dev` 分支，多 Node 版本矩阵（20、22）

目录结构映射 `src/` 下的模块：

```
tests/unit/
├── auth/           # OAuth 相关模块测试
├── converters/     # 协议转换器测试
├── core/           # 配置管理、插件管理测试
├── handlers/       # 请求处理器测试
├── plugins/        # 插件测试
├── providers/      # 各提供商适配器测试
├── services/       # 服务层测试
├── ui-modules/     # 管理端 API 测试
└── utils/          # 工具函数测试
```

### 集成测试（`tests/integration/`）

- **职责**：验证多个模块协作的完整请求链路，使用 Mock 上游服务
- **特点**：启动本地 stub 服务器模拟上游 API，不依赖真实 AI 服务
- **运行命令**：`pnpm run test:integration` 或 `make test-integration`
- **串行执行**：使用 `--runInBand` 避免端口冲突

### E2E 测试（`tests/e2e/api/`）

- **职责**：从 HTTP 客户端角度验证 API 行为，覆盖关键业务场景
- **特点**：启动完整服务（含 Mock 上游），通过真实 HTTP 请求验证
- **运行命令**：`pnpm run test:e2e` 或 `make test-e2e`
- **串行执行**：使用 `--runInBand`

### Live 测试（`tests/live/`）

- **职责**：对接真实 AI 服务的端到端验证
- **特点**：需要有效的 API 凭证和正在运行的服务，不纳入 CI
- **运行命令**：`pnpm run test:integration:live`
- **使用场景**：发布前人工验证、新提供商接入验证

### UI 测试（Playwright）

- **职责**：验证 Web 管理界面的交互功能
- **首次安装**：`pnpm run test:ui:install`（安装 Chromium）
- **运行命令**：`pnpm run test:ui`

## Mock 策略

### 单元测试 Mock

ESM 模块环境下，必须使用 `jest.unstable_mockModule()`：

```javascript
const mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
await jest.unstable_mockModule('../../src/utils/logger.js', () => ({
  default: mockLogger
}));

// 动态导入被测模块（必须在 mock 之后）
const { myFunction } = await import('../../src/module.js');
```

### 集成测试 Mock 上游

集成测试使用 `tests/helpers/` 下的 stub 服务器：

| 文件 | 说明 |
|------|------|
| `stub-openai-upstream.js` | 模拟 OpenAI API 响应 |
| `stub-claude-upstream.js` | 模拟 Claude API 响应 |
| `stub-gemini-upstream.js` | 模拟 Gemini API 响应 |
| `stub-grok-upstream.js` | 模拟 Grok API 响应 |
| `start-mock-upstream-stack.js` | 启动标准 Mock 栈 |

### 特殊模块

- `src/utils/tls-sidecar.js`：Go binary 接口，测试中需要 Mock，Jest 配置中已排除在 transform 之外
- `src/core/master.js`：进程管理，排除在覆盖率统计之外
- `src/providers/cursor/proto/`：Protobuf 生成代码，排除在覆盖率统计之外

## 测试编写规范

### 文件命名

`<被测模块名>.test.js`，放在 `tests/unit/` 下对应目录。

例如 `src/converters/strategies/claude-converter.js` 对应 `tests/unit/converters/claude-converter.test.js`。

### 结构规范

```javascript
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

describe('模块名 / 功能描述', () => {
  beforeEach(() => { /* 初始化 */ });
  afterEach(() => { /* 清理，恢复 Mock */ });

  describe('具体方法或场景', () => {
    it('应该在正常输入下返回预期结果', () => {
      // Arrange → Act → Assert
    });
  });
});
```

### 基本原则

- 每个测试只验证一个行为
- 测试名称用中文描述预期行为
- 不依赖外部网络和真实 API 密钥
- 测试超时默认 30 秒（Jest 全局配置）
- `afterEach` 中必须清理 Mock，避免测试间干扰

## CI 集成

### 流水线结构

```
Job 1: unit（Node 20）   ─┐
Job 2: unit（Node 22）   ─┤─ 并行
Job 3: integration-e2e  ─┘
                          ↓
Job 4: ci-gate（汇总，全部通过才算成功）
```

### 本地模拟 CI

```bash
make ci
```

等价于：`install → unit → integration → e2e`，全部通过后输出汇总结果。

## 运行特定测试

```bash
# 运行单个测试文件
pnpm test tests/unit/converters/claude-converter.test.js

# 运行某个目录下所有测试
pnpm test tests/unit/providers/

# 按测试名称过滤
pnpm test --testNamePattern="应该正确转换"

# Watch 模式
pnpm run test:watch

# 详细输出
pnpm run test:verbose
```
