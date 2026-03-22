// @ts-check
import { defineConfig, devices } from '@playwright/test';

/**
 * UI E2E: 需已启动 API 服务（默认 http://127.0.0.1:3000），或设置 PLAYWRIGHT_BASE_URL。
 * 安装浏览器：pnpm exec playwright install chromium
 */
export default defineConfig({
    testDir: './tests/e2e/ui',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    use: {
        baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000',
        trace: 'on-first-retry',
    },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
