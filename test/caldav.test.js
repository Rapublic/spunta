'use strict';
// Integration test against a local Radicale server: node test/caldav.test.js
const assert = require('assert');
const { CalDavClient } = require('../src/caldav');
const ical = require('../src/ical');

(async () => {
  const c = new CalDavClient({ url: process.env.DAV || 'http://127.0.0.1:5232', username: 'prova', password: 'prova123' });
  const home = await c.discover();
  console.log('home:', home);

  let lists = await c.listTaskLists();
  if (!lists.find((l) => l.name === 'Lavoro')) {
    await c.createList('Lavoro', '#2f6f9f');
    await c.createList('Casa', '#4c8c4a');
    lists = await c.listTaskLists();
  }
  console.log('lists:', lists.map((l) => `${l.name} ${l.color}`).join(', '));
  const lavoro = lists.find((l) => l.name === 'Lavoro');
  assert(lavoro, 'Lavoro list exists');

  // create
  const tomorrow10 = new Date(); tomorrow10.setDate(tomorrow10.getDate() + 1); tomorrow10.setHours(10, 0, 0, 0);
  const { uid, ics } = ical.newTodo({ title: 'Chiamare Marco, per il preventivo; urgente', due: { allDay: false, ts: tomorrow10.getTime() }, priority: 1, tags: ['telefono'] });
  const href = lavoro.href + uid + '.ics';
  let etag = await c.put(href, ics, null);
  console.log('created etag', etag);

  // subtask
  const sub = ical.newTodo({ title: 'Preparare numeri', parent: uid });
  await c.put(lavoro.href + sub.uid + '.ics', sub.ics, null);

  // read back
  let items = await c.listTasks(lavoro.href);
  let mine = items.find((i) => i.href.endsWith(uid + '.ics'));
  let task = ical.todoToTask(mine.ics);
  assert.strictEqual(task.title, 'Chiamare Marco, per il preventivo; urgente');
  assert.strictEqual(task.priority, 1);
  assert.strictEqual(task.due.ts, tomorrow10.getTime());
  assert.deepStrictEqual(task.tags, ['telefono']);
  assert.strictEqual(task.alarms.length, 1);
  const subTask = ical.todoToTask(items.find((i) => i.href.endsWith(sub.uid + '.ics')).ics);
  assert.strictEqual(subTask.parent, uid);

  // update with etag
  const updated = ical.applyPatch(mine.ics, { completed: true, notes: 'riga 1\nriga 2' });
  etag = await c.put(href, updated, mine.etag);
  items = await c.listTasks(lavoro.href);
  mine = items.find((i) => i.href.endsWith(uid + '.ics'));
  task = ical.todoToTask(mine.ics);
  assert.strictEqual(task.completed, true);
  assert.strictEqual(task.notes, 'riga 1\nriga 2');

  // stale etag => conflict
  let conflict = false;
  try { await c.put(href, updated, '"vecchio"'); } catch (e) { conflict = e.kind === 'conflict'; }
  assert(conflict, 'stale etag gives conflict');

  // recurring completion moves due forward
  const rec = ical.newTodo({ title: 'Report settimanale', due: { allDay: true, date: '2026-10-19' }, rrule: 'FREQ=WEEKLY;BYDAY=MO' });
  const t2 = ical.todoToTask(ical.applyPatch(rec.ics, { completed: true }));
  assert.strictEqual(t2.completed, false);
  assert.strictEqual(t2.due.date, '2026-10-26');

  // delete
  await c.remove(href, mine.etag);
  items = await c.listTasks(lavoro.href);
  assert(!items.find((i) => i.href.endsWith(uid + '.ics')));

  // wrong password
  let authErr = false;
  try { await new CalDavClient({ url: 'http://127.0.0.1:5232', username: 'prova', password: 'sbagliata' }).discover(); } catch (e) { authErr = e.kind === 'auth'; }
  assert(authErr, 'bad password detected');

  console.log('CALDAV TESTS OK');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
