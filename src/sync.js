'use strict';
// Local cache + offline queue on top of CalDavClient.
// Every change is applied locally right away and queued; the queue is sent to the
// server in order. If the network is down the changes wait and are retried.

const { EventEmitter } = require('events');
const ical = require('./ical');

class SyncEngine extends EventEmitter {
  constructor({ makeClient, load, save }) {
    super();
    this.makeClient = makeClient; // () => CalDavClient | null
    this.saveFn = save;
    const d = (load && load()) || {};
    this.lists = d.lists || [];
    this.items = new Map((d.items || []).map((i) => [i.href, i]));
    this.etags = new Map(Object.entries(d.etags || {}));
    this.ctags = new Map(Object.entries(d.ctags || {}));
    this.queue = d.queue || [];
    this.status = { online: true, syncing: false, lastSync: d.lastSync || null, error: null };
    this.taskCache = new Map();
    this.localWrites = new Map(); // href -> time of last local change confirmed or queued
    this._saveTimer = null;
  }

  // ---------- persistence ----------
  persist() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flushSave(), 300);
  }
  flushSave() {
    clearTimeout(this._saveTimer);
    this.saveFn && this.saveFn({
      lists: this.lists,
      items: [...this.items.values()].map(({ href, listHref, ics }) => ({ href, listHref, ics })),
      etags: Object.fromEntries(this.etags),
      ctags: Object.fromEntries(this.ctags),
      queue: this.queue,
      lastSync: this.status.lastSync,
    });
  }
  reset() {
    this.lists = []; this.items.clear(); this.etags.clear(); this.ctags.clear(); this.queue = [];
    this.status = { online: true, syncing: false, lastSync: null, error: null };
    this.taskCache.clear();
    this.flushSave();
    this.changed();
  }

  changed() { this.persist(); this.emit('change'); }

  // ---------- read model ----------
  taskOf(item) {
    const c = this.taskCache.get(item.href);
    if (c && c.ics === item.ics) return c.task;
    let task = null;
    try { task = ical.todoToTask(item.ics); } catch { task = null; }
    if (task) { task.href = item.href; task.listHref = item.listHref; }
    this.taskCache.set(item.href, { ics: item.ics, task });
    return task;
  }
  tasks() {
    const out = [];
    for (const it of this.items.values()) { const t = this.taskOf(it); if (t) out.push(t); }
    return out;
  }
  state() {
    return {
      lists: this.lists,
      tasks: this.tasks(),
      status: { ...this.status, pending: this.queue.length },
    };
  }
  findByUid(uid) {
    for (const it of this.items.values()) { const t = this.taskOf(it); if (t && t.uid === uid) return it; }
    return null;
  }
  childrenOf(uid) {
    return [...this.items.values()].filter((it) => { const t = this.taskOf(it); return t && t.parent === uid; });
  }

  // ---------- local mutations ----------
  enqueue(href, kind) {
    this.localWrites.set(href, Date.now());
    const idx = this.queue.findIndex((o) => o.href === href && !o.inFlight);
    if (idx >= 0) this.queue.splice(idx, 1);
    if (kind === 'delete' && !this.etags.has(href) && !this.queue.some((o) => o.href === href)) {
      return; // never reached the server: nothing to delete there
    }
    this.queue.push({ href, kind });
  }

  createTask(listHref, fields) {
    const { uid, ics } = ical.newTodo(fields);
    const href = listHref.replace(/\/?$/, '/') + uid + '.ics';
    this.items.set(href, { href, listHref, ics });
    this.enqueue(href, 'put');
    this.changed();
    this.kick();
    return this.taskOf(this.items.get(href));
  }

  updateTask(href, patch) {
    const it = this.items.get(href);
    if (!it) throw new Error('Attività non trovata');
    it.ics = ical.applyPatch(it.ics, patch);
    this.enqueue(href, 'put');
    // completing a parent completes its open subtasks too (like Todoist)
    if (patch.completed === true) {
      const t = this.taskOf(it);
      if (t && !t.rrule) {
        for (const ch of this.childrenOf(t.uid)) {
          const ct = this.taskOf(ch);
          if (ct && !ct.completed) { ch.ics = ical.applyPatch(ch.ics, { completed: true }); this.enqueue(ch.href, 'put'); }
        }
      }
    }
    this.changed();
    this.kick();
    return this.taskOf(it);
  }

  deleteTask(href) {
    const it = this.items.get(href);
    if (!it) return;
    const t = this.taskOf(it);
    if (t) for (const ch of this.childrenOf(t.uid)) this.deleteTask(ch.href);
    this.items.delete(href);
    this.enqueue(href, 'delete');
    this.changed();
    this.kick();
  }

  moveTask(href, newListHref) {
    const it = this.items.get(href);
    if (!it || it.listHref === newListHref) return href;
    const t = this.taskOf(it);
    const name = href.split('/').pop();
    const newHref = newListHref.replace(/\/?$/, '/') + name;
    this.items.delete(href);
    this.enqueue(href, 'delete');
    this.items.set(newHref, { href: newHref, listHref: newListHref, ics: it.ics });
    this.enqueue(newHref, 'put');
    if (t) for (const ch of this.childrenOf(t.uid)) this.moveTask(ch.href, newListHref);
    this.changed();
    this.kick();
    return newHref;
  }

  // ---------- server side ----------
  kick() {
    clearTimeout(this._kickTimer);
    this._kickTimer = setTimeout(() => this.flush().catch(() => {}), 400);
  }

  async flush() {
    const client = this.makeClient();
    if (!client || this._flushing) return;
    this._flushing = true;
    try {
      while (this.queue.length) {
        const op = this.queue[0];
        op.inFlight = true;
        try {
          if (op.kind === 'put') {
            const it = this.items.get(op.href);
            if (it) {
              const etag = this.etags.get(op.href) || null;
              let newEtag = await client.put(op.href, it.ics, etag);
              if (!newEtag) {
                const fresh = await client.get(op.href);
                newEtag = fresh.etag;
                // keep local text if the user changed it again meanwhile
                if (!this.queue.some((o, i) => i > 0 && o.href === op.href)) it.ics = fresh.ics;
              }
              if (newEtag) this.etags.set(op.href, newEtag);
            }
          } else {
            await client.remove(op.href, this.etags.get(op.href) || null);
            this.etags.delete(op.href);
          }
          this.queue.shift();
          this.localWrites.set(op.href, Date.now());
          this.status.online = true;
          this.status.error = null;
        } catch (e) {
          op.inFlight = false;
          if (e.kind === 'network' || e.kind === 'cert') { this.status.online = false; this.emit('change'); break; }
          if (e.kind === 'auth') { this.status.error = e.message; this.emit('change'); break; }
          this.queue.shift();
          if (e.kind === 'conflict' || (e.kind === 'notfound' && op.kind === 'put')) {
            await this.refetchOne(client, op.href).catch(() => {});
            const t = this.items.get(op.href) && this.taskOf(this.items.get(op.href));
            this.emit('notice', e.kind === 'conflict'
              ? `"${t ? t.title : 'Un\'attività'}" era stata modificata da un altro dispositivo: tengo la versione più recente.`
              : 'Un\'attività che hai modificato era stata eliminata da un altro dispositivo.');
          } else if (e.kind === 'forbidden') {
            this.emit('notice', 'Questa lista è in sola lettura: la modifica non è stata salvata sul server.');
            await this.refetchOne(client, op.href).catch(() => {});
          } else {
            this.emit('notice', 'Il server ha rifiutato una modifica: ' + e.message);
          }
        }
        this.persist();
      }
    } finally {
      this._flushing = false;
      this.emit('change');
    }
  }

  async refetchOne(client, href) {
    try {
      const { ics, etag } = await client.get(href);
      const it = this.items.get(href);
      if (it) it.ics = ics;
      else {
        const listHref = href.replace(/[^/]+$/, '');
        this.items.set(href, { href, listHref, ics });
      }
      if (etag) this.etags.set(href, etag);
    } catch (e) {
      if (e.kind === 'notfound') { this.items.delete(href); this.etags.delete(href); }
      else throw e;
    }
    this.changed();
  }

  async sync({ force = false } = {}) {
    const client = this.makeClient();
    if (!client) return;
    if (this.status.syncing) return;
    this.status.syncing = true;
    this.emit('change');
    try {
      await this.flush();
      const lists = await client.listTaskLists();
      this.lists = lists;
      const pendingHrefs = new Set(this.queue.map((o) => o.href));
      const listHrefs = new Set(lists.map((l) => l.href));
      // drop items from lists that disappeared
      for (const [href, it] of this.items) {
        if (!listHrefs.has(it.listHref) && !pendingHrefs.has(href)) { this.items.delete(href); this.etags.delete(href); }
      }
      for (const l of lists) {
        if (!force && l.ctag && this.ctags.get(l.href) === l.ctag) continue;
        const fetchStart = Date.now();
        const remote = await client.listTasks(l.href);
        // a local change sent while this list was being downloaded is newer than
        // what we just received: keep it and re-read the list on the next sync
        const touched = (href) => (this.localWrites.get(href) || 0) >= fetchStart;
        let stale = false;
        const seen = new Set();
        for (const r of remote) {
          seen.add(r.href);
          if (touched(r.href)) { stale = true; continue; }
          if (pendingHrefs.has(r.href)) continue;
          if (this.queue.some((o) => o.href === r.href)) continue;
          const local = this.items.get(r.href);
          if (!local || this.etags.get(r.href) !== r.etag || local.ics !== r.ics) {
            this.items.set(r.href, { href: r.href, listHref: l.href, ics: r.ics });
          }
          if (r.etag) this.etags.set(r.href, r.etag);
        }
        for (const [href, it] of this.items) {
          if (it.listHref !== l.href || seen.has(href)) continue;
          if (pendingHrefs.has(href) || this.queue.some((o) => o.href === href) || touched(href)) continue;
          this.items.delete(href); this.etags.delete(href); // deleted elsewhere
        }
        if (l.ctag && !stale) this.ctags.set(l.href, l.ctag);
        else this.ctags.delete(l.href);
      }
      this.status.online = true;
      this.status.error = null;
      this.status.lastSync = Date.now();
    } catch (e) {
      if (e.kind === 'network') this.status.online = false;
      else this.status.error = e.message;
      throw e;
    } finally {
      this.status.syncing = false;
      this.changed();
    }
  }

  async createList(name, color) {
    const client = this.makeClient();
    if (!client) throw new Error('Non collegato');
    const href = await client.createList(name, color);
    await this.sync({ force: false });
    return this.lists.find((l) => l.href === href) || this.lists.find((l) => l.name === name) || null;
  }
}

module.exports = { SyncEngine };
