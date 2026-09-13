import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 900 } });

test('serves an accessible production bootstrap from the API origin', async ({
  page,
  request,
}, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const response = await page.goto('/');
  expect(response?.ok()).toBe(true);
  await expect(page.getByRole('main')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'PromiseGuard', level: 1 }),
  ).toBeVisible();
  await expect(page.getByText('Application scaffold')).toBeVisible();
  await expect(page.getByText('No workflows have been run.')).toBeVisible();

  const healthLink = page.getByRole('link', { name: 'View server health' });
  await expect(healthLink).toHaveAttribute('href', '/api/health');
  await page.keyboard.press('Tab');
  await expect(healthLink).toBeFocused();

  const health = await request.get('/api/health');
  expect(health.ok()).toBe(true);
  expect(await health.json()).toEqual({
    status: 'ok',
    scope: 'bootstrap',
    modelMode: 'mock',
    adapterMode: 'fake',
    fixtureId: 'bootstrap-synthetic-v1',
  });

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);

  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
  expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.height);
  expect(pageErrors).toEqual([]);

  const screenshotPath = testInfo.outputPath('bootstrap.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach('Bootstrap scaffold — synthetic configuration', {
    path: screenshotPath,
    contentType: 'image/png',
  });
});
