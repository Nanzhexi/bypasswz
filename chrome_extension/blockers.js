const CONFLICTING_EXTENSION_IDS = ['cfhdojbkjhnklbpkdaibdccddilifddb'];

async function disableConflictingExtensions() {
  const extensions = await chrome.management.getAll();
  const conflicts = extensions.filter(item => item.enabled && CONFLICTING_EXTENSION_IDS.includes(item.id));
  const disabled = [];
  for (const item of conflicts) {
    try {
      await chrome.management.setEnabled(item.id, false);
      disabled.push({ id: item.id, name: item.name });
    } catch (error) {
      throw new Error(`无法临时停用 ${item.name}：${error.message}`);
    }
  }
  await chrome.storage.local.set({ temporarilyDisabledExtensions: disabled });
  return disabled;
}

async function restoreConflictingExtensions() {
  const { temporarilyDisabledExtensions = [] } = await chrome.storage.local.get('temporarilyDisabledExtensions');
  const restored = [];
  const remaining = [];
  for (const item of temporarilyDisabledExtensions) {
    try {
      await chrome.management.setEnabled(item.id, true);
      restored.push(item.name);
    } catch (_) {
      remaining.push(item);
    }
  }
  if (remaining.length) await chrome.storage.local.set({ temporarilyDisabledExtensions: remaining });
  else await chrome.storage.local.remove('temporarilyDisabledExtensions');
  return restored;
}
