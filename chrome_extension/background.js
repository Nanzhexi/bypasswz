const HOME = 'https://www.gsxt.gov.cn/index.html';
const isGsxtUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'gsxt.gov.cn' || url.hostname.endsWith('.gsxt.gov.cn'));
  } catch { return false; }
};
const ITEMS = [
  '营业执照信息', '营业期限信息', '股东及出资信息', '主要人员信息', '分支机构信息',
  '“多证合一”信息公示', '清算信息', '变更信息', '另册管理', '信誉信息', '行政许可信息',
  '知识产权信息', '知识产权出质登记信息', '商标注册信息', '名称转让信息',
  '动产抵押登记信息', '股权出质登记信息', '司法协助信息',
  '依人民法院判决申请撤销登记信息', '协助涤除信息', '双随机抽查结果信息',
  '产品质量监督抽查结果信息', '认证监管抽查检查结果信息', '食品抽查检查结果信息',
  '其他抽查检查结果信息', '行政处罚信息', '列入经营异常名录信息',
  '列入严重违法失信名单（黑名单）信息', '承诺不实情况', '企业年报信息', '集团成员信息',
  '执行标准自我声明', '信用承诺信息', '名称授权信息', '经营主体歇业公告',
  '涉嫌冒用他人身份登记信息', '拟强制注销公告', '合并/分立公告', '减少注册资本公告',
  '解散事由信息', '经营主体终止歇业公告', '简易注销公告信息', '注销备案/公告信息',
  '营业执照作废声明'
];
let running = false;
let activeJob = null;
let outputRoot = '';
let messages = [];
let workTabId = null;

chrome.storage.local.set({ engineVersion: '1.7.7' }).catch(() => {});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function resetGsxtCheck() {
  const cookies = await chrome.cookies.getAll({ domain: 'gsxt.gov.cn' });
  const wafCookies = cookies.filter(cookie => cookie.name.startsWith('__jsl'));
  await Promise.all(wafCookies.map(cookie => chrome.cookies.remove({
    url: `https://${cookie.domain.replace(/^\./, '')}${cookie.path || '/'}`,
    name: cookie.name
  })));
  return wafCookies.length;
}

async function log(message) {
  messages.push(message);
  messages = messages.slice(-100);
  await chrome.storage.local.set({ runStatus: { running, text: messages.join('\n') } });
}

const safeName = value => String(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 100) || 'unnamed';

async function gsxtTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isGsxtUrl(tab.url) || (tab.pendingUrl && !isGsxtUrl(tab.pendingUrl))) {
    throw new Error('安全中止：当前页面不是 GSXT 官网，不会读取或存档');
  }
  return tab;
}

async function execute(tabId, func, args = []) {
  await gsxtTab(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args
  });
  return results[0]?.result;
}

async function waitComplete(tabId, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    await sleep(500);
  }
  throw new Error('网页加载超时');
}

async function navigate(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await waitComplete(tabId);
}

async function waitUsable(tabId, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await execute(tabId, () => ({
      title: document.title || '',
      text: (document.body?.innerText || '').trim().length,
      controls: Boolean(document.querySelector('input,button,form,#keyword,#resultMenu'))
    })).catch(() => null);
    if (state?.controls && !/Environment Checking/i.test(state.title)) return;
    await sleep(1000);
  }
  throw new Error('网站仍为空白或处于环境校验页');
}

async function loginDetected(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return false;
  if (/login/i.test(tab.url || '')) return true;
  return Boolean(await execute(tabId, () => {
    const text = document.body?.innerText || '';
    const password = [...document.querySelectorAll('input[type=password]')]
      .some(e => e.offsetParent !== null);
    return password || (/当前系统繁忙/.test(text) && /实名注册\s*[/／]?\s*登录/.test(text));
  }).catch(() => false));
}

async function openLoginPrompt(tabId) {
  const clicked = await execute(tabId, () => {
    const visible = element => element && element.offsetParent !== null;
    const controls = [...document.querySelectorAll('a,button,[role=button]')].filter(visible);
    const login = controls.find(element => /实名注册\s*[/／]?\s*登录/.test((element.innerText || '').trim()));
    login?.click();
    return Boolean(login);
  }).catch(() => false);
  if (!clicked) return tabId;
  await log('系统要求实名登录，正在打开登录页…');
  await sleep(1500);
  const current = await chrome.tabs.get(tabId).catch(() => null);
  if (/login|shiming/i.test(current?.url || '')) return tabId;
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs.find(tab => /login|shiming/i.test(tab.url || ''))?.id || tabId;
}

async function tryAutoLogin(tabId, username, password) {
  if (!username || !password) return false;
  await gsxtTab(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    args: [username, password],
    func: async (user, pass) => {
      if (location.protocol !== 'https:' || (location.hostname !== 'gsxt.gov.cn' && !location.hostname.endsWith('.gsxt.gov.cn'))) return false;
      const visible = element => element && element.offsetParent !== null;
      const passwordInput = [...document.querySelectorAll('input[type=password]')].find(visible);
      if (!passwordInput) return false;
      const usernameInput = [...document.querySelectorAll(
        'input[placeholder*="账号"],input[placeholder*="用户名"],input[placeholder*="手机"],input[type=text],input[type=tel]'
      )].find(visible);
      if (!usernameInput) return false;
      const set = (input, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
        input.focus();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Tab' }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.blur();
      };
      set(usernameInput, user);
      set(passwordInput, pass);
      await new Promise(resolve => setTimeout(resolve, 300));
      const buttons = [...document.querySelectorAll('button,input[type=submit],[role=button]')].filter(visible);
      const submit = document.querySelector('#btn_login')
        || buttons.find(e => /登录/.test(e.innerText || e.value || ''))
        || buttons.at(-1);
      submit?.focus();
      submit?.click();
      return Boolean(submit);
    }
  }).catch(() => []);
  return results.some(result => result.result === true);
}

async function handleLogin(tabId, job) {
  tabId = await openLoginPrompt(tabId);
  await log('检测到登录页，正在填写账号密码；如出现验证码，请手动完成。');
  const deadline = Date.now() + 10 * 60_000;
  let filled = false;
  let submittedAt = 0;
  let warned = false;
  while (Date.now() < deadline) {
    if (!filled && await tryAutoLogin(tabId, job.username, job.password)) {
      filled = true;
      submittedAt = Date.now();
      await log('账号密码已自动填写并提交，等待验证码或登录完成。');
    }
    if (!await loginDetected(tabId)) {
      await log('登录完成，继续当前任务。');
      return;
    }
    if (filled && !warned && Date.now() - submittedAt > 8_000) {
      warned = true;
      await log('登录按钮已触发但网页无响应：请暂停广告/脚本拦截扩展对 gsxt.gov.cn 和 shiming.gsxt.gov.cn 的拦截，然后刷新登录页。');
    }
    await sleep(1000);
  }
  throw new Error('10 分钟内未完成登录');
}

async function submitSearch(tabId, company) {
  const result = await execute(tabId, query => {
    const input = document.querySelector('#keyword,input[name=keyword],input[placeholder*="企业名称"]');
    const button = document.querySelector('#btn_query') || [...document.querySelectorAll('button')]
      .find(e => /查\s*询/.test(e.innerText || ''));
    if (!input || !button) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    button.click();
    return true;
  }, [company]);
  if (!result) throw new Error('找不到企业查询框或查询按钮');
  await log('查询已提交；如出现验证码，请在 Chrome 中手动完成。');
}

async function prepareHomeTab() {
  const pageState = tabId => execute(tabId, () => ({
    search: Boolean(document.querySelector('#keyword,input[name=keyword],input[placeholder*="企业名称"]')),
    checking: /Environment Checking/i.test(document.title)
      || /努力加载中/.test(document.body?.innerText || '')
      || document.scripts.length > 0,
    blank: Boolean(document.body) && !document.body.innerText.trim()
      && ![...document.body.querySelectorAll('input,button,a,iframe')]
        .some(element => element.getClientRects().length)
  })).catch(() => null);
  const hasSearch = async tabId => Boolean((await pageState(tabId))?.search);
  const waitForSearch = async tabId => {
    await log('等待 GSXT 环境校验自动完成（最多 3 分钟，不刷新页面）…');
    const deadline = Date.now() + 180_000;
    let retriedRecovery = false;
    let blankSince = 0;
    while (Date.now() < deadline) {
      const state = await pageState(tabId);
      if (state?.search) return true;
      blankSince = state?.blank && !state.checking ? blankSince || Date.now() : 0;
      const needsRecovery = !state || blankSince && Date.now() - blankSince >= 12_000;
      if (needsRecovery && (await gsxtTab(tabId)).status === 'complete') {
        if (retriedRecovery) throw new Error('GSXT 首页重载后仍空白，已停止以避免反复刷新');
        retriedRecovery = true;
        blankSince = 0;
        const removed = await resetGsxtCheck();
        await log(`GSXT 首页完全空白（521 响应）；已清除 ${removed} 个 WAF cookie，重载一次…`);
        await chrome.tabs.reload(tabId);
        await waitComplete(tabId);
      }
      await sleep(1000);
    }
    return false;
  };
  if (workTabId) {
    const tab = await chrome.tabs.get(workTabId).catch(() => null);
    if (tab) {
      if (!await hasSearch(workTabId)) {
        if (tab.url !== HOME && !(await pageState(workTabId))?.checking) await navigate(workTabId, HOME);
        if (!await waitForSearch(workTabId)) throw new Error('GSXT 环境校验超过 3 分钟');
      }
      return workTabId;
    }
    workTabId = null;
  }
  const tabs = await chrome.tabs.query({ currentWindow: true });
  tabs.sort((a, b) => Number(b.active) - Number(a.active));
  const gsxtTabs = tabs.filter(tab => /^https:\/\/([^.]+\.)?gsxt\.gov\.cn\//.test(tab.url || ''));
  for (const tab of gsxtTabs) {
    if (await hasSearch(tab.id)) {
      workTabId = tab.id;
      return workTabId;
    }
  }
  if (!gsxtTabs.length) {
    await resetGsxtCheck();
    const tab = await chrome.tabs.create({ url: HOME, active: true });
    workTabId = tab.id;
    await waitComplete(workTabId);
    if (await waitForSearch(workTabId)) return workTabId;
    workTabId = null;
    throw new Error('GSXT 环境校验超过 3 分钟，请稍后重试');
  }
  workTabId = gsxtTabs[0].id;
  if (gsxtTabs[0].url !== HOME && !(await pageState(workTabId))?.checking) await navigate(workTabId, HOME);
  if (await waitForSearch(workTabId)) return workTabId;
  workTabId = null;
  throw new Error('GSXT 环境校验超过 3 分钟，请稍后重试');
}

async function searchCompany(company, job) {
  // Reuse a verified company detail instead of triggering another search CAPTCHA.
  const openTabs = await chrome.tabs.query({ currentWindow: true });
  for (const tab of openTabs.filter(tab => isGsxtUrl(tab.url))) {
    const existing = await execute(tab.id, query => {
      const heading = document.querySelector('h1');
      return Boolean(document.querySelector('#resultMenu') && heading
        && heading.innerText.trim() === query
        && !document.querySelector('[class*="geetest_panel"]'));
    }, [company]).catch(() => false);
    if (existing) {
      workTabId = tab.id;
      await log(`复用已打开的企业详情：${company}`);
      return { tabId: tab.id, selected: company };
    }
  }
  for (let loginAttempt = 0; loginAttempt < 2; loginAttempt++) {
    let tabId = await prepareHomeTab();
    await chrome.tabs.update(tabId, { active: true });
    await submitSearch(tabId, company);
    const deadline = Date.now() + 10 * 60_000;
    let announced = false;
    let restartAfterLogin = false;
    let blankSince = 0;
    let blankReloaded = false;

    const recoverBlank = async () => {
      const state = await execute(tabId, () => ({
        blank: Boolean(document.body) && !document.body.innerText.trim()
          && ![...document.body.querySelectorAll('input,button,a,iframe')]
            .some(element => element.getClientRects().length),
        checking: /Environment Checking/i.test(document.title) || document.scripts.length > 0
      })).catch(() => null);
      if (!state?.blank) { blankSince = 0; return false; }
      if (!blankSince) {
        blankSince = Date.now();
        await log(state.checking ? '查询页处于环境校验，等待网站自行完成，不刷新页面…' : '查询页呈空白，等待短暂加载…');
      }
      if (state.checking) {
        if (Date.now() - blankSince > 180_000) throw new Error('GSXT 环境校验超过 3 分钟，已停止以避免反复刷新');
        return 'blank';
      }
      if (Date.now() - blankSince < 12_000) return 'blank';
      blankSince = 0;
      if (blankReloaded) throw new Error('GSXT 查询页重载后仍持续空白，无法继续；请先确认网站可正常打开');
      blankReloaded = true;
      const removed = await resetGsxtCheck();
      await log(`查询页持续空白（521 响应），已清除 ${removed} 个 WAF cookie，正在重载并重新查询…`);
      await chrome.tabs.reload(tabId);
      await waitComplete(tabId);
      if (await execute(tabId, () => Boolean(document.querySelector('#keyword,input[name=keyword],input[placeholder*="企业名称"]')))
        .catch(() => false)) await submitSearch(tabId, company);
      return 'reloaded';
    };

    while (Date.now() < deadline) {
      if (await loginDetected(tabId)) {
        await handleLogin(tabId, job);
        restartAfterLogin = true;
        break;
      }
      if (await recoverBlank()) { await sleep(1000); continue; }

      const beforeTabs = new Set((await chrome.tabs.query({ currentWindow: true })).map(item => item.id));
      const state = await execute(tabId, query => {
        const visible = e => e && e.offsetParent !== null;
        if (visible(document.querySelector('#resultMenu'))) return { state: 'detail' };
        const links = [...document.querySelectorAll('a')].filter(visible);
        const exact = links.find(e => (e.innerText || '').trim() === query);
        const fuzzy = links.find(e => (e.innerText || '').trim().includes(query));
        const match = exact || fuzzy;
        if (!match) return { state: 'wait' };
        const name = (match.innerText || '').trim();
        match.click();
        return { state: 'clicked', name };
      }, [company]).catch(() => ({ state: 'wait' }));

      if (state.state === 'detail') return { tabId, selected: company };
      if (state.state === 'clicked') {
        if (state.name !== company) await log(`模糊搜索命中：${company} → ${state.name}`);
        const oldId = tabId;
        await sleep(1500);
        const candidates = await chrome.tabs.query({ currentWindow: true });
        const opened = candidates.find(item => !beforeTabs.has(item.id) && /gsxt\.gov\.cn/.test(item.url || item.pendingUrl || ''));
        if (opened) {
          tabId = opened.id;
          workTabId = tabId;
          await waitComplete(tabId);
        }
        const detailDeadline = Date.now() + 60_000;
        while (Date.now() < detailDeadline) {
          if (await loginDetected(tabId)) break;
          if (await execute(tabId, () => Boolean(document.querySelector('#resultMenu'))).catch(() => false)) {
            return { tabId, selected: state.name };
          }
          const blankState = await recoverBlank();
          if (blankState === 'reloaded') break;
          await sleep(1000);
        }
      } else if (!announced) {
        announced = true;
        await log('正在等待查询结果或手动验证码…');
      }
      await sleep(1000);
    }
    if (!restartAfterLogin) {
      throw new Error('10 分钟内未进入企业详情页');
    }
  }
  throw new Error('10 分钟内未进入企业详情页');
}

async function loadEverySection(tabId) {
  const missing = await execute(tabId, async names => {
    const duplicates = new Set(['行政许可信息','知识产权信息','司法协助信息']);
    const visible = e => e && e.offsetParent !== null;
    const elements = () => [...document.querySelectorAll('button,[role=button],a,li,div,span')].filter(visible);
    const exact = name => elements().filter(e => (e.innerText || '').trim() === name);
    exact('全部展开')[0]?.click();
    await new Promise(resolve => setTimeout(resolve, 500));
    const failed = [];
    for (const name of names) {
      const matches = exact(name);
      const leaf = [...document.querySelectorAll('#resultMenu [role=button][data-target]')]
        .find(e => (e.innerText || '').trim() === name);
      const item = leaf || (duplicates.has(name) ? matches.at(-1) : matches[0]);
      if (!item) failed.push(name);
      else item.click();
      await new Promise(resolve => setTimeout(resolve, 700));
    }
    return failed;
  }, [ITEMS]);
  if (missing?.length) throw new Error(`找不到栏目：${missing.join('、')}`);

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const loading = await execute(tabId, () => [...document.querySelectorAll('*')]
      .filter(e => e.offsetParent !== null && (e.innerText || '').trim() === '正在加载，请稍候').length);
    if (!loading) return;
    await sleep(1000);
  }
  throw new Error('栏目加载超过 2 分钟，已停止存档');
}

async function captureFullPage(tabId, index, name) {
  const tab = await gsxtTab(tabId);
  await chrome.tabs.update(tabId, { active: true });
  const metrics = await execute(tabId, () => ({
    height: Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0),
    viewport: window.innerHeight,
    title: document.title,
    hasContent: Boolean(document.body?.innerText.trim())
  }));
  if (!metrics?.hasContent || /Environment Checking/i.test(metrics.title)) throw new Error('GSXT 页面仍在校验或空白，未截图');
  if (!metrics?.height || !metrics?.viewport) throw new Error('无法读取页面尺寸');
  const pages = Math.max(1, Math.ceil(metrics.height / metrics.viewport));
  const company = `${String(index + 1).padStart(3, '0')}_${safeName(activeJob.companies[index])}`;
  const base = safeName(name.replace(/\.(pdf|png)$/i, ''));
  try {
    for (let page = 0; page < pages; page++) {
      const y = Math.min(page * metrics.viewport, Math.max(0, metrics.height - metrics.viewport));
      await execute(tabId, position => window.scrollTo(0, position), [y]);
      await sleep(650);
      const current = await gsxtTab(tabId);
      await chrome.tabs.update(tabId, { active: true });
      const [visible] = await chrome.tabs.query({ active: true, windowId: current.windowId });
      if (visible?.id !== tabId || !isGsxtUrl(visible.url) || (visible.pendingUrl && !isGsxtUrl(visible.pendingUrl))) {
        throw new Error('安全中止：可见标签不是 GSXT 官网，不会截图');
      }
      const url = await chrome.tabs.captureVisibleTab(current.windowId, { format: 'png' });
      const [afterCapture] = await chrome.tabs.query({ active: true, windowId: current.windowId });
      if (afterCapture?.id !== tabId || !isGsxtUrl(afterCapture.url) || (afterCapture.pendingUrl && !isGsxtUrl(afterCapture.pendingUrl))) {
        throw new Error('安全中止：截图期间切换了标签，已丢弃截图');
      }
      await chrome.downloads.download({
        url,
        filename: `${outputRoot}/${company}/${base}_${String(page + 1).padStart(3, '0')}.png`,
        conflictAction: 'uniquify',
        saveAs: false
      });
    }
  } finally {
    await execute(tabId, () => window.scrollTo(0, 0)).catch(() => {});
  }
  return pages;
}

async function saveDetails(tabId, index) {
  const count = await execute(tabId, () => [...document.querySelectorAll('a,button,span')]
    .filter(e => e.offsetParent !== null && (e.innerText || '').trim() === '查看').length);
  for (let i = 0; i < count; i++) {
    const beforeUrl = (await chrome.tabs.get(tabId)).url;
    const beforeTabs = new Set((await chrome.tabs.query({ currentWindow: true })).map(tab => tab.id));
    const row = await execute(tabId, position => {
      const visible = e => e && e.offsetParent !== null;
      const views = [...document.querySelectorAll('a,button,span')]
        .filter(e => visible(e) && (e.innerText || '').trim() === '查看');
      const item = views[position];
      if (!item) return null;
      const text = (item.closest('tr')?.innerText || `明细_${position + 1}`).trim();
      item.click();
      return text;
    }, [i]);
    if (!row) continue;
    await sleep(1200);
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const opened = tabs.find(tab => !beforeTabs.has(tab.id));
    const file = `${String(i + 1).padStart(3, '0')}_${row}`;

    if (opened) {
      await waitComplete(opened.id);
      await captureFullPage(opened.id, index, file);
      await chrome.tabs.remove(opened.id);
    } else if ((await chrome.tabs.get(tabId)).url !== beforeUrl) {
      await captureFullPage(tabId, index, file);
      await chrome.tabs.goBack(tabId);
      await sleep(500);
      await waitComplete(tabId);
    } else {
      await captureFullPage(tabId, index, file);
      const closed = await execute(tabId, () => {
        const visible = e => e && e.offsetParent !== null;
        const selectors = '.el-dialog__close,.ant-modal-close,.layui-layer-close,[aria-label*=关闭],[aria-label*=close]';
        const direct = [...document.querySelectorAll(selectors)].find(visible);
        if (direct) { direct.click(); return true; }
        const text = [...document.querySelectorAll('button,a,span')]
          .find(e => visible(e) && /^(关闭|×|✕)$/.test((e.innerText || '').trim()));
        if (text) { text.click(); return true; }
        return false;
      });
      if (!closed) throw new Error(`第 ${i + 1} 个明细窗口无法关闭`);
    }
    await sleep(500);
  }
  return count;
}

async function runCompany(company, index, job) {
  const { tabId, selected } = await searchCompany(company, job);
  let completed = false;
  try {
    await loadEverySection(tabId);
    const pages = await captureFullPage(tabId, index, `${selected}_企业信用信息`);
    const details = await saveDetails(tabId, index);
    await log(`完成：${selected}，主档案截图 ${pages} 张，明细 ${details} 份。`);
    completed = true;
  } finally {
    workTabId = tabId;
  }
}

async function runBatch(job) {
  const failures = [];
  let success = 0;
  const stamp = new Date().toLocaleString('sv-SE').replace(' ', '_').replaceAll(':', '-');
  activeJob = job;
  outputRoot = `GSXT企业信用存档/${stamp}_批量_${job.companies.length}家`;
  messages = [];
  if (job.disabledExtensions?.length) {
    await log(`已临时停用冲突扩展：${job.disabledExtensions.join('、')}；任务结束后自动恢复。`);
  }
  await log(`开始批量任务；输出到“下载/${outputRoot}”`);
  try {
    for (let index = 0; index < job.companies.length; index++) {
      const company = job.companies[index];
      await log(`[${index + 1}/${job.companies.length}] ${company}`);
      try {
        await runCompany(company, index, job);
        success++;
      } catch (error) {
        failures.push(`${company}: ${error.message}`);
        await log(`失败：${company}: ${error.message}`);
      }
    }
  } finally {
    await log(`批量任务结束：成功 ${success} 家，失败 ${failures.length} 家。`);
    await chrome.action.setBadgeText({ text: failures.length ? '!' : '✓' });
    await chrome.action.setBadgeBackgroundColor({ color: failures.length ? '#b3261e' : '#188038' });
    running = false;
    activeJob = null;
    await chrome.storage.local.set({ runStatus: { running: false, text: messages.join('\n') } });
  }
}
