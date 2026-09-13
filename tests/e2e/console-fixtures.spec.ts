import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { DEMO_FIXTURES } from '../../src/web/fixtures/demo.js';

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
];
const REVIEW_SCENARIOS = ['awaiting_approval', 'failed_partial', 'completed_pending_assessment'];
const WAITING = DEMO_FIXTURES.find(fixture => fixture.id === 'awaiting_approval')!;

for (const viewport of VIEWPORTS) {
  test(`synthetic review remains readable at ${viewport.width}×${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto('/');

    for (const scenario of REVIEW_SCENARIOS) {
      await page.getByRole('combobox', { name: 'Preview scenario' }).selectOption(scenario);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(WAITING.run!.incident.title);
      await expect(page.getByText('◇ Synthetic preview', { exact: true })).toBeVisible();
      const plan = page.getByRole('region', { name: 'Exact plan and approval' });
      await expect(plan.getByText(WAITING.run!.plan!.entries[0].recipient, { exact: true })).toBeVisible();
      await expect(plan.getByText(WAITING.run!.plan!.entries[0].subject, { exact: true })).toBeVisible();
      expect(await plan.locator('.draft-body').textContent()).toBe(WAITING.run!.plan!.entries[0].body);
      await expect(page.getByRole('button', { name: /^(approve|reject|send|reconcile)\b/i })).toHaveCount(0);

      if (scenario === 'failed_partial') {
        await expect(page.getByText('Unknown mutation outcome', { exact: true })).toBeVisible();
        await expect(page.locator('[data-effect-key]')).toHaveCount(5);
      }
      if (scenario === 'completed_pending_assessment') {
        const status = page.getByRole('region', { name: 'Run and assessment status' });
        await expect(status.getByText('✓ Completed', { exact: true })).toBeVisible();
        await expect(status.getByText('◷ Pending', { exact: true })).toHaveCount(2);
      }
      const layout = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        page: document.documentElement.scrollWidth,
        drafts: Array.from(document.querySelectorAll('.draft-body')).map(element => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
        }),
      }));
      expect(layout.page).toBeLessThanOrEqual(layout.viewport);
      for (const draft of layout.drafts) {
        expect(draft.left).toBeGreaterThanOrEqual(0);
        expect(draft.right).toBeLessThanOrEqual(layout.viewport);
        expect(draft.scrollWidth).toBeLessThanOrEqual(draft.clientWidth);
      }

      if (viewport.width === 1440 && scenario === 'awaiting_approval') {
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      }
      const path = testInfo.outputPath(`synthetic-${scenario}-${viewport.width}x${viewport.height}.png`);
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach(`Synthetic ${scenario} · ${viewport.width}×${viewport.height} · no provider activity`, {
        path, contentType: 'image/png',
      });
      if (viewport.width === 1440 && scenario === 'awaiting_approval') {
        const overviewPath = testInfo.outputPath('synthetic-desktop-overview.png');
        await page.screenshot({ path: overviewPath });
        await testInfo.attach('Synthetic operator console overview', { path: overviewPath, contentType: 'image/png' });
      }
    }
    expect(pageErrors).toEqual([]);
  });
}

test('keyboard validation, local reopen, and disclosures preserve focus without issuing commands', async ({ page }) => {
  const commands: string[] = [];
  page.on('request', request => {
    if (request.method() !== 'GET' || /\/api\/runs(?:\/|$)/.test(request.url())) commands.push(request.url());
  });
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to incident' })).toBeFocused();

  const input = page.getByRole('textbox', { name: 'GitHub incident URL' });
  await input.fill('https://example.invalid/incident');
  await input.press('Enter');
  await expect(page.getByRole('alert')).toBeFocused();
  await expect(page.getByRole('alert')).toContainText('allowlisted synthetic GitHub issue URL');
  await expect(input).toHaveAttribute('aria-invalid', 'true');

  await input.fill(WAITING.run!.incident.url);
  await input.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await expect(page.getByRole('alert')).toHaveCount(0);

  const summary = page.getByText('Plan identity and effect keys', { exact: true });
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Plan hash (SHA-256)', { exact: true })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(summary).toBeFocused();
  await expect(page.getByText('Plan hash (SHA-256)', { exact: true })).not.toBeVisible();

  await page.getByRole('combobox', { name: 'Preview scenario' }).selectOption('completed_contradicted');
  const draft = page.locator('[data-effect-key="synthetic-acme-draft"]');
  await draft.locator('summary').click();
  await expect(draft.getByText('maya@acme.example', { exact: true })).toBeVisible();
  await expect(draft.getByText('unintended@beta.example', { exact: true })).toBeVisible();
  await expect(draft.getByText('Recipient · Mismatched', { exact: true })).toBeVisible();
  expect(commands).toEqual([]);
});
