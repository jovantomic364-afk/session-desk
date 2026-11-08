import { DurableObject } from 'cloudflare:workers';

/* ------------------------------------------------------------------
   Session Desk: Worker + one Durable Object ("Room") per session.
   - POST /api/session                 create a session, returns code + engineer key
   - GET  /api/session/CODE            does it exist?
   - GET  /api/session/CODE/ws         WebSocket into the room
   - PUT  /api/session/CODE/stem/ID    upload audio: stems (st-) and shared bounces (bn-)
   - GET  /api/session/CODE/stem/ID    download audio (?dl=name to save as a file)
   Everything else is the page in ./public, served as free static assets.

   Audio lives inside the session's own Durable Object (SQLite, in chunks), not in R2.
   On the Workers Free plan nothing here can be billed: over a daily limit, requests
   simply fail until midnight UTC.
------------------------------------------------------------------- */

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const EMPTY_MS = 20 * 60 * 1000;          // nobody connected for 20 min -> session is deleted
const MAX_MS = 24 * 60 * 60 * 1000;       // hard limit: 24 h after it was created
const LEAD_MS = 300;                       // play starts this far ahead so every browser can line up
const MAX_TRACKS = 32;
const MAX_STEM_BYTES = 95 * 1024 * 1024;   // Workers request body limit is 100 MB on the free plan
const SESSION_BYTES = 900 * 1024 * 1024;   // a Durable Object holds up to 1 GB on the free plan
const CHUNK = 1536 * 1024;                 // SQLite rows hold up to 2 MB, so audio is stored in 1.5 MB pieces
const UNITY = Math.pow(10, -6 / 40);
const dbToPos = d => Math.pow(10, (d - 6) / 40);
const ECHO_DIVS = ['1/4', '1/8', '1/8d', '1/16'];

function makeCode() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map(x => CODE_CHARS[x % CODE_CHARS.length]).join('');
}
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const roomFor = (env, code) => env.ROOMS.get(env.ROOMS.idFromName(code));

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === '/api/session' && req.method === 'POST') {
      let body = {};
      try { body = await req.json(); } catch (e) {}
      for (let i = 0; i < 5; i++) {
        const code = makeCode();
        const key = crypto.randomUUID().replace(/-/g, '');
        const r = await roomFor(env, code).init(code, key, String(body.studio || '').slice(0, 60));
        if (r.ok) return json({ code, engineerKey: key });
      }
      return json({ error: 'Could not create a session, try again.' }, 500);
    }

    const m = p.match(/^\/api\/session\/([A-Z0-9]{6})(\/.*)?$/);
    if (m) {
      const code = m[1], rest = m[2] || '';
      const room = roomFor(env, code);
      if (rest === '/ws') return room.fetch(req);
      if (rest === '' && req.method === 'GET') return json(await room.info());
      if (/^\/stem\/[a-zA-Z0-9-]{1,40}$/.test(rest) && (req.method === 'PUT' || req.method === 'GET')) return room.fetch(req);
      return json({ error: 'Not found' }, 404);
    }

    // Only /api/* reaches the Worker (see wrangler.toml); this is a fallback.
    if (p.startsWith('/s/')) return env.ASSETS.fetch(new Request(new URL('/', url), req));
    return env.ASSETS.fetch(req);
  }
};

/* ------------------------------------------------------------------ */

function flatEq() { return { low: 0, mid: 0, midF: 1200, high: 0, bypass: false }; }
function flatFx() { return { cut: { on: false, f: 80 }, phone: { on: false }, sat: { on: false, drive: 0.35 }, comp: { on: false, amt: 0.4 }, dbl: { on: false, mix: 0.5 } }; }
function demoTrack(id, name, color, db, send, echo, pan = 0) {
  return { id, name, color, fader: dbToPos(db), pan, send, echo, mute: false, solo: false, eq: flatEq(), fx: flatFx(), group: '', at: 0 };
}
function defaultState(code, engineerKey, studio) {
  return {
    code, engineerKey, created: Date.now(), engineerId: null, controllerId: null,
    session: { studio, artist: '', title: '', engineer: '', key: '', bpm: 96, rec: false, click: false, countIn: false },
    tracks: [
      demoTrack('demo-drums', 'Drums', '#ff7a59', -7, 0.08, 0),
      demoTrack('demo-bass', 'Bass', '#ffc145', -7, 0, 0),
      demoTrack('demo-keys', 'Keys', '#7bd88f', -9, 0.28, 0.1),
      demoTrack('demo-lead', 'Lead', '#4cc9f0', -6, 0.35, 0.25, -0.15)
    ],
    groups: [],
    master: { pos: UNITY, glue: false, ret: 0.85, echoRet: 0.7, echoDiv: '1/8d', eq: flatEq(), cut: { on: false, f: 30 }, lim: { on: false, push: 3 } },
    loop: { on: false, start: 0, end: 10 },
    markers: [], sections: [],
    snaps: { A: null, B: null }, snapActive: null,
    transport: { playing: false, offset: 0, start: 0, countIn: false },
    bounces: [], chat: []
  };
}
const num = (v, a, b, d) => { v = Number(v); return Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : d; };
const str = (v, n) => String(v ?? '').slice(0, n);
const color = (c, d = '#ffa524') => /^#[0-9a-f]{6}$/i.test(c) ? c : d;
const idOk = v => typeof v === 'string' && /^[a-zA-Z0-9-]{1,40}$/.test(v);
function cleanEq(e = {}) {
  return { low: num(e.low, -12, 12, 0), mid: num(e.mid, -12, 12, 0), midF: num(e.midF, 100, 8000, 1200), high: num(e.high, -12, 12, 0), bypass: !!e.bypass };
}
function cleanFx(f = {}) {
  const d = flatFx(), g = k => f[k] || {};
  return {
    cut: { on: !!g('cut').on, f: num(g('cut').f, 20, 600, d.cut.f) },
    phone: { on: !!g('phone').on },
    sat: { on: !!g('sat').on, drive: num(g('sat').drive, 0, 1, d.sat.drive) },
    comp: { on: !!g('comp').on, amt: num(g('comp').amt, 0, 1, d.comp.amt) },
    dbl: { on: !!g('dbl').on, mix: num(g('dbl').mix, 0, 1, d.dbl.mix) }
  };
}
function cleanTrackFields(f = {}) {
  const o = {};
  if ('name' in f) o.name = str(f.name, 40) || 'Untitled';
  if ('color' in f) o.color = color(f.color);
  if ('fader' in f) o.fader = num(f.fader, 0, 1, UNITY);
  if ('pan' in f) o.pan = num(f.pan, -1, 1, 0);
  if ('send' in f) o.send = num(f.send, 0, 1, 0);
  if ('echo' in f) o.echo = num(f.echo, 0, 1, 0);
  if ('mute' in f) o.mute = !!f.mute;
  if ('solo' in f) o.solo = !!f.solo;
  if ('eq' in f) o.eq = cleanEq(f.eq);
  if ('fx' in f) o.fx = cleanFx(f.fx);
  if ('group' in f) o.group = idOk(f.group) ? f.group : '';
  return o;
}
function cleanMaster(g = {}) {
  const f = {};
  if ('pos' in g) f.pos = num(g.pos, 0, 1, UNITY);
  if ('glue' in g) f.glue = !!g.glue;
  if ('ret' in g) f.ret = num(g.ret, 0, 1.5, 0.85);
  if ('echoRet' in g) f.echoRet = num(g.echoRet, 0, 1.5, 0.7);
  if ('echoDiv' in g) f.echoDiv = ECHO_DIVS.includes(g.echoDiv) ? g.echoDiv : '1/8d';
  if ('eq' in g) f.eq = cleanEq(g.eq);
  if ('cut' in g) f.cut = { on: !!(g.cut && g.cut.on), f: num(g.cut && g.cut.f, 20, 200, 30) };
  if ('lim' in g) f.lim = { on: !!(g.lim && g.lim.on), push: num(g.lim && g.lim.push, 0, 12, 3) };
  return f;
}
function cleanGroups(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 8).filter(g => g && idOk(g.id)).map(g => ({ id: g.id, name: str(g.name, 24) || 'Bus', color: color(g.color, '#9aa3b2'), fader: num(g.fader, 0, 1, UNITY), mute: !!g.mute }));
}
function cleanMarkers(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 64).filter(x => x && idOk(x.id)).map(x => ({ id: x.id, t: num(x.t, 0, 36000, 0), name: str(x.name, 30) })).sort((a, b) => a.t - b.t);
}
function cleanSections(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 32).filter(x => x && idOk(x.id)).map(x => {
    const start = num(x.start, 0, 36000, 0), end = num(x.end, 0, 36000, 0);
    return { id: x.id, start: Math.min(start, end), end: Math.max(start, end), name: str(x.name, 24) || 'Section', color: color(x.color, '#4cc9f0') };
  }).filter(x => x.end - x.start > 0.05).sort((a, b) => a.start - b.start);
}
function cleanMix(d) {
  if (!d || typeof d !== 'object') return null;
  const tracks = {};
  if (d.tracks && typeof d.tracks === 'object') for (const [id, f] of Object.entries(d.tracks).slice(0, MAX_TRACKS)) {
    if (!idOk(id) || !f) continue;
    const c = cleanTrackFields(f); delete c.name; delete c.color; tracks[id] = c;
  }
  return { tracks, master: cleanMaster(d.master || {}), groups: cleanGroups(d.groups) };
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.s = null;
    this.saveTimer = null;
    ctx.blockConcurrencyWhile(async () => {
      this.s = (await ctx.storage.get('s')) || null;
      if (this.s) this.migrate();
    });
    this.sql = ctx.storage.sql;
    this.ensureTables();
    // Keep-alives are answered by Cloudflare without waking the room, so an idle session costs nothing.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ka"}', '{"type":"ka"}'));
  }
  ensureTables() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS blob_meta (id TEXT PRIMARY KEY, type TEXT, size INTEGER, done INTEGER);
                   CREATE TABLE IF NOT EXISTS blobs (id TEXT, seq INTEGER, data BLOB, PRIMARY KEY (id, seq));`);
  }
  migrate() {
    // sessions created by an older version of the desk get the new fields
    const s = this.s, d = defaultState(s.code, s.engineerKey, s.session.studio);
    for (const k of ['groups', 'markers', 'sections', 'snaps', 'bounces', 'chat']) if (!(k in s)) s[k] = d[k];
    if (!('snapActive' in s)) s.snapActive = null;
    s.session = { ...d.session, ...s.session };
    s.master = { ...d.master, ...s.master };
    s.transport = { ...d.transport, ...s.transport };
    s.tracks = s.tracks.map(t => ({ echo: 0, fx: flatFx(), group: '', at: 0, ...t }));
  }

  /* ---------- RPC from the Worker ---------- */
  async init(code, engineerKey, studio) {
    if (this.s) return { ok: false };
    this.ensureTables();
    this.s = defaultState(code, engineerKey, studio);
    await this.ctx.storage.put('s', this.s);
    await this.ctx.storage.setAlarm(Date.now() + EMPTY_MS);
    return { ok: true };
  }
  async info() { return { exists: !!this.s, people: this.people().length }; }
  canUpload(clientId, key, id) {
    const s = this.s;
    if (!s) return 'This session has ended.';
    if (id.startsWith('bn-')) {
      return this.people().some(p => p.clientId === clientId) || 'Join the session to share a bounce.';
    }
    if (!id.startsWith('st-')) return 'Bad file id.';
    if (s.tracks.length >= MAX_TRACKS) return `A session can hold ${MAX_TRACKS} tracks.`;
    return (key && key === s.engineerKey) || (clientId && clientId === s.controllerId) || 'Only whoever has the desk can add stems.';
  }

  /* ---------- WebSocket ---------- */
  async fetch(req) {
    const url = new URL(req.url), sm = url.pathname.match(/\/stem\/([a-zA-Z0-9-]{1,40})$/);
    if (sm && !this.s) return json({ error: 'This session has ended, so its files were deleted.' }, 404);
    if (sm && req.method === 'PUT') return this.putBlob(req, sm[1]);
    if (sm && req.method === 'GET') return this.getBlob(sm[1], url.searchParams.get('dl'));
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    if (!this.s) return new Response('This session has ended or does not exist.', { status: 404 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ clientId: null, name: '', eng: false });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /* ---------- audio storage (chunked SQLite rows inside this session) ---------- */
  blobMeta(id) { return this.sql.exec('SELECT type, size FROM blob_meta WHERE id = ? AND done = 1', id).toArray()[0] || null; }
  storedBytes() { return this.sql.exec('SELECT COALESCE(SUM(size), 0) AS n FROM blob_meta').one().n; }
  deleteBlob(id) { this.sql.exec('DELETE FROM blobs WHERE id = ?', id); this.sql.exec('DELETE FROM blob_meta WHERE id = ?', id); }
  async putBlob(req, id) {
    const verdict = this.canUpload(req.headers.get('x-client-id') || '', req.headers.get('x-engineer-key') || '', id);
    if (verdict !== true) return json({ error: verdict || 'Not allowed.' }, 403);
    const len = +req.headers.get('content-length') || 0;
    if (!len || !req.body) return json({ error: 'Empty file.' }, 400);
    if (len > MAX_STEM_BYTES) return json({ error: 'That file is over 95 MB. Use an MP3 or a shorter WAV.' }, 413);
    if (this.storedBytes() + len > SESSION_BYTES) return json({ error: 'This session is full (900 MB of audio). Remove a track or use MP3 stems.' }, 507);
    this.deleteBlob(id);
    this.sql.exec('INSERT INTO blob_meta (id, type, size, done) VALUES (?, ?, 0, 0)', id, (req.headers.get('content-type') || 'application/octet-stream').slice(0, 80));
    const reader = req.body.getReader();
    let buf = new Uint8Array(CHUNK), fill = 0, seq = 0, total = 0;
    const flushChunk = () => { if (!fill) return; this.sql.exec('INSERT INTO blobs (id, seq, data) VALUES (?, ?, ?)', id, seq++, buf.slice(0, fill).buffer); fill = 0; };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_STEM_BYTES) throw Object.assign(new Error('too big'), { status: 413 });
        let off = 0;
        while (off < value.length) {
          const n = Math.min(CHUNK - fill, value.length - off);
          buf.set(value.subarray(off, off + n), fill); fill += n; off += n;
          if (fill === CHUNK) flushChunk();
        }
      }
      flushChunk();
      this.sql.exec('UPDATE blob_meta SET size = ?, done = 1 WHERE id = ?', total, id);
      return json({ ok: true });
    } catch (e) {
      this.deleteBlob(id);
      if (e.status === 413) return json({ error: 'That file is over 95 MB.' }, 413);
      if (String(e).includes('SQLITE_FULL')) return json({ error: "The studio's storage is full right now. Try again later, or use MP3 stems." }, 507);
      return json({ error: 'Upload failed. Try again.' }, 500);
    }
  }
  getBlob(id, dl) {
    const meta = this.blobMeta(id);
    if (!meta) return json({ error: 'File not found.' }, 404);
    let seq = 0;
    const sql = this.sql;
    const body = new ReadableStream({
      pull(controller) {
        const row = sql.exec('SELECT data FROM blobs WHERE id = ? AND seq = ?', id, seq).toArray()[0];
        if (!row) { controller.close(); return; }
        seq++; controller.enqueue(new Uint8Array(row.data));
      }
    });
    const headers = { 'content-type': meta.type, 'content-length': String(meta.size), 'cache-control': 'private, max-age=3600' };
    if (dl) {
      const safe = dl.replace(/[^\w .()&'-]+/g, '').slice(0, 120) || 'mix.wav';
      headers['content-disposition'] = `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
    }
    return new Response(body, { headers });
  }

  sockets(except) { return this.ctx.getWebSockets().filter(w => w !== except && (w.deserializeAttachment() || {}).clientId); }
  people(except) {
    const seen = new Map();
    for (const w of this.sockets(except)) { const a = w.deserializeAttachment(); if (!seen.has(a.clientId)) seen.set(a.clientId, { clientId: a.clientId, name: a.name, eng: a.eng }); }
    return [...seen.values()];
  }
  send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch (e) {} }
  broadcast(msg, except) { const t = JSON.stringify(msg); for (const w of this.sockets(except)) { try { w.send(t); } catch (e) {} } }
  publicState() { const { engineerKey, ...rest } = this.s; return rest; }
  save(now = false) {
    if (!this.s) return;
    if (now) { clearTimeout(this.saveTimer); this.saveTimer = null; return this.ctx.storage.put('s', this.s); }
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; if (this.s) this.ctx.storage.put('s', this.s); }, 1500);
  }
  roster(except) { this.broadcast({ type: 'people', people: this.people(except), controllerId: this.s.controllerId, engineerId: this.s.engineerId }, except); }
  notice(text, except) { this.broadcast({ type: 'notice', text }, except); }

  async webSocketMessage(ws, raw) {
    if (!this.s) { this.send(ws, { type: 'ended', reason: 'This session has ended.' }); try { ws.close(1000, 'ended'); } catch (e) {} return; }
    if (typeof raw !== 'string' || raw.length > 64000) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const a = ws.deserializeAttachment() || {};
    const s = this.s;

    if (m.type === 'ping') { this.send(ws, { type: 'pong', t: m.t, s: Date.now() }); return; }

    if (m.type === 'hello') {
      a.clientId = str(m.clientId, 40) || crypto.randomUUID();
      a.name = str(m.name, 32).trim() || 'Guest';
      a.eng = !!m.engineerKey && m.engineerKey === s.engineerKey;
      ws.serializeAttachment(a);
      if (a.eng) {
        s.engineerId = a.clientId;
        const ctrlOnline = this.people().some(p => p.clientId === s.controllerId);
        if (!s.controllerId || !ctrlOnline) s.controllerId = a.clientId;
      }
      this.send(ws, { type: 'welcome', state: this.publicState(), you: { clientId: a.clientId, eng: a.eng }, serverNow: Date.now() });
      this.roster();
      this.save();
      return;
    }
    if (!a.clientId) return; // must say hello first
    const isCtrl = a.clientId === s.controllerId;

    switch (m.type) {
      case 'grant':
        if (a.eng && this.people().some(p => p.clientId === m.to)) { s.controllerId = m.to; this.roster(); this.save(); }
        return;
      case 'takeback': if (a.eng) { s.controllerId = a.clientId; this.roster(); this.save(); } return;
      case 'release': if (isCtrl && !a.eng) { s.controllerId = s.engineerId; this.roster(); this.save(); } return;
      case 'end': if (a.eng) await this.endSession(`${a.name || 'The engineer'} ended the session.`); return;

      case 'chat': { // talkback: anyone in the room can talk
        const text = str(m.text, 300).replace(/[\u0000-\u001f]+/g, ' ').trim();
        if (!text) return;
        const now = Date.now();
        if (a.lastChat && now - a.lastChat < 400) return; // simple flood guard
        a.lastChat = now; ws.serializeAttachment(a);
        const msg = { id: crypto.randomUUID().slice(0, 8), by: a.name, clientId: a.clientId, eng: a.eng, text, at: now, pos: m.pos == null ? null : num(m.pos, 0, 36000, 0) };
        s.chat.push(msg); if (s.chat.length > 80) s.chat.splice(0, s.chat.length - 80);
        this.broadcast({ type: 'chat', msg });
        this.save();
        return;
      }
      case 'bounce': { // someone shared a bounce with the room
        if (!idOk(m.id) || !m.id.startsWith('bn-')) return;
        const head = this.blobMeta(m.id);
        if (!head || s.bounces.some(b => b.id === m.id)) return;
        s.bounces.unshift({ id: m.id, name: str(m.name, 120) || 'Mix.wav', by: a.name, dur: num(m.dur, 0, 36000, 0), at: Date.now(), size: head.size });
        while (s.bounces.length > 12) this.deleteBlob(s.bounces.pop().id);
        this.broadcast({ type: 'bounces', list: s.bounces });
        this.save();
        return;
      }
      case 'op': {
        if (!isCtrl) { this.send(ws, { type: 'denied' }); return; }
        const op = this.applyOp(m.op);
        if (!op) return;
        if (op.k === 'transport') this.broadcast({ type: 'op', op });          // everyone, sender included, plays from the stamped time
        else this.broadcast({ type: 'op', op }, ws);
        if (op.k === 'removeTrack' && !op.id.startsWith('demo-')) this.deleteBlob(op.id);
        this.save(op.k === 'addTrack' || op.k === 'removeTrack');
        return;
      }
    }
  }

  applyOp(op) {
    if (!op || typeof op !== 'object') return null;
    const s = this.s;
    const mixChanged = () => { s.snapActive = null; };
    switch (op.k) {
      case 'track': {
        const t = s.tracks.find(x => x.id === op.id); if (!t) return null;
        const f = cleanTrackFields(op.f);
        if (f.group && !s.groups.some(g => g.id === f.group)) f.group = '';
        Object.assign(t, f);
        if (Object.keys(f).some(k => k !== 'name' && k !== 'color')) mixChanged();
        return { k: 'track', id: t.id, f };
      }
      case 'master': { const f = cleanMaster(op.f || {}); Object.assign(s.master, f); mixChanged(); return { k: 'master', f }; }
      case 'groups': {
        s.groups = cleanGroups(op.list);
        const ids = new Set(s.groups.map(g => g.id));
        s.tracks.forEach(t => { if (t.group && !ids.has(t.group)) t.group = ''; });
        mixChanged(); return { k: 'groups', list: s.groups };
      }
      case 'session': {
        const f = {}, g = op.f || {};
        for (const key of ['studio', 'artist', 'title', 'engineer', 'key']) if (key in g) f[key] = str(g[key], 60);
        if ('bpm' in g) f.bpm = num(g.bpm, 40, 240, 120);
        if ('rec' in g) f.rec = !!g.rec;
        if ('click' in g) f.click = !!g.click;
        if ('countIn' in g) f.countIn = !!g.countIn;
        Object.assign(s.session, f); return { k: 'session', f };
      }
      case 'loop': {
        s.loop = { on: !!op.on, start: num(op.start, 0, 36000, 0), end: num(op.end, 0, 36000, 0) };
        return { k: 'loop', ...s.loop };
      }
      case 'markers': s.markers = cleanMarkers(op.list); return { k: 'markers', list: s.markers };
      case 'sections': s.sections = cleanSections(op.list); return { k: 'sections', list: s.sections };
      case 'order': {
        if (!Array.isArray(op.ids)) return null;
        const pos = new Map(op.ids.map((id, i) => [id, i]));
        s.tracks.sort((x, y) => (pos.has(x.id) ? pos.get(x.id) : 999) - (pos.has(y.id) ? pos.get(y.id) : 999));
        return { k: 'order', ids: s.tracks.map(t => t.id) };
      }
      case 'snap': {
        if (op.slot !== 'A' && op.slot !== 'B') return null;
        s.snaps[op.slot] = cleanMix(op.data); s.snapActive = op.slot;
        return { k: 'snap', slot: op.slot, data: s.snaps[op.slot] };
      }
      case 'recall': {
        if (op.slot !== 'A' && op.slot !== 'B') return null;
        const d = s.snaps[op.slot]; if (!d) return null;
        for (const t of s.tracks) if (d.tracks[t.id]) Object.assign(t, d.tracks[t.id]);
        Object.assign(s.master, d.master);
        s.groups = d.groups.length || !s.groups.length ? d.groups : s.groups;
        const ids = new Set(s.groups.map(g => g.id));
        s.tracks.forEach(t => { if (t.group && !ids.has(t.group)) t.group = ''; });
        s.snapActive = op.slot;
        return { k: 'recall', slot: op.slot, tracks: s.tracks.map(t => ({ id: t.id, fader: t.fader, pan: t.pan, send: t.send, echo: t.echo, mute: t.mute, solo: t.solo, eq: t.eq, fx: t.fx, group: t.group })), master: s.master, groups: s.groups };
      }
      case 'transport': {
        const playing = !!op.playing, countIn = playing && !!op.countIn;
        const bar = 4 * 60 / s.session.bpm * 1000;
        const t = { playing, offset: num(op.offset, 0, 36000, 0), start: Date.now() + (playing ? LEAD_MS + (countIn ? bar : 0) : 0), countIn };
        s.transport = t;
        return { k: 'transport', ...t };
      }
      case 'addTrack': {
        if (s.tracks.length >= MAX_TRACKS) return null;
        const t = op.track || {}; const id = str(t.id, 40);
        if (!idOk(id) || !id.startsWith('st-') || s.tracks.some(x => x.id === id)) return null;
        const nt = { id, name: 'Untitled', color: '#ffa524', fader: UNITY, pan: 0, send: 0.12, echo: 0, mute: false, solo: false, eq: flatEq(), fx: flatFx(), group: '', at: 0, ...cleanTrackFields(t) };
        s.tracks.push(nt); return { k: 'addTrack', track: nt };
      }
      case 'removeTrack': {
        const id = str(op.id, 40); const before = s.tracks.length;
        s.tracks = s.tracks.filter(x => x.id !== id);
        return s.tracks.length === before ? null : { k: 'removeTrack', id };
      }
    }
    return null;
  }

  async webSocketClose(ws) {
    if (!this.s) return;
    const a = ws.deserializeAttachment() || {};
    const left = this.people(ws);
    if (a.clientId && !left.some(p => p.clientId === a.clientId)) {
      // whoever had the desk left: it goes back to the engineer
      if (a.clientId === this.s.controllerId && !a.eng) this.s.controllerId = this.s.engineerId;
    }
    this.roster(ws);
    this.save();
    if (!left.length) await this.ctx.storage.setAlarm(Date.now() + EMPTY_MS);
  }
  async webSocketError(ws) { return this.webSocketClose(ws); }

  async alarm() {
    if (!this.s) { await this.ctx.storage.deleteAll(); return; }
    if (Date.now() - this.s.created > MAX_MS) { await this.endSession('This session reached the 24 hour limit and was closed.'); return; }
    if (!this.people().length) { await this.endSession('Everyone left, so the session was closed.'); return; }
    await this.ctx.storage.setAlarm(Date.now() + EMPTY_MS);
  }

  async endSession(reason) {
    this.broadcast({ type: 'ended', reason });
    for (const w of this.ctx.getWebSockets()) { try { w.close(1000, 'Session ended'); } catch (e) {} }
    clearTimeout(this.saveTimer); this.saveTimer = null;
    this.s = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll(); // removes the session state and every stored stem and bounce
  }
}
