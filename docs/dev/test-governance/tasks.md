# 任务书: 测试系统性治理

> **功能标识**: test-governance
> **分支**: test-governance（worktree 已创建）
> **目标**: 整体覆盖率从 ~45% 提升到 70%，修复所有测试 bug，配置 CI 卡控

---

## 前置说明

### 工作环境
```bash
# 所有任务在此 worktree 执行
cd /Users/moxiaoxi/Desktop/AIClient-2-API/.claude/worktrees/test-governance

# 运行测试（必须带 NODE_OPTIONS）
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit --forceExit
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit --coverage --forceExit
```

### Mock 规范（所有测试必须遵守）
- 使用 `jest.unstable_mockModule()` 而不是 `jest.mock()`
- 所有 mock 在 `beforeAll(async () => {...})` 中设置
- 被测模块通过 `const mod = await import(...)` 动态导入
- 参考 `tests/unit/auth/codex-oauth.test.js` 的模式

### 当前状态（2026-03-24）
- **Phase 1（T01–T03）已完成**：`api-server.test.js`、`api-potluck-routes.test.js` 已修复；`pnpm test`（tests/unit）**1725 通过 / 0 失败**
- 整体覆盖率仍低于 70%，后续按 T04+ 继续补测；**T11 覆盖率阈值**须在达标后再开

---

## Phase 1: 修复现有失败测试

### T01 修复 api-server.test.js（优先级：P0）

**文件**: `tests/unit/services/api-server.test.js`

**问题**: 5 个测试超时（120s），原因是 HTTP 服务器或 TLS sidecar 未被正确 mock。

**任务**:
1. 读取 `src/services/api-server.js` 了解完整启动流程
2. 确保以下模块被正确 mock：
   - `http.createServer` → mock server（listen 回调立即触发）
   - `src/utils/tls-sidecar.js` → `{ start: jest.fn(), stop: jest.fn().mockResolvedValue() }`
   - `setInterval` / `clearInterval` → `jest.useFakeTimers()`
3. 修复失败的 5 个用例
4. 验证：`NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/services/api-server.test.js --forceExit` 全部通过

**关键 mock**:
```js
// tls-sidecar 必须 mock（被 babel transformIgnorePatterns 排除）
await jest.unstable_mockModule('../../../src/utils/tls-sidecar.js', () => ({
    __esModule: true,
    default: {
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn().mockResolvedValue(undefined),
    },
}));
```

---

### T02 修复 api-potluck-routes.test.js（优先级：P0）

**文件**: `tests/unit/plugins/api-potluck-routes.test.js`

**问题**: 10 个测试超时（303s）。

**任务**:
1. 读取当前测试文件，找到超时的根因
2. 检查路由处理函数调用后 `res.end()` 是否被正确触发
3. 如果使用了流对象，确保 mock 流的 `pipe`、`destroy`、`end` 方法
4. 将超时时间配置缩短（在用例或 describe 块中设置 `jest.setTimeout(5000)`）
5. 修复所有 10 个失败用例

**验证**: `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/plugins/api-potluck-routes.test.js --forceExit` 全部通过

---

### T03 验证已修复的测试（优先级：P0）

验证以下已修复的测试全部通过：
- `tests/unit/utils/provider-strategy.test.js`
- `tests/unit/auth/auth-index.test.js`
- `tests/unit/services/ui-manager.test.js`

运行：`NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/utils/provider-strategy.test.js tests/unit/auth/auth-index.test.js tests/unit/services/ui-manager.test.js --forceExit`

---

## Phase 2: 提升覆盖率到 70%

### T04 提升 providers/gemini 覆盖率（优先级：P1）

**目标**: 从 ~40% 提升到 70%

**文件**: `tests/unit/providers/gemini-core.test.js`

**任务**:
1. 读取 `src/providers/gemini/gemini-core.js` 查看未覆盖区域（行 54-87、96-102、126-127、131、137、175-242、272-273、298-315、326-518、571-609、632-695、710-780、809-938）
2. 参考 `tests/unit/providers/openai-core.test.js` 或 `forward-core.test.js` 的测试模式
3. 重点覆盖：
   - `callApi` / `streamApi` 方法（请求构建、响应处理、错误处理）
   - 流式 SSE 解析（`parseChunk` 或类似方法）
   - token 过期检查/刷新逻辑
4. 同时检查 `antigravity-core.js` 是否存在，若存在需创建其测试文件

**验证**: 运行 `--coverage` 确认 `providers/gemini` ≥ 60%

---

### T05 提升 providers/grok 覆盖率（优先级：P1）

**目标**: 从 ~40% 提升到 70%

**文件**: `tests/unit/providers/grok-core.test.js`

**任务**:
1. 读取 `src/providers/grok/grok-core.js`，查看未覆盖区域（行 64-110、117-218、262-676）
2. 注意 grok-core 可能使用 `tls-sidecar.js`（Go 二进制），需要 mock
3. 覆盖：
   - `buildRequest` 请求构建
   - 流式响应处理（SSE chunk 解析）
   - 401/429/5xx 错误处理
   - cookie/token 管理

**验证**: 运行 `--coverage` 确认 `providers/grok` ≥ 60%

---

### T06 提升 providers/openai 覆盖率（优先级：P1）

**目标**: 从 ~45% 提升到 70%

**文件**:
- `tests/unit/providers/codex-core.test.js`
- `tests/unit/providers/openai-core.test.js`（补充）

**任务**:
1. 读取 `src/providers/openai/` 目录，确认哪些文件（iflow-core.js、qwen-core.js 等）存在且无测试
2. 为每个无测试的 core 文件创建对应测试
3. `codex-core.js` 重点覆盖：token 刷新（408-419 行）、流式响应（487-586 行）
4. 检查 `src/providers/openai/` 中是否有 `iflow-core.js`、`qwen-core.js`、`openai-responses-core.js`，若存在需创建测试

**验证**: 运行 `--coverage` 确认 `providers/openai` ≥ 60%

---

### T07 提升 converters/strategies 覆盖率（优先级：P1）

**目标**: 从 ~50% 提升到 65%

**参考**: 已有 `openai-converter-extended.test.js`，按此模式继续补充

**任务**:

**ClaudeConverter.js** (当前 31%)：
- 覆盖 857-992 行（工具调用响应处理）
- 覆盖 1025-1074 行（thinking 模式处理）
- 文件：补充到 `tests/unit/converters/claude-converter-deep.test.js`

**GeminiConverter.js** (当前 37%)：
- 覆盖 688-853 行（multimodal 内容、流式解析）
- 覆盖 1085-1525 行（大段未覆盖逻辑）
- 文件：补充到 `tests/unit/converters/gemini-converter-deep.test.js`

**GrokConverter.js** (当前 38%)：
- 覆盖 369-440 行（响应转换）
- 覆盖 811-1142 行（流式块处理）
- 文件：`tests/unit/converters/grok-converter.test.js`

**CodexConverter.js** (当前 27%)：
- 覆盖 630-1324 行（大段未覆盖）
- 文件：`tests/unit/converters/codex-converter.test.js`（补充）

**验证**: 运行 `--coverage` 确认 `converters/strategies` ≥ 55%

---

### T08 提升 services 覆盖率（优先级：P1）

**目标**: 从 ~35% 提升到 55%

**任务**:
1. **api-server.js**（依赖 T01 完成）：在 T01 修复的基础上补充更多正常路径测试
2. **service-manager.js**：读取 `src/services/service-manager.js`，覆盖服务注册和 `autoLinkProviderConfigs`
3. **ui-manager.js**（依赖 T03）：覆盖 UI 路由注册、静态文件服务路径
4. **api-manager.js**：覆盖 API 请求路由和提供商选择逻辑

**验证**: 运行 `--coverage` 确认 `services` ≥ 50%

---

### T09 提升 ui-modules 覆盖率（优先级：P1）

**目标**: 从 ~35% 提升到 55%

**重点文件**:
- `provider-api.js`（13%）：行 175-1098 完全未覆盖，重点补充提供商 CRUD 端点
- `event-broadcast.js`（33%）：SSE 客户端注册/广播逻辑（行 114-274）
- `system-monitor.js`：新建测试文件
- `oauth-api.js`：新建测试文件

**任务**:
1. 读取各源文件，了解 HTTP 请求处理模式
2. UI modules 通常接收 `(req, res)` 并处理请求，mock 模式：
```js
const mockRes = {
    writeHead: jest.fn(),
    end: jest.fn(),
    setHeader: jest.fn(),
    write: jest.fn(),
};
const mockReq = {
    method: 'GET',
    url: '/api/test',
    headers: {},
    on: jest.fn(),
};
```
3. 为每个端点处理函数补充正常路径和错误路径测试

**验证**: 运行 `--coverage` 确认 `ui-modules` ≥ 50%

---

### T10 提升 auth 覆盖率（优先级：P2）

**目标**: 从 ~50% 提升到 65%

**重点文件**:
- `codex-oauth.js`（35%）：行 155-261、276-339、350-464 等未覆盖段
- `kiro-oauth.js`（31%）：行 282-518 等大段未覆盖
- `gemini-oauth.js`（58%）：行 195-318 等

**任务**: 在现有测试文件基础上补充更多测试用例，重点覆盖 OAuth 回调处理流程

**验证**: 运行 `--coverage` 确认 `auth` ≥ 60%

---

## Phase 3: CI 配置

### T11 配置 Jest 覆盖率阈值（优先级：P0，Phase 2 完成后执行）

**文件**: `jest.config.js`

**任务**:
1. 在 `jest.config.js` 的 export default 对象中添加：

```js
coverageThreshold: {
    global: {
        statements: 70,
        branches: 55,
        functions: 60,
        lines: 70,
    },
},
```

2. 运行 `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit --coverage --forceExit` 验证通过

**注意**: 只有在整体覆盖率确实达到 70% 后才能配置此项，否则会导致所有 CI 失败。

---

### T12 更新 CI workflow（优先级：P0，T11 完成后执行）

**文件**: `.github/workflows/test.yml`

**任务**:
1. 确认 Unit Tests job 使用 `pnpm run test:coverage` 而不是 `pnpm test`（这样才会检查 threshold）
2. 如果当前使用 `pnpm test`，修改为 `pnpm run test:coverage`
3. 提交并验证 CI 通过

---

## Phase 4: 集成测试与 E2E 补充

### T13 扩展集成测试 mock stack（优先级：P1）

**目标**: 每个提供商都有完整链路集成测试

**当前状态**: 集成测试仅支持 forward-api + mock OpenAI

**任务**:
1. 读取 `tests/helpers/stub-openai-upstream.js` 了解 mock 服务器实现
2. 创建 `tests/helpers/stub-gemini-upstream.js`（返回 Gemini 格式响应）
3. 创建 `tests/helpers/stub-claude-upstream.js`（返回 Claude 格式响应）
4. 创建 `tests/helpers/stub-grok-upstream.js`（返回 Grok 格式响应）
5. 创建集成测试：
   - `tests/integration/gemini-provider.test.js`（gemini 转换 + 流式）
   - `tests/integration/claude-provider.test.js`（claude 转换 + 流式）
   - `tests/integration/grok-provider.test.js`（grok 转换 + 流式）
   - `tests/integration/openai-provider.test.js`（openai 转换 + 流式）

**验证**: `pnpm run test:integration` 全部通过

---

### T14 补充 E2E 测试场景（优先级：P2）

**目标**: 覆盖关键业务场景

**任务**:
1. 读取现有 `tests/e2e/api/` 测试文件了解模式
2. 补充以下场景：
   - 多提供商模型列表（`/v1/models` 包含所有配置的提供商模型）
   - 账户池故障转移（模拟第一个账户返回 429，验证自动切换）
3. 文件：`tests/e2e/api/provider-failover.test.js`

**验证**: `pnpm run test:e2e` 全部通过

---

## 完成标准（全部任务的最终验收）

```bash
# 1. 单元测试全部通过（含覆盖率阈值）
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit --coverage --forceExit
# 期望：0 失败，语句覆盖率 ≥ 70%

# 2. 集成测试全部通过
pnpm run test:integration
# 期望：0 失败

# 3. E2E 测试全部通过
pnpm run test:e2e
# 期望：0 失败
```

---

## 任务执行顺序建议

```
T01 + T02 + T03 (并行)   → 修复所有失败测试
        ↓
T04 + T05 + T06 + T07 (并行)  → providers + converters 覆盖率提升
T08 + T09 + T10 (并行)         → services + ui-modules + auth 覆盖率提升
        ↓
T11 → 配置覆盖率阈值（验证通过后）
T12 → 更新 CI
        ↓
T13 + T14 (并行)  → 集成测试 + E2E 补充
```

---

## 关键文件位置

```
worktree: .claude/worktrees/test-governance/
设计文档: docs/dev/test-governance/design.md
需求文档: docs/dev/test-governance/test-governance-requirements.md
任务书:   docs/dev/test-governance/tasks.md  ← 本文件

源代码:   src/
现有测试: tests/unit/ (79 个文件), tests/integration/ (4 个), tests/e2e/api/ (5 个)
Jest 配置: jest.config.js
CI 配置:  .github/workflows/test.yml
```
