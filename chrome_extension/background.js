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

chrome.storage.local.set({ engineVersion: '1.7.8' }).catch(() => {});

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
  resetCaptchaState();
  tabId = await openLoginPrompt(tabId);
  await log('检测到登录页，正在填写账号密码…');
  const deadline = Date.now() + 10 * 60_000;
  let filled = false;
  let submittedAt = 0;
  let warned = false;
  while (Date.now() < deadline) {
    if (!filled && await tryAutoLogin(tabId, job.username, job.password)) {
      filled = true;
      submittedAt = Date.now();
      await log('账号密码已自动填写并提交，正在检测验证码…');
    }
    if (!await loginDetected(tabId)) {
      await log('登录完成，继续当前任务。');
      return;
    }
    if (filled) await handleCaptchaIfPresent(tabId);
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
  await log('查询已提交，正在检测验证码…');
}

// ---------------------------------------------------------------------------
// Geetest slide captcha auto-solver
// ---------------------------------------------------------------------------

// Runs inside the GSXT page through chrome.scripting.executeScript, so it must stay self-contained.
// One call is one attempt: read the bg / fullbg / slice canvases, locate the gap, drag the slider
// while measuring where the piece really is (closed loop), then report what the widget did.
async function solveGeetestSlide() {
  const started = Date.now();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const between = (min, max) => min + Math.random() * (max - min);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const classOf = el => String(el.getAttribute('class') || '');
  // offsetParent is null for position:fixed popups, so test visibility from computed style and geometry.
  const shown = el => {
    if (!el || !el.isConnected || getComputedStyle(el).visibility === 'hidden') return false;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || Number(style.opacity) < 0.05) return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 4 && rect.height > 4;
  };

  const panel = [...document.querySelectorAll('[class*="geetest_panel"],[class*="geetest_holder"],[class*="geetest_wrap"],[class*="geetest_widget"]')].find(shown);
  if (!panel) return { status: 'not_found' };
  const verified = () => panel.classList.contains('geetest_success')
    || [...panel.querySelectorAll('.geetest_success,.geetest_panel_success')].some(shown);
  if (verified()) return { status: 'solved', diag: { note: 'already verified' } };

  const canvases = [...panel.querySelectorAll('canvas')];
  // Compact description of what the widget looks like, for logs when it cannot be recognised.
  const domSummary = () => {
    const tokens = new Set();
    for (const el of panel.querySelectorAll('*')) {
      for (const token of classOf(el).split(/\s+/)) if (/geetest|slide|slider|captcha|verify/i.test(token)) tokens.add(token);
    }
    const sizes = canvases.map(c => `${classOf(c).split(/\s+/)[0] || 'canvas'}:${c.width}x${c.height}`).join(',');
    return `画布[${sizes}] 类名[${[...tokens].slice(0, 24).join(' ')}]`.slice(0, 420);
  };
  const fullCanvas = canvases.find(c => /full[_-]?bg/i.test(classOf(c)));
  const sliceCanvas = canvases.find(c => /slice|piece|puzzle|jigsaw/i.test(classOf(c)));
  const bgCanvas = canvases.find(c => c !== fullCanvas && c !== sliceCanvas && /(^|[\s_-])bg(\s|$)/i.test(classOf(c)))
    || canvases.filter(c => c !== fullCanvas && c !== sliceCanvas && c.width >= 100)
      .sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!bgCanvas) {
    const radar = panel.querySelector('[class*="geetest_radar_tip"]');
    if (radar && shown(radar)) { radar.click(); return { status: 'clicked_radar' }; }
    return { status: 'no_canvas', diag: { dom: domSummary() } };
  }

  // --- 1. Read pixels once the images have been painted and stopped changing -----------------
  const W = bgCanvas.width, H = bgCanvas.height, px = W * H;
  const read = (canvas, w = canvas.width, h = canvas.height) => {
    if (canvas.width === w && canvas.height === h) return canvas.getContext('2d').getImageData(0, 0, w, h);
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const g = tmp.getContext('2d');
    g.drawImage(canvas, 0, 0, w, h);
    return g.getImageData(0, 0, w, h);
  };
  const paintedRatio = data => {
    let hit = 0, n = 0;
    for (let i = 3; i < data.length; i += 44) { n++; if (data[i] > 0) hit++; }
    return n ? hit / n : 0;
  };
  const opaqueCount = data => {
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 40) n++;
    return n;
  };
  const digest = data => {
    let h = 0;
    for (let i = 0; i < data.length; i += 37) h = (Math.imul(h, 31) + data[i]) | 0;
    return h;
  };
  const bgSignature = () => { try { return digest(read(bgCanvas).data); } catch (_) { return 0; } };
  // Ask the widget for a fresh puzzle (used when this one cannot be solved); true when a refresh control was clicked.
  const refreshPuzzle = async () => {
    const before = bgSignature();
    const control = [...panel.querySelectorAll('[class*="geetest_refresh"],[class*="geetest_reload"]')].find(shown);
    if (!control) return false;
    control.click();
    for (let i = 0; i < 25 && bgSignature() === before; i++) await sleep(100);
    return true;
  };
  let bgImg, fullImg = null, sliceImg = null, lastSignature = '';
  for (let round = 0; ; round++) {
    try {
      bgImg = read(bgCanvas);
      fullImg = fullCanvas ? read(fullCanvas, W, H) : null;
      sliceImg = sliceCanvas ? read(sliceCanvas) : null;
    } catch (error) {
      return { status: 'canvas_error', detail: String((error && error.message) || error) };
    }
    const coreReady = paintedRatio(bgImg.data) > 0.9 && (!fullImg || paintedRatio(fullImg.data) > 0.9);
    const sliceReady = !sliceImg || opaqueCount(sliceImg.data) > 150;
    const signature = `${digest(bgImg.data)}:${fullImg ? digest(fullImg.data) : 0}:${sliceImg ? digest(sliceImg.data) : 0}`;
    if (coreReady && (sliceReady || round >= 15) && signature === lastSignature) break;
    lastSignature = coreReady ? signature : '';
    if (round >= 40) return { status: 'canvas_blank' };
    await sleep(150);
  }

  // Piece silhouette (alpha mask) from the slice canvas.
  let mask = null;
  if (sliceImg && opaqueCount(sliceImg.data) > 150) {
    const sw = sliceCanvas.width, sh = sliceCanvas.height, d = sliceImg.data;
    let x0 = sw, x1 = -1, y0 = sh, y1 = -1;
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        if (d[(y * sw + x) * 4 + 3] > 110) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    const us = [], vs = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (d[(y * sw + x) * 4 + 3] > 110) { us.push(x - x0); vs.push(y); }
      }
    }
    if (us.length >= 150) mask = { x0, w: x1 - x0 + 1, us, vs };
  }

  // --- 2. Geometry: canvas pixels <-> screen pixels --------------------------------------------
  const bgRect = bgCanvas.getBoundingClientRect();
  const sx = bgRect.width / W, sy = bgRect.height / H;
  const sliceRect0 = sliceCanvas ? sliceCanvas.getBoundingClientRect() : null;
  const ssx = sliceRect0 ? sliceRect0.width / sliceCanvas.width : sx;
  const ssy = sliceRect0 ? sliceRect0.height / sliceCanvas.height : sy;
  const offX = sliceRect0 ? (sliceRect0.left - bgRect.left) / sx : 0;
  const offY = sliceRect0 ? (sliceRect0.top - bgRect.top) / sy : 0;
  const diag = { bg: `${W}x${H}`, full: Boolean(fullImg), slice: sliceCanvas ? `${sliceCanvas.width}x${sliceCanvas.height}` : null, mask: mask ? mask.us.length : 0 };

  // --- 3. Locate the gap: left edge column (bg canvas px) where the piece's left edge must land ----
  let gapL = -1, mode = '', conf = 0;
  if (fullImg) {
    const b = bgImg.data, f = fullImg.data;
    const diffs = new Uint16Array(px), signed = new Int16Array(px), hist = new Uint32Array(766);
    for (let p = 0, i = 0; p < px; p++, i += 4) {
      const d = Math.abs(b[i] - f[i]) + Math.abs(b[i + 1] - f[i + 1]) + Math.abs(b[i + 2] - f[i + 2]);
      diffs[p] = d;
      signed[p] = (f[i] - b[i]) + (f[i + 1] - b[i + 1]) + (f[i + 2] - b[i + 2]);
      hist[d]++;
    }
    // Noise floor from the bulk of unchanged pixels: median and MAD of the colour difference.
    let acc = 0, median = 0, mad = 0;
    for (let v = 0; v < 766; v++) { acc += hist[v]; if (acc >= px * 0.5) { median = v; break; } }
    const dev = new Uint32Array(766);
    for (let v = 0; v < 766; v++) dev[Math.abs(v - median)] += hist[v];
    acc = 0;
    for (let v = 0; v < 766; v++) { acc += dev[v]; if (acc >= px * 0.5) { mad = v; break; } }
    const changed = Math.max(16, median + 4 * 1.4826 * mad);
    const raw = new Uint8Array(px), diff = new Uint8Array(px);
    for (let p = 0; p < px; p++) raw[p] = diffs[p] > changed ? 1 : 0;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const p = y * W + x;
        const n = raw[p - W - 1] + raw[p - W] + raw[p - W + 1] + raw[p - 1] + raw[p] + raw[p + 1] + raw[p + W - 1] + raw[p + W] + raw[p + W + 1];
        diff[p] = n >= 4 ? 1 : 0;
      }
    }
    if (mask) {
      // Slide the piece silhouette over an evidence map: reward evidence under the silhouette and
      // penalise evidence next to it, so the best score is where the silhouette fills the hole.
      const rsx = ssx / sx, rsy = ssy / sy;
      const relX = mask.us.map(u => Math.round(u * rsx));
      const relY = mask.vs.map(v => Math.round(offY + v * rsy));
      let yMin = H, yMax = 0, mw = 0;
      for (let k = 0; k < relX.length; k++) {
        if (relY[k] < yMin) yMin = relY[k];
        if (relY[k] > yMax) yMax = relY[k];
        if (relX[k] > mw) mw = relX[k];
      }
      mw += 1;
      const margin = 4;
      const slide = evidence => {
        const S = new Float64Array((W + 1) * (H + 1));
        for (let y = 0; y < H; y++) {
          let row = 0;
          for (let x = 0; x < W; x++) {
            row += evidence[y * W + x];
            S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row;
          }
        }
        const boxSum = (x0, y0, x1, y1) => {
          x0 = clamp(x0, 0, W); x1 = clamp(x1, 0, W); y0 = clamp(y0, 0, H); y1 = clamp(y1, 0, H);
          return x1 > x0 && y1 > y0 ? S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0] : 0;
        };
        let best = -Infinity, bestX = -1;
        const scores = new Float64Array(W).fill(-Infinity);
        for (let gx = 0; gx + mw <= W; gx++) {
          let inside = 0;
          for (let k = 0; k < relX.length; k++) {
            const X = gx + relX[k], Y = relY[k];
            if (X >= 0 && X < W && Y >= 0 && Y < H) inside += evidence[Y * W + X];
          }
          const score = 2 * inside - boxSum(gx - margin, yMin - margin, gx + mw + margin, yMax + 1 + margin);
          scores[gx] = score;
          if (score > best) { best = score; bestX = gx; }
        }
        let covered = 0;
        for (let k = 0; k < relX.length; k++) {
          const X = bestX + relX[k], Y = relY[k];
          if (X >= 0 && X < W && Y >= 0 && Y < H) covered += diff[Y * W + X];
        }
        let runnerUp = -Infinity;
        for (let gx = 0; gx < W; gx++) if (Math.abs(gx - bestX) > 12 && scores[gx] > runnerUp) runnerUp = scores[gx];
        return { best, bestX, scores, conf: bestX >= 0 ? covered / relX.length : 0, rival: best > 0 ? runnerUp / best : null };
      };
      // First pass counts only "darker than the full picture" (the shaded hole) and ignores lighter
      // pixels, so a pale rim around the hole can neither attract nor repel the silhouette; the second
      // pass accepts any change.
      const darker = new Float64Array(px), either = new Float64Array(px);
      for (let p = 0; p < px; p++) {
        darker[p] = clamp(signed[p], 0, 120);
        either[p] = Math.min(diffs[p], 120) - median;
      }
      for (const [name, evidence] of [['mask-dark', darker], ['mask-diff', either]]) {
        const found = slide(evidence);
        if (found.bestX < 0 || found.best <= 0 || found.conf < 0.2) continue;
        // Soft hole edges let several neighbouring offsets fit almost equally well; aim for the middle.
        let lo = found.bestX, hi = found.bestX;
        while (lo > 0 && found.scores[lo - 1] >= found.best * 0.97) lo--;
        while (hi < W - 1 && found.scores[hi + 1] >= found.best * 0.97) hi++;
        gapL = Math.round((lo + hi) / 2);
        mode = name;
        conf = found.conf;
        diag.rival = found.rival === null ? null : +found.rival.toFixed(2);
        break;
      }
    }
    if (gapL < 0) {
      // No usable silhouette: take the left edge of the changed region itself.
      const cols = new Int32Array(W);
      let maxCol = 0;
      for (let x = 0; x < W; x++) {
        let n = 0;
        for (let y = 0; y < H; y++) n += diff[y * W + x];
        cols[x] = n;
        if (n > maxCol) maxCol = n;
      }
      const limit = Math.max(3, maxCol * 0.3);
      if (maxCol >= 8) {
        for (let x = 4; x < W - 3; x++) {
          if (cols[x] >= limit && cols[x + 1] >= limit && cols[x + 2] >= limit) { gapL = x; mode = 'diff-edge'; conf = 0.5; break; }
        }
      }
    }
  } else if (mask) {
    // No full background to compare with: look for the position where the silhouette sits on a
    // region that is clearly darker than its surroundings (Geetest shades the hole).
    const b = bgImg.data;
    const L = new Float64Array(px);
    for (let p = 0, i = 0; p < px; p++, i += 4) L[p] = 0.299 * b[i] + 0.587 * b[i + 1] + 0.114 * b[i + 2];
    const S = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let row = 0;
      for (let x = 0; x < W; x++) {
        row += L[y * W + x];
        S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row;
      }
    }
    const boxSum = (x0, y0, x1, y1) => {
      x0 = clamp(x0, 0, W); x1 = clamp(x1, 0, W); y0 = clamp(y0, 0, H); y1 = clamp(y1, 0, H);
      return x1 > x0 && y1 > y0 ? S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0] : 0;
    };
    const rsx = ssx / sx, rsy = ssy / sy;
    const relX = mask.us.map(u => Math.round(u * rsx));
    const relY = mask.vs.map(v => Math.round(offY + v * rsy));
    let yMin = H, yMax = 0, mw = 0;
    for (let k = 0; k < relX.length; k++) {
      if (relY[k] < yMin) yMin = relY[k];
      if (relY[k] > yMax) yMax = relY[k];
      if (relX[k] > mw) mw = relX[k];
    }
    mw += 1;
    const margin = 5, startGx = Math.round(offX + mask.x0 * ssx / sx + 20);
    let best = -Infinity, bestX = -1;
    for (let gx = Math.max(0, startGx); gx + mw <= W; gx++) {
      let inside = 0;
      for (let k = 0; k < relX.length; k++) {
        const X = gx + relX[k], Y = relY[k];
        if (X >= 0 && X < W && Y >= 0 && Y < H) inside += L[Y * W + X];
      }
      inside /= relX.length;
      const outer = boxSum(gx - margin, yMin - margin, gx + mw + margin, yMax + 1 + margin);
      const inner = boxSum(gx, yMin, gx + mw, yMax + 1);
      const ringArea = (mw + 2 * margin) * (yMax - yMin + 1 + 2 * margin) - mw * (yMax - yMin + 1);
      const ring = (outer - inner) / Math.max(1, ringArea);
      const score = (ring - inside) / (ring + 12);
      if (score > best) { best = score; bestX = gx; }
    }
    conf = Math.max(0, best);
    if (bestX >= 0 && best >= 0.12) { gapL = bestX; mode = 'mask-shadow'; }
  }
  Object.assign(diag, { mode, gapL, conf: +conf.toFixed(2) });
  if (gapL < 0) {
    await refreshPuzzle();
    return { status: 'detection_failed', diag: { ...diag, dom: domSummary() } };
  }

  // --- 4. Slider button and where the piece has to travel --------------------------------------
  let btn = null;
  for (const selector of ['[class*="geetest_slider_button"]', '[class*="geetest_slide_btn"]', '[class*="slider_button"]', '[class*="slider-btn"]', '[class*="slide-btn"]', '[class*="geetest_btn"]']) {
    btn = [...panel.querySelectorAll(selector)].find(shown);
    if (btn) break;
  }
  if (!btn) {
    btn = [...panel.querySelectorAll('*')].find(el => el.tagName !== 'CANVAS' && shown(el)
      && /^(move|grab|ew-resize)$/.test(getComputedStyle(el).cursor));
  }
  if (!btn) return { status: 'no_slider_btn', diag: { ...diag, dom: domSummary() } };

  // Screen x of the piece's left edge: where the slice canvas sits plus where the piece is drawn in it,
  // so it works whether the widget moves the canvas or repaints the piece inside it.
  const sliceEdge = () => {
    try {
      const w = sliceCanvas.width, h = sliceCanvas.height;
      const d = sliceCanvas.getContext('2d').getImageData(0, 0, w, h).data;
      for (let col = 0; col < w; col++) {
        for (let row = 0; row < h; row++) if (d[(row * w + col) * 4 + 3] > 110) return col;
      }
    } catch (_) { /* use the resting position below */ }
    return null;
  };
  const pieceLeft = () => {
    if (!sliceCanvas) return bgRect.left + 6 * sx;
    const edge = sliceEdge();
    return sliceCanvas.getBoundingClientRect().left + (edge === null ? (mask ? mask.x0 : 6) : edge) * ssx;
  };
  const targetLeft = bgRect.left + gapL * sx;
  const startPiece = pieceLeft();
  const need = targetLeft - startPiece;
  diag.need = +need.toFixed(1);
  if (need < 3) {
    await refreshPuzzle();
    return { status: 'drag_too_small', diag };
  }

  // --- 5. Human-like drag, steered by the measured piece position -------------------------------
  const btnRect = btn.getBoundingClientRect();
  const startX = btnRect.left + btnRect.width * between(0.35, 0.65);
  const startY = btnRect.top + btnRect.height * between(0.35, 0.65);
  const fire = (type, x, y, buttons, target) => {
    const el = target || document.elementFromPoint(x, y) || document.body;
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: type !== 'mouseenter', cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x + window.screenX, screenY: y + window.screenY + 85,
      button: 0, buttons, detail: type === 'mousedown' ? 1 : 0
    }));
  };
  let x = startX, y = startY, driftY = 0;
  const moveTo = (nx, ny) => { x = nx; y = ny; fire('mousemove', x, y, 1); };

  fire('mousemove', startX - between(10, 30), startY + between(-8, 8), 0);
  await sleep(between(60, 140));
  fire('mouseover', startX, startY, 0, btn);
  fire('mouseenter', startX, startY, 0, btn);
  fire('mousemove', startX, startY, 0, btn);
  await sleep(between(140, 320));
  fire('mousedown', startX, startY, 1, btn);
  await sleep(between(80, 200));

  let ratio = 1, travel = need, calibrated = false, tracking = Boolean(sliceCanvas);
  const steps = Math.round(between(30, 44));
  let overshoot = sliceCanvas && Math.random() < 0.6 ? between(1.5, 5) : 0;
  const ease = t => { const u = Math.pow(t, 0.9); return u * u * u * (u * (u * 6 - 15) + 10); };
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    driftY = clamp(driftY + (Math.random() - 0.5) * 1.2, -4, 4);
    moveTo(startX + (travel + overshoot) * ease(t) + (Math.random() - 0.5) * 0.8, startY + driftY);
    await sleep(t < 0.15 || t > 0.85 ? between(22, 36) : between(12, 22));
    if (!calibrated && sliceCanvas && t >= 0.3 && x - startX > 12) {
      const moved = pieceLeft() - startPiece, mouse = x - startX;
      const buttonMoved = btn.getBoundingClientRect().left - btnRect.left;
      if (Math.abs(moved) < 1) {
        if (Math.abs(buttonMoved) < 1 && mouse > 25) {
          fire('mouseup', x, y, 0);
          diag.moved = +moved.toFixed(1);
          return { status: 'no_response', diag };
        }
        // The slider follows the mouse but the slice canvas does not: the widget moves the piece some
        // other way, so keep dragging by the computed distance without feedback.
        if (Math.abs(buttonMoved) >= 1) { tracking = false; overshoot = 0; diag.openLoop = true; }
      } else if (moved / mouse > 0.6 && moved / mouse < 1.6) {
        ratio = moved / mouse;
        travel = need / ratio;
      }
      calibrated = true;
    }
  }
  let corrections = 0;
  while (tracking && corrections < 6) {
    await sleep(between(70, 150));
    const error = targetLeft - pieceLeft();
    if (Math.abs(error) <= 0.8) break;
    corrections++;
    const delta = clamp(error / ratio, -8, 8);
    for (let s = 0; s < 3; s++) {
      moveTo(x + delta / 3, startY + driftY + (Math.random() - 0.5) * 0.6);
      await sleep(between(18, 40));
    }
  }
  await sleep(between(120, 320));
  diag.ratio = +ratio.toFixed(3);
  diag.corrections = corrections;
  diag.finalErr = tracking ? +(targetLeft - pieceLeft()).toFixed(1) : null;
  fire('mouseup', x, y, 0);

  // --- 6. What did the widget do? ------------------------------------------------------------
  const failurePattern = /失败|怪物|吃了|重试|再来|错误|不给力|被吃/;
  const tipText = () => [...panel.querySelectorAll('[class*="geetest_result_tip"],[class*="geetest_slider_tip"],[class*="geetest_panel_error"],[class*="geetest_error"],[class*="geetest_tip"]')]
    .filter(shown).map(el => (el.textContent || '').trim()).join(' ');
  const before = bgSignature();
  let verdict = '';
  const deadline = Date.now() + 3200;
  while (Date.now() < deadline) {
    await sleep(120);
    if (!shown(panel) || verified()) { verdict = 'solved'; break; }
    const tip = tipText();
    diag.tip = tip.slice(0, 40);
    if (failurePattern.test(tip)) { verdict = 'failed'; break; }
    if (bgSignature() !== before) {
      await sleep(500);
      verdict = !shown(panel) || verified() ? 'solved' : 'failed';
      break;
    }
  }
  diag.ms = Date.now() - started;
  if (verdict === 'solved') {
    for (let i = 0; i < 15 && shown(panel); i++) await sleep(100);
    return { status: 'solved', dragDist: Math.round(need), diag };
  }
  if (verdict === 'failed') {
    // The widget normally loads a fresh puzzle by itself; refresh it by hand if it did not.
    for (let i = 0; i < 25 && bgSignature() === before; i++) await sleep(100);
    if (bgSignature() === before && await refreshPuzzle()) await sleep(500);
  }
  diag.verdict = verdict || 'unknown';
  return { status: 'need_retry', dragDist: Math.round(need), diag };
}

async function tryAutoSolveCaptcha(tabId) {
  return execute(tabId, solveGeetestSlide).catch(error => ({ status: 'error', detail: String(error?.message || error) }));
}

// Auto-solve is paused after too many failures in a row so the site is not hammered;
// the user can still finish the captcha by hand and the surrounding wait loops carry on.
const CAPTCHA_MAX_FAILURES = 6;
let captchaFailures = 0;
let captchaPaused = false;
let captchaNoticeAt = {};

function resetCaptchaState() {
  captchaFailures = 0;
  captchaPaused = false;
  captchaNoticeAt = {};
}

async function logCaptchaOnce(kind, message, minGap = 30_000) {
  if (Date.now() - (captchaNoticeAt[kind] || 0) < minGap) return;
  captchaNoticeAt[kind] = Date.now();
  await log(message);
}

function describeCaptcha(result) {
  const d = result?.diag;
  if (!d) return result?.detail ? `：${result.detail}` : '';
  const parts = [];
  if (d.mode) parts.push(`${d.mode} 置信度${d.conf}`);
  if (d.need !== undefined) parts.push(`需移动${d.need}px`);
  if (d.finalErr !== undefined && d.finalErr !== null) parts.push(`松手误差${d.finalErr}px`);
  if (d.tip) parts.push(`提示“${d.tip}”`);
  if (d.dom) parts.push(d.dom);
  return parts.length ? `（${parts.join('，')}）` : '';
}

// Returns true when a captcha was solved during this call, false when there was nothing to solve or
// auto-solving gave up (the caller keeps waiting, so a manual solve still works).
async function handleCaptchaIfPresent(tabId, maxTries = 3) {
  if (captchaPaused) return false;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const result = await tryAutoSolveCaptcha(tabId);
    const status = result?.status;
    if (!status || status === 'not_found') return false;
    if (status === 'solved' && result.diag?.note === 'already verified') return false;
    if (status === 'solved') {
      captchaFailures = 0;
      await log(`滑动验证码已通过${result.dragDist ? `（拖动约 ${result.dragDist}px）` : ''}${describeCaptcha(result)}。`);
      await sleep(500);
      return true;
    }
    if (status === 'clicked_radar' || status === 'canvas_blank' || status === 'no_canvas') {
      if (status === 'no_canvas') await logCaptchaOnce('no_canvas', `检测到验证码弹窗，但没有找到滑块拼图画布（可能尚未加载或是点选类验证码）；如长时间无变化请手动完成${describeCaptcha(result)}。`);
      await sleep(1000);
      continue;
    }
    if (status === 'canvas_error') {
      captchaPaused = true;
      await log(`验证码图片无法读取${describeCaptcha(result)}，已停止自动识别，请在网页中手动完成滑动。`);
      return false;
    }
    if (status === 'no_response') {
      captchaPaused = true;
      await log(`验证码滑块没有响应脚本发出的鼠标事件${describeCaptcha(result)}，已停止自动识别，请在网页中手动完成滑动。`);
      return false;
    }
    if (status === 'error') {
      await logCaptchaOnce('error', `验证码自动识别出错${describeCaptcha(result)}，稍后重试。`);
      return false;
    }
    captchaFailures++;
    await log(`验证码自动滑动未通过：${status}${describeCaptcha(result)}（连续失败 ${captchaFailures} 次）。`);
    if (captchaFailures >= CAPTCHA_MAX_FAILURES) {
      captchaPaused = true;
      await log(`验证码自动识别连续失败 ${captchaFailures} 次，已暂停自动识别以免触发风控；请在网页中手动完成滑动，完成后任务会自动继续。`);
      return false;
    }
    await sleep(900 + Math.random() * 700);
  }
  return false;
}

async function prepareHomeTab() {
  const pageState = tabId => execute(tabId, () => ({
    search: Boolean(document.querySelector('#keyword,input[name=keyword],input[placeholder*="企业名称"]')),
    checking: /Environment Checking/i.test(document.title)
      || /努力加载中/.test(document.body?.innerText || '')
      || document.scripts.length > 0,
    // Stricter than "checking" (any normal page has scripts): only a real WAF challenge page.
    waf: /Environment Checking/i.test(document.title)
      || /努力加载中/.test(document.body?.innerText || '')
      || (document.scripts.length > 0 && Boolean(document.body) && !document.body.innerText.trim()),
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
        if (tab.url !== HOME && !(await pageState(workTabId))?.waf) await navigate(workTabId, HOME);
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
  if (gsxtTabs[0].url !== HOME && !(await pageState(workTabId))?.waf) await navigate(workTabId, HOME);
  if (await waitForSearch(workTabId)) return workTabId;
  workTabId = null;
  throw new Error('GSXT 环境校验超过 3 分钟，请稍后重试');
}

async function searchCompany(company, job) {
  resetCaptchaState();
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
      } else {
        if (!announced) {
          announced = true;
          await log('正在等待查询结果，尝试自动识别验证码…');
        }
        await handleCaptchaIfPresent(tabId);
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
