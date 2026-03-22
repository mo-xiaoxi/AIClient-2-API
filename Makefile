.PHONY: help install test test-unit test-integration test-e2e test-all test-watch test-coverage test-verbose test-live ci start start-dev start-standalone docker-build docker-run clean

# --------------------------------------------------------------------------
# 默认目标
# --------------------------------------------------------------------------
help: ## 显示帮助信息
	@echo ""
	@echo "  make <target>"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'
	@echo ""

# --------------------------------------------------------------------------
# 安装
# --------------------------------------------------------------------------
install: ## 安装依赖
	pnpm install --frozen-lockfile

# --------------------------------------------------------------------------
# 运行
# --------------------------------------------------------------------------
start: ## 启动服务（Master 模式）
	pnpm start

start-dev: ## 开发模式启动
	pnpm run start:dev

start-standalone: ## 单进程模式启动
	pnpm run start:standalone

# --------------------------------------------------------------------------
# 测试 — 单项
# --------------------------------------------------------------------------
test: test-unit ## 默认运行单元测试

test-unit: ## 单元测试
	pnpm test

test-integration: ## 集成测试（mock upstream）
	pnpm run test:integration

test-e2e: ## E2E API 测试
	pnpm run test:e2e

test-live: ## Live 集成测试（需要运行中的服务 + 真实 provider）
	pnpm run test:integration:live

test-watch: ## 单元测试（watch 模式）
	pnpm run test:watch

test-verbose: ## 单元测试（详细输出）
	pnpm run test:verbose

test-coverage: ## 单元测试 + 覆盖率报告
	pnpm run test:coverage

# --------------------------------------------------------------------------
# 测试 — 组合
# --------------------------------------------------------------------------
test-all: ## 运行全部测试（unit + integration + e2e）
	@echo "========== Unit Tests =========="
	pnpm test
	@echo ""
	@echo "========== Integration Tests =========="
	pnpm run test:integration
	@echo ""
	@echo "========== E2E API Tests =========="
	pnpm run test:e2e
	@echo ""
	@echo "========== All tests passed =========="

# --------------------------------------------------------------------------
# 本地 CI — 模拟 GitHub Actions 流水线
# --------------------------------------------------------------------------
ci: install ## 本地模拟完整 CI 流水线（install → unit → integration → e2e）
	@echo ""
	@echo "╔══════════════════════════════════════╗"
	@echo "║         Local CI Pipeline            ║"
	@echo "╚══════════════════════════════════════╝"
	@echo ""
	@echo "[1/3] Unit Tests..."
	@pnpm test && echo "  ✓ Unit tests passed" || (echo "  ✗ Unit tests FAILED" && exit 1)
	@echo ""
	@echo "[2/3] Integration Tests..."
	@pnpm run test:integration && echo "  ✓ Integration tests passed" || (echo "  ✗ Integration tests FAILED" && exit 1)
	@echo ""
	@echo "[3/3] E2E API Tests..."
	@pnpm run test:e2e && echo "  ✓ E2E tests passed" || (echo "  ✗ E2E tests FAILED" && exit 1)
	@echo ""
	@echo "╔══════════════════════════════════════╗"
	@echo "║      ✓ Local CI — All Passed         ║"
	@echo "╚══════════════════════════════════════╝"

# --------------------------------------------------------------------------
# Docker
# --------------------------------------------------------------------------
docker-build: ## 构建 Docker 镜像
	docker build -t aiclient-2-api .

docker-run: ## 运行 Docker 容器（端口 3000，挂载 configs/）
	docker run -d -p 3000:3000 -v "$$(pwd)/configs:/app/configs" --name aiclient-2-api aiclient-2-api

# --------------------------------------------------------------------------
# 清理
# --------------------------------------------------------------------------
clean: ## 清理构建产物和缓存
	rm -rf coverage node_modules/.cache
