// Italian natural-language parser for quick add.
// "Chiamare Marco domani alle 10 #Lavoro p1 @telefono" →
// { title: 'Chiamare Marco', due, project, priority, tags, rrule, chips }
(function (root) {
  'use strict';

  const B0 = '(?<![\\p{L}\\p{N}])';
  const B1 = '(?![\\p{L}\\p{N}])';

  const WEEKDAYS = [
    ['domenica'], ['lunedì', 'lunedi', "lunedi'"], ['martedì', 'martedi', "martedi'"],
    ['mercoledì', 'mercoledi', "mercoledi'"], ['giovedì', 'giovedi', "giovedi'"],
    ['venerdì', 'venerdi', "venerdi'"], ['sabato'],
  ];
  const WD_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const MONTHS = [
    ['gennaio', 'gen'], ['febbraio', 'feb'], ['marzo', 'mar'], ['aprile', 'apr'], ['maggio', 'mag'],
    ['giugno', 'giu'], ['luglio', 'lug'], ['agosto', 'ago'], ['settembre', 'set', 'sett'],
    ['ottobre', 'ott'], ['novembre', 'nov'], ['dicembre', 'dic'],
  ];
  const NUM_WORDS = { un: 1, uno: 1, una: 1, "un'": 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10, quindici: 15, venti: 20, trenta: 30 };

  const WD_ALT = WEEKDAYS.flat().map(esc).sort((a, b) => b.length - a.length).join('|');
  const MON_ALT = MONTHS.flat().map(esc).sort((a, b) => b.length - a.length).join('|');
  const NUM_ALT = `\\d+|${Object.keys(NUM_WORDS).map(esc).sort((a, b) => b.length - a.length).join('|')}`;

  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function wdIndex(w) { w = w.toLowerCase(); return WEEKDAYS.findIndex((a) => a.includes(w)); }
  function monIndex(w) { w = w.toLowerCase(); return MONTHS.findIndex((a) => a.includes(w)); }
  function num(w) { w = w.toLowerCase(); return /^\d+$/.test(w) ? parseInt(w, 10) : NUM_WORDS[w]; }
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  // next day after `from` on which a simple rule (daily / listed weekdays) falls; other rules: next day
  function nextRecurDay(rr, from) {
    const m = /BYDAY=([A-Z,]+)/.exec(rr);
    const days = m ? m[1].split(',').map((c) => WD_CODES.indexOf(c)).filter((i) => i >= 0) : null;
    let d = addDays(startOfDay(from), 1);
    if (/FREQ=(DAILY|WEEKLY)/.test(rr) && days && days.length) {
      for (let i = 0; i < 7 && !days.includes(d.getDay()); i++) d = addDays(d, 1);
    }
    return d;
  }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function nextWeekday(from, wd, allowToday) {
    const d = startOfDay(from);
    let diff = (wd - d.getDay() + 7) % 7;
    if (diff === 0 && !allowToday) diff = 7;
    return addDays(d, diff);
  }

  const MONTH_NAMES = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
  const DAY_NAMES = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];

  // ---- end of a recurrence (RRULE UNTIL / COUNT) ----
  // splitRRule('FREQ=WEEKLY;BYDAY=MO;UNTIL=20261130') -> { base:'FREQ=WEEKLY;BYDAY=MO', until:'2026-11-30', count:null }
  function splitRRule(rr) {
    const out = { base: '', until: null, count: null };
    if (!rr) return out;
    const keep = [];
    for (const part of rr.split(';')) {
      const [k, v] = part.split('=');
      if (!k) continue;
      const K = k.toUpperCase();
      if (K === 'UNTIL') {
        const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec((v || '').trim());
        if (m) {
          if (m[4] !== undefined && m[7]) {
            const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
            out.until = ymd(d);
          } else out.until = `${m[1]}-${m[2]}-${m[3]}`;
        }
      } else if (K === 'COUNT') {
        const n = parseInt(v, 10);
        if (n > 0) out.count = n;
      } else keep.push(`${K}=${v}`);
    }
    out.base = keep.join(';');
    return out;
  }
  // joinRRule(base, { until:'YYYY-MM-DD' } | { count:n } | {}, due) -> full RRULE string
  // UNTIL takes the value type of the due date (RFC 5545): a date for all-day tasks,
  // the end of that day in UTC for tasks with a time.
  function joinRRule(base, end, due) {
    if (!base) return null;
    end = end || {};
    if (end.until) {
      const [y, m, d] = end.until.split('-').map(Number);
      let v;
      if (due && !due.allDay) {
        const t = new Date(y, m - 1, d, 23, 59, 59);
        v = `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}Z`;
      } else v = `${y}${pad(m)}${pad(d)}`;
      return `${base};UNTIL=${v}`;
    }
    if (end.count) return `${base};COUNT=${Math.max(1, Math.round(end.count))}`;
    return base;
  }

  function describeRRule(rr) {
    if (!rr) return '';
    const sp = splitRRule(rr);
    let end = '';
    if (sp.until) {
      const [y, m, d] = sp.until.split('-').map(Number);
      end = ` fino al ${d} ${MONTH_NAMES[m - 1].slice(0, 3)}${y !== new Date().getFullYear() ? ' ' + y : ''}`;
    } else if (sp.count) end = sp.count === 1 ? ' per 1 volta' : ` per ${sp.count} volte`;
    return describeBase(sp.base) + end;
  }

  function describeBase(rr) {
    if (!rr) return '';
    const p = {};
    rr.split(';').forEach((kv) => { const [k, v] = kv.split('='); p[k] = v; });
    const n = parseInt(p.INTERVAL || '1', 10);
    if (p.FREQ === 'DAILY') return n === 1 ? 'ogni giorno' : `ogni ${n} giorni`;
    if (p.FREQ === 'WEEKLY') {
      if (p.BYDAY) {
        const codes = p.BYDAY.split(',');
        if (codes.join(',') === 'MO,TU,WE,TH,FR') return 'ogni giorno lavorativo';
        const names = codes.map((c) => DAY_NAMES[WD_CODES.indexOf(c.replace(/^[+-]?\d+/, ''))]).filter(Boolean);
        return (n === 1 ? 'ogni ' : `ogni ${n} settimane, `) + joinIt(names);
      }
      return n === 1 ? 'ogni settimana' : `ogni ${n} settimane`;
    }
    if (p.FREQ === 'MONTHLY') return n === 1 ? 'ogni mese' : `ogni ${n} mesi`;
    if (p.FREQ === 'YEARLY') return n === 1 ? 'ogni anno' : `ogni ${n} anni`;
    return 'ricorrente';
  }
  function joinIt(a) { return a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' e ' + a[a.length - 1]; }

  // lists: [{ id, name }]; options: { now, ignore: Set of raw strings not to interpret }
  function parse(input, lists, options) {
    options = options || {};
    const now = options.now ? new Date(options.now) : new Date();
    const ignore = options.ignore || new Set();
    let s = ' ' + input + ' ';
    const chips = [];
    const res = { project: null, priority: null, tags: [], rrule: null, date: null, time: null };

    function take(re, fn) {
      s = s.replace(re, (...args) => {
        const m = args[0];
        if (ignore.has(m.trim().toLowerCase())) return m;
        const r = fn(...args);
        if (r === false) return m;
        return ' ';
      });
    }

    // #project — prefer the longest list name that matches
    if (lists && lists.length) {
      const sorted = [...lists].sort((a, b) => b.name.length - a.name.length);
      for (const l of sorted) {
        const re = new RegExp(`(^|\\s)#${esc(l.name)}${B1}`, 'iu');
        const m = re.exec(s);
        if (m && !ignore.has(('#' + l.name).toLowerCase())) {
          s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
          res.project = l.id;
          chips.push({ kind: 'project', raw: '#' + l.name, label: l.name });
          break;
        }
      }
    }
    if (!res.project) {
      take(/(^|\s)#([\p{L}\p{N}_-]+)/u, (m, sp, name) => {
        res.projectName = name;
        chips.push({ kind: 'project-new', raw: m.trim(), label: name });
      });
    }

    // @tags
    take(/(^|\s)@([\p{L}\p{N}_\-./]+)/gu, (m, sp, tag) => {
      res.tags.push(tag);
      chips.push({ kind: 'tag', raw: m.trim(), label: tag });
    });

    // priority p1..p4
    take(new RegExp(`${B0}p([1-4])${B1}`, 'iu'), (m, n) => {
      const lvl = { 1: 1, 2: 2, 3: 3, 4: 0 }[n];
      res.priority = lvl;
      chips.push({ kind: 'priority', raw: m, label: ['Nessuna priorità', 'Priorità alta', 'Priorità media', 'Priorità bassa'][lvl], level: lvl });
    });

    // recurrence
    let recurStart = null;
    take(new RegExp(`${B0}ogni\\s+giorno\\s+lavorativo${B1}|${B0}nei\\s+giorni\\s+feriali${B1}`, 'iu'), (m) => {
      res.rrule = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
      chips.push({ kind: 'recur', raw: m, label: 'ogni giorno lavorativo' });
      let d = startOfDay(now);
      while (d.getDay() === 0 || d.getDay() === 6) d = addDays(d, 1);
      recurStart = d;
    });
    take(new RegExp(`${B0}ogni\\s+((?:${WD_ALT})(?:\\s*(?:,|e)\\s*(?:${WD_ALT}))*)${B1}`, 'iu'), (m, days) => {
      const idx = days.split(/\s*(?:,|\se\s)\s*/i).map((w) => wdIndex(w.trim())).filter((i) => i >= 0);
      if (!idx.length) return false;
      res.rrule = 'FREQ=WEEKLY;BYDAY=' + idx.map((i) => WD_CODES[i]).join(',');
      chips.push({ kind: 'recur', raw: m, label: describeRRule(res.rrule) });
      recurStart = idx.map((i) => nextWeekday(now, i, true)).sort((a, b) => a - b)[0];
    });
    take(new RegExp(`${B0}ogni\\s+(?:(${NUM_ALT})\\s+)?(giorn[oi]|settiman[ae]|mes[ei]|ann[oi])${B1}`, 'iu'), (m, n, unit) => {
      const k = n ? num(n) : 1;
      if (!k) return false;
      const u = unit.toLowerCase();
      const freq = u.startsWith('giorn') ? 'DAILY' : u.startsWith('settiman') ? 'WEEKLY' : u.startsWith('mes') ? 'MONTHLY' : 'YEARLY';
      res.rrule = `FREQ=${freq}${k > 1 ? ';INTERVAL=' + k : ''}`;
      chips.push({ kind: 'recur', raw: m, label: describeRRule(res.rrule) });
      recurStart = startOfDay(now);
    });

    // end of the recurrence: "fino al 30/11", "fino al 15 dicembre 2026", "per 10 volte"
    let recurEnd = null;
    if (res.rrule) {
      take(new RegExp(`${B0}fino\\s+(?:al|all'|a|il)?\\s*(\\d{1,2})[/.-](\\d{1,2})(?:[/.-](\\d{2,4}))?${B1}`, 'iu'), (m, d, mo, y) => {
        const dd = +d, mm = +mo;
        if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return false;
        const yy = y ? (+y < 100 ? 2000 + +y : +y) : now.getFullYear();
        let date = new Date(yy, mm - 1, dd);
        if (!y && date < startOfDay(now)) date = new Date(yy + 1, mm - 1, dd);
        recurEnd = { until: ymd(date), raw: m };
      });
      if (!recurEnd) {
        take(new RegExp(`${B0}fino\\s+(?:al|all'|a|il)?\\s*(\\d{1,2})\\s+(${MON_ALT})${B1}(?:\\s+(\\d{4})${B1})?`, 'iu'), (m, d, mon, y) => {
          const mi = monIndex(mon);
          if (mi < 0 || +d < 1 || +d > 31) return false;
          let date = new Date(y ? +y : now.getFullYear(), mi, +d);
          if (!y && date < startOfDay(now)) date = new Date(now.getFullYear() + 1, mi, +d);
          recurEnd = { until: ymd(date), raw: m };
        });
      }
      if (!recurEnd) {
        take(new RegExp(`${B0}fino\\s+a\\s+fine\\s+(mese|anno)${B1}`, 'iu'), (m, what) => {
          const date = what.toLowerCase() === 'mese' ? new Date(now.getFullYear(), now.getMonth() + 1, 0) : new Date(now.getFullYear(), 11, 31);
          recurEnd = { until: ymd(date), raw: m };
        });
      }
      if (!recurEnd) {
        take(new RegExp(`${B0}per\\s+(${NUM_ALT})\\s+volt[ae]${B1}`, 'iu'), (m, n) => {
          const k = num(n);
          if (!k) return false;
          recurEnd = { count: k, raw: m };
        });
      }
    }

    // relative: tra/fra N minuti|ore|giorni|settimane|mesi
    take(new RegExp(`${B0}(?:tra|fra)\\s+(${NUM_ALT})\\s*(minut[oi]|or[ae]|giorn[oi]|settiman[ae]|mes[ei]|ann[oi])${B1}`, 'iu'), (m, n, unit) => {
      const k = num(n);
      if (!k) return false;
      const u = unit.toLowerCase();
      if (u.startsWith('minut') || u.startsWith('or')) {
        const t = new Date(now.getTime() + k * (u.startsWith('minut') ? 60000 : 3600000));
        res.date = startOfDay(t);
        res.time = [t.getHours(), t.getMinutes()];
      } else {
        let d = startOfDay(now);
        if (u.startsWith('giorn')) d = addDays(d, k);
        else if (u.startsWith('settiman')) d = addDays(d, 7 * k);
        else if (u.startsWith('mes')) d.setMonth(d.getMonth() + k);
        else d.setFullYear(d.getFullYear() + k);
        res.date = d;
      }
      chips.push({ kind: 'date', raw: m });
    });

    // named days
    const dayPhrases = [
      [`${B0}dopodomani${B1}`, () => addDays(startOfDay(now), 2)],
      [`${B0}domattina${B1}`, () => { res.time = res.time || [9, 0]; return addDays(startOfDay(now), 1); }],
      [`${B0}domani${B1}`, () => addDays(startOfDay(now), 1)],
      [`${B0}stasera${B1}`, () => { res.time = res.time || [20, 0]; return startOfDay(now); }],
      [`${B0}stamattina${B1}`, () => { res.time = res.time || [9, 0]; return startOfDay(now); }],
      [`${B0}oggi${B1}`, () => startOfDay(now)],
      [`${B0}(?:la\\s+)?(?:prossima\\s+settimana|settimana\\s+prossima)${B1}`, () => nextWeekday(now, 1, false)],
      [`${B0}(?:il\\s+)?(?:prossimo\\s+mese|mese\\s+prossimo)${B1}`, () => new Date(now.getFullYear(), now.getMonth() + 1, 1)],
      [`${B0}(?:a\\s+|entro\\s+)?fine\\s+mese${B1}`, () => new Date(now.getFullYear(), now.getMonth() + 1, 0)],
      [`${B0}(?:a\\s+|entro\\s+)?fine\\s+settimana|${B0}weekend${B1}`, () => nextWeekday(now, 6, true)],
    ];
    if (!res.date) {
      for (const [src, fn] of dayPhrases) {
        let hit = false;
        take(new RegExp(src, 'iu'), (m) => { if (res.date) return false; res.date = fn(); hit = true; chips.push({ kind: 'date', raw: m }); });
        if (hit) break;
      }
    }

    // weekday names: "lunedì", "lunedì prossimo", "prossimo lunedì", "il prossimo venerdì"
    if (!res.date) {
      take(new RegExp(`${B0}(?:(?:il|la)\\s+)?(?:(prossim[oa])\\s+)?(${WD_ALT})(?:\\s+(prossim[oa]))?${B1}`, 'iu'), (m, p1, wd) => {
        if (res.date) return false;
        const i = wdIndex(wd);
        if (i < 0) return false;
        res.date = nextWeekday(now, i, false);
        chips.push({ kind: 'date', raw: m });
      });
    }

    // explicit dates: 25/10, 25-10-2026, 25.10
    if (!res.date) {
      take(new RegExp(`${B0}(?:il\\s+)?(\\d{1,2})[/.-](\\d{1,2})(?:[/.-](\\d{2,4}))?${B1}`, 'u'), (m, d, mo, y) => {
        const dd = +d, mm = +mo;
        if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return false;
        let yy = y ? (+y < 100 ? 2000 + +y : +y) : now.getFullYear();
        let date = new Date(yy, mm - 1, dd);
        if (!y && date < startOfDay(now)) date = new Date(yy + 1, mm - 1, dd);
        res.date = date;
        chips.push({ kind: 'date', raw: m });
      });
    }
    // 25 ottobre (2026)
    if (!res.date) {
      take(new RegExp(`${B0}(?:il\\s+|l')?(\\d{1,2})\\s+(${MON_ALT})${B1}(?:\\s+(\\d{4})${B1})?`, 'iu'), (m, d, mon, y) => {
        const mi = monIndex(mon);
        const dd = +d;
        if (mi < 0 || dd < 1 || dd > 31) return false;
        let yy = y ? +y : now.getFullYear();
        let date = new Date(yy, mi, dd);
        if (!y && date < startOfDay(now)) date = new Date(yy + 1, mi, dd);
        res.date = date;
        chips.push({ kind: 'date', raw: m });
      });
    }
    // "il 25" — next 25th
    if (!res.date) {
      take(new RegExp(`${B0}il\\s+(\\d{1,2})(?![\\p{L}\\p{N}%°.,:/])`, 'iu'), (m, d) => {
        const dd = +d;
        if (dd < 1 || dd > 31) return false;
        let date = new Date(now.getFullYear(), now.getMonth(), dd);
        if (date < startOfDay(now) || date.getDate() !== dd) date = new Date(now.getFullYear(), now.getMonth() + 1, dd);
        res.date = date;
        chips.push({ kind: 'date', raw: m });
      });
    }

    // times: alle 10, alle 10:30, ore 15, h 9, alle 8 di sera
    take(new RegExp(`${B0}(?:alle|all'|ore|h)\\s*(\\d{1,2})(?:[:.](\\d{2}))?(?:\\s+(di\\s+mattina|del\\s+mattino|di\\s+sera|del\\s+pomeriggio|di\\s+notte))?${B1}`, 'iu'), (m, h, mi, part) => {
      let hh = +h; const mm = mi ? +mi : 0;
      if (hh > 23 || mm > 59) return false;
      const p = (part || '').toLowerCase();
      if (/sera|pomeriggio/.test(p) && hh < 12) hh += 12;
      else if (!p && !mi && hh >= 1 && hh <= 7) hh += 12; // "alle 3" = 15:00
      res.time = [hh, mm];
      chips.push({ kind: 'time', raw: m });
    });
    if (res.date && !res.time) {
      take(new RegExp(`${B0}(?:di\\s+|in\\s+)?(mattina|pomeriggio|sera)${B1}`, 'iu'), (m, part) => {
        const p = part.toLowerCase();
        res.time = p === 'mattina' ? [9, 0] : p === 'pomeriggio' ? [15, 0] : [20, 0];
        chips.push({ kind: 'time', raw: m });
      });
    }

    if (!res.date && recurStart) {
      res.date = recurStart;
      // "ogni giorno alle 8" written in the evening: the first one is tomorrow, not this morning
      if (res.time && res.rrule && sameDay(recurStart, now)) {
        const first = new Date(recurStart); first.setHours(res.time[0], res.time[1], 0, 0);
        if (first <= now) res.date = nextRecurDay(res.rrule, recurStart);
      }
    }
    if (res.time && !res.date) {
      const t = new Date(now); t.setHours(res.time[0], res.time[1], 0, 0);
      res.date = t <= now ? addDays(startOfDay(now), 1) : startOfDay(now);
    }

    let due = null;
    if (res.date) {
      if (res.time) {
        const d = new Date(res.date); d.setHours(res.time[0], res.time[1], 0, 0);
        due = { allDay: false, ts: d.getTime() };
      } else due = { allDay: true, date: ymd(res.date) };
    }
    if (res.rrule && recurEnd) {
      res.rrule = joinRRule(res.rrule, recurEnd, due);
      const rc = chips.find((c) => c.kind === 'recur');
      if (rc) { rc.raws = [rc.raw.trim(), recurEnd.raw.trim()]; rc.raw = rc.raws.join(' '); rc.label = describeRRule(res.rrule); }
    }
    // merge date+time chips into a single readable chip
    const dateRaws = chips.filter((c) => c.kind === 'date' || c.kind === 'time').map((c) => c.raw.trim());
    const others = chips.filter((c) => c.kind !== 'date' && c.kind !== 'time');
    if (due) others.unshift({ kind: 'date', raw: dateRaws.join(' '), raws: dateRaws, label: formatDue(due, now) });

    const title = s.replace(/\s{2,}/g, ' ').trim();
    return { title, due, project: res.project, projectName: res.projectName || null, priority: res.priority, tags: res.tags, rrule: res.rrule, chips: others };
  }

  function formatDue(due, now) {
    now = now || new Date();
    let d;
    if (due.allDay) { const [y, m, dd] = due.date.split('-').map(Number); d = new Date(y, m - 1, dd); }
    else d = new Date(due.ts);
    const today = startOfDay(now);
    const diff = Math.round((startOfDay(d) - today) / 86400000);
    let label;
    if (diff === 0) label = 'Oggi';
    else if (diff === 1) label = 'Domani';
    else if (diff === -1) label = 'Ieri';
    else if (diff > 1 && diff < 7) label = cap(DAY_NAMES[d.getDay()]);
    else {
      label = `${d.getDate()} ${MONTH_NAMES[d.getMonth()].slice(0, 3)}`;
      if (d.getFullYear() !== now.getFullYear()) label += ' ' + d.getFullYear();
    }
    if (!due.allDay) label += ` ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return label;
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  const api = { parse, formatDue, describeRRule, splitRRule, joinRRule, DAY_NAMES, MONTH_NAMES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QuickAdd = api;
})(typeof window !== 'undefined' ? window : globalThis);
