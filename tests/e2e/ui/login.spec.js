// @ts-check
import { test, expect } from '@playwright/test';

test.describe('管理端登录页', () => {
    test('登录页可访问并包含密码输入框', async ({ page }) => {
        await page.goto('/login.html');
        await expect(page.locator('#password')).toBeVisible();
        await expect(page.locator('#loginButton')).toBeVisible();
    });
});
