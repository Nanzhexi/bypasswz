import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const profile = await mkdtemp(path.join(tmpdir(), 'gsxt-extension-'));
const extensionPath = path.join(profile, 'extension');
await cp(path.resolve('chrome_extension'), extensionPath, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extensionPath, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('<all_urls>'); // Test-only: simulate the user's optional screenshot grant.
await writeFile(path.join(extensionPath, 'manifest.json'), JSON.stringify(manifest));
const browser = await chromium.launchPersistentContext(profile, {
  headless: process.env.PW_HEADLESS !== '0',
  executablePath: process.env.PW_EXECUTABLE || chromium.executablePath(),
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
});

try {
  let homeRequests = 0;
  await browser.route('https://www.gsxt.gov.cn/index.html', route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: ++homeRequests === 1 ? '<!doctype html><body></body>' : '<input id="keyword"><button id="btn_query">查询</button>'
  }));
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  const popup = await browser.newPage();
  const errors = [];
  popup.on('pageerror', error => errors.push(error.message));
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const version = await popup.evaluate(() => chrome.runtime.getManifest().version);
  if (version !== '1.7.8') throw new Error(`loaded version ${version}`);
  await popup.evaluate(() => chrome.storage.local.set({ runStatus: { running: true, text: '旧任务状态' } }));
  await popup.locator('#start').filter({ hasText: '任务执行中' }).waitFor();
  if (!await popup.locator('#start').isEnabled()) throw new Error('stale running state disabled the start button');
  await popup.evaluate(() => chrome.storage.local.remove('runStatus'));
  await popup.locator('#pin').click();
  await popup.locator('#status').filter({ hasText: /已固定|固定工作台/ }).waitFor({ timeout: 5_000 });
  await popup.locator('#companies').fill('测试企业\n第二家企业');
  await popup.locator('#username').fill('test-user');
  await popup.locator('#password').fill('test-password');
  const opened = browser.waitForEvent('page');
  await popup.reload();
  if (await popup.locator('#companies').inputValue() !== '测试企业\n第二家企业'
      || await popup.locator('#username').inputValue() !== 'test-user'
      || await popup.locator('#password').inputValue() !== 'test-password') {
    throw new Error('form did not persist after popup reload');
  }
  const runner = await opened.catch(async error => {
    throw new Error(`${error.message}\nstatus: ${await popup.locator('#status').innerText()}`);
  });
  await runner.waitForLoadState('domcontentloaded');
  if (!runner.url().endsWith('/runner.html')) throw new Error(`wrong runner: ${runner.url()}`);
  const status = await popup.locator('#status').innerText();
  if (!/任务已提交，共 2 家|开始批量任务/.test(status) || errors.length) throw new Error(`${status}\n${errors.join('\n')}`);
  await runner.locator('#status').filter({ hasText: '开始批量任务' }).waitFor({ timeout: 5_000 });
  await popup.locator('#status').filter({ hasText: '查询已提交' }).waitFor({ timeout: 25_000 });
  if (homeRequests !== 2) throw new Error(`blank homepage reloaded ${homeRequests - 1} times, expected once`);
  if (!browser.pages().some(page => page.url() === 'https://www.gsxt.gov.cn/index.html')) {
    throw new Error('runner did not open GSXT after starting');
  }
  if (!await popup.locator('#start').isEnabled()) throw new Error('start button stayed disabled during a running job');
  await popup.locator('#start').click();
  await popup.locator('#status').filter({ hasText: '已有批量任务正在运行' }).waitFor();
  if (!await popup.locator('#start').isEnabled()) throw new Error('duplicate click left the start button disabled');
  const stillRunning = await popup.evaluate(async () => (await chrome.storage.local.get('runStatus')).runStatus?.running);
  if (!stillRunning) throw new Error('retry click incorrectly cleared the running job');
  console.log(`browser extension runner smoke ok: ${extensionId}`);
} finally {
  await browser.close();
  await rm(profile, { recursive: true, force: true });
}
