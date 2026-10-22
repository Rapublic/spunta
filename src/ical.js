'use strict';
// Minimal iCalendar (RFC 5545) reader/writer focused on VTODO.
// Unknown properties and components are preserved on round-trip so that
// data written by Tasks.org, Nextcloud Tasks, Thunderbird etc. is not lost.

const crypto = require('crypto');

// ---------- low level parse / serialize ----------

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}

function splitParams(str) {
  // split on ; or : outside of double quotes
  const parts = [];
  let cur = '';
  let q = false;
  for (const ch of str) {
    if (ch === '"') q = !q;
    if (ch === ';' && !q) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

function parseLine(line) {
  // find first ':' not inside quotes
  let q = false;
  let idx = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ':' && !q) { idx = i; break; }
  }
  if (idx < 0) return null;
  const head = line.slice(0, idx);
  const value = line.slice(idx + 1);
  const [name, ...rawParams] = splitParams(head);
  const params = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    let v = p.slice(eq + 1);
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params[p.slice(0, eq).toUpperCase()] = v;
  }
  return { name: name.toUpperCase(), params, value };
}

function parse(text) {
  const lines = unfold(text).split('\n');
  const root = { name: 'ROOT', props: [], children: [] };
  const stack = [root];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const p = parseLine(raw);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      const c = { name: p.value.trim().toUpperCase(), props: [], children: [] };
      stack[stack.length - 1].children.push(c);
      stack.push(c);
    } else if (p.name === 'END') {
      if (stack.length > 1) stack.pop();
    } else {
      stack[stack.length - 1].props.push(p);
    }
  }
  return root.children[0] || null;
}

function foldLine(line) {
  // fold at 75 octets, not splitting UTF-8 sequences
  const buf = Buffer.from(line, 'utf8');
  if (buf.length <= 75) return line;
  const out = [];
  let start = 0;
  let limit = 75;
  while (start < buf.length) {
    let end = Math.min(start + limit, buf.length);
    while (end < buf.length && (buf[end] & 0xc0) === 0x80) end--;
    out.push(buf.slice(start, end).toString('utf8'));
    start = end;
    limit = 74; // continuation lines start with a space
  }
  return out.join('\r\n ');
}

function quoteParam(v) {
  return /[;:,]/.test(v) ? `"${v}"` : v;
}

function serializeProp(p) {
  const params = Object.entries(p.params || {})
    .map(([k, v]) => `;${k}=${quoteParam(v)}`)
    .join('');
  return foldLine(`${p.name}${params}:${p.value}`);
}

function serialize(comp) {
  const lines = [`BEGIN:${comp.name}`];
  for (const p of comp.props) lines.push(serializeProp(p));
  for (const c of comp.children) lines.push(serialize(c));
  lines.push(`END:${comp.name}`);
  return lines.join('\r\n');
}

function toText(comp) {
  return serialize(comp) + '\r\n';
}

// ---------- text escaping ----------

function unescapeText(v) {
  return (v || '').replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}
function escapeText(v) {
  return String(v || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// ---------- property helpers ----------

function getProp(comp, name) {
  return comp.props.find((p) => p.name === name) || null;
}
function getProps(comp, name) {
  return comp.props.filter((p) => p.name === name);
}
function setProp(comp, name, value, params = {}) {
  const i = comp.props.findIndex((p) => p.name === name);
  const prop = { name, params, value };
  if (i >= 0) comp.props[i] = prop;
  else comp.props.push(prop);
}
function removeProp(comp, name) {
  comp.props = comp.props.filter((p) => p.name !== name);
}

// ---------- dates & time zones ----------

const pad = (n, l = 2) => String(n).padStart(l, '0');

function tzOffsetMs(tz, utcMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const { type, value } of dtf.formatToParts(new Date(utcMs))) parts[type] = value;
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return asUtc - utcMs;
}

function normalizeTzid(tzid) {
  if (!tzid) return null;
  const candidates = [tzid];
  const segs = tzid.split('/').filter(Boolean);
  if (segs.length >= 2) candidates.push(segs.slice(-2).join('/'));
  if (segs.length >= 3) candidates.push(segs.slice(-3).join('/'));
  for (const c of candidates) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: c }); return c; } catch { /* next */ }
  }
  return null;
}

function zonedToEpoch(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let off = tzOffsetMs(tz, guess);
  let t = guess - off;
  const off2 = tzOffsetMs(tz, t);
  if (off2 !== off) t = guess - off2;
  return t;
}

// Returns { allDay: true, date: 'YYYY-MM-DD' } or { allDay: false, ts }
function parseDateProp(prop) {
  if (!prop) return null;
  const v = prop.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (prop.params.VALUE === 'DATE' || h === undefined) {
    return { allDay: true, date: `${y}-${mo}-${d}` };
  }
  let ts;
  if (z) ts = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0));
  else {
    const tz = normalizeTzid(prop.params.TZID);
    if (tz) ts = zonedToEpoch(+y, +mo, +d, +h, +mi, +(s || 0), tz);
    else ts = new Date(+y, +mo - 1, +d, +h, +mi, +(s || 0)).getTime(); // floating
  }
  return { allDay: false, ts };
}

function utcStamp(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function writeDateProp(comp, name, due) {
  if (!due) { removeProp(comp, name); return; }
  if (due.allDay) setProp(comp, name, due.date.replace(/-/g, ''), { VALUE: 'DATE' });
  else setProp(comp, name, utcStamp(due.ts));
}

// Compare two due values; returns ms timestamp used for ordering
function dueSortKey(due) {
  if (!due) return Infinity;
  if (due.allDay) {
    const [y, m, d] = due.date.split('-').map(Number);
    return new Date(y, m - 1, d, 23, 59, 59).getTime();
  }
  return due.ts;
}

// ---------- duration (for VALARM) ----------

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec((v || '').trim());
  if (!m) return null;
  const [, sign, w, d, h, mi, s] = m;
  const ms = ((+w || 0) * 7 * 86400 + (+d || 0) * 86400 + (+h || 0) * 3600 + (+mi || 0) * 60 + (+s || 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

// ---------- recurrence ----------

function parseRRule(v) {
  if (!v) return null;
  const r = {};
  for (const part of v.split(';')) {
    const [k, val] = part.split('=');
    if (k) r[k.toUpperCase()] = val;
  }
  return r;
}
function rruleToString(r) {
  const order = ['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'COUNT', 'UNTIL', 'WKST'];
  const keys = Object.keys(r).sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return keys.filter((k) => r[k] !== undefined && r[k] !== '').map((k) => `${k}=${r[k]}`).join(';');
}

const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// Compute the next occurrence after completing a recurring task.
// base: Date of current due (local). Returns Date or null if series ended.
function nextOccurrence(rr, base, fromNow = false) {
  const freq = rr.FREQ;
  const interval = Math.max(1, parseInt(rr.INTERVAL || '1', 10));
  const days = rr.BYDAY ? rr.BYDAY.split(',').map((x) => x.replace(/^[+-]?\d+/, '')).map((x) => WD.indexOf(x)).filter((x) => x >= 0) : null;
  let d = new Date(base.getTime());
  const step = () => {
    switch (freq) {
      case 'DAILY': d.setDate(d.getDate() + interval); break;
      case 'WEEKLY':
        if (days && days.length) {
          // weeks start on Monday; look for a later listed day in the same week,
          // otherwise jump `interval` weeks ahead and take the first listed day
          const iso = (x) => (x + 6) % 7; // Mon=0 .. Sun=6
          const sorted = [...new Set(days)].sort((a, b) => iso(a) - iso(b));
          const cur = iso(d.getDay());
          const later = sorted.find((x) => iso(x) > cur);
          if (later !== undefined) d.setDate(d.getDate() + (iso(later) - cur));
          else d.setDate(d.getDate() - cur + 7 * interval + iso(sorted[0]));
        } else d.setDate(d.getDate() + 7 * interval);
        break;
      case 'MONTHLY': {
        const day = rr.BYMONTHDAY ? parseInt(rr.BYMONTHDAY, 10) : base.getDate();
        d.setDate(1);
        d.setMonth(d.getMonth() + interval);
        const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        d.setDate(Math.min(day, last));
        break;
      }
      case 'YEARLY': d.setFullYear(d.getFullYear() + interval); break;
      default: d = null;
    }
  };
  step();
  if (!d) return null;
  if (fromNow) {
    let guard = 0;
    const now = new Date();
    while (d && d < now && guard++ < 1000) step();
  }
  if (rr.UNTIL) {
    const u = parseDateProp({ value: rr.UNTIL, params: {} });
    const lim = u ? (u.allDay ? new Date(u.date + 'T23:59:59') : new Date(u.ts)) : null;
    if (lim && d > lim) return null;
  }
  return d;
}

// ---------- VTODO <-> task object ----------

function priorityLevel(p) {
  const n = parseInt(p || '0', 10);
  if (!n) return 0;
  if (n <= 4) return 1;
  if (n === 5) return 2;
  return 3;
}
const LEVEL_TO_PRIORITY = { 0: 0, 1: 1, 2: 5, 3: 9 };

function findTodo(cal) {
  return cal && cal.children.find((c) => c.name === 'VTODO');
}

function todoToTask(ics) {
  const cal = parse(ics);
  const t = findTodo(cal);
  if (!t) return null;
  const val = (n) => { const p = getProp(t, n); return p ? p.value : null; };
  const status = (val('STATUS') || 'NEEDS-ACTION').toUpperCase();
  const percent = parseInt(val('PERCENT-COMPLETE') || '0', 10);
  const completed = status === 'COMPLETED' || percent >= 100 || !!getProp(t, 'COMPLETED');
  const due = parseDateProp(getProp(t, 'DUE'));
  const start = parseDateProp(getProp(t, 'DTSTART'));
  const completedAt = parseDateProp(getProp(t, 'COMPLETED'));
  let parent = null;
  for (const r of getProps(t, 'RELATED-TO')) {
    const type = (r.params.RELTYPE || 'PARENT').toUpperCase();
    if (type === 'PARENT') { parent = r.value.trim(); break; }
  }
  const categories = getProps(t, 'CATEGORIES')
    .flatMap((p) => p.value.split(/(?<!\\),/))
    .map((s) => unescapeText(s).trim())
    .filter(Boolean);
  const alarms = [];
  for (const a of t.children.filter((c) => c.name === 'VALARM')) {
    const tr = getProp(a, 'TRIGGER');
    if (!tr) continue;
    if (tr.params.VALUE === 'DATE-TIME') {
      const d = parseDateProp(tr);
      if (d && !d.allDay) alarms.push({ abs: d.ts });
    } else {
      const off = parseDuration(tr.value);
      if (off !== null) alarms.push({ rel: off, related: (tr.params.RELATED || 'START').toUpperCase() });
    }
  }
  const sortProp = val('X-APPLE-SORT-ORDER');
  return {
    uid: (val('UID') || '').trim(),
    title: unescapeText(val('SUMMARY') || ''),
    notes: unescapeText(val('DESCRIPTION') || ''),
    completed,
    completedAt: completedAt ? (completedAt.allDay ? new Date(completedAt.date).getTime() : completedAt.ts) : null,
    status,
    due,
    start,
    priority: priorityLevel(val('PRIORITY')),
    tags: categories,
    parent,
    rrule: val('RRULE'),
    alarms,
    created: (parseDateProp(getProp(t, 'CREATED')) || {}).ts || null,
    sort: sortProp !== null ? Number(sortProp) : null,
  };
}

function touch(t) {
  const now = utcStamp();
  setProp(t, 'LAST-MODIFIED', now);
  setProp(t, 'DTSTAMP', now);
  const seq = getProp(t, 'SEQUENCE');
  if (seq) setProp(t, 'SEQUENCE', String((parseInt(seq.value, 10) || 0) + 1));
}

function applyCompleted(t, done) {
  if (done) {
    setProp(t, 'STATUS', 'COMPLETED');
    setProp(t, 'PERCENT-COMPLETE', '100');
    setProp(t, 'COMPLETED', utcStamp());
  } else {
    setProp(t, 'STATUS', 'NEEDS-ACTION');
    removeProp(t, 'PERCENT-COMPLETE');
    removeProp(t, 'COMPLETED');
  }
}

function setDueAlarm(t, enable) {
  // our own "at due time" alarm, identified by X-SPUNTA marker or RELATED=END:PT0S
  t.children = t.children.filter((c) => {
    if (c.name !== 'VALARM') return true;
    const tr = getProp(c, 'TRIGGER');
    return !(tr && /^[+-]?PT0[SMH]$/.test(tr.value.trim()) && (tr.params.RELATED || '').toUpperCase() === 'END');
  });
  if (enable) {
    t.children.push({
      name: 'VALARM',
      props: [
        { name: 'TRIGGER', params: { RELATED: 'END' }, value: 'PT0S' },
        { name: 'ACTION', params: {}, value: 'DISPLAY' },
        { name: 'DESCRIPTION', params: {}, value: 'Promemoria' },
      ],
      children: [],
    });
  }
}

// patch: subset of { title, notes, completed, due, priority, tags, parent, rrule, sort }
function applyPatch(ics, patch) {
  const cal = parse(ics);
  const t = findTodo(cal);
  if (!t) throw new Error('VTODO non trovato');
  if ('title' in patch) setProp(t, 'SUMMARY', escapeText(patch.title));
  if ('notes' in patch) {
    if (patch.notes) setProp(t, 'DESCRIPTION', escapeText(patch.notes));
    else removeProp(t, 'DESCRIPTION');
  }
  if ('due' in patch) {
    writeDateProp(t, 'DUE', patch.due);
    const start = parseDateProp(getProp(t, 'DTSTART'));
    if (!patch.due) {
      // keep DTSTART only if it makes sense alone; drop to avoid stale data
      removeProp(t, 'DTSTART');
    } else if (start && dueSortKey(start) > dueSortKey(patch.due)) {
      removeProp(t, 'DTSTART');
    } else if (start && start.allDay !== patch.due.allDay) {
      // RFC 5545: DTSTART and DUE must share value type
      removeProp(t, 'DTSTART');
    }
    setDueAlarm(t, !!(patch.due && !patch.due.allDay));
  }
  if ('priority' in patch) {
    const p = LEVEL_TO_PRIORITY[patch.priority] || 0;
    if (p) setProp(t, 'PRIORITY', String(p)); else removeProp(t, 'PRIORITY');
  }
  if ('tags' in patch) {
    removeProp(t, 'CATEGORIES');
    if (patch.tags && patch.tags.length) setProp(t, 'CATEGORIES', patch.tags.map(escapeText).join(','));
  }
  if ('parent' in patch) {
    t.props = t.props.filter((p) => !(p.name === 'RELATED-TO' && (p.params.RELTYPE || 'PARENT').toUpperCase() === 'PARENT'));
    if (patch.parent) t.props.push({ name: 'RELATED-TO', params: { RELTYPE: 'PARENT' }, value: patch.parent });
  }
  if ('rrule' in patch) {
    if (patch.rrule) setProp(t, 'RRULE', patch.rrule); else removeProp(t, 'RRULE');
  }
  if ('sort' in patch) {
    if (patch.sort === null || patch.sort === undefined) removeProp(t, 'X-APPLE-SORT-ORDER');
    else setProp(t, 'X-APPLE-SORT-ORDER', String(Math.round(patch.sort)));
  }
  if ('completed' in patch) {
    const rrProp = getProp(t, 'RRULE');
    if (patch.completed && rrProp && getProp(t, 'DUE')) {
      // recurring: advance to next occurrence instead of closing the task
      const rr = parseRRule(rrProp.value);
      const due = parseDateProp(getProp(t, 'DUE'));
      const baseDate = due ? (due.allDay ? new Date(due.date + 'T12:00:00') : new Date(due.ts)) : new Date();
      const next = nextOccurrence(rr, baseDate);
      if (next) {
        if (rr.COUNT) {
          const c = parseInt(rr.COUNT, 10) - 1;
          if (c <= 0) { applyCompleted(t, true); touch(t); return toText(cal); }
          rr.COUNT = String(c);
          setProp(t, 'RRULE', rruleToString(rr));
        }
        const shift = next.getTime() - baseDate.getTime();
        if (due) {
          writeDateProp(t, 'DUE', due.allDay
            ? { allDay: true, date: localDateStr(next) }
            : { allDay: false, ts: due.ts + shift });
        }
        const st = parseDateProp(getProp(t, 'DTSTART'));
        if (st) {
          writeDateProp(t, 'DTSTART', st.allDay
            ? { allDay: true, date: localDateStr(new Date(new Date(st.date + 'T12:00:00').getTime() + shift)) }
            : { allDay: false, ts: st.ts + shift });
        }
        applyCompleted(t, false);
        touch(t);
        return toText(cal);
      }
    }
    applyCompleted(t, patch.completed);
  }
  touch(t);
  return toText(cal);
}

function localDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function newTodo(fields) {
  const uid = crypto.randomUUID();
  const now = utcStamp();
  const t = {
    name: 'VTODO',
    props: [
      { name: 'UID', params: {}, value: uid },
      { name: 'CREATED', params: {}, value: now },
      { name: 'LAST-MODIFIED', params: {}, value: now },
      { name: 'DTSTAMP', params: {}, value: now },
      { name: 'SUMMARY', params: {}, value: escapeText(fields.title || '') },
      { name: 'STATUS', params: {}, value: 'NEEDS-ACTION' },
    ],
    children: [],
  };
  const cal = {
    name: 'VCALENDAR',
    props: [
      { name: 'VERSION', params: {}, value: '2.0' },
      { name: 'PRODID', params: {}, value: '-//Spunta//Spunta 1.0//IT' },
    ],
    children: [t],
  };
  const rest = { ...fields };
  delete rest.title;
  delete rest.completed;
  let ics = toText(cal);
  if (Object.keys(rest).length) ics = applyPatch(ics, rest);
  return { uid, ics };
}

module.exports = {
  parse, serialize, toText, todoToTask, applyPatch, newTodo,
  parseDateProp, utcStamp, nextOccurrence, parseRRule, rruleToString,
  dueSortKey, escapeText, unescapeText, localDateStr, parseDuration,
};
