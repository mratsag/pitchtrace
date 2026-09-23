import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from '../services/analyzer/node_modules/playwright/index.mjs';

const baseUrl = process.env.N8N_TEST_URL ?? 'http://127.0.0.1:5678';
const email = process.env.N8N_TEST_EMAIL;
const password = process.env.N8N_TEST_PASSWORD;
const decision = process.env.N8N_TEST_DECISION ?? 'Reddet';
assert.ok(email && password, 'N8N_TEST_EMAIL and N8N_TEST_PASSWORD are required');
assert.ok(['Onayla', 'Reddet'].includes(decision));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
try {
  const login = await context.request.post(`${baseUrl}/rest/login`, {
    data: { emailOrLdapLoginId: email, password },
  });
  assert.ok(login.ok(), `n8n login failed: ${login.status()}`);
  await page.goto(`${baseUrl}/form/pitchtrace-campaign-review`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/oauth\/(?:authorize|consent)|form\/pitchtrace-campaign-review/, { timeout: 15_000 });
  if (page.url().includes('/oauth/')) {
    await page.waitForLoadState('networkidle');
    const allow = page.getByRole('button', { name: /allow|authorize|continue|grant/i });
    assert.ok(await allow.count(), `OAuth consent button missing: ${await page.locator('body').innerText()}`);
    await allow.first().click();
    await page.waitForURL(/form\/pitchtrace-campaign-review/, { timeout: 15_000 });
  }
  await page.getByLabel('campaign_name').fill('n8n Browser Fixture');
  await page.getByLabel('sector').fill('fixture');
  await page.getByLabel('city').fill('Test City');
  await page.getByLabel('csv').setInputFiles(path.resolve('tests/fixtures/n8n-companies.csv'));
  await page.getByRole('button', { name: /CSV'yi doğrula/i }).click();

  await page.getByText(/Import tamamlandı/i).waitFor({ timeout: 20_000 });
  await page.getByLabel('Başlat').check();
  await page.getByRole('button', { name: /Kararı uygula/i }).click();

  await page.getByText(/Kanıta bağlı taslak incelemesi/i).waitFor({ timeout: 90_000 });
  await page.getByText(/otomatik e-posta göndermez/i).waitFor();
  const image = page.getByAltText('Audit screenshot');
  assert.equal(await image.count(), 1, 'review form did not render the screenshot element');
  if (!(await image.evaluate((element) => element.naturalWidth > 0))) {
    console.error(`screenshot element: ${(await image.evaluate((element) => element.outerHTML)).slice(0, 240)}`);
  }
  assert.ok(await image.evaluate((element) => element.naturalWidth > 0), 'controlled screenshot preview did not decode');
  await page.getByLabel(decision).check();

  if (decision === 'Onayla') {
    const download = page.waitForEvent('download', { timeout: 20_000 });
    await page.getByRole('button', { name: /İnceleme kararını kaydet/i }).click();
    const file = await download;
    assert.match(file.suggestedFilename(), /\.eml$/);
  } else {
    await page.getByLabel('rejection_note').fill('Headless rejection-path verification');
    await page.getByRole('button', { name: /İnceleme kararını kaydet/i }).click();
    await page.getByText(/Approval endpoint'i çağrılmadı/i).waitFor({ timeout: 10_000 });
  }
  console.log(JSON.stringify({ form: 'ok', screenshot: 'decoded', decision }));
} finally {
  await browser.close();
}
