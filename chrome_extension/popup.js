const button = document.querySelector('#start');
const status = document.querySelector('#status');
const companies = document.querySelector('#companies');
const username = document.querySelector('#username');
const password = document.querySelector('#password');
const clear = document.querySelector('#clear');
const pin = document.querySelector('#pin');
const parseCompanies = value => [...new Set(value.split(/[\n,，;；]+/).map(item => item.trim()).filter(Boolean))];

pin.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
    status.textContent = '已固定在浏览器右侧。';
  } catch {
    await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
    status.textContent = '当前浏览器未能打开侧边栏，已改为固定工作台标签页。';
  }
});

async function saveForm() {
  await chrome.storage.local.set({
    savedForm: { companies: companies.value, username: username.value, password: password.value }
  });
}

for (const field of [companies, username, password]) field.addEventListener('input', saveForm);

button.addEventListener('click', async () => {
  const names = parseCompanies(companies.value);
  if (!names.length) {
    status.textContent = '请至少输入一家企业或一个关键词。';
    return;
  }
  if (Boolean(username.value.trim()) !== Boolean(password.value)) {
    status.textContent = '账号和密码需要同时填写，或同时留空。';
    return;
  }
  button.disabled = true;
  status.textContent = '正在确认 Chrome 截图权限…';
  try {
    if (!await chrome.permissions.request({ origins: ['<all_urls>'] })) {
      throw new Error('未授予 Chrome 跨标签截图权限，无法批量保存完整页面');
    }
    await saveForm();
    const starting = `任务已提交，共 ${names.length} 家；正在启动…`;
    status.textContent = starting;
    const response = await chrome.runtime.sendMessage({
      type: 'start',
      job: { companies: names, username: username.value.trim(), password: password.value }
    });
    if (!response?.ok) throw new Error(response?.error || '后台没有响应');
    if (response.text?.startsWith('已有批量任务')) status.textContent = response.text;
    button.disabled = false;
  } catch (error) {
    status.textContent = `启动失败：${error.message}`;
    button.disabled = false;
  }
});

clear.addEventListener('click', async () => {
  await chrome.storage.local.remove('savedForm');
  companies.value = username.value = password.value = '';
  status.textContent = '已清除保存的信息。';
});

async function refresh() {
  const { runStatus } = await chrome.storage.local.get('runStatus');
  if (!runStatus) return;
  status.textContent = runStatus.text || '等待开始任务。';
  button.disabled = false;
  button.textContent = runStatus.running ? '任务执行中（点击检查）' : '开始执行';
}

async function restore() {
  const { runStatus } = await chrome.storage.local.get('runStatus');
  if (!runStatus?.running) await restoreConflictingExtensions();
  const { savedForm = {} } = await chrome.storage.local.get('savedForm');
  companies.value = savedForm.companies || '';
  username.value = savedForm.username || '';
  password.value = savedForm.password || '';
  await refresh();
  const { runnerTabId } = await chrome.storage.local.get('runnerTabId');
  if (runStatus?.running && runnerTabId && await chrome.tabs.get(runnerTabId).catch(() => null)) return;
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const openHomeIfNeeded = async () => {
    if (!tabs.some(tab => /^https:\/\/([^.]+\.)?gsxt\.gov\.cn\//.test(tab.url || ''))) {
      await chrome.tabs.create({ url: 'https://www.gsxt.gov.cn/index.html', active: false });
    }
  };
  const names = parseCompanies(companies.value);
  if (!names.length) {
    await openHomeIfNeeded();
    status.textContent = '已打开 GSXT。请先填写企业名称。';
    button.disabled = false;
    return;
  }
  if (!await chrome.permissions.contains({ origins: ['<all_urls>'] })) {
    await openHomeIfNeeded();
    status.textContent = '已打开 GSXT。首次请点“开始执行”并授予截图权限；以后点扩展图标即可自动执行。';
    button.disabled = false;
    return;
  }
  const response = await chrome.runtime.sendMessage({
    type: 'start',
    job: { companies: names, username: username.value.trim(), password: password.value }
  });
  if (!response?.ok) {
    status.textContent = `自动启动失败：${response?.error || '后台没有响应'}`;
    button.disabled = false;
  }
}

restore().catch(error => {
  status.textContent = `打开失败：${error.message}`;
  button.disabled = false;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.runStatus) refresh();
});
