import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { mockOptions, widgetHtml } from './test_geetest_mock.mjs';

const profile = await mkdtemp(path.join(tmpdir(), 'gsxt-archive-'));
const extensionPath = path.join(profile, 'extension');
await cp(path.resolve('chrome_extension'), extensionPath, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extensionPath, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('<all_urls>'); // Test-only: simulate the user's optional screenshot grant.
await writeFile(path.join(extensionPath, 'manifest.json'), JSON.stringify(manifest));
const source = await readFile('chrome_extension/background.js', 'utf8');
const items = [...source.match(/const ITEMS = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
const loginMock = process.env.GSXT_MOCK_LOGIN === '1';
const batchMock = process.env.GSXT_MOCK_BATCH === '1';
const blockedMock = process.env.GSXT_MOCK_BLOCKED === '1';
const blankAfterClickMock = process.env.GSXT_MOCK_BLANK_AFTER_CLICK === '1';
const persistentBlankMock = process.env.GSXT_MOCK_PERSISTENT_BLANK === '1';
const inactiveTabMock = process.env.GSXT_MOCK_INACTIVE_TAB === '1';
const captchaMock = process.env.GSXT_MOCK_CAPTCHA === '1';
const captchaWidget = captchaMock
  ? widgetHtml(mockOptions(11, { sliceMode: 'full', moveMode: 'left', scale: 1, naiveScale: false, sliceRatio: 1, panelPosition: 'fixed', listenOn: 'document', noise: 3, dark: false, stripes: false }))
  : '';
let blockedServed = false;
const browser = await chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath: process.env.PW_EXECUTABLE || chromium.executablePath(),
  acceptDownloads: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
});

try {
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  if (loginMock) await browser.route('https://shiming.gsxt.gov.cn/socialuser-use-rllogin.html', route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><meta charset="utf-8"><input type="text" placeholder="登录账号"><input type="password"><button id="btn_login">登录</button><script>
      document.querySelector('#btn_login').onclick = () => {
        if (document.querySelector('input[type=text]').value === 'test-user' && document.querySelector('input[type=password]').value === 'test-password') {
          document.cookie = 'testlogin=yes; Domain=.gsxt.gov.cn; Path=/';
          location.href = 'https://www.gsxt.gov.cn/index.html';
        }
      };
    </script>`
  }));
  await browser.route(/https:\/\/www\.gsxt\.gov\.cn\/detail\.html\?.*/, route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><meta charset="utf-8"><nav id="resultMenu"><button>全部展开</button>${items.map(item => `<div><span>${item}</span></div>`).join('')}</nav><main style="height:1500px"><table><tr><td>行政处罚</td><td><button class="view">查看</button></td></tr><tr><td>股权出质</td><td><button class="view">查看</button></td></tr></table></main><div id="modal" style="display:none"><span id="title"></span><button id="close">关闭</button></div><script>
      document.querySelectorAll('.view').forEach(button => button.onclick = () => {
        document.querySelector('#title').textContent = button.closest('tr').innerText;
        document.querySelector('#modal').style.display = 'block';
      });
      document.querySelector('#close').onclick = () => document.querySelector('#modal').style.display = 'none';
    </script>`
  }));
  await browser.route('https://www.gsxt.gov.cn/index.html', route => {
    if (blockedMock && !blockedServed) {
      blockedServed = true;
      return route.fulfill({ contentType: 'text/html', body: '<h1>This site can’t be reached</h1><p>ERR_BLOCKED_BY_CLIENT</p>' });
    }
    return route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><meta charset="utf-8"><input id="keyword"><button id="btn_query">查询</button><div id="results"></div><script>
      document.querySelector('#btn_query').addEventListener('click', () => {
        if (${loginMock} && !document.cookie.includes('testlogin=yes')) {
          location.href = 'https://shiming.gsxt.gov.cn/socialuser-use-rllogin.html';
          return;
        }
        const showResults = () => {
          const link = document.createElement('a');
          link.textContent = document.querySelector('#keyword').value + '有限公司';
          link.href = '/detail.html?name=' + encodeURIComponent(link.textContent);
          if (${inactiveTabMock}) link.target = '_blank';
          if (${blankAfterClickMock} && (${persistentBlankMock} || !sessionStorage.getItem('blankAfterClickSeen'))) {
            link.addEventListener('click', event => {
              event.preventDefault();
              sessionStorage.setItem('blankAfterClickSeen', 'yes');
              document.body.replaceChildren();
            });
          }
          document.querySelector('#results').replaceChildren(link);
        };
        if (${captchaMock}) {
          window.__onGeetestSuccess = showResults;
          window.__geetest.show();
          return;
        }
        showResults();
      });
    </script>${captchaWidget}`
    });
  });
  const page = await browser.newPage();
  if (inactiveTabMock) browser.on('page', async opened => {
    if (await opened.opener() === page) await page.bringToFront();
  });
  await page.goto('https://www.gsxt.gov.cn/index.html');
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator('#companies').fill(batchMock ? '小米科技\n华为技术' : '小米科技');
  if (loginMock) {
    await popup.locator('#username').fill('test-user');
    await popup.locator('#password').fill('test-password');
  }
  await popup.locator('#start').click();
  await popup.locator('#status').filter({ hasText: /模糊搜索命中：小米科技 → 小米科技有限公司/ })
    .waitFor({ timeout: 30_000 }).catch(async error => {
      throw new Error(`${error.message}\nstatus: ${await popup.locator('#status').innerText()}\npage: ${await page.locator('body').innerText()}`);
    });
  const status = await popup.locator('#status').innerText();
  if (!status.includes('模糊搜索命中')) throw new Error(status);
  if (captchaMock && !status.includes('滑动验证码已通过')) throw new Error(`captcha was not solved by the extension\n${status}`);
  await popup.locator('#status').filter({ hasText: /批量任务结束/ }).waitFor({ timeout: 180_000 }).catch(async error => {
    throw new Error(`${error.message}\nstatus: ${await popup.locator('#status').innerText()}`);
  });
  const finalStatus = await popup.locator('#status').innerText();
  if (persistentBlankMock) {
    if (!finalStatus.includes('成功 0 家，失败 1 家') || !finalStatus.includes('重载后仍持续空白')) throw new Error(finalStatus);
  } else if (!finalStatus.includes(`成功 ${batchMock ? 2 : 1} 家，失败 0 家`) || !finalStatus.includes('明细 2 份')) throw new Error(finalStatus);
  if (loginMock && !finalStatus.includes('账号密码已自动填写并提交')) throw new Error(finalStatus);
  if (blankAfterClickMock && !finalStatus.includes('查询页持续空白，正在重载并重新查询一次')) throw new Error(finalStatus);
  if (captchaMock && !finalStatus.includes('滑动验证码已通过')) throw new Error(finalStatus);
  const downloads = await popup.evaluate(async () => chrome.downloads.search({}));
  if (!persistentBlankMock && (downloads.length < 3 || downloads.some(item => item.state !== 'complete'))) throw new Error(JSON.stringify(downloads.map(item => ({ filename: item.filename, state: item.state }))));
  // Playwright redirects downloads to random file names, so recognise the log by its data: URL instead of its path.
  const logFile = downloads.find(item => item.url.startsWith('data:text/plain'));
  if (!logFile || logFile.state !== 'complete') throw new Error(`the run log was not saved next to the screenshots\nstatus: ${finalStatus}\ndownloads: ${JSON.stringify(downloads.map(item => [item.url.slice(0, 24), item.state]))}`);
  const savedLog = decodeURIComponent(logFile.url.slice(logFile.url.indexOf(',') + 1));
  if (!savedLog.includes('批量任务结束') || !savedLog.includes('开始批量任务')) throw new Error(`saved run log is incomplete:\n${savedLog}`);
  if (process.env.PRINT_RUN_LOG) console.log(`---- 运行日志.txt ----\n${savedLog}----------------------`);
  if (captchaMock && !savedLog.includes('滑动验证码已通过')) throw new Error(`saved run log has no captcha result:\n${savedLog}`);
  console.log(`mock site archive ok: ${items.length} sections, ${downloads.filter(item => item.url.startsWith('data:image/png')).length} PNG screenshots, run log saved, login: ${loginMock}, batch: ${batchMock}, blocked-first: ${blockedMock}, blank-after-click: ${blankAfterClickMock}, persistent-blank: ${persistentBlankMock}, inactive-tab: ${inactiveTabMock}, captcha: ${captchaMock}`);
} finally {
  await browser.close();
  await rm(profile, { recursive: true, force: true });
}
