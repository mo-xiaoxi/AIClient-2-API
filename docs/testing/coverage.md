# 覆盖率说明

## 覆盖率目标

### 当前基线（CI 强制卡控）

| 指标 | 当前基线 |
|------|----------|
| 语句覆盖率（Statements） | 43% |
| 分支覆盖率（Branches） | 37% |
| 函数覆盖率（Functions） | 52% |
| 行覆盖率（Lines） | 44% |

### 产品目标

| 指标 | 产品目标 |
|------|----------|
| 语句覆盖率（Statements） | 70% |
| 分支覆盖率（Branches） | 55% |
| 函数覆盖率（Functions） | 60% |
| 行覆盖率（Lines） | 70% |

**原则**：每次 PR 不得降低覆盖率。基线会随着测试完善逐步提高。

## 查看覆盖率报告

### 命令行

```bash
pnpm run test:coverage
```

### HTML 报告

```bash
pnpm run test:coverage
open coverage/index.html    # macOS
xdg-open coverage/index.html  # Linux
```

### CI 报告

GitHub Actions 中 Node 22 的覆盖率报告自动上传为 Artifact，保留 7 天。

### IDE 集成

`coverage/lcov.info` 是标准 LCOV 格式，VS Code 安装 `Coverage Gutters` 插件即可自动高亮未覆盖行。

## 覆盖率统计范围

在 `jest.config.js` 的 `collectCoverageFrom` 中定义，以下文件已排除：

- `src/core/master.js` — 进程管理，难以单元测试
- `src/utils/tls-sidecar.js` — Go binary 接口
- `src/scripts/**` — 工具脚本
- `src/providers/cursor/proto/**` — Protobuf 生成代码

## 如何提升覆盖率

1. 运行 `pnpm run test:coverage`，打开 HTML 报告按覆盖率升序排序
2. 从最低覆盖率文件开始补充测试
3. 优先覆盖：happy path → 错误路径 → 边界条件
4. ESM 环境下 Mock 必须用 `jest.unstable_mockModule()`，动态导入被测模块

### 不应强行追求 100% 的情况

- 仅在特定 OS 或 Node 版本触发的代码路径
- 依赖真实 OAuth 流程的认证回调（归属 Live 测试）
- 纯粹的胶水代码（注册表、简单委托）
