const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');

const stored = {};
const changes = [];
const chrome = {
  management: {
    getAll: async () => [
      { id: 'self', name: 'GSXT', enabled: true },
      { id: 'cfhdojbkjhnklbpkdaibdccddilifddb', name: 'Adblock Plus', enabled: true },
      { id: 'other', name: 'Other', enabled: true }
    ],
    setEnabled: async (id, enabled) => changes.push([id, enabled])
  },
  storage: { local: {
    get: async key => ({ [key]: stored[key] }),
    set: async value => Object.assign(stored, value),
    remove: async key => delete stored[key]
  }}
};
const context = { chrome };
vm.runInNewContext(`${fs.readFileSync('chrome_extension/blockers.js', 'utf8')};globalThis.api={disableConflictingExtensions,restoreConflictingExtensions}`, context);

(async () => {
  const disabled = await context.api.disableConflictingExtensions();
  assert.equal(disabled.length, 1);
  assert.deepEqual(changes[0], ['cfhdojbkjhnklbpkdaibdccddilifddb', false]);
  const restored = await context.api.restoreConflictingExtensions();
  assert.deepEqual([...restored], ['Adblock Plus']);
  assert.deepEqual(changes[1], ['cfhdojbkjhnklbpkdaibdccddilifddb', true]);
  assert.equal(stored.temporarilyDisabledExtensions, undefined);
  console.log('blocker management ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
