if (chrome.sidePanel) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
}

async function startJob(job) {
  if (!job?.companies?.length) throw new Error('请至少输入一家企业或一个关键词');
  if (Boolean(job.username) !== Boolean(job.password)) throw new Error('账号和密码需要同时填写，或同时留空');
  const { runStatus, runnerTabId } = await chrome.storage.local.get(['runStatus', 'runnerTabId']);
  if (runStatus?.running && runnerTabId) {
    const runner = await chrome.tabs.get(runnerTabId).catch(() => null);
    if (runner?.url === chrome.runtime.getURL('runner.html')) {
      return { ok: true, text: '已有批量任务正在运行；进度见面板。' };
    }
  }
  const starting = `任务已提交，共 ${job.companies.length} 家；正在启动…`;
  await chrome.storage.local.set({ pendingJob: job, runStatus: { running: true, text: starting } });
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('runner.html'), active: false });
  await chrome.storage.local.set({ runnerTabId: tab.id });
  return { ok: true, text: starting };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'start') return;
  startJob(message.job).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});
