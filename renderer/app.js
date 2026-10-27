/* Spunta — renderer */
(function () {
  'use strict';
  const api = window.spunta;
  const Q = window.QuickAdd;

  // ---------------- state ----------------
  let S = { lists: [], tasks: [], status: {}, account: null, settings: {} };
  const ui = {
    view: 'today',
    prevView: 'today',
    selected: null,          // uid
    collapsed: new Set(),
    showDone: false,
    search: '',
    qaIgnore: new Set(),
    pendingDone: new Map(),  // uid -> timer
    flash: null,
    detailDirty: false,
  };
  let byUid = new Map();
  let childrenOf = new Map();

  const $ = (sel, root = document) => root.querySelector(sel);
  const el = {
    sidebar: $('#sidebar'), list: $('#list'), head: $('#viewHead'), detail: $('#detail'),
    qa: $('#quickadd'), qaInput: $('#qaInput'), qaChips: $('#qaChips'), search: $('#search'),
    toasts: $('#toasts'), modal: $('#modal'), onboarding: $('#onboarding'), main: $('#main'),
  };

  // ---------------- helpers ----------------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayKey = () => ymd(new Date());
  const addDaysKey = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
  const keyToDate = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const dateKey = (t) => (t.due ? (t.due.allDay ? t.due.date : ymd(new Date(t.due.ts))) : null);
  const timeOf = (t) => (t.due && !t.due.allDay ? new Date(t.due.ts) : null);
  const fmtTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const longDate = (k) => { const d = keyToDate(k); return `${Q.DAY_NAMES[d.getDay()]} ${d.getDate()} ${Q.MONTH_NAMES[d.getMonth()]}`; };

  const FALLBACK_COLORS = ['#2457a6', '#2f7d4f', '#c77d10', '#8a4fb3', '#c8372d', '#2a8a8a', '#6b7785'];
  const listByHref = (h) => S.lists.find((l) => l.href === h);
  function colorOf(list) {
    if (!list) return 'var(--ink-3)';
    if (list.color) return list.color;
    return FALLBACK_COLORS[Math.max(0, S.lists.indexOf(list)) % FALLBACK_COLORS.length];
  }
  const writableLists = () => S.lists.filter((l) => !l.readOnly);
  function defaultListHref() {
    const d = S.settings.defaultList && listByHref(S.settings.defaultList);
    if (d && !d.readOnly) return d.href;
    const w = writableLists()[0];
    return w ? w.href : null;
  }

  const ICONS = {
    today: '<rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M4 9.5h16M8.5 3v4M15.5 3v4"/><path d="M9.5 14.5l1.8 1.6 3.4-3.6"/>',
    upcoming: '<rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M4 9.5h16M8.5 3v4M15.5 3v4M8 13.5h2M12 13.5h4M8 16.5h5"/>',
    all: '<path d="M9 7h11M9 12h11M9 17h11"/><circle cx="5" cy="7" r="1"/><circle cx="5" cy="12" r="1"/><circle cx="5" cy="17" r="1"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    sync: '<path d="M20 11a8 8 0 0 0-14.3-4.3L4 9M4 4v5h5M4 13a8 8 0 0 0 14.3 4.3L20 15M20 20v-5h-5"/>',
    cal: '<rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M4 9.5h16M8.5 3v4M15.5 3v4"/>',
    repeat: '<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/>',
    note: '<path d="M5 4h14v16H5z"/><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4"/>',
    tag: '<path d="M3.5 12.5V5a1.5 1.5 0 0 1 1.5-1.5h7.5L21 12l-8.5 8.5z"/><circle cx="8" cy="8" r="1.3"/>',
    sub: '<path d="M6 4v9a3 3 0 0 0 3 3h10M15 12l4 4-4 4"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  };
  const icon = (n) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;
  const TICK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.8c1.6 1.2 3.2 2.7 4.6 4.6C11.6 12.9 15 8.9 19.6 5.8"/></svg>';
  const PRIO_LABEL = ['Nessuna', 'Alta', 'Media', 'Bassa'];

  // ---------------- indexing & sorting ----------------
  function reindex() {
    byUid = new Map(S.tasks.map((t) => [t.uid, t]));
    childrenOf = new Map();
    for (const t of S.tasks) {
      if (t.parent && byUid.has(t.parent)) {
        if (!childrenOf.has(t.parent)) childrenOf.set(t.parent, []);
        childrenOf.get(t.parent).push(t);
      }
    }
  }
  const isRoot = (t) => !(t.parent && byUid.has(t.parent));
  const isOpen = (t) => !t.completed || ui.pendingDone.has(t.uid);

  function cmpDay(a, b) {
    const ta = timeOf(a), tb = timeOf(b);
    if (ta && tb) return ta - tb;
    if (ta) return -1;
    if (tb) return 1;
    return prioRank(a) - prioRank(b) || cmpTitle(a, b);
  }
  const prioRank = (t) => (t.priority ? t.priority : 9);
  const cmpTitle = (a, b) => (a.title || '').localeCompare(b.title || '', 'it');
  const dueRank = (t) => (t.due ? (t.due.allDay ? keyToDate(t.due.date).getTime() + 86399000 : t.due.ts) : Infinity);
  function cmpList(a, b) {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    if (a.sort !== null && b.sort !== null && a.sort !== b.sort) return a.sort - b.sort;
    return dueRank(a) - dueRank(b) || prioRank(a) - prioRank(b) || (a.created || 0) - (b.created || 0) || cmpTitle(a, b);
  }

  // ---------------- rendering: rows ----------------
  function dueMeta(t) {
    if (!t.due) return '';
    const k = dateKey(t);
    const today = todayKey();
    let cls = '';
    if (!t.completed) {
      if (k < today || (!t.due.allDay && t.due.ts < Date.now() && k === today)) cls = 'late';
      else if (k === today) cls = 'today';
    }
    return `<span class="${cls}">${icon('cal')}${esc(Q.formatDue(t.due))}${t.rrule ? ' ' + icon('repeat') : ''}</span>`;
  }

  function row(t, opts = {}) {
    const kids = childrenOf.get(t.uid) || [];
    const openKids = kids.filter((k) => !k.completed);
    const list = listByHref(t.listHref);
    const meta = [];
    if (opts.showDate !== false) meta.push(dueMeta(t));
    else if (timeOf(t)) meta.push(`<span>${esc(fmtTime(timeOf(t)))}${t.rrule ? ' ' + icon('repeat') : ''}</span>`);
    else if (t.rrule) meta.push(`<span>${icon('repeat')}${esc(Q.describeRRule(t.rrule))}</span>`);
    if (kids.length) meta.push(`<span>${icon('sub')}${kids.length - openKids.length}/${kids.length}</span>`);
    if (t.notes) meta.push(`<span title="Ha delle note">${icon('note')}</span>`);
    for (const tag of t.tags || []) meta.push(`<span>${icon('tag')}${esc(tag)}</span>`);
    if (opts.showParent && t.parent && byUid.has(t.parent)) meta.push(`<span class="parent">in ${esc(byUid.get(t.parent).title)}</span>`);
    if (opts.showList && list) meta.push(`<span class="list"><i class="dot" style="background:${esc(colorOf(list))}"></i>${esc(list.name)}</span>`);

    const twisty = opts.tree && kids.length
      ? `<button class="twisty" data-act="toggle" aria-expanded="${!ui.collapsed.has(t.uid)}" aria-label="Mostra o nascondi sottoattività">${icon('chevron')}</button>`
      : '<span></span>';
    const pending = ui.pendingDone.has(t.uid);
    const done = t.completed && !pending;
    return `<div class="task${done ? ' completed' : ''}${ui.selected === t.uid ? ' selected' : ''}${pending ? ' leaving' : ''}" data-uid="${esc(t.uid)}" style="--indent:${opts.indent || 0}">
      ${twisty}
      <button class="check${t.priority ? ' p' + t.priority : ''}${pending ? ' done' : ''}" data-act="check" aria-label="${done ? 'Riapri' : 'Completa'}: ${esc(t.title)}">${TICK}</button>
      <div class="body" data-act="open">
        <div class="title">${esc(t.title) || '<em>Senza titolo</em>'}</div>
        <div class="meta">${meta.join('')}</div>
      </div>
    </div>`;
  }

  function tree(roots, depth, opts) {
    let html = '';
    for (const t of roots.sort(cmpList)) {
      html += row(t, { ...opts, tree: true, indent: depth });
      const kids = (childrenOf.get(t.uid) || []).filter((k) => ui.showDone || isOpen(k));
      if (kids.length && !ui.collapsed.has(t.uid)) html += tree(kids, depth + 1, opts);
    }
    return html;
  }

  function section(title, sub, body, cls = '', count) {
    return `<section class="section"><div class="section-head ${cls}"><h2>${esc(title)}</h2>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}${count ? `<span class="count">${count}</span>` : ''}</div>${body}</section>`;
  }

  function emptyState(title, text) {
    return `<div class="empty-state"><strong>${esc(title)}</strong>${esc(text)}</div>`;
  }

  // ---------------- rendering: views ----------------
  function renderMain() {
    const v = ui.search ? 'search' : ui.view;
    let head = '', body = '';
    const open = S.tasks.filter(isOpen);
    const today = todayKey();

    if (v === 'today') {
      const d = new Date();
      head = `<h1>Oggi</h1><p>${esc(cap(longDate(today)))}</p>`;
      const late = open.filter((t) => t.due && dateKey(t) < today).sort((a, b) => dueRank(a) - dueRank(b));
      const now = open.filter((t) => t.due && dateKey(t) === today).sort(cmpDay);
      if (late.length) body += section('In ritardo', '', late.map((t) => row(t, { showList: true, showParent: true })).join(''), 'late', late.length);
      if (now.length) body += section('Oggi', '', now.map((t) => row(t, { showList: true, showParent: true, showDate: false })).join(''), '', now.length);
      if (!late.length && !now.length) body = emptyState('Giornata libera', 'Non hai niente in scadenza oggi. Scrivi qui sopra cosa devi fare: senza una data, la mettiamo per oggi.');
      void d;
    } else if (v === 'upcoming') {
      head = '<h1>Prossimi 7 giorni</h1>';
      for (let i = 0; i < 7; i++) {
        const k = addDaysKey(i);
        const items = open.filter((t) => t.due && (i === 0 ? dateKey(t) <= k : dateKey(t) === k)).sort((a, b) => (dateKey(a) < dateKey(b) ? -1 : dateKey(a) > dateKey(b) ? 1 : cmpDay(a, b)));
        const dd = keyToDate(k);
        const title = i === 0 ? 'Oggi' : i === 1 ? 'Domani' : cap(Q.DAY_NAMES[dd.getDay()]);
        const sub = `${dd.getDate()} ${Q.MONTH_NAMES[dd.getMonth()]}`;
        body += section(title, sub, items.map((t) => row(t, { showList: true, showParent: true, showDate: i === 0 ? dateKey(t) < today : false })).join(''), items.length ? '' : 'empty', items.length || '');
      }
      const later = open.filter((t) => t.due && dateKey(t) > addDaysKey(6)).sort((a, b) => dueRank(a) - dueRank(b));
      if (later.length) body += section('Più avanti', '', later.map((t) => row(t, { showList: true, showParent: true })).join(''), '', later.length);
    } else if (v === 'all') {
      head = '<h1>Tutte le attività</h1>';
      for (const l of S.lists) {
        const roots = S.tasks.filter((t) => t.listHref === l.href && isRoot(t) && isOpen(t));
        if (!roots.length) continue;
        body += section(l.name, '', tree(roots, 0, {}), '', roots.length);
      }
      if (!body) body = emptyState('Nessuna attività aperta', 'Tutto fatto. Aggiungine una nuova qui sopra.');
    } else if (v === 'search') {
      const q = ui.search.toLowerCase();
      const hits = S.tasks.filter((t) => (t.title || '').toLowerCase().includes(q) || (t.notes || '').toLowerCase().includes(q) || (t.tags || []).some((g) => g.toLowerCase().includes(q)));
      head = `<h1>Risultati per “${esc(ui.search)}”</h1>`;
      const o = hits.filter((t) => !t.completed).sort((a, b) => dueRank(a) - dueRank(b));
      const c = hits.filter((t) => t.completed).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
      if (o.length) body += section('Da fare', '', o.map((t) => row(t, { showList: true, showParent: true })).join(''), '', o.length);
      if (c.length) body += section('Completate', '', c.slice(0, 50).map((t) => row(t, { showList: true })).join(''), '', c.length);
      if (!hits.length) body = emptyState('Nessun risultato', 'Prova con un’altra parola: cerco nei titoli, nelle note e nelle etichette.');
    } else if (v.startsWith('list:')) {
      const href = v.slice(5);
      const l = listByHref(href);
      if (!l) { ui.view = 'today'; return renderMain(); }
      head = `<h1><i class="dot" style="background:${esc(colorOf(l))}"></i>${esc(l.name)}${l.readOnly ? ` <span title="Lista in sola lettura" style="color:var(--ink-3)">${icon('lock')}</span>` : ''}</h1>`;
      const all = S.tasks.filter((t) => t.listHref === href);
      const roots = all.filter((t) => isRoot(t) && (ui.showDone || isOpen(t)));
      body = roots.length ? tree(roots, 0, {}) : emptyState('Questo progetto è vuoto', 'Aggiungi la prima attività qui sopra.');
      const doneCount = all.filter((t) => t.completed).length;
      if (doneCount) body += `<button class="show-completed" data-act="toggle-done">${ui.showDone ? 'Nascondi le completate' : `Mostra le completate (${doneCount})`}</button>`;
    }

    el.head.innerHTML = head;
    el.list.innerHTML = body;
    el.qa.hidden = v === 'search' || (v.startsWith('list:') && listByHref(v.slice(5))?.readOnly);
    if (ui.flash) {
      const r = el.list.querySelector(`[data-uid="${CSS.escape(ui.flash)}"]`);
      if (r) r.animate([{ background: 'var(--biro-soft)' }, { background: 'transparent' }], { duration: 1200, easing: 'ease-out' });
      ui.flash = null;
    }
  }

  function renderSidebar() {
    const today = todayKey();
    const open = S.tasks.filter((t) => !t.completed);
    const nToday = open.filter((t) => t.due && dateKey(t) === today).length;
    const nLate = open.filter((t) => t.due && dateKey(t) < today).length;
    const nWeek = open.filter((t) => t.due && dateKey(t) <= addDaysKey(6)).length;
    const cur = (v) => (ui.view === v && !ui.search ? 'true' : 'false');
    const item = (v, ic, label, count, extra = '') =>
      `<button class="nav-item" data-view="${esc(v)}" aria-current="${cur(v)}">${ic}<span class="label">${esc(label)}</span>${extra}${count ? `<span class="count">${count}</span>` : ''}</button>`;

    let lists = '';
    for (const l of S.lists) {
      const n = open.filter((t) => t.listHref === l.href).length;
      lists += item('list:' + l.href, `<i class="dot" style="background:${esc(colorOf(l))}"></i>`, l.name, n || '', l.readOnly ? `<span title="Sola lettura" style="color:var(--ink-3)">${icon('lock')}</span>` : '');
    }
    const st = S.status || {};
    let stCls = '', stText;
    if (!S.account) { stText = 'Non collegato'; stCls = 'offline'; }
    else if (st.error) { stText = 'Problema: ' + st.error; stCls = 'error'; }
    else if (st.syncing) { stText = 'Sincronizzazione…'; stCls = 'busy'; }
    else if (!st.online) { stText = st.pending ? `Offline, ${st.pending} ${st.pending === 1 ? 'modifica' : 'modifiche'} in attesa` : 'Offline'; stCls = 'offline'; }
    else if (st.pending) { stText = `Invio ${st.pending} ${st.pending === 1 ? 'modifica' : 'modifiche'}…`; stCls = 'busy'; }
    else if (st.lastSync) { stText = `Aggiornato alle ${fmtTime(new Date(st.lastSync))}`; }
    else stText = 'Pronto';

    el.sidebar.innerHTML = `
      <div class="nav-group">
        ${item('today', icon('today'), 'Oggi', nToday || '', nLate ? `<span class="count late" title="${nLate} in ritardo">${nLate}</span>` : '')}
        ${item('upcoming', icon('upcoming'), 'Prossimi 7 giorni', nWeek || '')}
        ${item('all', icon('all'), 'Tutte le attività', open.length || '')}
      </div>
      <div class="nav-group">
        <div class="nav-title"><span>Progetti</span><button data-act="new-list" title="Nuovo progetto" aria-label="Nuovo progetto">${icon('plus')}</button></div>
        ${lists || (S.account ? '<p class="hint" style="padding:0 8px">Nessuna lista di attività sul server. <a href="#" data-act="why-nolists" style="color:var(--biro)">Perché?</a></p>' : '')}
      </div>
      <div class="sidebar-foot">
        <button class="status ${stCls}" data-act="sync" title="${esc(stText)} — clic per sincronizzare"><i class="led"></i><span class="label" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(stText)}</span></button>
        <button class="icon-btn" data-act="settings" title="Impostazioni" aria-label="Impostazioni">${icon('gear')}</button>
      </div>`;
  }

  // ---------------- detail panel ----------------
  const RRULES = [
    ['', 'Non si ripete'],
    ['FREQ=DAILY', 'Ogni giorno'],
    ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'Ogni giorno lavorativo'],
    ['FREQ=WEEKLY', 'Ogni settimana'],
    ['FREQ=MONTHLY', 'Ogni mese'],
    ['FREQ=YEARLY', 'Ogni anno'],
  ];

  function renderDetail(force) {
    const t = ui.selected && byUid.get(ui.selected);
    if (!t) { el.detail.hidden = true; el.detail.innerHTML = ''; return; }
    const active = document.activeElement;
    // keep the empty "add subtask" field focused across re-renders
    const refocusSub = el.detail.contains(active) && active.dataset.f === 'newsub' && !active.value;
    if (!force && !refocusSub && el.detail.contains(active) && /INPUT|TEXTAREA|SELECT/.test(active.tagName) && el.detail.dataset.uid === t.uid) {
      ui.detailDirty = true;
      return;
    }
    const scroll = el.detail.scrollTop;
    ui.detailDirty = false;
    el.detail.hidden = false;
    el.detail.dataset.uid = t.uid;
    const list = listByHref(t.listHref);
    const ro = list && list.readOnly;
    const k = dateKey(t);
    const tm = timeOf(t);
    const rsp = Q.splitRRule(t.rrule);
    let rr = RRULES.map(([v, l]) => `<option value="${v}"${rsp.base === v ? ' selected' : ''}>${l}</option>`).join('');
    if (rsp.base && !RRULES.some(([v]) => v === rsp.base)) rr += `<option value="${esc(rsp.base)}" selected>${esc(cap(Q.describeRRule(rsp.base)))}</option>`;
    const rEnd = rsp.until ? 'until' : rsp.count ? 'count' : 'never';
    const rEndHtml = rsp.base ? `
          <div class="row">
            <label for="f-rend" class="hint">Termina</label>
            <select class="input" id="f-rend" data-f="rend" ${ro ? 'disabled' : ''}>
              <option value="never"${rEnd === 'never' ? ' selected' : ''}>Mai</option>
              <option value="until"${rEnd === 'until' ? ' selected' : ''}>Il giorno…</option>
              <option value="count"${rEnd === 'count' ? ' selected' : ''}>Dopo un numero di volte</option>
            </select>
            ${rEnd === 'until' ? `<input class="input" type="date" data-f="runtil" value="${esc(rsp.until)}" aria-label="Ultimo giorno della ripetizione" ${ro ? 'disabled' : ''}>` : ''}
            ${rEnd === 'count' ? `<input class="input" type="number" min="1" max="999" data-f="rcount" value="${rsp.count}" aria-label="Numero di volte" style="width:84px" ${ro ? 'disabled' : ''}><span class="hint">${rsp.count === 1 ? 'volta' : 'volte'}</span>` : ''}
          </div>
          ${rsp.until && k && rsp.until < k ? '<p class="hint" style="color:var(--late)">La fine è prima della scadenza: dopo questa volta l\'attività non si ripete più.</p>' : ''}
          ${rsp.count ? '<p class="hint">Il numero scende di uno a ogni completamento.</p>' : ''}` : '';
    const kids = (childrenOf.get(t.uid) || []).slice().sort(cmpList);
    const listOpts = S.lists.filter((l) => !l.readOnly || l.href === t.listHref)
      .map((l) => `<option value="${esc(l.href)}"${l.href === t.listHref ? ' selected' : ''}>${esc(l.name)}</option>`).join('');
    const parent = t.parent && byUid.get(t.parent);

    el.detail.innerHTML = `
      <div class="detail-head">
        <select class="input" data-f="list" aria-label="Progetto" ${ro ? 'disabled' : ''}>${listOpts}</select>
        <button class="icon-btn" data-act="close" title="Chiudi (Esc)" aria-label="Chiudi">${icon('x')}</button>
      </div>
      <div class="detail-body">
        ${parent ? `<button class="quick" data-act="open-parent" style="align-self:flex-start">${icon('sub')} In “${esc(parent.title)}”</button>` : ''}
        <div class="detail-title">
          <button class="check${t.priority ? ' p' + t.priority : ''}${t.completed ? ' done' : ''}" data-act="check" aria-label="${t.completed ? 'Riapri' : 'Completa'}">${TICK}</button>
          <textarea data-f="title" rows="1" aria-label="Titolo" ${ro ? 'readonly' : ''}>${esc(t.title)}</textarea>
        </div>
        <div class="field">
          <span class="flabel">Scadenza</span>
          <div class="row">
            <input class="input" type="date" data-f="date" value="${k || ''}" aria-label="Data" ${ro ? 'disabled' : ''}>
            <input class="input" type="time" data-f="time" value="${tm ? fmtTime(tm) : ''}" aria-label="Ora" ${ro || !k ? 'disabled' : ''}>
          </div>
          ${ro ? '' : `<div class="row">
            <button class="quick" data-act="due" data-v="0">Oggi</button>
            <button class="quick" data-act="due" data-v="1">Domani</button>
            <button class="quick" data-act="due" data-v="mon">Lunedì prossimo</button>
            ${k ? '<button class="quick" data-act="due" data-v="none">Nessuna data</button>' : ''}
          </div>`}
          ${tm ? `<p class="hint">${icon('bell')} Riceverai un avviso all'ora di scadenza, anche sul telefono.</p>` : ''}
        </div>
        <div class="field">
          <label for="f-rr">Ripetizione</label>
          <select class="input" id="f-rr" data-f="rrule" ${ro ? 'disabled' : ''}>${rr}</select>${rEndHtml}
        </div>
        <div class="field">
          <span class="flabel">Priorità</span>
          <div class="seg" role="group" aria-label="Priorità">
            ${[1, 2, 3, 0].map((p) => `<button data-act="prio" data-v="${p}" aria-pressed="${t.priority === p}" ${ro ? 'disabled' : ''}><i class="flag" style="--c:${p ? `var(--p${p})` : 'var(--rule)'}"></i>${PRIO_LABEL[p]}</button>`).join('')}
          </div>
        </div>
        <div class="field">
          <label for="f-tags">Etichette</label>
          <input class="input" id="f-tags" data-f="tags" value="${esc((t.tags || []).join(', '))}" placeholder="es. telefono, ufficio" ${ro ? 'readonly' : ''}>
        </div>
        <div class="field">
          <label for="f-notes">Note</label>
          <textarea class="input" id="f-notes" data-f="notes" placeholder="Dettagli, numeri di telefono, link…" ${ro ? 'readonly' : ''}>${esc(t.notes)}</textarea>
        </div>
        <div class="field">
          <span class="flabel">Sottoattività${kids.length ? ` (${kids.filter((x) => x.completed).length}/${kids.length})` : ''}</span>
          <div class="subtasks">
            ${kids.map((c) => row(c, { indent: 0 }).replace('<span></span>', '')).join('')}
            ${ro ? '' : `<label class="sub-add">${icon('plus')}<input data-f="newsub" placeholder="Aggiungi sottoattività" aria-label="Aggiungi sottoattività"></label>`}
          </div>
        </div>
      </div>
      <div class="detail-foot">
        <span>${t.created ? 'Creata il ' + esc(new Date(t.created).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' })) : ''}</span>
        <span class="spacer"></span>
        ${ro ? '' : `<button class="btn ghost danger" data-act="delete">${icon('trash')}Elimina</button>`}
      </div>`;
    autosize(el.detail.querySelector('textarea[data-f=title]'));
    if (el.detail.dataset.prev === t.uid) el.detail.scrollTop = scroll;
    el.detail.dataset.prev = t.uid;
    if (refocusSub) { const inp = el.detail.querySelector('[data-f=newsub]'); if (inp) inp.focus(); }
  }

  function autosize(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  function render() {
    reindex();
    renderSidebar();
    renderMain();
    renderDetail();
    el.onboarding.hidden = !!S.account;
    if (!S.account && !el.onboarding.innerHTML) renderOnboarding();
  }

  // ---------------- actions ----------------
  async function run(fn, errPrefix) {
    try { return await fn(); } catch (e) { toast((errPrefix ? errPrefix + ': ' : '') + e.message); return undefined; }
  }

  function selectTask(uid) {
    ui.selected = uid;
    renderMain();
    renderDetail(true);
  }

  function complete(uid) {
    const t = byUid.get(uid);
    if (!t) return;
    if (t.completed) {
      run(() => api.updateTask(t.href, { completed: false }));
      toast(`Riaperta: ${t.title}`);
      return;
    }
    if (ui.pendingDone.has(uid)) {
      clearTimeout(ui.pendingDone.get(uid));
      ui.pendingDone.delete(uid);
      render();
      return;
    }
    const prevDue = t.due;
    const timer = setTimeout(async () => {
      ui.pendingDone.delete(uid);
      const cur = byUid.get(uid) || t;
      const res = await run(() => api.updateTask(cur.href, { completed: true }));
      if (res && t.rrule && !res.completed && res.due) {
        toast(`Fatta. Prossima volta: ${Q.formatDue(res.due)}`, 'Annulla', () => run(() => api.updateTask(res.href, { due: prevDue })));
      }
    }, 700);
    ui.pendingDone.set(uid, timer);
    // draw the tick in place, without a full re-render
    document.querySelectorAll(`[data-uid="${CSS.escape(uid)}"] .check, #detail[data-uid="${CSS.escape(uid)}"] .detail-title .check`).forEach((b) => b.classList.add('done'));
    document.querySelectorAll(`.list [data-uid="${CSS.escape(uid)}"]`).forEach((r) => r.classList.add('leaving'));
    if (!t.rrule) {
      toast(`Completata: ${t.title}`, 'Annulla', () => {
        if (ui.pendingDone.has(uid)) { clearTimeout(ui.pendingDone.get(uid)); ui.pendingDone.delete(uid); render(); }
        else { const cur = byUid.get(uid); if (cur) run(() => api.updateTask(cur.href, { completed: false })); }
      });
    }
  }

  function patchSelected(patch) {
    const t = byUid.get(ui.selected);
    if (!t) return;
    return run(() => api.updateTask(t.href, patch));
  }

  async function addFromQuickAdd(createdListHref) {
    const raw = el.qaInput.value;
    const p = Q.parse(raw, writableLists().map((l) => ({ id: l.href, name: l.name })), { ignore: ui.qaIgnore });
    if (!p.title) { el.qaInput.focus(); return; }
    let listHref = p.project;
    if (!listHref && p.projectName) {
      const created = await run(() => api.createList(p.projectName, null), 'Non riesco a creare il progetto');
      if (!created) return;
      listHref = created.href;
    }
    const v = ui.view;
    if (!listHref && v.startsWith('list:')) listHref = v.slice(5);
    if (!listHref) listHref = defaultListHref();
    if (!listHref && createdListHref) listHref = createdListHref;
    if (!listHref) {
      // no task list yet: ask to create one, then save this task into it
      openNewList({
        name: 'Personale',
        title: 'Serve una lista per salvare l’attività',
        lead: `“${p.title}” va messa in una lista. Sul tuo Nextcloud non ce n’è ancora nessuna: creane una adesso (puoi cambiare il nome). Comparirà anche in Tasks.org sul telefono.`,
        button: 'Crea la lista e salva',
        onCreated: (l) => addFromQuickAdd(l.href),
      });
      return;
    }
    let due = p.due;
    // in Oggi/Prossimi a task without a date goes to today, unless a project was named
    // explicitly (#Prima o poi): then the user wants it in that list, with no date
    if (!due && !p.project && !p.projectName && (v === 'today' || v === 'upcoming')) due = { allDay: true, date: todayKey() };
    const fields = { title: p.title };
    if (due) fields.due = due;
    if (p.priority !== null && p.priority !== undefined) fields.priority = p.priority;
    if (p.tags.length) fields.tags = p.tags;
    if (p.rrule) fields.rrule = p.rrule;
    const t = await run(() => api.createTask(listHref, fields), 'Non riesco ad aggiungere l’attività');
    if (!t) return;
    el.qaInput.value = '';
    ui.qaIgnore.clear();
    renderChips();
    ui.flash = t.uid;
    // tell the user where it went if it is not visible here
    const k = due ? (due.allDay ? due.date : ymd(new Date(due.ts))) : null;
    const visible = (v === 'today' && k && k <= todayKey()) || (v === 'upcoming' && k) || v === 'all' || v === 'list:' + listHref;
    if (!visible) {
      const l = listByHref(listHref);
      toast(`Aggiunta a ${l ? l.name : 'progetto'}${due ? ', ' + Q.formatDue(due) : ''}`, 'Mostra', () => { setView('list:' + listHref); selectTask(t.uid); });
    }
  }

  function renderChips() {
    const raw = el.qaInput.value;
    if (!raw.trim()) { el.qaChips.innerHTML = ''; return; }
    const p = Q.parse(raw, writableLists().map((l) => ({ id: l.href, name: l.name })), { ignore: ui.qaIgnore });
    el.qaChips.innerHTML = p.chips.map((c) => {
      let ic = '', cls = 'chip', label = c.label;
      if (c.kind === 'date') { ic = icon('cal'); cls += ' date'; }
      else if (c.kind === 'project') { const l = listByHref(c.label) || S.lists.find((x) => x.name === c.label); ic = `<i class="dot" style="background:${esc(colorOf(l))}"></i>`; }
      else if (c.kind === 'project-new') { ic = icon('plus'); label = `Nuovo progetto: ${c.label}`; }
      else if (c.kind === 'tag') ic = icon('tag');
      else if (c.kind === 'priority') cls += c.level ? ' p' + c.level : '';
      else if (c.kind === 'recur') ic = icon('repeat');
      const raws = (c.raws || [c.raw]).map((r) => r.trim().toLowerCase());
      return `<button type="button" class="${cls}" data-ignore="${esc(JSON.stringify(raws))}" title="Clic per lasciarlo nel testo">${ic}${esc(label)}<span class="x">×</span></button>`;
    }).join('');
  }

  function setView(v) {
    ui.view = v;
    ui.showDone = false;
    if (ui.search) { ui.search = ''; el.search.value = ''; }
    renderSidebar();
    renderMain();
    el.main.scrollTop = 0;
  }

  function nextMonday() { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return ymd(d); }

  // ---------------- event wiring ----------------
  el.sidebar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-view],[data-act]');
    if (!b) return;
    if (b.dataset.view) return setView(b.dataset.view);
    if (b.dataset.act === 'sync') return run(() => api.sync(), 'Sincronizzazione non riuscita');
    if (b.dataset.act === 'settings') return openSettings();
    if (b.dataset.act === 'new-list') return openNewList({});
    if (b.dataset.act === 'why-nolists') { e.preventDefault(); return showNoListsHelp(S.scan); }
  });

  function onTaskAreaClick(e) {
    const actEl = e.target.closest('[data-act]');
    const rowEl = e.target.closest('[data-uid]');
    const uid = rowEl && rowEl.dataset.uid;
    if (!actEl) return;
    const act = actEl.dataset.act;
    if (act === 'check' && uid) { e.stopPropagation(); complete(uid); }
    else if (act === 'check' && el.detail.contains(actEl)) complete(ui.selected);
    else if (act === 'toggle' && uid) { ui.collapsed.has(uid) ? ui.collapsed.delete(uid) : ui.collapsed.add(uid); renderMain(); }
    else if (act === 'open' && uid) selectTask(uid);
    else if (act === 'toggle-done') { ui.showDone = !ui.showDone; renderMain(); }
  }
  el.list.addEventListener('click', onTaskAreaClick);

  el.detail.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    const t = byUid.get(ui.selected);
    if (!t) return;
    if (act === 'close') { ui.selected = null; renderMain(); renderDetail(); }
    else if (act === 'check') {
      const inSub = b.closest('.subtasks [data-uid]');
      complete(inSub ? inSub.dataset.uid : t.uid);
    } else if (act === 'open') { const r = b.closest('[data-uid]'); if (r) selectTask(r.dataset.uid); }
    else if (act === 'open-parent') selectTask(t.parent);
    else if (act === 'prio') patchSelected({ priority: Number(b.dataset.v) });
    else if (act === 'due') {
      const v = b.dataset.v;
      const tm = timeOf(t);
      let date = v === 'none' ? null : v === 'mon' ? nextMonday() : addDaysKey(Number(v));
      let due = null;
      if (date) {
        if (tm) { const d = keyToDate(date); d.setHours(tm.getHours(), tm.getMinutes()); due = { allDay: false, ts: d.getTime() }; }
        else due = { allDay: true, date };
      }
      patchSelected(v === 'none' ? { due: null, rrule: null } : { due });
    } else if (act === 'delete') confirmDelete(t);
  });

  el.detail.addEventListener('change', (e) => {
    const f = e.target.dataset.f;
    const t = byUid.get(ui.selected);
    if (!f || !t) return;
    const dateIn = el.detail.querySelector('[data-f=date]');
    const timeIn = el.detail.querySelector('[data-f=time]');
    if (f === 'date' || f === 'time') {
      const dv = dateIn.value, tv = timeIn.value;
      let due = null;
      if (dv) {
        if (tv) { const [h, m] = tv.split(':').map(Number); const d = keyToDate(dv); d.setHours(h, m, 0, 0); due = { allDay: false, ts: d.getTime() }; }
        else due = { allDay: true, date: dv };
      }
      timeIn.disabled = !dv;
      const patch = due ? { due } : { due: null, rrule: null };
      // keep the end date of a recurrence in the same form as the due date (date vs date-time)
      if (due && t.rrule) {
        const sp = Q.splitRRule(t.rrule);
        if (sp.until) patch.rrule = Q.joinRRule(sp.base, { until: sp.until }, due);
      }
      patchSelected(patch).then(() => renderDetail(true));
    } else if (f === 'rrule') {
      const sp = Q.splitRRule(t.rrule);
      const due = t.due || (e.target.value ? { allDay: true, date: todayKey() } : null);
      const patch = { rrule: e.target.value ? Q.joinRRule(e.target.value, sp, due) : null };
      if (e.target.value && !t.due) patch.due = due;
      patchSelected(patch).then(() => renderDetail(true));
    } else if (f === 'rend' || f === 'runtil' || f === 'rcount') {
      const sp = Q.splitRRule(t.rrule);
      if (!sp.base) return;
      let end = {};
      if (f === 'rend') {
        if (e.target.value === 'until') {
          // proposal: three months after the due date (or today)
          const d = t.due ? keyToDate(dateKey(t)) : new Date();
          d.setMonth(d.getMonth() + 3);
          end = { until: ymd(d) };
        } else if (e.target.value === 'count') end = { count: 10 };
      } else if (f === 'runtil') {
        if (!e.target.value) return;
        end = { until: e.target.value };
      } else {
        const n = parseInt(e.target.value, 10);
        if (!(n >= 1)) { e.target.value = sp.count || 1; return; }
        end = { count: Math.min(n, 999) };
      }
      patchSelected({ rrule: Q.joinRRule(sp.base, end, t.due) }).then(() => renderDetail(true));
    } else if (f === 'list') {
      run(() => api.moveTask(t.href, e.target.value));
    } else if (f === 'tags') {
      const tags = e.target.value.split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean);
      patchSelected({ tags });
    }
  });

  el.detail.addEventListener('input', (e) => { if (e.target.dataset.f === 'title') autosize(e.target); });

  el.detail.addEventListener('keydown', (e) => {
    const f = e.target.dataset.f;
    if (f === 'title' && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    if (f === 'newsub' && e.key === 'Enter') {
      e.preventDefault();
      const t = byUid.get(ui.selected);
      const p = Q.parse(e.target.value, [], {});
      if (!t || !p.title) return;
      const fields = { title: p.title, parent: t.uid };
      if (p.due) fields.due = p.due;
      if (p.priority) fields.priority = p.priority;
      if (p.tags.length) fields.tags = p.tags;
      e.target.value = '';
      run(() => api.createTask(t.listHref, fields)).then(() => {
        renderDetail(true);
        const inp = el.detail.querySelector('[data-f=newsub]');
        if (inp) inp.focus();
      });
    }
  });

  el.detail.addEventListener('focusout', (e) => {
    const f = e.target.dataset.f;
    const t = byUid.get(ui.selected);
    if (t && f === 'title') {
      const v = e.target.value.replace(/\s+/g, ' ').trim();
      if (v && v !== t.title) patchSelected({ title: v });
      else e.target.value = t.title;
    }
    if (t && f === 'notes' && e.target.value !== (t.notes || '')) patchSelected({ notes: e.target.value });
    setTimeout(() => { if (ui.detailDirty && !el.detail.contains(document.activeElement)) renderDetail(true); }, 0);
  });

  el.qa.addEventListener('submit', (e) => { e.preventDefault(); addFromQuickAdd(); });
  el.qaInput.addEventListener('input', () => {
    // forget ignores that no longer appear in the text
    const low = el.qaInput.value.toLowerCase();
    for (const r of [...ui.qaIgnore]) if (!low.includes(r)) ui.qaIgnore.delete(r);
    renderChips();
  });
  el.qaInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { el.qaInput.value = ''; ui.qaIgnore.clear(); renderChips(); el.qaInput.blur(); } });
  el.qaChips.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ignore]');
    if (!b) return;
    JSON.parse(b.dataset.ignore).forEach((r) => r && ui.qaIgnore.add(r));
    renderChips();
    el.qaInput.focus();
  });

  el.search.addEventListener('input', () => {
    ui.search = el.search.value.trim();
    renderSidebar();
    renderMain();
  });
  el.search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { el.search.value = ''; ui.search = ''; renderSidebar(); renderMain(); el.search.blur(); } });

  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '');
    const typing = /INPUT|TEXTAREA|SELECT/.test(tag) || e.target.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); el.search.focus(); el.search.select(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); el.qaInput.focus(); return; }
    if (!el.modal.hidden) { if (e.key === 'Escape') closeModal(); return; }
    if (typing) return;
    if (e.key === 'q' || e.key === 'n') { e.preventDefault(); el.qaInput.focus(); }
    else if (e.key === '/') { e.preventDefault(); el.search.focus(); }
    else if (e.key === 'Escape' && ui.selected) { ui.selected = null; renderMain(); renderDetail(); }
    else if (e.altKey && e.key === '1') setView('today');
    else if (e.altKey && e.key === '2') setView('upcoming');
    else if (e.altKey && e.key === '3') setView('all');
    else if (e.key === 'Delete' && ui.selected) { const t = byUid.get(ui.selected); if (t) confirmDelete(t); }
  });

  // ---------------- toasts ----------------
  function toast(text, action, onAction) {
    const n = document.createElement('div');
    n.className = 'toast';
    n.innerHTML = `<span>${esc(text)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
    let gone = false;
    const close = () => { if (gone) return; gone = true; n.remove(); };
    if (action) n.querySelector('button').addEventListener('click', () => { close(); onAction(); });
    el.toasts.appendChild(n);
    while (el.toasts.children.length > 3) el.toasts.firstChild.remove();
    setTimeout(close, action ? 6000 : 4000);
  }

  // ---------------- modals ----------------
  function openModal(html, onReady) {
    el.modal.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
    el.modal.hidden = false;
    el.modal.onclick = (e) => { if (e.target === el.modal) closeModal(); };
    onReady && onReady(el.modal.firstChild);
    const f = el.modal.querySelector('[autofocus]') || el.modal.querySelector('input,button');
    f && f.focus();
  }
  function closeModal() { el.modal.hidden = true; el.modal.innerHTML = ''; }

  function confirmDelete(t) {
    const n = countDescendants(t.uid);
    openModal(`
      <h2>Eliminare questa attività?</h2>
      <p class="lead">“${esc(t.title)}”${n ? ` e ${n === 1 ? 'la sua sottoattività' : `le sue ${n} sottoattività`}` : ''} ${n ? 'verranno eliminate' : 'verrà eliminata'} anche dal telefono. Non si può annullare.</p>
      <div class="actions"><button class="btn" data-x="no">Annulla</button><button class="btn primary" data-x="yes" autofocus>Elimina</button></div>`, (m) => {
      m.querySelector('[data-x=no]').onclick = closeModal;
      m.querySelector('[data-x=yes]').onclick = () => {
        closeModal();
        if (ui.selected === t.uid) ui.selected = null;
        run(() => api.deleteTask(t.href)).then(() => toast('Attività eliminata'));
      };
    });
  }
  function countDescendants(uid) {
    let n = 0;
    for (const c of childrenOf.get(uid) || []) n += 1 + countDescendants(c.uid);
    return n;
  }

  const SWATCHES = ['#2457a6', '#2f7d4f', '#c77d10', '#c8372d', '#8a4fb3', '#2a8a8a', '#b5476f', '#6b7785'];
  function openNewList(opts = {}) {
    if (!S.account) return;
    let color = SWATCHES[S.lists.length % SWATCHES.length];
    const btnLabel = opts.button || 'Crea progetto';
    openModal(`
      <h2>${esc(opts.title || 'Nuovo progetto')}</h2>
      <p class="lead">${esc(opts.lead || 'Diventa una lista di attività sul tuo Nextcloud e comparirà anche in Tasks.org.')}</p>
      <form>
        <div class="field"><label for="nl-name">Nome</label><input class="input" id="nl-name" required maxlength="60" autofocus placeholder="es. Ufficio, Casa, Viaggi" value="${esc(opts.name || '')}"></div>
        <div class="field"><span class="flabel">Colore</span><div class="swatches">${SWATCHES.map((c) => `<button type="button" style="--c:${c}" data-c="${c}" aria-label="Colore ${c}" aria-pressed="${c === color}"></button>`).join('')}</div></div>
        <p class="error-text" hidden></p>
        <div class="actions"><button type="button" class="btn" data-x="no">Annulla</button><button class="btn primary">${esc(btnLabel)}</button></div>
      </form>`, (m) => {
      const nameIn = m.querySelector('#nl-name');
      if (opts.name) setTimeout(() => nameIn.select(), 0);
      m.querySelector('[data-x=no]').onclick = closeModal;
      m.querySelector('.swatches').onclick = (e) => {
        const b = e.target.closest('[data-c]'); if (!b) return;
        color = b.dataset.c;
        m.querySelectorAll('.swatches button').forEach((x) => x.setAttribute('aria-pressed', x === b));
      };
      m.querySelector('form').onsubmit = async (e) => {
        e.preventDefault();
        const name = m.querySelector('#nl-name').value.trim();
        if (!name) return;
        const btn = m.querySelector('.btn.primary'); btn.disabled = true; btn.textContent = 'Creo…';
        try {
          const l = await api.createList(name, color);
          closeModal();
          if (l && opts.onCreated) opts.onCreated(l);
          else if (l) setView('list:' + l.href);
        } catch (err) {
          const p = m.querySelector('.error-text'); p.hidden = false; p.textContent = 'Non riesco a creare il progetto: ' + err.message;
          btn.disabled = false; btn.textContent = btnLabel;
        }
      };
    });
  }

  function openSettings() {
    const s = S.settings;
    const lists = writableLists().map((l) => `<option value="${esc(l.href)}"${l.href === defaultListHref() ? ' selected' : ''}>${esc(l.name)}</option>`).join('');
    const sc = (s.shortcut || 'CommandOrControl+Alt+A').replace('CommandOrControl', 'Ctrl').split('+').map((k) => `<span class="kbd">${esc(k)}</span>`).join(' + ');
    openModal(`
      <h2>Impostazioni</h2>
      <p class="lead">${S.env ? `Spunta ${esc(S.env.version)}${S.env.portable ? ', versione portatile' : ''}. ` : ''}${S.account ? `Collegato a <strong>${esc(S.account.url)}</strong> come <strong>${esc(S.account.user)}</strong>.` : 'Non collegato.'}</p>
      <form>
        <div class="field"><label for="st-def">Progetto predefinito per le nuove attività</label><select class="input" id="st-def">${lists}</select></div>
        <hr>
        <label class="switch"><span>Riepilogo del mattino<br><span class="hint">Una notifica con le attività del giorno</span></span><input type="checkbox" id="st-morning" ${s.morningSummary ? 'checked' : ''}></label>
        <div class="row"><label for="st-mtime" class="hint">Orario del riepilogo</label><input class="input" type="time" id="st-mtime" value="${esc(s.morningTime)}"></div>
        <div class="row"><label for="st-allday" class="hint">Ora dei promemoria su attività senza orario (quelli impostati dal telefono)</label><input class="input" type="time" id="st-allday" value="${esc(s.notifyAllDayAt)}"></div>
        <hr>
        <div class="field">
          <span class="flabel">${S.env && S.env.platform === 'linux' ? 'Notifiche' : 'Notifiche di Windows'}</span>
          ${S.env && S.env.portable && !S.env.notifyShortcut
            ? `<p class="hint">Questa è la versione portatile: per mostrare le notifiche, Windows vuole un collegamento a Spunta nel menu Start. Lo creo solo se premi il pulsante, e puoi toglierlo quando vuoi.</p>
               <div class="row"><button type="button" class="btn primary" data-x="mkshort">Attiva le notifiche</button></div>`
            : `${S.env && S.env.portable ? '<p class="hint">Attive tramite il collegamento “Spunta (portatile)” nel menu Start.</p>' : ''}
               <div class="row"><button type="button" class="btn" data-x="testnotif">Prova una notifica</button>${S.env && S.env.portable ? '<button type="button" class="btn ghost" data-x="rmshort">Togli il collegamento</button>' : ''}</div>`}
        </div>
        <hr>
        <label class="switch"><span>Avvia Spunta all'accensione del PC</span><input type="checkbox" id="st-login" ${s.startAtLogin ? 'checked' : ''}></label>
        <label class="switch"><span>Chiudendo la finestra, resta attiva vicino all'orologio<br><span class="hint">Serve per ricevere i promemoria</span></span><input type="checkbox" id="st-tray" ${s.closeToTray ? 'checked' : ''}></label>
        <p class="hint">Scorciatoia da qualsiasi programma per aggiungere un'attività: ${sc}. Nell'app: <span class="kbd">Q</span> nuova attività, <span class="kbd">/</span> cerca, <span class="kbd">Esc</span> chiudi.</p>
        <hr>
        <div class="actions" style="justify-content:space-between">
          ${S.account ? '<button type="button" class="btn danger" data-x="logout">Scollega account</button>' : '<span></span>'}
          <span class="row"><button type="button" class="btn" data-x="acct">Cambia server</button><button class="btn primary">Salva</button></span>
        </div>
      </form>`, (m) => {
      m.querySelector('form').onsubmit = async (e) => {
        e.preventDefault();
        await run(() => api.setSettings({
          defaultList: m.querySelector('#st-def').value || null,
          morningSummary: m.querySelector('#st-morning').checked,
          morningTime: m.querySelector('#st-mtime').value || '08:30',
          notifyAllDayAt: m.querySelector('#st-allday').value || '09:00',
          startAtLogin: m.querySelector('#st-login').checked,
          closeToTray: m.querySelector('#st-tray').checked,
        }));
        closeModal();
        toast('Impostazioni salvate');
      };
      const lo = m.querySelector('[data-x=logout]');
      if (lo) lo.onclick = () => {
        openModal(`<h2>Scollegare l'account?</h2><p class="lead">Le attività restano sul tuo Nextcloud. Su questo PC verranno tolte, insieme alla password salvata.</p>
          <div class="actions"><button class="btn" data-x="no">Annulla</button><button class="btn primary" data-x="yes">Scollega</button></div>`, (m2) => {
          m2.querySelector('[data-x=no]').onclick = closeModal;
          m2.querySelector('[data-x=yes]').onclick = async () => { closeModal(); await run(() => api.disconnect()); el.onboarding.innerHTML = ''; ui.selected = null; };
        });
      };
      const mk = m.querySelector('[data-x=mkshort]');
      if (mk) mk.onclick = async () => {
        const r = await run(() => api.createNotifyShortcut(), 'Non riesco ad attivare le notifiche');
        if (r) { closeModal(); openSettings(); toast('Notifiche attivate. Premi “Prova una notifica” per controllare.'); }
      };
      const tn = m.querySelector('[data-x=testnotif]');
      if (tn) tn.onclick = () => run(() => api.testNotification(), 'Notifica non inviata');
      const rm = m.querySelector('[data-x=rmshort]');
      if (rm) rm.onclick = async () => { await run(() => api.removeNotifyShortcut()); closeModal(); openSettings(); };
      m.querySelector('[data-x=acct]').onclick = () => { closeModal(); renderOnboarding(true); el.onboarding.hidden = false; };
    });
  }

  function renderOnboarding(changing) {
    el.onboarding.innerHTML = `
      <div class="onb">
        <svg class="big-tick" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.8c1.6 1.2 3.2 2.7 4.6 4.6C11.6 12.9 15 8.9 19.6 5.8"/></svg>
        <h1>${changing ? 'Cambia server' : 'Collega il tuo Nextcloud'}</h1>
        <p>Spunta legge e scrive le stesse attività che vedi in Tasks.org sul telefono. Restano sul tuo server.</p>
        <form>
          <div class="field"><label for="ob-url">Indirizzo del server</label><input class="input" id="ob-url" required placeholder="https://cloud.tuodominio.it" value="${esc(S.account ? S.account.url : '')}" autofocus spellcheck="false"></div>
          <div class="field"><label for="ob-user">Nome utente</label><input class="input" id="ob-user" required value="${esc(S.account ? S.account.user : '')}" spellcheck="false" autocomplete="username"></div>
          <div class="field"><label for="ob-pass">Password per app</label><input class="input" id="ob-pass" type="password" required autocomplete="current-password"></div>
          <details><summary>Come creo una password per app?</summary>
            <ol>
              <li>Apri Nextcloud nel browser e clicca sulla tua foto in alto a destra.</li>
              <li>Vai in Impostazioni personali, poi Sicurezza.</li>
              <li>In fondo, in “Dispositivi e sessioni”, scrivi “Spunta PC” e premi “Crea nuova password per l'applicazione”.</li>
              <li>Copia la password e incollala qui. Se usi la verifica in due passaggi, è l'unico modo per collegarsi.</li>
            </ol>
          </details>
          <p class="error-text" hidden></p>
          <div class="actions">${changing ? '<button type="button" class="btn" data-x="no">Annulla</button>' : ''}<button class="btn primary">Collega</button></div>
        </form>
      </div>`;
    const f = el.onboarding.querySelector('form');
    const cancel = el.onboarding.querySelector('[data-x=no]');
    if (cancel) cancel.onclick = () => { el.onboarding.hidden = true; };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const btn = f.querySelector('.btn.primary');
      const err = f.querySelector('.error-text');
      err.hidden = true; btn.disabled = true; btn.textContent = 'Collegamento…';
      try {
        const r = await api.connect({ url: f.querySelector('#ob-url').value, user: f.querySelector('#ob-user').value.trim(), password: f.querySelector('#ob-pass').value });
        el.onboarding.hidden = true;
        el.onboarding.innerHTML = '';
        if (S.env && S.env.portable && !S.env.notifyShortcut) {
          setTimeout(() => toast('Per ricevere i promemoria, attiva le notifiche', 'Impostazioni', openSettings), 1500);
        }
        if (r.lists) toast(`Collegato. ${r.lists === 1 ? 'Trovata 1 lista' : `Trovate ${r.lists} liste`} di attività.`);
        else showNoListsHelp(r.scan);
      } catch (ex) {
        err.hidden = false;
        err.textContent = ex.kind === 'auth' ? 'Nome utente o password non corretti. Usa una password per app, non quella di accesso.'
          : ex.kind === 'cert' ? ex.message + '. Se il server usa un certificato fatto in casa, va installato in Windows, oppure usa Let’s Encrypt.'
          : ex.kind === 'network' ? ex.message + '. Controlla l’indirizzo e la connessione.'
          : 'Collegamento non riuscito: ' + ex.message;
        btn.disabled = false; btn.textContent = 'Collega';
      }
    };
  }

  // Explains why no task list shows up: lists calendars found and what they accept
  function showNoListsHelp(scan) {
    const cals = (scan && scan.calendars) || [];
    const kind = (c) => (c.comps.includes('VTODO') ? 'attività' : c.comps.includes('VEVENT') ? 'solo eventi' : (c.comps.join(', ') || 'non specificato'));
    const rows = cals.map((c) => `<li><strong>${esc(c.name)}</strong>: ${esc(kind(c))}</li>`).join('');
    openModal(`
      <h2>Collegato, ma nessuna lista di attività</h2>
      ${cals.length
        ? `<p class="lead">Sul server ho trovato ${cals.length === 1 ? 'questo calendario' : `questi ${cals.length} calendari`}, ma nessuno accetta attività:</p><ul>${rows}</ul>
           <p class="hint">È normale se finora le attività non le tenevi su Nextcloud: i calendari spostati da Google contengono solo appuntamenti.</p>`
        : `<p class="lead">Non ho trovato nessun calendario nella cartella <code>${esc(scan ? scan.home : '')}</code> (${scan ? scan.entries : 0} elementi).</p>
           <p class="hint">Se in Nextcloud vedi dei calendari, mandami questa schermata: vuol dire che sto cercando nel posto sbagliato.</p>`}
      <p class="hint">Crea la prima lista ora: comparirà anche su Nextcloud e in Tasks.org sul telefono.</p>
      <div class="actions"><button class="btn" data-x="no">Più tardi</button><button class="btn primary" data-x="new" autofocus>Crea una lista</button></div>`, (m) => {
      m.querySelector('[data-x=no]').onclick = closeModal;
      m.querySelector('[data-x=new]').onclick = () => { closeModal(); openNewList({}); };
    });
  }

  // ---------------- boot ----------------
  api.on('state', (s) => { S = s; render(); });
  api.on('notice', (msg) => toast(msg));
  api.on('focus-quickadd', () => { el.qaInput.focus(); el.qaInput.select(); });
  api.on('show-view', (v) => setView(v));
  api.on('open-task', (uid) => {
    const t = byUid.get(uid);
    if (!t) return;
    if (ui.view !== 'today' && ui.view !== 'upcoming') setView('list:' + t.listHref);
    selectTask(uid);
  });

  // refresh relative dates when the day changes or every minute
  let lastDay = todayKey();
  setInterval(() => {
    if (todayKey() !== lastDay) { lastDay = todayKey(); render(); }
    else if (!el.detail.contains(document.activeElement)) renderMain();
  }, 60 * 1000);

  api.state().then((s) => { S = s; render(); if (S.account) el.qaInput.focus(); });
})();
