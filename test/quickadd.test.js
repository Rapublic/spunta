'use strict';
const assert = require('assert');
const Q = require('../renderer/quickadd');

// Monday 19 Oct 2026, 23:10
const now = new Date(2026, 9, 19, 23, 10);
const lists = [{ id: 'L', name: 'Lavoro' }, { id: 'C', name: 'Casa' }, { id: 'U', name: 'Ufficio Commerciale' }];
const P = (s) => Q.parse(s, lists, { now });
const at = (y, m, d, h, mi) => new Date(y, m - 1, d, h, mi).getTime();

const cases = [
  ['Chiamare Marco domani alle 10 #Lavoro p1 @telefono', (r) => {
    assert.strictEqual(r.title, 'Chiamare Marco');
    assert.deepStrictEqual(r.due, { allDay: false, ts: at(2026, 10, 20, 10, 0) });
    assert.strictEqual(r.project, 'L'); assert.strictEqual(r.priority, 1); assert.deepStrictEqual(r.tags, ['telefono']);
  }],
  ['Riunione #Ufficio Commerciale venerdì', (r) => { assert.strictEqual(r.project, 'U'); assert.strictEqual(r.due.date, '2026-10-23'); assert.strictEqual(r.title, 'Riunione'); }],
  ['Pagare bollo il 25/10', (r) => { assert.strictEqual(r.due.date, '2026-10-25'); assert.strictEqual(r.title, 'Pagare bollo'); }],
  ['Scadenza F24 16 novembre', (r) => assert.strictEqual(r.due.date, '2026-11-16')],
  ['Tagliando 3 marzo', (r) => assert.strictEqual(r.due.date, '2027-03-03')],
  ['Report ogni lunedì', (r) => { assert.strictEqual(r.rrule, 'FREQ=WEEKLY;BYDAY=MO'); assert.strictEqual(r.due.date, '2026-10-19'); assert.strictEqual(r.title, 'Report'); }],
  ['Palestra ogni martedì e giovedì alle 19', (r) => { assert.strictEqual(r.rrule, 'FREQ=WEEKLY;BYDAY=TU,TH'); assert.strictEqual(r.due.ts, at(2026, 10, 20, 19, 0)); }],
  ['Backup ogni 2 settimane', (r) => assert.strictEqual(r.rrule, 'FREQ=WEEKLY;INTERVAL=2')],
  ['Posta ogni giorno lavorativo', (r) => assert.strictEqual(r.rrule, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')],
  ['Richiamare tra 3 giorni', (r) => assert.strictEqual(r.due.date, '2026-10-22')],
  ['Fattura fine mese', (r) => assert.strictEqual(r.due.date, '2026-10-31')],
  ['Telefonata alle 15:30', (r) => assert.strictEqual(r.due.ts, at(2026, 10, 20, 15, 30))],
  ['Cena stasera', (r) => assert.strictEqual(r.due.ts, at(2026, 10, 19, 20, 0))],
  ['Sconto del 25% il 10', (r) => { assert.strictEqual(r.due.date, '2026-11-10'); assert.strictEqual(r.title, 'Sconto del 25%'); }],
  ['Compro latte', (r) => { assert.strictEqual(r.due, null); assert.strictEqual(r.title, 'Compro latte'); }],
  ['Riunione lunedì prossimo alle 9', (r) => assert.strictEqual(r.due.ts, at(2026, 10, 26, 9, 0))],
  ['Nuovo #progettoX oggi', (r) => { assert.strictEqual(r.projectName, 'progettoX'); assert.strictEqual(r.due.date, '2026-10-19'); }],
  ['Chiamare alle 3 domani', (r) => assert.strictEqual(r.due.ts, at(2026, 10, 20, 15, 0))],
  ['Mercato la prossima settimana', (r) => assert.strictEqual(r.due.date, '2026-10-26')],
  ['Lettera domani pomeriggio', (r) => assert.strictEqual(r.due.ts, at(2026, 10, 20, 15, 0))],
];

let ok = 0;
for (const [input, check] of cases) {
  const r = P(input);
  try { check(r); ok++; } catch (e) { console.log('FAIL:', input, JSON.stringify(r), '\n  ', e.message); }
}
// ignore list keeps text in the title
const r = Q.parse('Leggere Domani è un altro giorno', lists, { now, ignore: new Set(['domani']) });
assert.strictEqual(r.due, null); assert.strictEqual(r.title, 'Leggere Domani è un altro giorno');
console.log(`${ok}/${cases.length} quick-add cases ok`);
console.log(Q.formatDue({ allDay: false, ts: at(2026, 10, 20, 10, 0) }, now), '|', Q.formatDue({ allDay: true, date: '2026-12-01' }, now));
if (ok !== cases.length) process.exit(1);
