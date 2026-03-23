# Changelog

All notable changes to this project will be documented in this file.

## [v1.0.0] - 2026-03-24

### Features
- feat(cursor): 集成 Cursor Provider，支持 PKCE OAuth + HTTP/2 Protobuf 协议代理
- feat(cursor): 动态模型获取、模型缓存 TTL 及调试日志清理
- feat(providers): 集成 Claude Kiro OAuth 提供商，增强 Grok API 重试机制
- feat: 优化 OAuth 授权流程并更新 UI 样式
- feat: 支持 modelFallbackMapping 将标准 Anthropic 模型名路由到 Cursor 内部模型

### Bug Fixes
- fix(cursor): 修复 5 个 Bug 并重构消除重复代码
- fix(cursor): 解析 end-stream 错误帧，避免无效模型返回空内容
- fix(gemini): 修复认证初始化顺序和令牌刷新逻辑
- fix: 修复 PR 审查发现的全部问题

### Tests
- test: 测试治理 Phase 1 完成，1725 个测试全部通过（0 失败）
- test: 补全 Cursor Provider 单元测试（5 个模块 109 个用例）
- test: 大规模补充单元测试，覆盖核心管道/Converter/Provider/Auth/Plugin
- test: 增强集成测试和 E2E 测试，优化 CI 配置

### CI/Build
- ci: 重构 CI 流水线，拆分并行 job + 多版本矩阵
- build: 添加 Makefile，支持本地测试和本地 CI 流水线
- refactor(test): 整理测试文件结构，与源码目录 1:1 对应

### Docs
- docs: 整理主 README 与 CLAUDE，移除多语言 README 与 VERSION
- docs: 添加测试治理设计文档和任务书
