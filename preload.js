'use strict';
const { contextBridge, ipcRenderer } = require('electron');

async function call(name, ...args) {
  const r = await ipcRenderer.invoke(name, ...args);
  // plain object: custom Error properties do not survive the context bridge
  if (!r.ok) throw { message: r.error, kind: r.kind || null };
  return r.value;
}

contextBridge.exposeInMainWorld('spunta', {
  state: () => call('state'),
  connect: (data) => call('connect', data),
  disconnect: () => call('disconnect'),
  sync: () => call('sync'),
  createTask: (listHref, fields) => call('createTask', listHref, fields),
  updateTask: (href, patch) => call('updateTask', href, patch),
  deleteTask: (href) => call('deleteTask', href),
  moveTask: (href, listHref) => call('moveTask', href, listHref),
  createList: (name, color) => call('createList', name, color),
  setSettings: (patch) => call('setSettings', patch),
  openExternal: (url) => call('openExternal', url),
  createNotifyShortcut: () => call('createNotifyShortcut'),
  removeNotifyShortcut: () => call('removeNotifyShortcut'),
  testNotification: () => call('testNotification'),
  on: (channel, cb) => {
    const allowed = ['state', 'notice', 'focus-quickadd', 'open-task', 'show-view'];
    if (!allowed.includes(channel)) return () => {};
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
