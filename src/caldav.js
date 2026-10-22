'use strict';
// Small CalDAV client for task lists (VTODO) on Nextcloud and other servers.

const { XMLParser } = require('fast-xml-parser');

const xml = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  isArray: (name) => ['response', 'propstat', 'comp', 'href'].includes(name),
});

class CalDavError extends Error {
  constructor(message, status, kind) {
    super(message);
    this.status = status;
    this.kind = kind; // 'auth' | 'network' | 'conflict' | 'notfound' | 'server'
  }
}

const arr = (x) => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);
const text = (x) => {
  if (x === undefined || x === null) return '';
  if (typeof x === 'object') return x['#text'] !== undefined ? String(x['#text']) : '';
  return String(x);
};

class CalDavClient {
  constructor({ url, username, password, fetch: fetchImpl, timeoutMs = 20000 }) {
    this.base = url.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(this.base)) this.base = 'https://' + this.base;
    this.username = username;
    this.auth = 'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
    this.fetch = fetchImpl || globalThis.fetch;
    this.timeoutMs = timeoutMs;
    this.homeUrl = null;
  }

  abs(href) {
    return new URL(href, this.base + '/').toString();
  }

  async request(method, url, { headers = {}, body, expect = [200, 207] } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetch(url, {
        method,
        headers: { Authorization: this.auth, ...headers },
        body,
        signal: ctrl.signal,
        redirect: 'follow',
      });
    } catch (e) {
      const detail = `${e.message || ''} ${e.cause?.code || ''} ${e.cause?.message || ''}`;
      if (/CERT|certificate|SSL|TLS/i.test(detail)) {
        throw new CalDavError('Il certificato HTTPS del server non è valido o non è riconosciuto da Windows', 0, 'cert');
      }
      if (e.name === 'AbortError') throw new CalDavError('Il server non risponde (tempo scaduto)', 0, 'network');
      if (/NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(detail)) {
        throw new CalDavError('Indirizzo del server non trovato', 0, 'network');
      }
      throw new CalDavError('Server non raggiungibile', 0, 'network');
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) {
      throw new CalDavError('Nome utente o password non accettati dal server', 401, 'auth');
    }
    if (res.status === 403) throw new CalDavError('Il server nega l\'accesso a questa risorsa', 403, 'forbidden');
    if (res.status === 412) throw new CalDavError('Modificata altrove nel frattempo', 412, 'conflict');
    if (res.status === 404) throw new CalDavError('Risorsa non trovata sul server', 404, 'notfound');
    if (!expect.includes(res.status)) {
      const t = await res.text().catch(() => '');
      const msg = /<s:message>([^<]+)/.exec(t);
      throw new CalDavError(`Il server ha risposto ${res.status}${msg ? ': ' + msg[1] : ''}`, res.status, 'server');
    }
    return res;
  }

  async propfind(url, depth, propsXml) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.com/ns">
  <d:prop>${propsXml}</d:prop>
</d:propfind>`;
    const res = await this.request('PROPFIND', url, {
      headers: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' },
      body,
    });
    return { responses: this.parseMultistatus(await res.text()), finalUrl: res.url || url };
  }

  parseMultistatus(body) {
    const doc = xml.parse(body);
    const ms = doc.multistatus;
    if (!ms) return [];
    return arr(ms.response).map((r) => {
      const props = {};
      for (const ps of arr(r.propstat)) {
        const status = text(ps.status);
        if (!/ 200 /.test(status)) continue;
        Object.assign(props, ps.prop || {});
      }
      return { href: decodeURIComponentSafe(text(arr(r.href)[0])), props };
    });
  }

  // Find the calendar home (where task lists live)
  async discover() {
    const candidates = [];
    if (/\/remote\.php\/dav/.test(this.base)) candidates.push(this.base + '/');
    else {
      candidates.push(this.base + '/remote.php/dav/');
      candidates.push(this.base + '/.well-known/caldav');
      candidates.push(this.base + '/');
    }
    let lastErr = null;
    for (const c of candidates) {
      try {
        const { responses, finalUrl } = await this.propfind(c, 0, '<d:current-user-principal/>');
        const cup = responses[0] && responses[0].props['current-user-principal'];
        const href = cup && text(arr(cup.href)[0]);
        if (!href) continue;
        const principal = new URL(href, finalUrl).toString();
        const r2 = await this.propfind(principal, 0, '<c:calendar-home-set/>');
        const chs = r2.responses[0] && r2.responses[0].props['calendar-home-set'];
        const home = chs && text(arr(chs.href)[0]);
        if (!home) continue;
        this.homeUrl = new URL(home, principal).toString();
        return this.homeUrl;
      } catch (e) {
        if (e.kind === 'auth' || e.kind === 'network' || e.kind === 'cert') throw e;
        lastErr = e;
      }
    }
    // Nextcloud fallback
    if (!/\/remote\.php\/dav/.test(this.base)) {
      this.homeUrl = `${this.base}/remote.php/dav/calendars/${encodeURIComponent(this.username)}/`;
      return this.homeUrl;
    }
    throw lastErr || new CalDavError('Non trovo il servizio calendari su questo indirizzo', 0, 'server');
  }

  async listTaskLists() {
    if (!this.homeUrl) await this.discover();
    const { responses } = await this.propfind(this.homeUrl, 1, `
      <d:resourcetype/><d:displayname/><cs:getctag/><d:sync-token/>
      <c:supported-calendar-component-set/><ic:calendar-color/><ic:calendar-order/>
      <d:current-user-privilege-set/>`);
    const lists = [];
    // what we saw, for the diagnostic message when no task list is found
    this.lastScan = { home: this.homeUrl, entries: responses.length, calendars: [] };
    for (const r of responses) {
      const rt = r.props.resourcetype;
      if (!rt || typeof rt !== 'object' || !('calendar' in rt)) continue;
      const set = r.props['supported-calendar-component-set'];
      const comps = set ? arr(set.comp).map((c) => (c['@name'] || '').toUpperCase()) : ['VTODO'];
      const calName = text(r.props.displayname) || decodeURIComponentSafe(r.href.split('/').filter(Boolean).pop());
      this.lastScan.calendars.push({ name: calName, comps });
      if (!comps.includes('VTODO')) continue;
      const privs = JSON.stringify(r.props['current-user-privilege-set'] || '');
      const readOnly = privs.length > 4 && !/write/.test(privs);
      let color = text(r.props['calendar-color']) || null;
      if (color && /^#[0-9a-f]{8}$/i.test(color)) color = color.slice(0, 7);
      lists.push({
        href: this.abs(r.href),
        name: calName,
        color,
        ctag: text(r.props.getctag) || text(r.props['sync-token']) || null,
        order: Number(text(r.props['calendar-order'])) || 0,
        readOnly,
      });
    }
    lists.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'it'));
    return lists;
  }

  async listTasks(listHref) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter>
</c:calendar-query>`;
    const res = await this.request('REPORT', listHref, {
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body,
    });
    const out = [];
    for (const r of this.parseMultistatus(await res.text())) {
      const data = text(r.props['calendar-data']);
      if (!data) continue;
      out.push({ href: this.abs(r.href), etag: text(r.props.getetag) || null, ics: data });
    }
    return out;
  }

  async get(href) {
    const res = await this.request('GET', href, { expect: [200] });
    return { ics: await res.text(), etag: res.headers.get('etag') };
  }

  // Create (etag === null) or update (etag given) a task resource.
  async put(href, ics, etag) {
    const headers = { 'Content-Type': 'text/calendar; charset=utf-8' };
    if (etag) headers['If-Match'] = etag;
    else headers['If-None-Match'] = '*';
    const res = await this.request('PUT', href, { headers, body: ics, expect: [200, 201, 204] });
    return res.headers.get('etag');
  }

  async remove(href, etag) {
    const headers = {};
    if (etag) headers['If-Match'] = etag;
    await this.request('DELETE', href, { headers, expect: [200, 204, 404] });
  }

  async createList(name, color) {
    if (!this.homeUrl) await this.discover();
    const slug = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'lista';
    const href = `${this.homeUrl.replace(/\/$/, '')}/${slug}-${Date.now().toString(36)}/`;
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const body = `<?xml version="1.0" encoding="utf-8"?>
<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:ic="http://apple.com/ns/ical/">
  <d:set><d:prop>
    <d:displayname>${esc(name)}</d:displayname>
    ${color ? `<ic:calendar-color>${esc(color)}</ic:calendar-color>` : ''}
    <c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>
  </d:prop></d:set>
</c:mkcalendar>`;
    await this.request('MKCALENDAR', href, {
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
      body,
      expect: [201],
    });
    return href;
  }
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

module.exports = { CalDavClient, CalDavError };
