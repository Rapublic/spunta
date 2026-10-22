'use strict';
const assert = require('assert');
const { CalDavClient } = require('../src/caldav');
const { SyncEngine } = require('../src/sync');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let offline = false;
  let saved = null;
  const net = (u, o) => (offline ? Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })) : fetch(u, o));
  const mk = () => new CalDavClient({ url: 'http://127.0.0.1:5232', username: 'prova', password: 'prova123', timeoutMs: 3000, fetch: net });
  const eng = new SyncEngine({ makeClient: mk, load: () => null, save: (d) => { saved = d; } });
  const notices = [];
  eng.on('notice', (n) => notices.push(n));

  await eng.sync({ force: true });
  const casa = eng.lists.find((l) => l.name === 'Casa');
  const lavoro = eng.lists.find((l) => l.name === 'Lavoro');
  const before = eng.tasks().length;

  // online create
  const t = eng.createTask(casa.href, { title: 'Comprare pane', priority: 2 });
  await wait(600); await eng.flush();
  assert.strictEqual(eng.queue.length, 0);

  // offline: server unreachable
  offline = true;
  const t2 = eng.createTask(casa.href, { title: 'Offline 1' });
  eng.updateTask(t.href, { title: 'Comprare pane integrale' });
  eng.updateTask(t.href, { completed: true });
  await wait(600); await eng.flush();
  assert.strictEqual(eng.status.online, false);
  assert.strictEqual(eng.queue.length, 2, 'two coalesced ops waiting');

  // simulate app restart with persisted state
  eng.flushSave();
  offline = false;
  const eng2 = new SyncEngine({ makeClient: mk, load: () => JSON.parse(JSON.stringify(saved)), save: (d) => { saved = d; } });
  assert.strictEqual(eng2.queue.length, 2);
  eng2.on('notice', (n) => notices.push(n));
  await eng2.sync();
  assert.strictEqual(eng2.queue.length, 0);
  assert.strictEqual(eng2.status.online, true);
  let tasks = eng2.tasks();
  const p = tasks.find((x) => x.uid === t.uid);
  assert.strictEqual(p.title, 'Comprare pane integrale');
  assert.strictEqual(p.completed, true);
  assert(tasks.find((x) => x.title === 'Offline 1'));

  // move to another list (with a subtask)
  const sub = eng2.createTask(casa.href, { title: 'Sottoattività', parent: t2.uid });
  await wait(500); await eng2.flush();
  eng2.moveTask(t2.href, lavoro.href);
  await wait(500); await eng2.flush();
  await eng2.sync({ force: true });
  tasks = eng2.tasks();
  assert.strictEqual(tasks.find((x) => x.uid === t2.uid).listHref, lavoro.href);
  assert.strictEqual(tasks.find((x) => x.uid === sub.uid).listHref, lavoro.href);

  // conflict: change on "another device" then edit locally with stale etag
  const other = mk();
  const remoteItem = eng2.items.get(tasks.find((x) => x.uid === t2.uid).href);
  const ical = require('../src/ical');
  await other.put(remoteItem.href, ical.applyPatch(remoteItem.ics, { title: 'Cambiata dal telefono' }), eng2.etags.get(remoteItem.href));
  eng2.updateTask(remoteItem.href, { title: 'Cambiata dal PC' });
  await wait(500); await eng2.flush();
  assert(notices.some((n) => /altro dispositivo/.test(n)), 'conflict notice shown');
  assert.strictEqual(eng2.tasks().find((x) => x.uid === t2.uid).title, 'Cambiata dal telefono');

  // deleting parent deletes children
  eng2.deleteTask(eng2.tasks().find((x) => x.uid === t2.uid).href);
  await wait(500); await eng2.flush();
  await eng2.sync({ force: true });
  assert(!eng2.tasks().find((x) => x.uid === sub.uid));

  // race: a change sent while a list download is in progress must not be overwritten
  let slowReport = false;
  const slowFetch = async (u, o) => {
    if (slowReport && o.method === 'REPORT') { const res = await fetch(u, o); await wait(700); return res; }
    return fetch(u, o);
  };
  const eng3 = new SyncEngine({ makeClient: () => new CalDavClient({ url: 'http://127.0.0.1:5232', username: 'prova', password: 'prova123', fetch: slowFetch }), load: () => null, save: () => {} });
  await eng3.sync({ force: true });
  const rt = eng3.tasks().find((x) => x.uid === t.uid);
  slowReport = true;
  const syncing = eng3.sync({ force: true });
  await wait(150);
  eng3.updateTask(rt.href, { title: 'Titolo durante il download' });
  await eng3.flush();
  await syncing;
  slowReport = false;
  assert.strictEqual(eng3.tasks().find((x) => x.uid === t.uid).title, 'Titolo durante il download', 'local change survives a concurrent download');
  await eng3.sync();
  assert.strictEqual(eng3.tasks().find((x) => x.uid === t.uid).title, 'Titolo durante il download', 'still there after next sync');
  eng3.updateTask(rt.href, { title: 'Ancora una modifica' });
  await wait(500); await eng3.flush();
  assert.strictEqual(eng3.queue.length, 0, 'no false conflict afterwards');
  assert(!notices.some((n) => /Titolo durante/.test(n)));

  // recurring task without a due date can be closed
  const ical2 = require('../src/ical');
  const noDue = ical2.newTodo({ title: 'Senza data', rrule: 'FREQ=DAILY' });
  assert.strictEqual(ical2.todoToTask(ical2.applyPatch(noDue.ics, { completed: true })).completed, true);

  // cleanup
  await eng2.sync({ force: true });
  eng2.deleteTask(eng2.tasks().find((x) => x.uid === t.uid).href);
  await wait(500); await eng2.flush();
  await eng2.sync({ force: true });
  assert.strictEqual(eng2.tasks().length, before);
  console.log('SYNC TESTS OK', notices);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
