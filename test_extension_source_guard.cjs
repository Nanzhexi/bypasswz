const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

let targetUrl = 'https://other.example.com/company';
let visibleUrl = targetUrl;
let pendingUrl;
let injections = 0;
let captures = 0;
let downloads = 0;
let switchDuringCapture = false;
let injectedLogin;
const chrome = {
  storage: { local: { set: async () => {} } },
  tabs: {
    get: async () => ({ id: 1, url: targetUrl, pendingUrl, windowId: 2 }),
    update: async () => {},
    query: async () => [{ id: 1, url: visibleUrl, windowId: 2 }],
    captureVisibleTab: async () => {
      captures++;
      if (switchDuringCapture) visibleUrl = 'https://other.example.com/';
      return 'data:image/png;base64,AA==';
    }
  },
  scripting: { executeScript: async ({ func }) => {
    injections++;
    injectedLogin = func;
    return [{ result: { height: 100, viewport: 100, title: 'GSXT 企业详情', hasContent: true } }];
  } },
  downloads: { download: async () => { downloads++; } }
};
const context = vm.createContext({ chrome, URL, setTimeout });
vm.runInContext(`${fs.readFileSync('chrome_extension/background.js', 'utf8')}
globalThis.api = { isGsxtUrl, execute, tryAutoLogin, captureFullPage, setJob: job => { activeJob = job; outputRoot = 'test'; } };`, context);

(async () => {
  const { api } = context;
  for (const url of ['https://www.gsxt.gov.cn/index.html', 'https://shiming.gsxt.gov.cn/login']) {
    assert.equal(api.isGsxtUrl(url), true);
  }
  for (const url of ['http://www.gsxt.gov.cn/', 'https://gsxt.gov.cn.evil.test/', 'https://other.example.com/', 'chrome-error://chromewebdata/']) {
    assert.equal(api.isGsxtUrl(url), false);
  }
  await assert.rejects(api.execute(1, () => true), /不是 GSXT 官网/);
  await assert.rejects(api.tryAutoLogin(1, 'user', 'password'), /不是 GSXT 官网/);
  await assert.rejects(api.captureFullPage(1, 0, 'other'), /不是 GSXT 官网/);
  assert.equal(injections, 0);
  assert.equal(captures, 0);

  targetUrl = 'https://shiming.gsxt.gov.cn/login';
  await api.tryAutoLogin(1, 'user', 'password');
  context.location = { protocol: 'https:', hostname: 'other.example.com' };
  assert.equal(await injectedLogin('user', 'password'), false, 'credentials must not enter third-party frames');

  targetUrl = 'https://www.gsxt.gov.cn/detail.html';
  pendingUrl = 'https://other.example.com/';
  await assert.rejects(api.execute(1, () => true), /不是 GSXT 官网/);
  pendingUrl = undefined;
  visibleUrl = 'https://other.example.com/';
  api.setJob({ companies: ['测试企业'] });
  await assert.rejects(api.captureFullPage(1, 0, 'detail'), /可见标签不是 GSXT 官网/);
  assert.equal(captures, 0, 'switching to another site must never save its screenshot');

  visibleUrl = targetUrl;
  switchDuringCapture = true;
  await assert.rejects(api.captureFullPage(1, 0, 'detail'), /截图期间切换了标签/);
  assert.equal(downloads, 0, 'a screenshot captured during a tab switch must be discarded');
  console.log('GSXT source guard ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
