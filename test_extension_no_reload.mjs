import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const profile = await mkdtemp(path.join(tmpdir(), 'gsxt-no-reload-'));
const extensionPath = path.join(profile, 'extension');
await cp(path.resolve('chrome_extension'), extensionPath, { recursive: true });
const manifestPath = path.join(extensionPath, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions.push('<all_urls>');
await writeFile(manifestPath, JSON.stringify(manifest));
const browser = await chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath: process.env.PW_EXECUTABLE || chromium.executablePath(),
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
});

try {
  let homeRequests = 0;
  await browser.route('https://www.gsxt.gov.cn/index.html', route => {
    homeRequests++;
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><body>正在校验</body>' });
  });
  const page = await browser.newPage();
  await page.goto('https://www.gsxt.gov.cn/index.html');
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.evaluate(() => chrome.storage.local.set({ savedForm: { companies: '测试企业', username: '', password: '' } }));
  await popup.reload();
  await popup.locator('#status').filter({ hasText: '等待 GSXT 环境校验' }).waitFor({ timeout: 10_000 });
  assert.equal(homeRequests, 1, 'opening the extension must not reload a checking page');
  await page.evaluate(() => { document.body.innerHTML = '<input id="keyword"><button id="btn_query">查询</button>'; });
  await popup.locator('#status').filter({ hasText: '查询已提交' }).waitFor({ timeout: 10_000 });
  assert.equal(homeRequests, 1, 'resuming after the page becomes usable must not reload it');
  console.log('GSXT no-reload regression ok');
} finally {
  await browser.close();
  await rm(profile, { recursive: true, force: true });
}
