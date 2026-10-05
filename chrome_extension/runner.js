const statusElement = document.querySelector('#status');

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.runStatus) {
    statusElement.textContent = changes.runStatus.newValue?.text || '';
  }
});

(async () => {
  const { pendingJob } = await chrome.storage.local.get('pendingJob');
  if (!pendingJob?.companies?.length) {
    await restoreConflictingExtensions();
    statusElement.textContent = '没有待执行任务，请从插件弹窗点击“开始执行”。';
    await chrome.storage.local.remove('runnerTabId');
    return;
  }
  await chrome.storage.local.remove('pendingJob');
  running = true;
  await chrome.action.setBadgeText({ text: '…' });
  await chrome.action.setBadgeBackgroundColor({ color: '#b87817' });
  try {
    const disabled = await disableConflictingExtensions();
    pendingJob.disabledExtensions = disabled.map(item => item.name);
    await runBatch(pendingJob);
  } catch (error) {
    running = false;
    activeJob = null;
    await log(`启动失败：${error.message}`).catch(() => {});
    await chrome.action.setBadgeText({ text: '!' }).catch(() => {});
  } finally {
    const restored = await restoreConflictingExtensions();
    if (restored.length) await log(`已恢复扩展：${restored.join('、')}`).catch(() => {});
    const tab = await chrome.tabs.getCurrent().catch(() => null);
    await chrome.storage.local.remove('runnerTabId');
    if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
  }
})();
