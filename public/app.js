(() => {
'use strict';

/* =====================================================================
   Session Desk: shared studio desk. One person "has the desk" and every
   change they make is sent to the room as an op; everyone's browser
   plays the same stems in sync from a server-stamped start time.
===================================================================== */

/* ================= identity & constants ================= */
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rid = p => p + '-' + Math.random().toString(36).slice(2, 10);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
};
const CODE = ((location.pathname.match(/^\/s\/([A-Za-z0-9]{6})\/?$/) || [])[1] || '').toUpperCase();
let clientId = store.get('sd.cid');
if (!clientId) { clientId = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2); store.set('sd.cid', clientId); }
const engineerKey = CODE ? store.get('sd.key.' + CODE) : null;
const me = { clientId, eng: false, name: store.get('sd.name') || '' };

const TRACK_H = 76;
const PALETTE = ['#ff7a59','#ffc145','#7bd88f','#4cc9f0','#a08bff','#ff6fb5','#3dd6c6','#c0e15c','#f4845f','#7aa2ff'];
const SEC_COLORS = { Intro: '#7aa2ff', Verse: '#3dd6c6', Pre: '#c0e15c', Chorus: '#ffa524', Bridge: '#a08bff', Drop: '#ff4b4b', Outro: '#9aa3b2' };
const ECHO_DIVS = ['1/4', '1/8', '1/8d', '1/16'];
const UNITY = Math.pow(10, -6 / 40);
const flatEq = () => ({ low: 0, mid: 0, midF: 1200, high: 0, bypass: false });
const flatFx = () => ({ cut: { on: false, f: 80 }, phone: { on: false }, sat: { on: false, drive: 0.35 }, comp: { on: false, amt: 0.4 }, dbl: { on: false, mix: 0.5 } });

const state = {
  tracks: [], groups: [], markers: [], sections: [], bounces: [], chat: [],
  snaps: { A: null, B: null }, snapActive: null,
  session: { studio: '', artist: '', title: '', engineer: '', key: '', bpm: 96, rec: false, click: false, countIn: false },
  master: { pos: UNITY, glue: false, ret: 0.85, echoRet: 0.7, echoDiv: '1/8d', eq: flatEq(), cut: { on: false, f: 30 }, lim: { on: false, push: 3 } },
  loop: { on: false, start: 0, end: 10 },
  tp: { playing: false, offset: 0, start: 0, countIn: false },
  zoom: 40, scrollX: 0, follow: true, lanesDirty: true
};
const net = { ws: null, open: false, controllerId: null, engineerId: null, people: [], clockOff: 0, samples: [], ended: false, retry: 0, welcomed: false };
const canControl = () => !!net.controllerId && net.controllerId === me.clientId;
const isLocked = () => document.body.classList.contains('locked');
let ctx = null, master = null, monitor = null, irCache = null, workletReady = null, lufsNode = null;

/* ================= small helpers ================= */
const posToDb = p => p <= 0.001 ? -Infinity : 40 * Math.log10(p) + 6;
const dbToPos = d => Math.pow(10, (d - 6) / 40);
const posToGain = p => { const d = posToDb(p); return d === -Infinity ? 0 : Math.pow(10, d / 20); };
const fmtDb = d => d === -Infinity ? '-inf' : (d > 0 ? '+' : '') + d.toFixed(1);
const fmtPan = v => Math.abs(v) < 0.02 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100);
const fmtPct = v => Math.round(v * 100) + '%';
function fmtTime(s, ms = true) { s = Math.max(0, s); const m = Math.floor(s / 60), r = s - m * 60; return ms ? `${m}:${r.toFixed(3).padStart(6, '0')}` : `${m}:${String(Math.floor(r)).padStart(2, '0')}`; }
function barsBeats(s) { const beats = s * state.session.bpm / 60, bar = Math.floor(beats / 4) + 1, bt = Math.floor(beats % 4) + 1, six = Math.floor((beats % 1) * 4) + 1; return `${String(bar).padStart(3, '0')}.${bt}.${six}`; }
const barOf = s => Math.floor(s * state.session.bpm / 60 / 4) + 1;
const barBeat = s => { const b = s * state.session.bpm / 60; return `${Math.floor(b / 4) + 1}.${Math.floor(b % 4) + 1}`; };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let toastT = 0;
function toast(msg, ms = 2800) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }

/* ================= audio graph ================= */
function ensureCtx() {
  if (ctx) return ctx;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  monitor = ctx.createGain(); monitor.gain.value = monitorGain(); monitor.connect(ctx.destination);
  master = buildMaster(ctx, monitor, true);
  syncGroupsAudio(ctx, master);
  state.tracks.forEach(t => { t.nodes = buildChain(ctx, t, master); });
  workletReady = ctx.audioWorklet ? ctx.audioWorklet.addModule('/worklet.js').then(() => true).catch(() => false) : Promise.resolve(false);
  workletReady.then(ok => { if (ok) attachLufs(); });
  return ctx;
}
const monitorGain = () => Math.pow(+$('monitor').value / 100, 2) * 1.2;
const isOffline = c => typeof OfflineAudioContext !== 'undefined' && c instanceof OfflineAudioContext;
function sp(c, param, v) { if (isOffline(c)) param.value = v; else param.setTargetAtTime(v, c.currentTime, 0.012); }
function irData(sr) {
  if (irCache && irCache.sr === sr) return irCache;
  const len = Math.floor(sr * 2.8), L = new Float32Array(len), R = new Float32Array(len);
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 * 2 - 1; };
  const pre = Math.floor(sr * 0.018);
  for (let i = pre; i < len; i++) { const t = (i - pre) / sr, env = Math.pow(1 - (i - pre) / (len - pre), 3.2) * Math.exp(-t * 1.6); L[i] = rnd() * env; R[i] = rnd() * env; }
  irCache = { sr, L, R }; return irCache;
}
function makeIR(c) { const d = irData(c.sampleRate), b = c.createBuffer(2, d.L.length, c.sampleRate); b.copyToChannel(d.L, 0); b.copyToChannel(d.R, 1); return b; }
const echoSeconds = () => { const b = 60 / state.session.bpm; return { '1/4': b, '1/8': b / 2, '1/8d': b * 0.75, '1/16': b / 4 }[state.master.echoDiv] || b * 0.75; };

function buildMaster(c, dest, live) {
  const m = { groups: new Map() };
  m.input = c.createGain(); m.compIn = c.createGain(); m.dry = c.createGain();
  m.comp = c.createDynamicsCompressor();
  m.comp.threshold.value = -20; m.comp.knee.value = 8; m.comp.ratio.value = 3; m.comp.attack.value = 0.012; m.comp.release.value = 0.2;
  m.makeup = c.createGain(); m.makeup.gain.value = 1.45; m.sum = c.createGain(); m.out = c.createGain();
  m.input.connect(m.compIn); m.compIn.connect(m.comp); m.comp.connect(m.makeup); m.makeup.connect(m.sum);
  m.input.connect(m.dry); m.dry.connect(m.sum);
  // master rack: low cut -> VQ-3 EQ -> master fader -> Lombank limiter (last, so nothing gets past it)
  m.cut = c.createBiquadFilter(); m.cut.type = 'highpass'; m.cut.Q.value = 0.7;
  m.eqL = c.createBiquadFilter(); m.eqL.type = 'lowshelf'; m.eqL.frequency.value = 110;
  m.eqM = c.createBiquadFilter(); m.eqM.type = 'peaking'; m.eqM.Q.value = 0.9;
  m.eqH = c.createBiquadFilter(); m.eqH.type = 'highshelf'; m.eqH.frequency.value = 7500;
  m.limIn = c.createGain();
  m.lim = c.createDynamicsCompressor(); m.lim.knee.value = 0; m.lim.attack.value = 0.001; m.lim.release.value = 0.08;
  m.fader = c.createGain();
  m.clipPre = c.createGain(); m.clip = c.createWaveShaper(); // safety ceiling: catches anything the limiter lets through
  m.sum.connect(m.cut); m.cut.connect(m.eqL); m.eqL.connect(m.eqM); m.eqM.connect(m.eqH); m.eqH.connect(m.fader);
  m.fader.connect(m.limIn); m.limIn.connect(m.lim); m.lim.connect(m.clipPre); m.clipPre.connect(m.clip); m.clip.connect(m.out);
  m.out.connect(dest);
  // Del Perro Hall (reverb bus)
  m.verbIn = c.createGain(); m.conv = c.createConvolver(); m.conv.buffer = makeIR(c); m.verbRet = c.createGain();
  m.verbIn.connect(m.conv); m.conv.connect(m.verbRet); m.verbRet.connect(m.input);
  // Grove St Echo (tempo-synced delay bus)
  m.echoIn = c.createGain(); m.dly = c.createDelay(2.5); m.dlyTone = c.createBiquadFilter(); m.dlyTone.type = 'lowpass'; m.dlyTone.frequency.value = 4200;
  m.dlyHp = c.createBiquadFilter(); m.dlyHp.type = 'highpass'; m.dlyHp.frequency.value = 180;
  m.dlyFb = c.createGain(); m.dlyFb.gain.value = 0.38; m.echoRet = c.createGain();
  m.echoIn.connect(m.dly); m.dly.connect(m.dlyTone); m.dlyTone.connect(m.dlyHp); m.dlyHp.connect(m.dlyFb); m.dlyFb.connect(m.dly);
  m.dlyHp.connect(m.echoRet); m.echoRet.connect(m.input);
  if (live) {
    m.split = c.createChannelSplitter(2); m.out.connect(m.split);
    m.aL = c.createAnalyser(); m.aR = c.createAnalyser(); m.aL.fftSize = m.aR.fftSize = 1024;
    m.split.connect(m.aL, 0); m.split.connect(m.aR, 1);
    m.spec = c.createAnalyser(); m.spec.fftSize = 4096; m.spec.smoothingTimeConstant = 0.75; m.out.connect(m.spec);
    // K-weighting for the loudness meter (ITU-R BS.1770, approximated with two biquads)
    m.kShelf = c.createBiquadFilter(); m.kShelf.type = 'highshelf'; m.kShelf.frequency.value = 1500; m.kShelf.gain.value = 4;
    m.kHp = c.createBiquadFilter(); m.kHp.type = 'highpass'; m.kHp.frequency.value = 38; m.kHp.Q.value = 0.5;
    m.out.connect(m.kShelf); m.kShelf.connect(m.kHp);
  }
  applyMaster(c, m); return m;
}
function applyMaster(c, m) {
  const M = state.master;
  sp(c, m.compIn.gain, M.glue ? 1 : 0); sp(c, m.dry.gain, M.glue ? 0 : 1);
  sp(c, m.verbRet.gain, M.ret); sp(c, m.echoRet.gain, M.echoRet);
  sp(c, m.dly.delayTime, echoSeconds()); sp(c, m.fader.gain, posToGain(M.pos));
  const E = M.eq, byp = E.bypass;
  sp(c, m.cut.frequency, M.cut.on ? M.cut.f : 10);
  sp(c, m.eqL.gain, byp ? 0 : E.low); m.eqM.frequency.value = E.midF; sp(c, m.eqM.gain, byp ? 0 : E.mid); sp(c, m.eqH.gain, byp ? 0 : E.high);
  sp(c, m.limIn.gain, M.lim.on ? Math.pow(10, M.lim.push / 20) : 1);
  sp(c, m.lim.threshold, M.lim.on ? -2 : 0); sp(c, m.lim.ratio, M.lim.on ? 20 : 1);
  m.clipPre.gain.value = M.lim.on ? 0.25 : 1; m.clip.curve = M.lim.on ? ceilingCurve() : null; m.clip.oversample = M.lim.on ? '4x' : 'none';
}
function syncGroupsAudio(c, m) {
  const ids = new Set(state.groups.map(g => g.id));
  m.groups.forEach((n, id) => { if (!ids.has(id)) { Object.values(n).forEach(x => { try { x.disconnect(); } catch (e) {} }); m.groups.delete(id); } });
  state.groups.forEach(g => {
    let n = m.groups.get(g.id);
    if (!n) {
      n = { input: c.createGain(), fader: c.createGain(), mute: c.createGain() };
      n.input.connect(n.fader); n.fader.connect(n.mute); n.mute.connect(m.input);
      if (m.aL) { n.an = c.createAnalyser(); n.an.fftSize = 1024; n.mute.connect(n.an); }
      m.groups.set(g.id, n);
    }
    sp(c, n.fader.gain, posToGain(g.fader)); sp(c, n.mute.gain, g.mute ? 0 : 1);
  });
}
// Soft ceiling at -0.3 dBFS. Input is pre-scaled by 1/4 so the curve covers up to +12 dB over full scale.
let ceilCurve = null;
function ceilingCurve() {
  if (ceilCurve) return ceilCurve;
  const n = 8192, cu = new Float32Array(n), C = Math.pow(10, -0.3 / 20), K = 0.8;
  for (let i = 0; i < n; i++) {
    const u = (i / (n - 1) * 2 - 1) * 4, a = Math.abs(u);
    const y = a <= K ? a : C - (C - K) * Math.exp(-(a - K) / (C - K));
    cu[i] = Math.sign(u) * y;
  }
  return (ceilCurve = cu);
}
const satCurves = new Map();
function satCurve(drive) {
  const key = Math.round(drive * 50); if (satCurves.has(key)) return satCurves.get(key);
  const k = 1 + key / 50 * 14, n = 2048, cu = new Float32Array(n), norm = Math.tanh(k);
  for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; cu[i] = Math.tanh(k * x) / norm; }
  satCurves.set(key, cu); return cu;
}
function buildChain(c, t, m) {
  const n = { m };
  n.input = c.createGain();
  n.cut = c.createBiquadFilter(); n.cut.type = 'highpass'; n.cut.Q.value = 0.7;
  n.phHp = c.createBiquadFilter(); n.phHp.type = 'highpass'; n.phHp.Q.value = 0.9;
  n.phLp = c.createBiquadFilter(); n.phLp.type = 'lowpass'; n.phLp.Q.value = 0.9;
  n.sat = c.createWaveShaper(); n.satOut = c.createGain();
  n.comp = c.createDynamicsCompressor(); n.comp.knee.value = 6; n.comp.attack.value = 0.006; n.comp.release.value = 0.16; n.compOut = c.createGain();
  n.low = c.createBiquadFilter(); n.low.type = 'lowshelf'; n.low.frequency.value = 110;
  n.mid = c.createBiquadFilter(); n.mid.type = 'peaking'; n.mid.Q.value = 0.9;
  n.high = c.createBiquadFilter(); n.high.type = 'highshelf'; n.high.frequency.value = 7500;
  // Vespucci Doubler: two short modulated delays panned wide, mixed with the dry signal
  n.dblSum = c.createGain(); n.dblWet = c.createGain();
  n.dblVoices = []; // built the first time the doubler is switched on, so idle tracks cost nothing
  n.fader = c.createGain(); n.pan = c.createStereoPanner(); n.mute = c.createGain(); n.send = c.createGain(); n.echo = c.createGain();
  n.input.connect(n.cut); n.cut.connect(n.phHp); n.phHp.connect(n.phLp); n.phLp.connect(n.sat); n.sat.connect(n.satOut);
  n.satOut.connect(n.comp); n.comp.connect(n.compOut); n.compOut.connect(n.low); n.low.connect(n.mid); n.mid.connect(n.high);
  n.high.connect(n.dblSum); n.dblWet.connect(n.dblSum); n.dblSum.connect(n.fader);
  n.fader.connect(n.pan); n.pan.connect(n.mute);
  n.mute.connect(n.send); n.send.connect(m.verbIn); n.mute.connect(n.echo); n.echo.connect(m.echoIn);
  if (m.aL) { n.an = c.createAnalyser(); n.an.fftSize = 1024; n.mute.connect(n.an); }
  applyChain(c, t, n);
  return n;
}
function routeTrack(t, n) {
  const g = t.group && n.m.groups.get(t.group), target = g ? g.input : n.m.input;
  if (n.target === target) return;
  if (n.target) { try { n.mute.disconnect(n.target); } catch (e) {} }
  n.mute.connect(target); n.target = target;
}
function audible(t) { if (t.mute) return false; if (state.tracks.some(x => x.solo)) return t.solo; return true; }
function applyChain(c, t, n) {
  const fx = t.fx, byp = t.eq.bypass;
  sp(c, n.cut.frequency, fx.cut.on ? fx.cut.f : 10);
  sp(c, n.phHp.frequency, fx.phone.on ? 480 : 10); sp(c, n.phLp.frequency, fx.phone.on ? 3200 : 22000);
  n.sat.curve = fx.sat.on ? satCurve(fx.sat.drive) : null; n.sat.oversample = fx.sat.on ? '2x' : 'none';
  sp(c, n.satOut.gain, fx.sat.on ? 1 / (1 + fx.sat.drive * 0.9) : 1);
  sp(c, n.comp.threshold, fx.comp.on ? -fx.comp.amt * 32 : 0); sp(c, n.comp.ratio, fx.comp.on ? 1 + fx.comp.amt * 7 : 1);
  sp(c, n.compOut.gain, fx.comp.on ? Math.pow(10, fx.comp.amt * 6 / 20) : 1);
  sp(c, n.low.gain, byp ? 0 : t.eq.low); sp(c, n.mid.gain, byp ? 0 : t.eq.mid); n.mid.frequency.value = t.eq.midF; sp(c, n.high.gain, byp ? 0 : t.eq.high);
  if (fx.dbl.on && !n.dblVoices.length) n.dblVoices = [[0.016, 0.55, -0.75], [0.023, 0.73, 0.75]].map(([base, rate, pan]) => {
    const d = c.createDelay(0.1); d.delayTime.value = base;
    const lfo = c.createOscillator(); lfo.frequency.value = rate; const depth = c.createGain(); depth.gain.value = 0.0022;
    lfo.connect(depth); depth.connect(d.delayTime); lfo.start(0);
    const p = c.createStereoPanner(); p.pan.value = pan;
    n.high.connect(d); d.connect(p); p.connect(n.dblWet);
    return { d, lfo, depth, p };
  });
  sp(c, n.dblWet.gain, fx.dbl.on ? fx.dbl.mix * 0.75 : 0);
  sp(c, n.fader.gain, posToGain(t.fader)); sp(c, n.pan.pan, t.pan);
  sp(c, n.mute.gain, audible(t) ? 1 : 0); sp(c, n.send.gain, t.send); sp(c, n.echo.gain, t.echo);
  routeTrack(t, n);
}
function applyAll() {
  if (!ctx) return;
  syncGroupsAudio(ctx, master);
  state.tracks.forEach(t => t.nodes && applyChain(ctx, t, t.nodes));
  applyMaster(ctx, master);
}

/* ================= clock & transport ================= */
const serverNow = () => Date.now() + net.clockOff;
const songDuration = () => state.tracks.reduce((a, t) => Math.max(a, t.buffer ? t.buffer.duration : 0), 0);
const loopValid = () => state.loop.end - state.loop.start > 0.05;
function tpPos(elapsed) {
  const tp = state.tp, L = state.loop;
  let p = tp.offset + Math.max(0, elapsed);
  if (L.on && loopValid() && tp.offset < L.end && p >= L.end) p = L.start + ((p - L.start) % (L.end - L.start));
  return p;
}
function position() { return state.tp.playing ? tpPos((serverNow() - state.tp.start) / 1000) : state.tp.offset; }
function stopSources() {
  state.tracks.forEach(t => { if (t.source) { try { t.source.stop(); } catch (e) {} try { t.source.disconnect(); } catch (e) {} t.source = null; } });
}
function startSource(t) {
  if (!ctx || !t.buffer || !t.nodes || !state.tp.playing) return;
  if (t.source) { try { t.source.stop(); } catch (e) {} t.source = null; }
  const L = state.loop, looping = L.on && loopValid() && state.tp.offset < L.end;
  let delay = (state.tp.start - serverNow()) / 1000, off = state.tp.offset;
  if (delay < 0.03) { const lead = 0.06; off = tpPos((serverNow() - state.tp.start) / 1000 + lead); delay = lead; }
  if (!looping && off >= t.buffer.duration) return;
  const s = ctx.createBufferSource(); s.buffer = t.buffer;
  if (looping) { s.loop = true; s.loopStart = L.start; s.loopEnd = Math.min(L.end, t.buffer.duration); if (off >= t.buffer.duration) off = L.start; }
  s.connect(t.nodes.input); s.start(ctx.currentTime + delay, off); t.source = s;
}
// The audio engine sleeps a few seconds after playback stops (lets reverb and echo tails ring out),
// so an idle desk uses no CPU while players have the game running.
let idleT = 0;
function wakeAudio() { clearTimeout(idleT); return ctx && ctx.state !== 'running' ? ctx.resume().catch(() => {}) : Promise.resolve(); }
function sleepAudioSoon() {
  clearTimeout(idleT);
  idleT = setTimeout(() => { if (ctx && !state.tp.playing && ctx.state === 'running') ctx.suspend().catch(() => {}); }, 5000);
}
function applyTransport() {
  stopSources(); clickNext = null;
  if (state.tp.playing && ctx) {
    const go = () => { if (!state.tp.playing) return; state.tracks.forEach(startSource); scheduleCountIn(); };
    if (ctx.state === 'running') { clearTimeout(idleT); go(); } else wakeAudio().then(go);
  } else sleepAudioSoon();
  updateTransportUI();
}
function personName(id) { const p = net.people.find(x => x.clientId === id); return p ? (p.clientId === me.clientId ? 'You' : p.name) : ''; }
function denied() { const who = personName(net.controllerId); toast(who ? `${who} has the desk right now.` : 'Nobody has the desk right now.'); }
function sendTransport(playing, offset, countIn = false) {
  if (!canControl()) return denied();
  sendNow({ k: 'transport', playing, offset: Math.max(0, offset), countIn });
}
function play() {
  if (!state.tracks.length) return;
  const dur = songDuration(); let off = position();
  if (off >= dur - 0.01) off = 0;
  if (state.loop.on && loopValid() && off >= state.loop.end) off = state.loop.start;
  sendTransport(true, off, state.session.countIn);
}
function pause() { sendTransport(false, position()); }
function stop() {
  if (state.tp.playing) return pause();
  sendTransport(false, state.loop.on && loopValid() ? state.loop.start : 0);
  state.scrollX = 0; syncHScroll();
}
function seek(t) { sendTransport(state.tp.playing, clamp(t, 0, songDuration())); }
function togglePlay() { state.tp.playing ? pause() : play(); }
function updateTransportUI() {
  $('playBtn').classList.toggle('on', state.tp.playing);
  $('playIcon').innerHTML = state.tp.playing ? '<path d="M3 2h4v12H3zM9 2h4v12H9z"/>' : '<path d="M4 2l10 6-10 6z"/>';
  $('playBtn').setAttribute('aria-label', state.tp.playing ? 'Pause' : 'Play');
  $('loopBtn').classList.toggle('on', state.loop.on);
  $('followBtn').classList.toggle('on', state.follow);
  $('recBtn').classList.toggle('on', state.session.rec);
  $('clickBtn').classList.toggle('on', state.session.click);
  $('countBtn').classList.toggle('on', state.session.countIn);
  document.body.classList.toggle('rec', state.session.rec);
}

/* ---------- click track & count-in (go to your monitor only, never into the mix) ---------- */
let clickNext = null;
function blip(at, accent) {
  if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = accent ? 1760 : 1180; o.type = 'sine';
  g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.32, at + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
  o.connect(g); g.connect(monitor); o.start(at); o.stop(at + 0.08);
}
function scheduleCountIn() {
  if (!state.tp.countIn || !ctx) return;
  const delay = (state.tp.start - serverNow()) / 1000, beat = 60 / state.session.bpm;
  for (let k = 4; k >= 1; k--) { const tb = delay - k * beat; if (tb > -0.01) blip(ctx.currentTime + tb, k === 4); }
}
function scheduleClicks(pos) {
  if (!ctx || !state.tp.playing || !state.session.click || serverNow() < state.tp.start) { if (!state.tp.playing) clickNext = null; return; }
  const beat = 60 / state.session.bpm;
  if (clickNext === null || clickNext < pos - 0.05 || clickNext > pos + 0.3) clickNext = Math.ceil((pos - 0.001) / beat) * beat;
  while (clickNext < pos + 0.15) {
    const at = ctx.currentTime + (clickNext - pos);
    if (at >= ctx.currentTime - 0.005) blip(Math.max(at, ctx.currentTime), Math.round(clickNext / beat) % 4 === 0);
    clickNext += beat;
  }
}

/* ================= ops: everything that changes the shared session ================= */
const pending = new Map(); let flushT = 0;
const LIST_OPS = new Set(['groups', 'markers', 'sections']);
function act(op) {
  if (!canControl()) { denied(); return false; }
  applyOp(op, true);
  let key = null;
  if (op.k === 'track') key = 'track:' + op.id;
  else if (op.k === 'master' || op.k === 'session') key = op.k;
  else if (LIST_OPS.has(op.k)) key = op.k;
  if (key) {
    const prev = pending.get(key);
    if (LIST_OPS.has(op.k) || !prev) pending.set(key, LIST_OPS.has(op.k) ? op : { ...op, f: { ...op.f } });
    else pending.set(key, { ...op, f: { ...prev.f, ...op.f } });
    if (!flushT) flushT = setTimeout(flush, 45);
  } else sendNow(op);
  return true;
}
function flush() { clearTimeout(flushT); flushT = 0; pending.forEach(op => sendRaw({ type: 'op', op })); pending.clear(); }
function sendNow(op) { flush(); sendRaw({ type: 'op', op }); }
function sendRaw(msg) { if (net.ws && net.open) { try { net.ws.send(JSON.stringify(msg)); } catch (e) {} } }
const MIX_FIELDS = ['fader', 'pan', 'send', 'echo', 'mute', 'solo', 'eq', 'fx', 'group'];
function mixChanged() { if (state.snapActive) { state.snapActive = null; updateSnapUI(); } }

function applyOp(op, local) {
  switch (op.k) {
    case 'track': {
      const t = state.tracks.find(x => x.id === op.id); if (!t) return;
      Object.assign(t, op.f);
      if (op.f.eq) t.eq = { ...op.f.eq };
      if (op.f.fx) t.fx = JSON.parse(JSON.stringify(op.f.fx));
      applyAll();
      if (!local) syncTrackUI(t);
      if ('color' in op.f) { buildHeaders(); buildStrips(); }
      if ('group' in op.f) { updateRouteLabels(); buildBusStrips(); }
      refreshStates();
      if (!local && rackTrack === t) openRack(t);
      if ('name' in op.f || 'color' in op.f) state.lanesDirty = true;
      if (Object.keys(op.f).some(k => MIX_FIELDS.includes(k))) mixChanged();
      break;
    }
    case 'master':
      Object.assign(state.master, JSON.parse(JSON.stringify(op.f))); applyAll();
      if (!local && rackMaster) openMasterRack();
      updateMasterRackBtn();
      if (!local) syncMasterUI(); else if ('echoDiv' in op.f) masterUI.div.textContent = 'Echo ' + state.master.echoDiv;
      mixChanged(); break;
    case 'groups':
      state.groups = op.list.map(g => ({ ...g }));
      { const ids = new Set(state.groups.map(g => g.id)); state.tracks.forEach(t => { if (t.group && !ids.has(t.group)) t.group = ''; }); }
      applyAll(); if (!local) buildBusStrips(); updateRouteLabels(); if (rackTrack && !local) openRack(rackTrack);
      mixChanged(); break;
    case 'session':
      Object.assign(state.session, op.f); syncSessionUI(local);
      if ('bpm' in op.f) { state.lanesDirty = true; applyAll(); }
      break;
    case 'loop': state.loop = { on: op.on, start: op.start, end: op.end }; updateTransportUI(); break;
    case 'markers': state.markers = op.list.map(x => ({ ...x })); state.lanesDirty = true; if (!local) renderMap(); break;
    case 'sections': state.sections = op.list.map(x => ({ ...x })); state.lanesDirty = true; if (!local) renderMap(); break;
    case 'order': {
      const pos = new Map(op.ids.map((id, i) => [id, i]));
      state.tracks.sort((a, b) => (pos.has(a.id) ? pos.get(a.id) : 999) - (pos.has(b.id) ? pos.get(b.id) : 999));
      rebuildUI(); break;
    }
    case 'snap': state.snaps[op.slot] = op.data; state.snapActive = op.slot; updateSnapUI(); break;
    case 'recall': {
      op.tracks.forEach(f => { const t = state.tracks.find(x => x.id === f.id); if (!t) return; Object.assign(t, f); t.eq = { ...f.eq }; t.fx = JSON.parse(JSON.stringify(f.fx)); });
      state.master = { ...state.master, ...JSON.parse(JSON.stringify(op.master)) };
      state.groups = op.groups.map(g => ({ ...g }));
      state.snapActive = op.slot;
      applyAll(); rebuildUI(); reopenRack();
      break;
    }
    case 'transport': state.tp = { playing: op.playing, offset: op.offset, start: op.start, countIn: !!op.countIn }; if (op.playing) lufsReset(); applyTransport(); break;
    case 'addTrack': {
      if (state.tracks.some(x => x.id === op.track.id)) return;
      const t = makeTrack(op.track); state.tracks.push(t); loadTrackAudio(t); rebuildUI(); break;
    }
    case 'removeTrack': {
      const t = state.tracks.find(x => x.id === op.id); if (!t) return;
      destroyTrack(t); state.tracks = state.tracks.filter(x => x !== t); rebuildUI(); applyAll(); break;
    }
  }
}
function applyFullState(st) {
  state.session = { ...state.session, ...st.session }; state.master = { ...state.master, ...JSON.parse(JSON.stringify(st.master)) }; state.loop = { ...st.loop };
  state.groups = (st.groups || []).map(g => ({ ...g }));
  state.markers = st.markers || []; state.sections = st.sections || []; state.bounces = st.bounces || [];
  state.chat = st.chat || []; renderChat();
  state.snaps = st.snaps || { A: null, B: null }; state.snapActive = st.snapActive || null;
  const have = new Map(state.tracks.map(t => [t.id, t]));
  state.tracks = st.tracks.map(f => {
    let t = have.get(f.id);
    if (t) { Object.assign(t, trackFields(f)); have.delete(f.id); }
    else { t = makeTrack(f); loadTrackAudio(t); }
    return t;
  });
  have.forEach(destroyTrack);
  net.controllerId = st.controllerId; net.engineerId = st.engineerId;
  applyAll(); rebuildUI(); syncSessionUI(false); syncMasterUI(); renderBounces();
  state.tp = { ...st.transport }; applyTransport(); updateLock();
}
function mixData() {
  const tracks = {};
  state.tracks.forEach(t => { tracks[t.id] = { fader: t.fader, pan: t.pan, send: t.send, echo: t.echo, mute: t.mute, solo: t.solo, eq: { ...t.eq }, fx: JSON.parse(JSON.stringify(t.fx)), group: t.group }; });
  return { tracks, master: JSON.parse(JSON.stringify(state.master)), groups: state.groups.map(g => ({ ...g })) };
}
function recallPayload(slot) {
  const d = state.snaps[slot];
  const groups = (d.groups.length || !state.groups.length) ? d.groups : state.groups;
  const ids = new Set(groups.map(g => g.id));
  return {
    k: 'recall', slot, master: { ...JSON.parse(JSON.stringify(state.master)), ...d.master }, groups,
    tracks: state.tracks.map(t => {
      const f = { id: t.id, fader: t.fader, pan: t.pan, send: t.send, echo: t.echo, mute: t.mute, solo: t.solo, eq: t.eq, fx: t.fx, group: t.group, ...(d.tracks[t.id] || {}) };
      if (f.group && !ids.has(f.group)) f.group = '';
      return f;
    })
  };
}

/* ================= tracks ================= */
function trackFields(t) { return { id: t.id, name: t.name, color: t.color, fader: t.fader, pan: t.pan, send: t.send, echo: t.echo, mute: t.mute, solo: t.solo, eq: { ...t.eq }, fx: JSON.parse(JSON.stringify(t.fx)), group: t.group || '' }; }
function makeTrack(f) {
  const t = { name: 'Untitled', color: '#ffa524', fader: UNITY, pan: 0, send: 0.12, echo: 0, mute: false, solo: false, group: '', ...f,
    eq: { ...flatEq(), ...(f.eq || {}) }, fx: JSON.parse(JSON.stringify(f.fx || flatFx())),
    buffer: null, peaks: null, status: 'Loading…', nodes: null, source: null, lvl: 0, hold: 0, holdT: 0, ui: {} };
  if (ctx) t.nodes = buildChain(ctx, t, master);
  return t;
}
function destroyTrack(t) {
  if (t.source) { try { t.source.stop(); } catch (e) {} }
  if (t.nodes) {
    t.nodes.dblVoices.forEach(v => { try { v.lfo.stop(); } catch (e) {} });
    Object.entries(t.nodes).forEach(([k, n]) => { if (k !== 'm' && k !== 'target' && n && n.disconnect) { try { n.disconnect(); } catch (e) {} } });
  }
  t.dead = true; if (rackTrack === t) closeRack();
}
function setStatus(t, s) { t.status = s; if (t.ui.status) t.ui.status.textContent = s; state.lanesDirty = true; }
async function loadTrackAudio(t) {
  try {
    let buf;
    if (t.id.startsWith('demo-')) buf = (await demoBuffers())[t.id];
    else {
      const res = await fetch(`/api/session/${CODE}/stem/${t.id}`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const total = +res.headers.get('content-length') || 0;
      let ab;
      if (res.body && total) {
        const reader = res.body.getReader(), parts = []; let got = 0;
        for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; setStatus(t, `Downloading ${Math.round(got / total * 100)}%`); }
        const u8 = new Uint8Array(got); let o = 0; for (const p of parts) { u8.set(p, o); o += p.length; } ab = u8.buffer;
      } else ab = await res.arrayBuffer();
      setStatus(t, 'Decoding…');
      buf = await ensureCtx().decodeAudioData(ab);
    }
    if (t.dead || !buf) return;
    t.buffer = buf; t.peaks = computePeaks(buf); setStatus(t, '');
    $('lcdLen').textContent = 'of ' + fmtTime(songDuration(), false);
    syncHScroll(); state.lanesDirty = true;
    if (state.tp.playing) startSource(t);
  } catch (e) { setStatus(t, "Couldn't load"); }
}
function stemName(file) {
  let n = file.replace(/\.[^.]+$/, '');
  const par = n.match(/\(([^)]+)\)\s*$/); if (par) return par[1].trim();
  if (n.includes(' - ')) return n.split(' - ').pop().trim();
  const us = n.split(/[_]+/); if (us.length > 1) return us[us.length - 1].trim();
  return n.trim();
}
function songFromName(file) { const m = file.replace(/\.[^.]+$/, '').match(/^(.*?)\s*\([^)]+\)\s*$/); return m ? m[1].trim() : ''; }
function computePeaks(buf) {
  const B = 256, n = Math.ceil(buf.length / B), mn = new Float32Array(n), mx = new Float32Array(n);
  const chs = []; for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) chs.push(buf.getChannelData(c));
  for (let i = 0; i < n; i++) {
    let lo = 0, hi = 0; const s0 = i * B, s1 = Math.min(buf.length, s0 + B);
    for (const d of chs) for (let s = s0; s < s1; s++) { const v = d[s]; if (v < lo) lo = v; else if (v > hi) hi = v; }
    mn[i] = lo; mx[i] = hi;
  }
  return { mn, mx, per: B / buf.sampleRate };
}
function uploadFile(id, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', `/api/session/${CODE}/stem/${id}`);
    x.setRequestHeader('x-client-id', me.clientId);
    if (engineerKey) x.setRequestHeader('x-engineer-key', engineerKey);
    x.setRequestHeader('content-type', blob.type || 'application/octet-stream');
    x.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => { if (x.status >= 200 && x.status < 300) resolve(); else { let msg = 'Upload failed (' + x.status + ')'; try { msg = JSON.parse(x.responseText).error || msg; } catch (e) {} reject(new Error(msg)); } };
    x.onerror = () => reject(new Error('Upload failed. Check your connection.'));
    x.send(blob);
  });
}
const AUDIO_RE = /\.(wav|mp3|flac|ogg|m4a|aiff?|opus)$/i;
const MIME = { wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aif: 'audio/aiff', aiff: 'audio/aiff' };
const isZip = f => /\.zip$/i.test(f.name) || /zip/i.test(f.type);
// Reads the audio files out of a zip (e.g. Suno's stem download) using the browser's own unzip support.
async function unzipAudio(file) {
  const buf = new Uint8Array(await file.arrayBuffer()), dv = new DataView(buf.buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error(`${file.name} isn't a zip file the desk can read.`);
  const count = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
  if (p === 0xFFFFFFFF) throw new Error(`${file.name} is too big to unzip here. Extract it and drop the files in instead.`);
  const out = [], dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
    const path = dec.decode(buf.subarray(p + 46, p + 46 + nlen)); p += 46 + nlen + xlen + clen;
    const base = path.split('/').pop();
    if (!base || path.startsWith('__MACOSX/') || base.startsWith('.') || !AUDIO_RE.test(base)) continue;
    if (flags & 1) throw new Error(`${base} is password-protected, so it can't be unzipped here.`);
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) {
      if (typeof DecompressionStream === 'undefined') throw new Error("This browser can't unzip files. Extract the zip and drop the files in instead.");
      data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    } else continue;
    out.push(new File([data], base, { type: MIME[base.split('.').pop().toLowerCase()] || 'application/octet-stream' }));
  }
  return out;
}
async function loadFiles(files) {
  if (!canControl()) return denied();
  files = [...files];
  const expanded = [];
  for (const f of files) {
    if (!isZip(f)) { expanded.push(f); continue; }
    try {
      toast(`Unzipping ${f.name}…`, 30000);
      const inner = await unzipAudio(f);
      if (!inner.length) toast(`No audio files found inside ${f.name}.`);
      expanded.push(...inner);
    } catch (e) { toast(e.message); }
  }
  files = expanded.filter(f => /^audio\//.test(f.type) || AUDIO_RE.test(f.name));
  if (!files.length) { if (!files.some(isZip)) toast('No audio stems found. Use WAV or MP3 files, or a zip of them.'); return; }
  ensureCtx();
  state.tracks.filter(t => t.id.startsWith('demo-')).forEach(t => act({ k: 'removeTrack', id: t.id }));
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const jobs = [];
  for (const f of files) {
    let buf;
    try { buf = await ctx.decodeAudioData(await f.arrayBuffer()); }
    catch (e) { toast(`Couldn't read ${f.name}. Try a WAV or MP3.`); continue; }
    if (!state.session.title) { const s = songFromName(f.name); if (s) { act({ k: 'session', f: { title: s } }); $('fTitle').value = s; } }
    const id = rid('st');
    const t = makeTrack({ id, name: stemName(f.name), color: PALETTE[state.tracks.length % PALETTE.length] });
    t.buffer = buf; t.peaks = computePeaks(buf); t.status = 'Uploading 0%';
    state.tracks.push(t); rebuildUI();
    jobs.push(uploadFile(id, f, p => setStatus(t, `Uploading ${Math.round(p * 100)}%`))
      .then(() => {
        if (t.dead) return;
        setStatus(t, '');
        if (!act({ k: 'addTrack', track: trackFields(t) })) return;
        if (state.tp.playing) startSource(t);
      })
      .catch(e => { destroyTrack(t); state.tracks = state.tracks.filter(x => x !== t); rebuildUI(); toast(`${t.name}: ${e.message}`); }));
  }
  await Promise.all(jobs);
}

/* ================= demo stems (generated identically in every browser) ================= */
let demoPromise = null;
function demoBuffers() { return demoPromise || (demoPromise = makeDemo()); }
async function makeDemo() {
  const sr = 44100, bpm = 96, beat = 60 / bpm, bars = 16, len = Math.ceil((bars * 4 * beat + 1.5) * sr);
  const prog = [[57,60,64],[53,57,60],[48,52,55],[55,59,62]], roots = [45, 41, 36, 43];
  const hz = m => 440 * Math.pow(2, (m - 69) / 12);
  let seed = 5; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const noiseBuf = c => { const b = c.createBuffer(1, sr, sr), d = b.getChannelData(0); let s = 3; for (let i = 0; i < d.length; i++) { s = (s * 16807) % 2147483647; d[i] = s / 2147483647 * 2 - 1; } return b; };
  async function render(fn) { const c = new OfflineAudioContext(2, len, sr); const out = c.createGain(); out.connect(c.destination); fn(c, out); return c.startRendering(); }
  const drums = await render((c, out) => {
    const nb = noiseBuf(c);
    for (let b = 0; b < bars * 4; b++) {
      const t = b * beat, inBar = b % 4;
      if (inBar === 0 || inBar === 2 || (b % 8 === 7)) {
        const kt = (b % 8 === 7) ? t + beat / 2 : t, o = c.createOscillator(), g = c.createGain();
        o.frequency.setValueAtTime(150, kt); o.frequency.exponentialRampToValueAtTime(42, kt + 0.12);
        g.gain.setValueAtTime(0.95, kt); g.gain.exponentialRampToValueAtTime(0.001, kt + 0.42);
        o.connect(g); g.connect(out); o.start(kt); o.stop(kt + 0.45);
      }
      if (inBar === 1 || inBar === 3) {
        const s = c.createBufferSource(); s.buffer = nb; const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 0.7;
        const g = c.createGain(); g.gain.setValueAtTime(0.7, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
        s.connect(f); f.connect(g); g.connect(out); s.start(t, rnd() * 0.5); s.stop(t + 0.22);
        const o = c.createOscillator(), og = c.createGain(); o.frequency.value = 190; og.gain.setValueAtTime(0.35, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        o.connect(og); og.connect(out); o.start(t); o.stop(t + 0.12);
      }
      for (let h = 0; h < 2; h++) {
        const ht = t + h * beat / 2, s = c.createBufferSource(); s.buffer = nb;
        const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7500;
        const p = c.createStereoPanner(); p.pan.value = 0.25;
        const g = c.createGain(); const v = h ? 0.16 : 0.26; g.gain.setValueAtTime(v, ht); g.gain.exponentialRampToValueAtTime(0.001, ht + 0.05);
        s.connect(f); f.connect(g); g.connect(p); p.connect(out); s.start(ht, rnd() * 0.5); s.stop(ht + 0.06);
      }
    }
  });
  const bass = await render((c, out) => {
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 520; lp.Q.value = 3; lp.connect(out);
    for (let bar = 0; bar < bars; bar++) for (let e = 0; e < 8; e++) {
      const t = (bar * 4 + e / 2) * beat, r = roots[bar % 4] + (e === 6 ? 12 : 0);
      const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = hz(r);
      const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.45, t + 0.01); g.gain.exponentialRampToValueAtTime(0.02, t + beat / 2 * 0.95);
      o.connect(g); g.connect(lp); o.start(t); o.stop(t + beat / 2);
    }
  });
  const keys = await render((c, out) => {
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2200; lp.connect(out);
    for (let bar = 0; bar < bars; bar++) {
      const t = bar * 4 * beat, d = 4 * beat;
      prog[bar % 4].forEach((m, i) => [0, 7].forEach(det => {
        const o = c.createOscillator(); o.type = 'triangle'; o.frequency.value = hz(m); o.detune.value = det - 3;
        const p = c.createStereoPanner(); p.pan.value = (i - 1) * 0.45;
        const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.09, t + 0.25); g.gain.setValueAtTime(0.09, t + d - 0.3); g.gain.linearRampToValueAtTime(0, t + d);
        o.connect(g); g.connect(p); p.connect(lp); o.start(t); o.stop(t + d + 0.05);
      }));
    }
  });
  const lead = await render((c, out) => {
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200; lp.connect(out);
    const scale = [69, 72, 74, 76, 79, 81]; let s = 11; const r2 = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let bar = 4; bar < bars; bar++) {
      if (bar % 8 === 7) continue;
      const pattern = [0, 1, 1.5, 2.5, 3];
      pattern.forEach((p, k) => {
        if (r2() < 0.18) return;
        const t = (bar * 4 + p) * beat, d = (k === pattern.length - 1 ? 1 : 0.5) * beat * 0.95, m = scale[Math.floor(r2() * scale.length)];
        const o = c.createOscillator(); o.type = 'square'; o.frequency.value = hz(m);
        const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.3, t + 0.01); g.gain.exponentialRampToValueAtTime(0.02, t + d);
        o.connect(g); g.connect(lp); o.start(t); o.stop(t + d + 0.02);
      });
    }
  });
  return { 'demo-drums': drums, 'demo-bass': bass, 'demo-keys': keys, 'demo-lead': lead };
}

/* ================= controls: knob & fader ================= */
function makeKnob({ label, min, max, value, def, fmt, onChange, bipolar, color }) {
  const el = document.createElement('div'); el.className = 'knob lockable'; el.tabIndex = 0;
  el.setAttribute('role', 'slider'); el.setAttribute('aria-label', label);
  el.innerHTML = `<div class="dial"><i></i></div><div class="kv"></div><div class="kl">${esc(label)}</div>`;
  const dial = el.querySelector('.dial'), ptr = el.querySelector('i'), kv = el.querySelector('.kv');
  let v = value; const col = color || 'var(--accent)';
  function draw() {
    const f = (v - min) / (max - min), ang = f * 270;
    ptr.style.transform = `rotate(${ang + 45}deg)`;
    let a0 = 0, a1 = ang; if (bipolar) { a0 = Math.min(135, ang); a1 = Math.max(135, ang); }
    dial.style.background = `conic-gradient(from -135deg,#2d3139 0 ${a0}deg,${col} ${a0}deg ${a1}deg,#2d3139 ${a1}deg 270deg,transparent 270deg)`;
    kv.textContent = fmt(v); el.setAttribute('aria-valuetext', fmt(v));
  }
  function set(nv, fire = true) { if (fire && isLocked()) return; v = clamp(nv, min, max); draw(); if (fire) onChange(v); }
  let sy = 0, sv = 0, drag = false;
  el.addEventListener('pointerdown', e => { if (isLocked()) return; drag = true; sy = e.clientY; sv = v; el.setPointerCapture(e.pointerId); e.preventDefault(); el.focus(); });
  el.addEventListener('pointermove', e => { if (!drag) return; const k = e.shiftKey ? 600 : 150; set(sv + (sy - e.clientY) / k * (max - min)); });
  el.addEventListener('pointerup', () => drag = false);
  el.addEventListener('dblclick', () => set(def));
  el.addEventListener('wheel', e => { if (isLocked()) return; e.preventDefault(); set(v - Math.sign(e.deltaY) * (max - min) / 60); }, { passive: false });
  el.addEventListener('keydown', e => {
    const st = (max - min) / 50;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { set(v + st); e.preventDefault(); e.stopPropagation(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { set(v - st); e.preventDefault(); e.stopPropagation(); }
  });
  draw(); el.set = set; return el;
}
function makeFader(pos, onChange, label) {
  const el = document.createElement('div'); el.className = 'fader lockable'; el.tabIndex = 0;
  el.setAttribute('role', 'slider'); el.setAttribute('aria-label', label);
  el.innerHTML = '<div class="rail"></div><div class="cap"></div>';
  const cap = el.querySelector('.cap'); let p = pos, H = 0; const CAP = 16;
  [6, 0, -6, -12, -24, -40].forEach(d => { const tk = document.createElement('div'); tk.className = 'tick'; tk.dataset.p = dbToPos(d); tk.innerHTML = `<span>${d > 0 ? '+' + d : d}</span>`; el.appendChild(tk); });
  function layout() { H = el.clientHeight; const range = H - CAP; cap.style.top = ((1 - p) * range) + 'px'; el.querySelectorAll('.tick').forEach(tk => tk.style.top = ((1 - tk.dataset.p) * range + CAP / 2) + 'px'); }
  function set(np, fire = true) { if (fire && isLocked()) return; p = clamp(np, 0, 1); layout(); el.setAttribute('aria-valuetext', fmtDb(posToDb(p)) + ' dB'); if (fire) onChange(p); }
  let sy = 0, sp0 = 0, drag = false;
  el.addEventListener('pointerdown', e => {
    if (isLocked()) return;
    const r = el.getBoundingClientRect(), y = e.clientY - r.top, ct = (1 - p) * (H - CAP);
    if (y < ct - 2 || y > ct + CAP + 2) set(1 - (y - CAP / 2) / (H - CAP));
    drag = true; sy = e.clientY; sp0 = p; el.setPointerCapture(e.pointerId); e.preventDefault(); el.focus();
  });
  el.addEventListener('pointermove', e => { if (!drag) return; const k = e.shiftKey ? 0.25 : 1; set(sp0 + (sy - e.clientY) / (H - CAP) * k); });
  el.addEventListener('pointerup', () => drag = false);
  el.addEventListener('dblclick', () => set(UNITY));
  el.addEventListener('wheel', e => { if (isLocked()) return; e.preventDefault(); set(p - Math.sign(e.deltaY) * 0.015); }, { passive: false });
  el.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp') { set(p + 0.01); e.preventDefault(); e.stopPropagation(); }
    if (e.key === 'ArrowDown') { set(p - 0.01); e.preventDefault(); e.stopPropagation(); }
  });
  new ResizeObserver(layout).observe(el);
  el.set = set; set(p, false); return el;
}
function meterEl(n = 1) { const vm = document.createElement('div'); vm.className = 'vm'; vm.innerHTML = '<div><i></i><b></b></div>'.repeat(n); return vm; }

/* ================= build UI ================= */
function rebuildUI() {
  buildHeaders(); buildStrips(); buildBusStrips(); buildMasterStrip();
  $('trackCount').textContent = `${state.tracks.length} track${state.tracks.length === 1 ? '' : 's'}`;
  $('lcdLen').textContent = 'of ' + fmtTime(songDuration(), false);
  refreshStates(); resizeCanvases(); syncHScroll(); updateNotes(); renderMap(); state.lanesDirty = true;
}
function updateNotes() {
  const allDemo = state.tracks.length > 0 && state.tracks.every(t => t.id.startsWith('demo-'));
  const n = $('demoNote');
  n.hidden = !allDemo;
  if (allDemo) n.innerHTML = canControl()
    ? '<b>Demo stems.</b> Drop your Suno stems (or their zip) anywhere on the page, or use <b>+ Stems</b>. They upload once, replace the demo and load for everyone in the room.'
    : '<b>Demo stems.</b> These play until whoever has the desk loads the real stems.';
  $('empty').hidden = state.tracks.length > 0;
  $('emptyTitle').textContent = canControl() ? 'Drop your stems to start' : 'Waiting for stems';
  $('emptyText').textContent = canControl() ? 'WAV or MP3, one file per stem, or the stems zip straight from Suno. They upload once and load for everyone in the room.' : 'Whoever has the desk will load the stems. They appear here for you automatically.';
  $('emptyAdd').hidden = !canControl();
}
const fxActive = t => Object.values(t.fx).some(d => d.on) || (!t.eq.bypass && (t.eq.low || t.eq.mid || t.eq.high));
const groupName = id => (state.groups.find(g => g.id === id) || {}).name || '';

/* ---------- track headers: grip to reorder, click grip for colour ---------- */
function buildHeaders() {
  const h = $('headers'); h.querySelectorAll('.th').forEach(x => x.remove());
  state.tracks.forEach((t, idx) => {
    const row = document.createElement('div'); row.className = 'th'; row.style.setProperty('--c', t.color);
    row.innerHTML = `<div class="th-color" title="Drag to reorder, click to change colour"></div><div class="th-main">
      <div class="th-top"><span class="th-name" spellcheck="false"></span><button class="x lockable" title="Remove track for everyone" aria-label="Remove track">×</button></div>
      <div class="th-ctrls"><button class="ms m lockable" title="Mute">M</button><button class="ms s lockable" title="Solo (Ctrl+click: solo only this)">S</button><button class="fxb" title="Open the channel rack">FX</button><div class="hmeter"><i></i></div></div></div><span class="status"></span>`;
    const nm = row.querySelector('.th-name'); nm.textContent = t.name; nm.contentEditable = canControl() ? 'true' : 'false';
    nm.addEventListener('input', () => { const v = nm.textContent.trim() || 'Untitled'; if (t.ui.sname) t.ui.sname.textContent = v; if (rackTrack === t) $('ptrack').textContent = v; act({ k: 'track', id: t.id, f: { name: v } }); });
    nm.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); nm.blur(); } });
    row.querySelector('.x').onclick = () => act({ k: 'removeTrack', id: t.id });
    row.querySelector('.m').onclick = () => toggleMute(t);
    row.querySelector('.s').onclick = e => toggleSolo(t, e.ctrlKey || e.metaKey);
    row.querySelector('.fxb').onclick = () => openRack(t);
    gripInput(row.querySelector('.th-color'), t, idx, row);
    Object.assign(t.ui, { row, name: nm, hm: row.querySelector('.hmeter i'), hfx: row.querySelector('.fxb'), hM: row.querySelector('.m'), hS: row.querySelector('.s'), status: row.querySelector('.status') });
    t.ui.status.textContent = t.status;
    h.appendChild(row);
  });
}
function gripInput(grip, t, idx, row) {
  let down = false, moved = false, sy = 0, target = idx;
  const line = $('dropline');
  grip.addEventListener('pointerdown', e => { if (isLocked()) return; down = true; moved = false; sy = e.clientY; grip.setPointerCapture(e.pointerId); e.preventDefault(); });
  grip.addEventListener('pointermove', e => {
    if (!down) return;
    if (!moved && Math.abs(e.clientY - sy) > 5) { moved = true; row.classList.add('dragging'); }
    if (!moved) return;
    const r = $('headers').getBoundingClientRect();
    target = clamp(Math.round((e.clientY - r.top) / TRACK_H), 0, state.tracks.length);
    line.style.display = 'block'; line.style.top = (target * TRACK_H - 1) + 'px';
  });
  grip.addEventListener('pointerup', e => {
    if (!down) return; down = false; line.style.display = 'none'; row.classList.remove('dragging');
    if (!moved) { openSwatches(t, e.clientX, e.clientY); return; }
    const ids = state.tracks.map(x => x.id), from = ids.indexOf(t.id);
    let to = target > from ? target - 1 : target;
    if (to === from) return;
    ids.splice(from, 1); ids.splice(to, 0, t.id);
    act({ k: 'order', ids });
  });
}
function openSwatches(t, x, y) {
  const sw = $('swatches'); sw.innerHTML = '';
  PALETTE.forEach(c => {
    const b = document.createElement('button'); b.style.background = c; b.title = c; b.className = c === t.color ? 'cur' : '';
    b.onclick = () => { sw.classList.remove('open'); act({ k: 'track', id: t.id, f: { color: c } }); };
    sw.appendChild(b);
  });
  sw.style.left = Math.min(x + 8, innerWidth - 160) + 'px'; sw.style.top = Math.min(y - 10, innerHeight - 90) + 'px';
  sw.classList.add('open');
}

/* ---------- mixer strips ---------- */
function buildStrips() {
  const s = $('strips'); s.innerHTML = '';
  state.tracks.forEach(t => {
    const st = document.createElement('div'); st.className = 'strip'; st.style.setProperty('--c', t.color);
    const route = document.createElement('button'); route.className = 'route'; route.title = 'Where this track goes: the master, or a bus. Click to change.';
    route.onclick = () => cycleRoute(t);
    const plug = document.createElement('button'); plug.className = 'plug'; plug.textContent = 'Rack'; plug.title = 'Open the channel rack: EQ, low cut, phone, grit, squeeze, doubler'; plug.onclick = () => openRack(t);
    const knobs = document.createElement('div'); knobs.className = 'knobs';
    const kSend = makeKnob({ label: 'Hall', min: 0, max: 1, value: t.send, def: 0, fmt: fmtPct, color: t.color, onChange: v => act({ k: 'track', id: t.id, f: { send: v } }) });
    const kEcho = makeKnob({ label: 'Echo', min: 0, max: 1, value: t.echo, def: 0, fmt: fmtPct, color: t.color, onChange: v => act({ k: 'track', id: t.id, f: { echo: v } }) });
    const kPan = makeKnob({ label: 'Pan', min: -1, max: 1, value: t.pan, def: 0, fmt: fmtPan, bipolar: true, color: t.color, onChange: v => act({ k: 'track', id: t.id, f: { pan: v } }) });
    knobs.append(kSend, kEcho, kPan);
    const ms = document.createElement('div'); ms.className = 'msrow';
    ms.innerHTML = '<button class="ms m lockable" title="Mute">M</button><button class="ms s lockable" title="Solo">S</button>';
    ms.querySelector('.m').onclick = () => toggleMute(t);
    ms.querySelector('.s').onclick = e => toggleSolo(t, e.ctrlKey || e.metaKey);
    const fw = document.createElement('div'); fw.className = 'fwrap';
    const db = document.createElement('div'); db.className = 'db';
    const fader = makeFader(t.fader, p => { db.textContent = fmtDb(posToDb(p)); act({ k: 'track', id: t.id, f: { fader: p } }); }, t.name + ' fader');
    db.textContent = fmtDb(posToDb(t.fader));
    const vm = meterEl(1); fw.append(fader, vm);
    const nm = document.createElement('div'); nm.className = 'sname'; nm.textContent = t.name;
    st.append(route, plug, knobs, ms, fw, db, nm);
    Object.assign(t.ui, { strip: st, plug, route, vm: vm.querySelector('i'), vmh: vm.querySelector('b'), db, sname: nm, sM: ms.querySelector('.m'), sS: ms.querySelector('.s'), kSend, kEcho, kPan, fader });
    s.appendChild(st);
  });
  updateRouteLabels();
}
function updateRouteLabels() {
  state.tracks.forEach(t => {
    if (!t.ui.route) return;
    const g = t.group && groupName(t.group);
    t.ui.route.textContent = g ? '→ ' + g : '→ Master';
    t.ui.route.classList.toggle('bus', !!g);
  });
}
function cycleRoute(t) {
  if (!canControl()) return denied();
  if (!state.groups.length) { toast('Add a bus first with + Bus in the mixer.'); return; }
  const opts = ['', ...state.groups.map(g => g.id)], i = opts.indexOf(t.group || '');
  act({ k: 'track', id: t.id, f: { group: opts[(i + 1) % opts.length] } });
}

/* ---------- buses ---------- */
let busUI = new Map();
function buildBusStrips() {
  const box = $('busStrips'); box.innerHTML = ''; busUI = new Map();
  state.groups.forEach(g => {
    const st = document.createElement('div'); st.className = 'strip busstrip'; st.style.setProperty('--c', g.color);
    const tag = document.createElement('div'); tag.className = 'bustag'; tag.textContent = 'BUS';
    const x = document.createElement('button'); x.className = 'x lockable'; x.textContent = '×'; x.title = 'Remove this bus'; x.setAttribute('aria-label', 'Remove bus');
    x.onclick = () => { act({ k: 'groups', list: state.groups.filter(y => y.id !== g.id) }); buildBusStrips(); };
    const members = document.createElement('div'); members.className = 'kl'; members.style.textAlign = 'center';
    const n = state.tracks.filter(t => t.group === g.id).length; members.textContent = `${n} track${n === 1 ? '' : 's'}`;
    const ms = document.createElement('div'); ms.className = 'msrow';
    const mb = document.createElement('button'); mb.className = 'ms m lockable' + (g.mute ? ' on' : ''); mb.textContent = 'M'; mb.title = 'Mute bus';
    mb.onclick = () => { act({ k: 'groups', list: state.groups.map(y => y.id === g.id ? { ...y, mute: !y.mute } : y) }); mb.classList.toggle('on', g.mute); };
    ms.appendChild(mb);
    const fw = document.createElement('div'); fw.className = 'fwrap';
    const db = document.createElement('div'); db.className = 'db'; db.textContent = fmtDb(posToDb(g.fader));
    const fader = makeFader(g.fader, p => { db.textContent = fmtDb(posToDb(p)); act({ k: 'groups', list: state.groups.map(y => y.id === g.id ? { ...y, fader: p } : y) }); }, g.name + ' bus fader');
    const vm = meterEl(1); fw.append(fader, vm);
    const nm = document.createElement('div'); nm.className = 'sname'; nm.textContent = g.name; nm.contentEditable = canControl() ? 'true' : 'false'; nm.spellcheck = false;
    nm.addEventListener('input', () => { act({ k: 'groups', list: state.groups.map(y => y.id === g.id ? { ...y, name: nm.textContent.trim() || 'Bus' } : y) }); updateRouteLabels(); });
    nm.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); nm.blur(); } });
    st.append(x, tag, members, ms, fw, db, nm);
    busUI.set(g.id, { vm: vm.querySelector('i'), vmh: vm.querySelector('b'), lvl: 0, hold: 0, holdT: 0 });
    box.appendChild(st);
  });
}
$('addBusBtn').onclick = () => {
  if (!canControl()) return denied();
  if (state.groups.length >= 8) { toast('A session can have 8 buses.'); return; }
  const names = ['Drums', 'Vocals', 'Music', 'FX', 'Bus 5', 'Bus 6', 'Bus 7', 'Bus 8'];
  const name = names.find(n => !state.groups.some(g => g.name === n)) || 'Bus';
  act({ k: 'groups', list: [...state.groups, { id: rid('bus'), name, color: '#9aa3b2', fader: UNITY, mute: false }] });
  buildBusStrips(); toast(`Added the ${name} bus. Click a track's "→ Master" label to send it there.`, 4000);
};

/* ---------- master strip with A/B snapshots ---------- */
let masterUI = {}, storeArmed = false;
function buildMasterStrip() {
  const st = $('masterStrip'); st.innerHTML = ''; st.style.setProperty('--c', 'var(--accent)');
  const snaps = document.createElement('div'); snaps.className = 'snaps';
  snaps.innerHTML = '<button data-s="A" class="guard" title="Mix A">A</button><button data-s="B" class="guard" title="Mix B">B</button><button class="store guard" title="Store the current mix into A or B">STORE</button>';
  snaps.querySelectorAll('[data-s]').forEach(b => b.onclick = () => snapClick(b.dataset.s));
  snaps.querySelector('.store').onclick = () => { if (!canControl()) return denied(); storeArmed = !storeArmed; updateSnapUI(); if (storeArmed) toast('Now click A or B to store this mix there.'); };
  const mrack = document.createElement('button'); mrack.className = 'plug'; mrack.id = 'masterRackBtn'; mrack.textContent = 'Master rack'; mrack.title = 'Low cut, EQ and limiter on the whole mix';
  mrack.onclick = openMasterRack;
  const glue = document.createElement('button'); glue.className = 'plug lockable' + (state.master.glue ? ' on' : ''); glue.textContent = 'Pillbox Glue';
  glue.title = 'Bus compressor on the master. Gently glues the mix together.';
  glue.onclick = () => act({ k: 'master', f: { glue: !state.master.glue } }) && glue.classList.toggle('on', state.master.glue);
  const knobs = document.createElement('div'); knobs.className = 'knobs';
  const kRet = makeKnob({ label: 'Hall', min: 0, max: 1.5, value: state.master.ret, def: 0.85, fmt: fmtPct, onChange: v => act({ k: 'master', f: { ret: v } }) });
  const kEchoRet = makeKnob({ label: 'Echo', min: 0, max: 1.5, value: state.master.echoRet, def: 0.7, fmt: fmtPct, onChange: v => act({ k: 'master', f: { echoRet: v } }) });
  knobs.append(kRet, kEchoRet);
  const div = document.createElement('button'); div.className = 'echo-div guard'; div.textContent = 'Echo ' + state.master.echoDiv; div.title = 'Grove St Echo timing, locked to the session tempo. Click to change.';
  div.onclick = () => { const i = ECHO_DIVS.indexOf(state.master.echoDiv); act({ k: 'master', f: { echoDiv: ECHO_DIVS[(i + 1) % ECHO_DIVS.length] } }); };
  const fw = document.createElement('div'); fw.className = 'fwrap';
  const db = document.createElement('div'); db.className = 'db';
  const fader = makeFader(state.master.pos, p => { db.textContent = fmtDb(posToDb(p)); act({ k: 'master', f: { pos: p } }); }, 'Master fader');
  db.textContent = fmtDb(posToDb(state.master.pos));
  const vm = meterEl(2); fw.append(fader, vm);
  const nm = document.createElement('div'); nm.className = 'sname'; nm.textContent = 'MASTER';
  st.append(snaps, mrack, glue, knobs, div, fw, db, nm);
  const is = vm.querySelectorAll('i'), bs = vm.querySelectorAll('b');
  masterUI = { L: is[0], R: is[1], hL: bs[0], hR: bs[1], db, glue, kRet, kEchoRet, div, fader, snaps, lv: [0, 0], hold: [0, 0], holdT: [0, 0] };
  updateSnapUI(); updateMasterRackBtn();
}
function updateMasterRackBtn() {
  const b = $('masterRackBtn'); if (!b) return;
  const M = state.master, lit = M.cut.on || M.lim.on || (!M.eq.bypass && (M.eq.low || M.eq.mid || M.eq.high));
  b.classList.toggle('lit', !!lit);
}
function snapClick(slot) {
  if (!canControl()) return denied();
  if (storeArmed) { storeArmed = false; act({ k: 'snap', slot, data: mixData() }); toast(`Stored the mix as ${slot}.`); return; }
  if (!state.snaps[slot]) { toast(`Mix ${slot} is empty. Press STORE, then ${slot}, to save the current mix there.`, 3800); return; }
  act(recallPayload(slot));
  toast(`Switched to mix ${slot}.`);
}
function updateSnapUI() {
  if (!masterUI.snaps) return;
  masterUI.snaps.querySelectorAll('[data-s]').forEach(b => {
    const s = b.dataset.s; b.classList.toggle('has', !!state.snaps[s]); b.classList.toggle('act', state.snapActive === s);
    b.title = state.snaps[s] ? `Recall mix ${s}` : `Mix ${s} is empty`;
  });
  const st = masterUI.snaps.querySelector('.store'); st.classList.toggle('arm', storeArmed); st.textContent = storeArmed ? 'PICK' : 'STORE';
}
function syncTrackUI(t) {
  const u = t.ui;
  if (u.kSend) u.kSend.set(t.send, false);
  if (u.kEcho) u.kEcho.set(t.echo, false);
  if (u.kPan) u.kPan.set(t.pan, false);
  if (u.fader) { u.fader.set(t.fader, false); u.db.textContent = fmtDb(posToDb(t.fader)); }
  if (u.name && document.activeElement !== u.name) u.name.textContent = t.name;
  if (u.sname) u.sname.textContent = t.name;
}
function syncMasterUI() {
  if (!masterUI.fader) return;
  masterUI.fader.set(state.master.pos, false); masterUI.db.textContent = fmtDb(posToDb(state.master.pos));
  masterUI.kRet.set(state.master.ret, false); masterUI.kEchoRet.set(state.master.echoRet, false);
  masterUI.glue.classList.toggle('on', state.master.glue); masterUI.div.textContent = 'Echo ' + state.master.echoDiv; updateMasterRackBtn();
}
const FIELDS = { fArtist: 'artist', fTitle: 'title', fEngineer: 'engineer', fKey: 'key' };
function syncSessionUI(local) {
  const S = state.session;
  if (!local) {
    Object.entries(FIELDS).forEach(([id, k]) => { if (document.activeElement !== $(id)) $(id).value = S[k] || ''; });
    if (document.activeElement !== $('studioName')) $('studioName').textContent = S.studio || '';
    if (document.activeElement !== $('bpm')) $('bpm').value = S.bpm;
  }
  document.title = (S.studio ? S.studio + ' · ' : '') + 'Session Desk';
  updateTransportUI();
}
function refreshStates() {
  state.tracks.forEach(t => {
    const live = audible(t);
    [t.ui.hM, t.ui.sM].forEach(b => b && b.classList.toggle('on', t.mute));
    [t.ui.hS, t.ui.sS].forEach(b => b && b.classList.toggle('on', t.solo));
    t.ui.row && t.ui.row.classList.toggle('dead', !live);
    t.ui.strip && t.ui.strip.classList.toggle('dead', !live);
    const lit = fxActive(t);
    t.ui.hfx && t.ui.hfx.classList.toggle('lit', lit);
    t.ui.plug && t.ui.plug.classList.toggle('lit', lit);
  });
  state.lanesDirty = true;
}
function toggleMute(t) { act({ k: 'track', id: t.id, f: { mute: !t.mute } }); }
function toggleSolo(t, exclusive) {
  if (!canControl()) return denied();
  if (exclusive) { const was = t.solo; state.tracks.forEach(x => { if (x !== t && x.solo) act({ k: 'track', id: x.id, f: { solo: false } }); }); act({ k: 'track', id: t.id, f: { solo: !was } }); }
  else act({ k: 'track', id: t.id, f: { solo: !t.solo } });
}

/* ================= channel rack window (tracks and master) ================= */
let rackTrack = null, rackMaster = false;
const DEVICES = [
  { key: 'cut', maker: 'Mirror Park Audio', name: 'Low Cut', desc: 'Clears rumble and mud below the cutoff.', knobs: [{ p: 'f', label: 'Cutoff', min: 20, max: 600, def: 80, log: true, fmt: v => Math.round(v) + ' Hz' }] },
  { key: 'phone', maker: 'Davis Telecom', name: 'Phone Box', desc: 'Squeezes the sound down to a phone or radio line.', knobs: [] },
  { key: 'sat', maker: 'Strawberry Valve', name: 'Grit', desc: 'Tube-style saturation for warmth and edge.', knobs: [{ p: 'drive', label: 'Drive', min: 0, max: 1, def: 0.35, fmt: fmtPct }] },
  { key: 'comp', maker: 'Maze Bank Dynamics', name: 'Squeeze', desc: 'Compressor. Evens out the level and brings detail forward.', knobs: [{ p: 'amt', label: 'Amount', min: 0, max: 1, def: 0.4, fmt: fmtPct }] },
  { key: 'eq' },
  { key: 'dbl', maker: 'Vespucci Sound', name: 'Doubler', desc: 'Two detuned copies either side for a wider, thicker sound.', knobs: [{ p: 'mix', label: 'Width', min: 0, max: 1, def: 0.5, fmt: fmtPct }] }
];
// One rack row: power switch, name, knobs. set(patch) returns true if the change was allowed.
function deviceRow({ maker, name, desc, on, color, knobs, set }) {
  const row = document.createElement('div'); row.className = 'dev';
  const pw = document.createElement('button'); pw.className = 'pow lockable' + (on ? ' on' : ''); pw.title = 'On / off'; pw.setAttribute('aria-label', name + ' on/off');
  let isOn = on;
  pw.onclick = () => { if (set({ on: !isOn })) { isOn = !isOn; pw.classList.toggle('on', isOn); } };
  const nm = document.createElement('div'); nm.className = 'dname'; nm.innerHTML = `<small>${esc(maker)}</small><b>${esc(name)}</b><p>${esc(desc)}</p>`;
  row.append(pw, nm);
  knobs.forEach(k => {
    const toV = x => k.log ? Math.log(x / k.min) / Math.log(k.max / k.min) : x, fromV = v => k.log ? k.min * Math.pow(k.max / k.min, v) : v;
    row.appendChild(makeKnob({ label: k.label, min: k.log ? 0 : k.min, max: k.log ? 1 : k.max, value: toV(k.value), def: toV(k.def), fmt: v => k.fmt(fromV(v)), color,
      onChange: v => { if (set({ [k.p]: fromV(v), on: true })) { isOn = true; pw.classList.add('on'); } } }));
  });
  return row;
}
function openRackShell(title, view) {
  ensureCtx();
  $('ptrack').textContent = title; $('pview').textContent = view || (canControl() ? '' : 'view only');
  const p = $('plugin');
  if (!p.classList.contains('open')) { p.style.left = Math.max(16, (innerWidth - 540) / 2) + 'px'; p.style.top = '70px'; }
  p.classList.add('open');
  const rack = $('rack'); rack.innerHTML = ''; return rack;
}
function openRack(t) {
  rackTrack = t; rackMaster = false;
  const rack = openRackShell(t.name);
  document.querySelector('.routing').hidden = false;
  const sel = $('routeSel'); sel.innerHTML = '';
  [['', 'Master'], ...state.groups.map(g => [g.id, g.name + ' bus'])].forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; sel.appendChild(o); });
  sel.value = t.group || ''; sel.disabled = !canControl();
  sel.onchange = () => act({ k: 'track', id: t.id, f: { group: sel.value } });
  DEVICES.forEach(d => {
    if (d.key === 'eq') { rack.appendChild(eqDevice(() => t.eq, t.color, eq => act({ k: 'track', id: t.id, f: { eq } }), () => openRack(t), 'Three-band tone shaping for this track.')); return; }
    rack.appendChild(deviceRow({ maker: d.maker, name: d.name, desc: d.desc, on: t.fx[d.key].on, color: t.color,
      knobs: d.knobs.map(k => ({ ...k, value: t.fx[d.key][k.p] })),
      set: patch => act({ k: 'track', id: t.id, f: { fx: { ...t.fx, [d.key]: { ...t.fx[d.key], ...patch } } } }) }));
  });
  drawEQ();
}
function openMasterRack() {
  rackTrack = null; rackMaster = true;
  const rack = openRackShell('Master bus');
  document.querySelector('.routing').hidden = true;
  const M = state.master;
  rack.appendChild(deviceRow({ maker: 'Mirror Park Audio', name: 'Low Cut', desc: 'Clears rumble below the cutoff from the whole mix.', on: M.cut.on, color: '#ffa524',
    knobs: [{ p: 'f', label: 'Cutoff', min: 20, max: 200, def: 30, log: true, value: M.cut.f, fmt: v => Math.round(v) + ' Hz' }],
    set: patch => act({ k: 'master', f: { cut: { ...state.master.cut, ...patch } } }) }));
  rack.appendChild(eqDevice(() => state.master.eq, '#ffa524', eq => act({ k: 'master', f: { eq } }), openMasterRack, 'Tone shaping for the whole mix. Small moves go a long way here.'));
  const lim = deviceRow({ maker: 'Lombank Mastering', name: 'Limiter', desc: 'Catches peaks before they distort, so you can push the mix louder without clipping. It sits at the very end, after the master fader.', on: M.lim.on, color: '#ffa524',
    knobs: [{ p: 'push', label: 'Push', min: 0, max: 12, def: 3, value: M.lim.push, fmt: v => '+' + v.toFixed(1) + ' dB' }],
    set: patch => act({ k: 'master', f: { lim: { ...state.master.lim, ...patch } } }) });
  const gr = document.createElement('div'); gr.className = 'grbox'; gr.innerHTML = '<span>Reduction</span><div class="grm"><i id="grFill"></i></div><b id="grText">0.0 dB</b>';
  lim.querySelector('.dname').appendChild(gr);
  rack.appendChild(lim);
  drawEQ();
}
function eqDevice(getEq, color, commit, reopen, desc) {
  const wrap = document.createElement('div'); wrap.className = 'dev'; wrap.style.flexDirection = 'column'; wrap.style.alignItems = 'stretch';
  const top = document.createElement('div'); top.style.display = 'flex'; top.style.gap = '12px'; top.style.alignItems = 'center';
  const pw = document.createElement('button'); pw.className = 'pow lockable' + (getEq().bypass ? '' : ' on'); pw.title = 'On / off'; pw.setAttribute('aria-label', 'EQ on/off');
  const setEq = patch => { const ok = commit({ ...getEq(), ...patch }); drawEQ(); return ok; };
  pw.onclick = () => { if (setEq({ bypass: !getEq().bypass })) pw.classList.toggle('on', !getEq().bypass); };
  const nm = document.createElement('div'); nm.className = 'dname'; nm.innerHTML = `<small>Vinewood Audio</small><b>VQ-3 Channel EQ</b><p>${esc(desc)} Double-click a knob to reset it.</p>`;
  const flat = document.createElement('button'); flat.className = 'btn lockable'; flat.textContent = 'Flat'; flat.style.padding = '3px 9px';
  flat.onclick = () => { if (setEq(flatEq())) reopen(); };
  top.append(pw, nm, flat);
  const cv = document.createElement('canvas'); cv.id = 'eqCanvas'; cv.width = 1000; cv.height = 260; cv.style.cssText = 'width:100%;height:130px;display:block;background:#0b0c0e;border-radius:5px;border:1px solid #2c3037;margin-top:8px';
  const kr = document.createElement('div'); kr.className = 'prow';
  const fmtG = v => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
  const midFromV = v => 180 * Math.pow(6000 / 180, v), vFromMid = f => Math.log(f / 180) / Math.log(6000 / 180);
  const fmtF = v => { const f = midFromV(v); return f >= 1000 ? (f / 1000).toFixed(1) + ' kHz' : Math.round(f) + ' Hz'; };
  const e = getEq();
  kr.append(
    makeKnob({ label: 'Low 110', min: -12, max: 12, value: e.low, def: 0, bipolar: true, fmt: fmtG, color, onChange: v => setEq({ low: v }) }),
    makeKnob({ label: 'Mid freq', min: 0, max: 1, value: vFromMid(e.midF), def: vFromMid(1200), fmt: fmtF, color, onChange: v => setEq({ midF: midFromV(v) }) }),
    makeKnob({ label: 'Mid gain', min: -12, max: 12, value: e.mid, def: 0, bipolar: true, fmt: fmtG, color, onChange: v => setEq({ mid: v }) }),
    makeKnob({ label: 'Air 7.5k', min: -12, max: 12, value: e.high, def: 0, bipolar: true, fmt: fmtG, color, onChange: v => setEq({ high: v }) }));
  wrap.append(top, cv, kr);
  return wrap;
}
function closeRack() { $('plugin').classList.remove('open'); rackTrack = null; rackMaster = false; }
function reopenRack() { if (rackMaster) openMasterRack(); else if (rackTrack) openRack(rackTrack); }
$('pclose').onclick = closeRack;
(function dragWin() {
  const p = $('plugin'), h = $('ptitle'); let sx, sy, ox, oy, d = false;
  h.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; d = true; sx = e.clientX; sy = e.clientY; ox = p.offsetLeft; oy = p.offsetTop; h.setPointerCapture(e.pointerId); });
  h.addEventListener('pointermove', e => { if (!d) return; p.style.left = clamp(ox + e.clientX - sx, 0, innerWidth - 120) + 'px'; p.style.top = clamp(oy + e.clientY - sy, 0, innerHeight - 40) + 'px'; });
  h.addEventListener('pointerup', () => d = false);
})();
function drawEQ() {
  const src = rackMaster ? { eq: state.master.eq, color: '#ffa524' } : rackTrack;
  const cv = $('eqCanvas'); if (!src || !ctx || !cv) return;
  const eq = src.eq, g = cv.getContext('2d'), W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  const fx = f => Math.log(f / 20) / Math.log(1000) * W, gy = d => H / 2 - d / 15 * (H / 2 - 14);
  g.font = '18px JetBrains Mono, monospace'; g.fillStyle = '#4a4f58'; g.lineWidth = 2;
  [50, 100, 200, 500, 1000, 2000, 5000, 10000].forEach(f => { const x = fx(f); g.strokeStyle = '#1d2026'; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.fillText(f >= 1000 ? f / 1000 + 'k' : f, x + 4, H - 8); });
  [-12, -6, 0, 6, 12].forEach(d => { const y = gy(d); g.strokeStyle = d === 0 ? '#2f343c' : '#1d2026'; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); g.fillText((d > 0 ? '+' : '') + d, 6, y - 5); });
  const N = 240, fr = new Float32Array(N); for (let i = 0; i < N; i++) fr[i] = 20 * Math.pow(1000, i / (N - 1));
  const total = new Float32Array(N).fill(1);
  if (!eq.bypass) [['lowshelf', 110, eq.low], ['peaking', eq.midF, eq.mid], ['highshelf', 7500, eq.high]].forEach(([type, f, gain]) => {
    const tmp = ctx.createBiquadFilter(); tmp.type = type; tmp.frequency.value = f; tmp.Q.value = 0.9; tmp.gain.value = gain;
    const mag = new Float32Array(N), ph = new Float32Array(N); tmp.getFrequencyResponse(fr, mag, ph);
    for (let i = 0; i < N; i++) total[i] *= mag[i];
  });
  g.beginPath();
  for (let i = 0; i < N; i++) { const x = fx(fr[i]), y = gy(20 * Math.log10(total[i])); i ? g.lineTo(x, y) : g.moveTo(x, y); }
  const col = eq.bypass ? '#555b65' : src.color;
  g.strokeStyle = col; g.lineWidth = 4; g.stroke();
  g.lineTo(W, gy(0)); g.lineTo(0, gy(0)); g.closePath(); g.globalAlpha = 0.14; g.fillStyle = col; g.fill(); g.globalAlpha = 1;
}

/* ================= song map: sections & markers ================= */
function addSection(name) {
  if (!canControl()) return denied();
  const bar = 240 / state.session.bpm, dur = songDuration() || bar * 8;
  let start, end;
  if (loopValid() && state.loop.end <= dur + 0.01) { start = state.loop.start; end = state.loop.end; }
  else { start = Math.floor(position() / bar) * bar; end = Math.min(dur, start + bar * 8); }
  if (end - start < 0.1) { toast('Set a loop region first by dragging on the ruler.'); return; }
  act({ k: 'sections', list: [...state.sections, { id: rid('sc'), start, end, name, color: SEC_COLORS[name] || '#4cc9f0' }].sort((a, b) => a.start - b.start) });
  renderMap();
}
function addMarker() {
  if (!canControl()) return denied();
  if (!state.tracks.length) return;
  const n = state.markers.length + 1;
  act({ k: 'markers', list: [...state.markers, { id: rid('mk'), t: position(), name: `Marker ${n}` }].sort((a, b) => a.t - b.t) });
  renderMap(); toast(`Marker ${n} added at bar ${barBeat(position())}.`);
}
function loopSection(s) {
  if (!canControl()) return denied();
  act({ k: 'loop', on: true, start: s.start, end: s.end });
  sendTransport(state.tp.playing, s.start, false);
}
function renderMap() {
  const pop = $('mapPop'); if (!pop.classList.contains('open')) return;
  if (pop.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return; // don't clobber typing
  const chips = $('secChips');
  if (!chips.children.length) Object.keys(SEC_COLORS).forEach(n => { const b = document.createElement('button'); b.className = 'chip'; b.textContent = '+ ' + n; b.style.borderColor = SEC_COLORS[n] + '88'; b.onclick = () => addSection(n); chips.appendChild(b); });
  const mine = canControl();
  const sr = $('secRows'); sr.innerHTML = '';
  if (!state.sections.length) sr.innerHTML = `<div class="mempty">${mine ? 'No sections yet. Set a loop on the ruler, then pick a name above.' : 'No sections yet.'}</div>`;
  state.sections.forEach(s => {
    const r = document.createElement('div'); r.className = 'mrow';
    r.innerHTML = `<span class="sw" style="background:${s.color}"></span><input aria-label="Section name"><span class="when">bars ${barOf(s.start)}–${barOf(s.end - 0.001)}</span><button class="btn ctl-only">Loop</button><button class="btn ctl-only" aria-label="Delete section">×</button>`;
    const inp = r.querySelector('input'); inp.value = s.name; inp.readOnly = !mine;
    inp.oninput = () => act({ k: 'sections', list: state.sections.map(x => x.id === s.id ? { ...x, name: inp.value } : x) });
    inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); };
    const [lb, xb] = r.querySelectorAll('button');
    lb.onclick = () => loopSection(s);
    xb.onclick = () => { act({ k: 'sections', list: state.sections.filter(x => x.id !== s.id) }); renderMap(); };
    sr.appendChild(r);
  });
  const mr = $('markRows'); mr.innerHTML = '';
  if (!state.markers.length) mr.innerHTML = `<div class="mempty">${mine ? 'No markers yet. Press M while it plays to drop one.' : 'No markers yet.'}</div>`;
  state.markers.forEach(m => {
    const r = document.createElement('div'); r.className = 'mrow';
    r.innerHTML = `<span class="sw" style="background:#ff6fb5;border-radius:50%"></span><input aria-label="Marker name"><span class="when">bar ${barBeat(m.t)}</span><button class="btn ctl-only">Go</button><button class="btn ctl-only" aria-label="Delete marker">×</button>`;
    const inp = r.querySelector('input'); inp.value = m.name; inp.readOnly = !mine;
    inp.oninput = () => act({ k: 'markers', list: state.markers.map(x => x.id === m.id ? { ...x, name: inp.value } : x) });
    inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); };
    const [gb, xb] = r.querySelectorAll('button');
    gb.onclick = () => seek(m.t);
    xb.onclick = () => { act({ k: 'markers', list: state.markers.filter(x => x.id !== m.id) }); renderMap(); };
    mr.appendChild(r);
  });
}
$('addMarkerBtn').onclick = addMarker;

/* ================= popovers ================= */
function wirePop(btnId, popId, onOpen) {
  $(btnId).onclick = e => {
    e.stopPropagation(); const p = $(popId), open = !p.classList.contains('open');
    document.querySelectorAll('.pop.open,.people.open').forEach(x => x !== p && x.classList.remove('open'));
    p.classList.toggle('open', open); $(btnId).setAttribute('aria-expanded', open);
    if (open && onOpen) onOpen();
  };
}
wirePop('peopleBtn', 'people');
wirePop('mapBtn', 'mapPop', renderMap);
wirePop('bouncesBtn', 'bouncePop', renderBounces);
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('.peoplewrap')) $('people').classList.remove('open');
  if (!e.target.closest('.popwrap')) document.querySelectorAll('.pop.open').forEach(p => p.classList.remove('open'));
  if (!e.target.closest('.swatches') && !e.target.closest('.th-color')) $('swatches').classList.remove('open');
});

/* ================= desk control, people ================= */
function updateLock() {
  const mine = canControl();
  document.body.classList.toggle('locked', !mine);
  Object.keys(FIELDS).forEach(id => $(id).readOnly = !mine);
  $('bpm').readOnly = !mine;
  $('studioName').contentEditable = mine ? 'true' : 'false';
  state.tracks.forEach(t => { if (t.ui.name) t.ui.name.contentEditable = mine ? 'true' : 'false'; });
  $('busStrips').querySelectorAll('.sname').forEach(n => n.contentEditable = mine ? 'true' : 'false');
  if (!mine) storeArmed = false;
  const bar = $('deskbar'), txt = $('deskText'), btn = $('deskAction');
  bar.classList.toggle('mine', mine); bar.classList.toggle('off', !net.open);
  btn.hidden = true;
  if (!net.open) txt.textContent = net.welcomed ? 'Reconnecting…' : 'Connecting…';
  else if (mine) {
    txt.textContent = 'You have the desk';
    if (!me.eng) { btn.hidden = false; btn.textContent = 'Give it back'; btn.onclick = () => sendRaw({ type: 'release' }); }
  } else {
    const who = personName(net.controllerId);
    txt.textContent = who ? `Watching · ${who} has the desk` : 'Watching · nobody has the desk';
    if (me.eng) { btn.hidden = false; btn.textContent = 'Take the desk'; btn.onclick = () => sendRaw({ type: 'takeback' }); }
  }
  reopenRack();
  updateNotes(); renderPeople(); renderMap(); updateSnapUI();
}
function renderPeople() {
  const list = $('plist'); list.innerHTML = '';
  $('peopleBtn').textContent = `${net.people.length || 1} in room`;
  net.people.forEach(p => {
    const row = document.createElement('div'); row.className = 'prow2';
    const n = document.createElement('span'); n.className = 'pn'; n.textContent = p.name; row.appendChild(n);
    const tag = (cls, text) => { const s = document.createElement('span'); s.className = 'tag ' + cls; s.textContent = text; row.appendChild(s); };
    if (p.clientId === me.clientId) tag('you', 'You');
    if (p.eng) tag('eng', 'Engineer');
    if (p.clientId === net.controllerId) tag('desk', 'Has desk');
    if (me.eng && p.clientId !== net.controllerId) {
      const b = document.createElement('button'); b.className = 'btn';
      b.textContent = p.clientId === me.clientId ? 'Take desk' : 'Hand desk';
      b.onclick = () => sendRaw(p.clientId === me.clientId ? { type: 'takeback' } : { type: 'grant', to: p.clientId });
      row.appendChild(b);
    }
    list.appendChild(row);
  });
  $('endBtn').hidden = !me.eng;
}
$('copyBtn').onclick = async () => {
  try { await navigator.clipboard.writeText($('inviteUrl').value); toast('Invite link copied.'); }
  catch (e) { $('inviteUrl').select(); toast('Press Ctrl+C to copy the link.'); }
};
let endArm = 0;
$('endBtn').onclick = () => {
  const b = $('endBtn');
  if (!b.classList.contains('arm')) { b.classList.add('arm'); b.textContent = 'Click again to end for everyone'; clearTimeout(endArm); endArm = setTimeout(() => { b.classList.remove('arm'); b.textContent = 'End session and delete stems'; }, 3500); return; }
  sendRaw({ type: 'end' });
};

/* ================= networking ================= */
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/session/${CODE}/ws`);
  net.ws = ws;
  ws.onopen = () => {
    net.open = true; net.retry = 0; net.samples = [];
    let n = 0;
    const burst = () => { sendRaw({ type: 'ping', t: Date.now() }); if (++n < 6) setTimeout(burst, 110); else setTimeout(() => sendRaw({ type: 'hello', clientId: me.clientId, name: me.name, engineerKey }), 150); };
    burst();
  };
  ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } onMessage(m); };
  ws.onclose = ev => {
    net.open = false; updateLock();
    if (net.ended) return;
    if (ev.code === 1000 && ev.reason === 'Session ended') return;
    const wait = Math.min(8000, 500 * Math.pow(2, net.retry++));
    setTimeout(async () => {
      try { const r = await fetch(`/api/session/${CODE}`); const j = await r.json(); if (!j.exists) return showEnded('Session ended', 'This session has closed and its stems were deleted.'); } catch (e) {}
      connect();
    }, wait);
  };
}
// Keep-alive every 30 s (answered without waking the server's room) and a clock re-sync every 2 minutes.
setInterval(() => { if (net.open) sendRaw({ type: 'ka' }); }, 30000);
setInterval(() => { if (net.open) sendRaw({ type: 'ping', t: Date.now() }); }, 120000);
function onMessage(m) {
  switch (m.type) {
    case 'pong': {
      const now = Date.now(), rtt = now - m.t, off = m.s - (m.t + rtt / 2);
      net.samples.push({ rtt, off }); if (net.samples.length > 12) net.samples.shift();
      const best = net.samples.reduce((a, b) => b.rtt < a.rtt ? b : a);
      const changed = Math.abs(best.off - net.clockOff) > 25;
      net.clockOff = best.off;
      if (changed && net.welcomed && state.tp.playing) applyTransport();
      break;
    }
    case 'welcome': me.eng = m.you.eng; net.welcomed = true; applyFullState(m.state); updateLock(); break;
    case 'people': {
      chatRoster(m.people);
      net.people = m.people; net.controllerId = m.controllerId; net.engineerId = m.engineerId;
      const wasMine = !isLocked();
      updateLock();
      if (!wasMine && canControl()) toast('You have the desk.');
      if (wasMine && !canControl()) { flush(); toast('The desk was handed over.'); }
      break;
    }
    case 'op': applyOp(m.op, false); break;
    case 'bounces': state.bounces = m.list; renderBounces(); if (m.list[0]) toast(`${m.list[0].by} shared a bounce: ${m.list[0].name}`, 4000); break;
    case 'notice': toast(m.text, 4500); break;
    case 'chat': state.chat.push(m.msg); if (state.chat.length > 80) state.chat.shift(); addChatLine(m.msg); if (!chatOpen() && m.msg.clientId !== me.clientId) { chatUnread++; updateChatBtn(); } break;
    case 'denied': denied(); break;
    case 'ended': net.ended = true; showEnded('Session ended', m.reason + ' The stems were deleted.'); break;
  }
}
function showEnded(title, text) {
  net.ended = true; stopSources(); if (ctx) ctx.suspend().catch(() => {});
  $('endTitle').textContent = title; $('endText').textContent = text;
  ['landing', 'gate'].forEach(id => $(id).classList.remove('open'));
  $('ended').classList.add('open');
}

/* ================= arrangement drawing ================= */
const ruler = $('ruler'), lanes = $('lanes'), rulerWrap = $('rulerWrap'), lanesWrap = $('lanesWrap'), vscroll = $('vscroll'), hsw = $('hscrollWrap');
let dpr = 1, RW = 0, RH = 44, LW = 0, LH = 0; const cache = document.createElement('canvas');
let loopDraft = null;
const SEC_Y = 0, SEC_H = 13, LOOP_Y = 15, MK_Y = 22;
function resizeCanvases() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  RW = rulerWrap.clientWidth; RH = rulerWrap.clientHeight;
  LW = RW; LH = Math.max(state.tracks.length * TRACK_H, vscroll.clientHeight);
  lanesWrap.style.height = LH + 'px';
  for (const [c, w, h] of [[ruler, RW, RH], [lanes, LW, LH], [cache, LW, LH]]) {
    c.width = Math.max(1, Math.round(w * dpr)); c.height = Math.max(1, Math.round(h * dpr));
    if (c !== cache) { c.style.width = w + 'px'; c.style.height = h + 'px'; }
  }
  state.lanesDirty = true;
}
function syncHScroll() {
  const total = Math.max(LW + 1, (songDuration() + 8) * state.zoom);
  $('hspacer').style.width = total + 'px';
  state.scrollX = clamp(state.scrollX, 0, Math.max(0, total - LW));
  if (Math.abs(hsw.scrollLeft - state.scrollX) > 1) hsw.scrollLeft = state.scrollX;
  state.lanesDirty = true;
}
hsw.addEventListener('scroll', () => { state.scrollX = hsw.scrollLeft; state.lanesDirty = true; });
const tx = t => t * state.zoom - state.scrollX;
const xt = x => (x + state.scrollX) / state.zoom;
function gridStep() { const beatPx = state.zoom * 60 / state.session.bpm, barPx = beatPx * 4; let every = 1; while (barPx * every < 56) every *= 2; return { beatPx, barPx, every }; }
function drawLanesCache() {
  const g = cache.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#0e0f12'; g.fillRect(0, 0, LW, LH);
  // faint section tint behind everything
  state.sections.forEach(s => { const a = tx(s.start), b = tx(s.end); if (b < 0 || a > LW) return; g.fillStyle = s.color; g.globalAlpha = 0.035; g.fillRect(a, 0, b - a, LH); g.globalAlpha = 1; });
  state.tracks.forEach((t, i) => { if (i % 2) { g.fillStyle = 'rgba(255,255,255,.012)'; g.fillRect(0, i * TRACK_H, LW, TRACK_H); } });
  const { beatPx } = gridStep(), beat = 60 / state.session.bpm;
  const firstBeat = Math.floor(xt(0) / beat), lastBeat = Math.ceil(xt(LW) / beat);
  for (let b = Math.max(0, firstBeat); b <= lastBeat; b++) {
    const x = Math.round(tx(b * beat)) + 0.5, isBar = b % 4 === 0;
    if (!isBar && beatPx < 9) continue;
    g.strokeStyle = isBar ? '#22262c' : '#16181c'; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, LH); g.stroke();
  }
  state.tracks.forEach((t, i) => {
    const y = i * TRACK_H, live = audible(t), col = live ? t.color : '#5a5f69';
    if (!t.buffer) {
      g.fillStyle = '#5a5f69'; g.font = '600 11px "IBM Plex Sans Condensed", sans-serif';
      g.fillText(`${t.name}: ${t.status || 'Loading…'}`, 12, y + TRACK_H / 2 + 4); return;
    }
    const x0 = tx(0), x1 = tx(t.buffer.duration);
    if (x1 < 0 || x0 > LW) return;
    const cx0 = Math.max(x0, -4), cx1 = Math.min(x1, LW + 4);
    g.save(); g.beginPath(); g.roundRect ? g.roundRect(cx0, y + 4, cx1 - cx0, TRACK_H - 8, 4) : g.rect(cx0, y + 4, cx1 - cx0, TRACK_H - 8); g.clip();
    g.globalAlpha = live ? 0.16 : 0.08; g.fillStyle = col; g.fillRect(cx0, y + 4, cx1 - cx0, TRACK_H - 8);
    g.globalAlpha = live ? 0.9 : 0.4; g.fillRect(cx0, y + 4, cx1 - cx0, 15);
    g.globalAlpha = 1; g.fillStyle = '#121316'; g.font = '600 10.5px "IBM Plex Sans Condensed", sans-serif';
    g.fillText(t.name + (fxActive(t) ? '  · FX' : '') + (t.group ? `  → ${groupName(t.group)}` : ''), Math.max(cx0, 0) + 6, y + 15.5);
    const top = y + 21, h = TRACK_H - 27, mid = top + h / 2, P = t.peaks, per = P.per;
    g.fillStyle = col; g.globalAlpha = live ? 0.95 : 0.45;
    const sx = Math.max(0, Math.floor(x0)), ex = Math.min(LW, Math.ceil(x1));
    for (let x = sx; x < ex; x++) {
      const t0 = xt(x), t1 = xt(x + 1);
      let i0 = Math.floor(t0 / per), i1 = Math.max(i0 + 1, Math.floor(t1 / per));
      i1 = Math.min(i1, P.mx.length); if (i0 >= P.mx.length) break;
      let lo = 0, hi = 0; for (let k = i0; k < i1; k++) { if (P.mn[k] < lo) lo = P.mn[k]; if (P.mx[k] > hi) hi = P.mx[k]; }
      const yh = mid - Math.min(1, hi) * h / 2, yl = mid - Math.max(-1, lo) * h / 2;
      g.fillRect(x, yh, 1, Math.max(1, yl - yh));
    }
    g.restore();
    g.strokeStyle = '#1a1c21'; g.beginPath(); g.moveTo(0, y + TRACK_H - 0.5); g.lineTo(LW, y + TRACK_H - 0.5); g.stroke();
  });
  // markers: dashed line + label
  g.font = '600 10px "IBM Plex Sans Condensed", sans-serif';
  state.markers.forEach(m => {
    const x = Math.round(tx(m.t)) + 0.5; if (x < -80 || x > LW) return;
    g.strokeStyle = 'rgba(255,111,181,.55)'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, LH); g.stroke(); g.setLineDash([]);
    const w = g.measureText(m.name).width + 8;
    g.fillStyle = '#ff6fb5'; g.fillRect(x, 0, w, 14); g.fillStyle = '#1a0d14'; g.fillText(m.name, x + 4, 10.5);
  });
  state.lanesDirty = false;
}
function drawRuler(pos) {
  const g = ruler.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#16181c'; g.fillRect(0, 0, RW, RH);
  const { beatPx, every } = gridStep(), beat = 60 / state.session.bpm, L = loopDraft || state.loop;
  g.font = '600 9.5px "IBM Plex Sans Condensed", sans-serif';
  state.sections.forEach(s => {
    const a = tx(s.start), b = tx(s.end); if (b < 0 || a > RW) return;
    g.fillStyle = s.color; g.globalAlpha = 0.85; g.fillRect(a + 1, SEC_Y + 1, b - a - 2, SEC_H - 1); g.globalAlpha = 1;
    g.save(); g.beginPath(); g.rect(a + 1, SEC_Y, b - a - 2, SEC_H); g.clip();
    g.fillStyle = '#111215'; g.fillText(s.name.toUpperCase(), Math.max(a, 0) + 5, SEC_Y + 10); g.restore();
  });
  if (state.tracks.length && L.end - L.start > 0.05) {
    const a = tx(L.start), b = tx(L.end);
    g.fillStyle = (L.on || loopDraft) ? 'rgba(255,165,36,.85)' : 'rgba(255,165,36,.25)'; g.fillRect(a, LOOP_Y, b - a, 5);
  }
  g.font = '10px "JetBrains Mono", monospace';
  const firstBar = Math.max(0, Math.floor(xt(0) / beat / 4)), lastBar = Math.ceil(xt(RW) / beat / 4);
  for (let bar = firstBar; bar <= lastBar; bar++) {
    const x = Math.round(tx(bar * 4 * beat)) + 0.5;
    if (bar % every === 0) { g.strokeStyle = '#4a4f58'; g.beginPath(); g.moveTo(x, 27); g.lineTo(x, RH); g.stroke(); g.fillStyle = '#9aa0aa'; g.fillText(String(bar + 1), x + 4, 38); }
    if (beatPx >= 9) for (let k = 1; k < 4; k++) { const bx = Math.round(tx((bar * 4 + k) * beat)) + 0.5; g.strokeStyle = '#2e323a'; g.beginPath(); g.moveTo(bx, 36); g.lineTo(bx, RH); g.stroke(); }
  }
  state.markers.forEach(m => { const x = tx(m.t); if (x < -6 || x > RW + 6) return; g.fillStyle = '#ff6fb5'; g.beginPath(); g.moveTo(x - 4, MK_Y); g.lineTo(x + 4, MK_Y); g.lineTo(x, MK_Y + 6); g.fill(); });
  if (state.tracks.length) { const x = tx(pos); g.fillStyle = '#fff'; g.beginPath(); g.moveTo(x - 5, RH - 9); g.lineTo(x + 5, RH - 9); g.lineTo(x, RH); g.fill(); }
}
function drawLanes(pos) {
  if (state.lanesDirty) drawLanesCache();
  const g = lanes.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(cache, 0, 0); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (state.tracks.length && state.loop.on && loopValid()) {
    const a = tx(state.loop.start), b = tx(state.loop.end);
    g.fillStyle = 'rgba(255,165,36,.06)'; g.fillRect(a, 0, b - a, LH);
    g.strokeStyle = 'rgba(255,165,36,.4)'; g.beginPath(); g.moveTo(a + .5, 0); g.lineTo(a + .5, LH); g.moveTo(b - .5, 0); g.lineTo(b - .5, LH); g.stroke();
  }
  if (state.tracks.length) { const x = Math.round(tx(pos)) + 0.5; g.strokeStyle = '#ffffff'; g.lineWidth = 1; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, LH); g.stroke(); }
}
(function rulerInput() {
  let down = false, sx = 0, moved = false, zone = '';
  const beat = () => 60 / state.session.bpm, snap = t => Math.round(t / beat()) * beat();
  rulerWrap.addEventListener('pointerdown', e => {
    if (!state.tracks.length) return; if (!canControl()) return denied();
    zone = e.offsetY < SEC_H + 1 ? 'sec' : 'main';
    down = true; moved = false; sx = e.offsetX; rulerWrap.setPointerCapture(e.pointerId);
  });
  rulerWrap.addEventListener('pointermove', e => {
    if (!down) return;
    if (Math.abs(e.offsetX - sx) > 4) moved = true;
    if (moved) loopDraft = { on: true, start: clamp(snap(xt(Math.min(sx, e.offsetX))), 0, songDuration()), end: clamp(snap(xt(Math.max(sx, e.offsetX))), 0, songDuration()) };
  });
  rulerWrap.addEventListener('pointerup', e => {
    if (!down) return; down = false;
    if (!moved) {
      const t = xt(e.offsetX);
      if (zone === 'sec') { const s = state.sections.find(s => t >= s.start && t < s.end); if (s) { loopSection(s); return; } }
      const mk = state.markers.find(m => Math.abs(tx(m.t) - e.offsetX) < 6 && e.offsetY >= MK_Y - 2 && e.offsetY <= MK_Y + 9);
      seek(mk ? mk.t : t); return;
    }
    const d = loopDraft; loopDraft = null;
    if (d && d.end - d.start > 0.05) {
      act({ k: 'loop', on: true, start: d.start, end: d.end });
      sendTransport(state.tp.playing, state.tp.playing ? d.start : (state.tp.offset < d.start || state.tp.offset >= d.end ? d.start : state.tp.offset));
    }
  });
})();
lanesWrap.addEventListener('pointerdown', e => { if (!state.tracks.length || !canControl()) return; seek(xt(e.offsetX)); });
function onWheel(e) {
  if (e.ctrlKey || e.metaKey) { e.preventDefault(); const r = lanesWrap.getBoundingClientRect(), mx = e.clientX - r.left; setZoom(state.zoom * Math.pow(1.0018, -e.deltaY), xt(mx), mx); }
  else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) { e.preventDefault(); hsw.scrollLeft += (e.shiftKey ? e.deltaY : e.deltaX); }
}
lanesWrap.addEventListener('wheel', onWheel, { passive: false });
rulerWrap.addEventListener('wheel', onWheel, { passive: false });
const zoomFromSlider = v => 4 * Math.pow(100, v / 100), sliderFromZoom = z => Math.log(z / 4) / Math.log(100) * 100;
function setZoom(z, tAt, mx) { state.zoom = clamp(z, 4, 400); $('zoom').value = sliderFromZoom(state.zoom); state.scrollX = Math.max(0, tAt * state.zoom - mx); syncHScroll(); hsw.scrollLeft = state.scrollX; }
$('zoom').addEventListener('input', e => { const mx = LW / 2; setZoom(zoomFromSlider(+e.target.value), xt(mx), mx); });

/* ================= meters, spectrum, loudness ================= */
const meterBuf = new Float32Array(1024);
function peakOf(an) { an.getFloatTimeDomainData(meterBuf); let p = 0; for (let i = 0; i < meterBuf.length; i++) { const v = Math.abs(meterBuf[i]); if (v > p) p = v; } return p; }
const meterFrac = p => p <= 0.00001 ? 0 : clamp((20 * Math.log10(p) + 60) / 66, 0, 1);
function runMeter(o, p, now, fill, holdEl, vertical = true) {
  const f = meterFrac(p);
  o.lvl = Math.max(f, (o.lvl || 0) * 0.9);
  if (f >= (o.hold || 0)) { o.hold = f; o.holdT = now; } else if (now - o.holdT > 900) o.hold = Math.max(o.lvl, o.hold - 0.01);
  if (fill) fill.style.transform = vertical ? `scaleY(${o.lvl})` : `scaleX(${o.lvl})`;
  if (holdEl) { holdEl.style.bottom = `calc(${o.hold * 100}% - 2px)`; holdEl.style.opacity = o.hold > 0.01 ? .85 : 0; }
}
const lufs = { blocks: [], gated: [] };
const toLufs = ms => ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity;
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
function lufsReset() { lufs.gated = []; }
function attachLufs() {
  try {
    lufsNode = new AudioWorkletNode(ctx, 'sd-lufs', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'explicit' });
    const sink = ctx.createGain(); sink.gain.value = 0; lufsNode.connect(sink); sink.connect(ctx.destination);
    master.kHp.connect(lufsNode);
    lufsNode.port.onmessage = e => {
      lufs.blocks.push(e.data); if (lufs.blocks.length > 30) lufs.blocks.shift();
      if (state.tp.playing && serverNow() >= state.tp.start && lufs.blocks.length >= 4) lufs.gated.push(mean(lufs.blocks.slice(-4)));
    };
  } catch (e) {}
}
function integrated() {
  const abs = lufs.gated.filter(v => toLufs(v) > -70); if (!abs.length) return -Infinity;
  const rel = toLufs(mean(abs)) - 10; const g = abs.filter(v => toLufs(v) > rel);
  return toLufs(mean(g.length ? g : abs));
}
const fmtL = v => v > -70 ? v.toFixed(1) : '–';
let lastLufsUi = 0;
function drawLoudness(now) {
  if (now - lastLufsUi < 200) return; lastLufsUi = now;
  $('lufsM').textContent = fmtL(toLufs(mean(lufs.blocks.slice(-4))));
  $('lufsS').textContent = fmtL(toLufs(mean(lufs.blocks)));
  $('lufsI').textContent = fmtL(integrated());
}
const specCv = $('spec'), specG = specCv.getContext('2d'); let specData = null, specBars = null;
function drawSpectrum() {
  const W = specCv.width, H = specCv.height, N = 72;
  specG.fillStyle = '#0a0b0d'; specG.fillRect(0, 0, W, H);
  specG.strokeStyle = '#191c21'; specG.lineWidth = 1;
  [100, 1000, 10000].forEach(f => { const x = Math.log(f / 30) / Math.log(16000 / 30) * W; specG.beginPath(); specG.moveTo(x, 0); specG.lineTo(x, H); specG.stroke(); specG.fillStyle = '#3a3f48'; specG.font = '18px JetBrains Mono, monospace'; specG.fillText(f >= 1000 ? f / 1000 + 'k' : f, x + 4, H - 8); });
  if (!master || !master.spec) return;
  const a = master.spec; if (!specData) { specData = new Float32Array(a.frequencyBinCount); specBars = new Float32Array(N); }
  a.getFloatFrequencyData(specData);
  const binHz = ctx.sampleRate / a.fftSize, bw = W / N;
  for (let i = 0; i < N; i++) {
    const f0 = 30 * Math.pow(16000 / 30, i / N), f1 = 30 * Math.pow(16000 / 30, (i + 1) / N);
    let mx = -140; for (let b = Math.floor(f0 / binHz); b <= Math.ceil(f1 / binHz) && b < specData.length; b++) mx = Math.max(mx, specData[b]);
    const v = clamp((mx + 90) / 80, 0, 1);
    specBars[i] = Math.max(v, specBars[i] - 0.02);
    const h = specBars[i] * (H - 4);
    const grd = specG.createLinearGradient(0, H, 0, H - h); grd.addColorStop(0, '#ff7a1a'); grd.addColorStop(1, '#ffd23f');
    specG.fillStyle = grd; specG.fillRect(i * bw + 1, H - h, bw - 2, h);
  }
}
const joinedAt = Date.now(); let lastClock = 0;
function frame(now) {
  const dur = songDuration();
  let pos = position();
  if (state.tp.playing && !(state.loop.on && loopValid()) && dur > 0 && pos >= dur && state.tracks.every(t => t.buffer)) {
    stopSources(); state.tp = { playing: false, offset: dur, start: 0 }; pos = dur; updateTransportUI();
    if (canControl()) sendNow({ k: 'transport', playing: false, offset: dur });
  }
  scheduleClicks(pos);
  if (state.tp.playing && state.follow && LW) {
    const x = tx(pos);
    if (x > LW * 0.9 || x < 0) { state.scrollX = Math.max(0, pos * state.zoom - LW * 0.1); syncHScroll(); hsw.scrollLeft = state.scrollX; }
  }
  drawRuler(pos); drawLanes(pos);
  const preroll = state.tp.playing && state.tp.countIn ? (state.tp.start - serverNow()) / 1000 : 0;
  $('lcdBars').textContent = preroll > 0 ? `COUNT ${Math.min(4, Math.max(1, 4 - Math.floor(preroll / (60 / state.session.bpm))))}` : barsBeats(pos);
  $('lcdTime').textContent = fmtTime(pos);
  const live = ctx && state.tp.playing;
  state.tracks.forEach(t => runMeter(t, live && t.nodes && t.nodes.an ? peakOf(t.nodes.an) : 0, now, t.ui.vm, t.ui.vmh));
  state.tracks.forEach(t => { if (t.ui.hm) t.ui.hm.style.transform = `scaleX(${t.lvl})`; });
  busUI.forEach((u, id) => { const n = master && master.groups.get(id); runMeter(u, live && n && n.an ? peakOf(n.an) : 0, now, u.vm, u.vmh); });
  if (masterUI.L) {
    ['L', 'R'].forEach((ch, k) => {
      const p = live ? peakOf(k ? master.aR : master.aL) : 0, o = { lvl: masterUI.lv[k], hold: masterUI.hold[k], holdT: masterUI.holdT[k] };
      runMeter(o, p, now, masterUI[ch], k ? masterUI.hR : masterUI.hL);
      masterUI.lv[k] = o.lvl; masterUI.hold[k] = o.hold; masterUI.holdT[k] = o.holdT;
      if (p >= 1) masterUI.clipAt = now;
    });
    masterUI.db.classList.toggle('clip', !!(masterUI.clipAt && now - masterUI.clipAt < 1500));
  }
  if (!$('mixer').classList.contains('hide')) { drawSpectrum(); drawLoudness(now); }
  if (rackMaster && master && $('grText')) {
    const r = state.master.lim.on ? Math.min(0, master.lim.reduction) : 0;
    $('grText').textContent = r.toFixed(1) + ' dB'; $('grFill').style.transform = `scaleX(${clamp(-r / 12, 0, 1)})`;
  }
  if (now - lastClock > 500) {
    lastClock = now; const s = Math.floor((Date.now() - joinedAt) / 1000);
    $('clock').textContent = 'SESSION ' + [s / 3600, (s / 60) % 60, s % 60].map(v => String(Math.floor(v)).padStart(2, '0')).join(':');
  }
  requestAnimationFrame(frame);
}

/* ================= bounce & share ================= */
let bounceBlob = null, bounceName = '', bounceDur = 0;
function encodeWav(buf) {
  const ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate, bytes = len * ch * 2;
  const ab = new ArrayBuffer(44 + bytes), v = new DataView(ab);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, ch, true); v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, bytes, true);
  const data = []; for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  let o = 44; for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) { const s = clamp(data[c][i], -1, 1); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
  return new Blob([ab], { type: 'audio/wav' });
}
const safe = s => (s || '').replace(/[\\/:*?"<>|]+/g, '').trim();
async function bounce() {
  if (!state.tracks.some(t => t.buffer)) { toast('No stems loaded yet.'); return; }
  ensureCtx();
  $('bounceModal').classList.add('open');
  $('bTitle').textContent = 'Bouncing mix'; $('bText').textContent = 'Rendering every stem through the desk, with the current mix and rack settings.';
  $('bBar').classList.remove('done'); $('bStats').hidden = true; $('bSave').hidden = true; $('bShare').hidden = true; bounceBlob = null;
  await new Promise(r => setTimeout(r, 60));
  try {
    const sr = ctx.sampleRate, tail = state.tracks.some(t => (t.send > 0.001 || t.echo > 0.001) && audible(t)) ? 3 : 0.3;
    const off = new OfflineAudioContext(2, Math.ceil((songDuration() + tail) * sr), sr);
    const mm = buildMaster(off, off.destination, false);
    syncGroupsAudio(off, mm);
    state.tracks.forEach(t => { if (!t.buffer) return; const n = buildChain(off, t, mm); const s = off.createBufferSource(); s.buffer = t.buffer; s.connect(n.input); s.start(0); });
    const out = await off.startRendering();
    let peak = 0; for (let c = 0; c < out.numberOfChannels; c++) { const d = out.getChannelData(c); for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; } }
    bounceBlob = encodeWav(out); bounceDur = out.duration;
    const artist = safe(state.session.artist), title = safe(state.session.title) || 'Untitled';
    bounceName = (artist ? artist + ' - ' : '') + title + (state.snapActive ? ` (mix ${state.snapActive})` : ' (mix)') + '.wav';
    $('bBar').classList.add('done'); $('bStats').hidden = false;
    $('bLen').textContent = fmtTime(out.duration, false); $('bPeak').textContent = fmtDb(peak > 0 ? 20 * Math.log10(peak) : -Infinity) + ' dB';
    $('bPeak').style.color = peak >= 1 ? 'var(--rec)' : '';
    $('bTitle').textContent = 'Mix bounced';
    $('bText').textContent = (peak >= 1 ? 'Heads up: the mix clips. Pull the master fader down a little and bounce again. ' : '') + 'Save it to this computer, or share it so everyone in the room can download it.';
    $('bSave').hidden = false; $('bShare').hidden = false; $('bShare').disabled = false; $('bShare').textContent = 'Share with room';
  } catch (e) { $('bTitle').textContent = 'Bounce failed'; $('bText').textContent = 'The browser could not render the mix: ' + (e && e.message || e); }
}
$('bounceBtn').onclick = bounce;
$('bClose').onclick = () => $('bounceModal').classList.remove('open');
$('bSave').onclick = () => { if (!bounceBlob) return; const a = document.createElement('a'); a.href = URL.createObjectURL(bounceBlob); a.download = bounceName; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000); };
$('bShare').onclick = async () => {
  if (!bounceBlob) return;
  const b = $('bShare'), id = rid('bn'); b.disabled = true;
  try {
    await uploadFile(id, bounceBlob, p => b.textContent = `Sharing ${Math.round(p * 100)}%`);
    sendRaw({ type: 'bounce', id, name: bounceName, dur: bounceDur });
    b.textContent = 'Shared'; toast('Shared with the room. Everyone can download it from Bounces.');
  } catch (e) { b.disabled = false; b.textContent = 'Share with room'; toast(e.message); }
};
function renderBounces() {
  $('bouncesBtn').textContent = state.bounces.length ? `Bounces (${state.bounces.length})` : 'Bounces';
  const l = $('blist'); l.innerHTML = '';
  if (!state.bounces.length) { l.innerHTML = '<div class="mempty">Nothing shared yet. Bounce the mix, then press Share with room.</div>'; return; }
  state.bounces.forEach(b => {
    const r = document.createElement('div'); r.className = 'brow';
    const when = new Date(b.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    r.innerHTML = `<div class="bn"><b></b><span>${fmtTime(b.dur, false)} · ${(b.size / 1048576).toFixed(1)} MB · by ${esc(b.by)} at ${when}</span></div><a>Download</a>`;
    r.querySelector('b').textContent = b.name;
    const a = r.querySelector('a'); a.href = `/api/session/${CODE}/stem/${b.id}?dl=${encodeURIComponent(b.name)}`;
    l.appendChild(r);
  });
}

/* ================= credits card ================= */
function creditsInfo() {
  const S = state.session, stems = state.tracks.filter(t => !t.id.startsWith('demo-')).map(t => t.name);
  return {
    studio: S.studio || 'Unnamed studio', title: S.title || 'Untitled', artist: S.artist || 'Unknown artist', engineer: S.engineer || personName(net.engineerId) || '—',
    date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    length: fmtTime(songDuration(), false), bpm: S.bpm, key: S.key || '—', code: CODE,
    stems: stems.length ? stems : state.tracks.map(t => t.name), sections: state.sections.map(s => s.name)
  };
}
function drawCredits() {
  const c = $('creditsCanvas'), g = c.getContext('2d'), W = c.width, H = c.height, I = creditsInfo();
  const F = (w, s) => `${w} ${s}px "IBM Plex Sans Condensed", "Arial Narrow", sans-serif`;
  g.fillStyle = '#101114'; g.fillRect(0, 0, W, H);
  const grd = g.createRadialGradient(W * 0.85, -100, 50, W * 0.85, -100, 700); grd.addColorStop(0, 'rgba(255,165,36,.22)'); grd.addColorStop(1, 'rgba(255,165,36,0)');
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  g.fillStyle = '#ffa524'; g.fillRect(0, 0, 14, H);
  const fit = (text, weight, size, maxW) => { let s = size; g.font = F(weight, s); while (g.measureText(text).width > maxW && s > 20) { s -= 2; g.font = F(weight, s); } return s; };
  g.fillStyle = '#ffa524'; g.font = F(600, 20); g.fillText('RECORDED AT', 70, 82);
  fit(I.studio, 700, 40, W - 140); g.fillStyle = '#d9dce2'; g.fillText(I.studio, 70, 128);
  const ts = fit(I.title, 700, 96, W - 140); g.fillStyle = '#ffffff'; g.fillText(I.title, 70, 210 + ts * 0.25);
  fit('by ' + I.artist, 500, 42, W - 140); g.fillStyle = '#b9bec7'; g.fillText('by ' + I.artist, 70, 300);
  g.strokeStyle = '#2a2e35'; g.lineWidth = 2; g.beginPath(); g.moveTo(70, 340); g.lineTo(W - 70, 340); g.stroke();
  const cells = [['Engineer', I.engineer], ['Date', I.date], ['Length', I.length], ['Tempo', I.bpm + ' BPM'], ['Key', I.key], ['Session', I.code]];
  const cw = (W - 140) / 3;
  cells.forEach(([k, v], i) => {
    const x = 70 + (i % 3) * cw, y = 390 + Math.floor(i / 3) * 86;
    g.fillStyle = '#7f8590'; g.font = F(600, 17); g.fillText(k.toUpperCase(), x, y);
    g.fillStyle = '#e8eaee'; fit(String(v), 600, 32, cw - 20); g.fillText(String(v), x, y + 38);
  });
  g.fillStyle = '#7f8590'; g.font = F(600, 17); g.fillText('STEMS', 70, 590);
  let x = 70; g.font = F(600, 20);
  for (const s of I.stems.slice(0, 12)) {
    const w = g.measureText(s).width + 26; if (x + w > W - 220) { g.fillStyle = '#7f8590'; g.fillText(`+${I.stems.length - I.stems.indexOf(s)} more`, x, 628); break; }
    g.fillStyle = '#1d2026'; g.beginPath(); g.roundRect ? g.roundRect(x, 604, w, 34, 17) : g.rect(x, 604, w, 34); g.fill();
    g.fillStyle = '#d9dce2'; g.fillText(s, x + 13, 628); x += w + 8;
  }
  g.fillStyle = '#4a4f58'; g.font = F(600, 18); g.textAlign = 'right'; g.fillText('SESSION DESK', W - 70, 628); g.textAlign = 'left';
}
function creditsText() {
  const I = creditsInfo();
  return [`${I.title} by ${I.artist}`, `Recorded at ${I.studio}`, `Engineer: ${I.engineer}`, `Date: ${I.date}`, `Length ${I.length} · ${I.bpm} BPM${I.key !== '—' ? ' · Key ' + I.key : ''}`,
    `Stems: ${I.stems.join(', ')}`, ...(I.sections.length ? [`Structure: ${I.sections.join(' / ')}`] : [])].join('\n');
}
$('creditsBtn').onclick = () => { $('creditsModal').classList.add('open'); (document.fonts ? document.fonts.ready : Promise.resolve()).then(drawCredits); drawCredits(); };
$('cClose').onclick = () => $('creditsModal').classList.remove('open');
$('cCopy').onclick = async () => { try { await navigator.clipboard.writeText(creditsText()); toast('Credits copied.'); } catch (e) { toast("Couldn't copy here. Try the image instead."); } };
$('cSave').onclick = () => $('creditsCanvas').toBlob(b => {
  const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${safe(state.session.title) || 'Session'} credits.png`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}, 'image/png');

/* ================= talkback chat ================= */
let chatUnread = 0, rosterSeen = null;
const chatOpen = () => document.body.classList.contains('chat-open');
function updateChatBtn() {
  const b = $('chatBtn'); b.textContent = chatUnread ? `Talkback (${chatUnread})` : 'Talkback';
  b.classList.toggle('unread', chatUnread > 0); b.setAttribute('aria-expanded', chatOpen());
}
function toggleChat(force) {
  const open = force === undefined ? !chatOpen() : force;
  document.body.classList.toggle('chat-open', open);
  if (open) { chatUnread = 0; setTimeout(() => $('chatIn').focus(), 0); scrollChat(); }
  updateChatBtn(); requestAnimationFrame(() => { resizeCanvases(); syncHScroll(); });
}
function scrollChat() { const box = $('cmsgs'); box.scrollTop = box.scrollHeight; }
function chatLine(msg) {
  const el = document.createElement('div');
  el.className = 'cm' + (msg.eng ? ' eng' : '') + (msg.clientId === me.clientId ? ' mine' : '');
  const time = new Date(msg.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = '<div class="meta"><span class="who"></span><span class="t"></span></div><div class="txt"></div>';
  el.querySelector('.who').textContent = msg.by; el.querySelector('.t').textContent = time;
  el.querySelector('.txt').textContent = msg.text;
  if (msg.pos != null) {
    const tag = document.createElement(canControl() ? 'button' : 'span'); tag.className = 'bartag'; tag.textContent = 'bar ' + barBeat(msg.pos);
    if (tag.tagName === 'BUTTON') { tag.title = 'Jump there'; tag.onclick = () => seek(msg.pos); }
    el.querySelector('.meta').appendChild(tag);
  }
  return el;
}
function addChatLine(msg) {
  const box = $('cmsgs'), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const empty = box.querySelector('.cempty'); if (empty) empty.remove();
  box.appendChild(msg.sys ? Object.assign(document.createElement('div'), { className: 'csys', textContent: msg.text }) : chatLine(msg));
  if (atBottom || msg.clientId === me.clientId) scrollChat();
}
function renderChat() {
  const box = $('cmsgs'); box.innerHTML = '';
  if (!state.chat.length) box.innerHTML = '<div class="cempty">Talk to the room here. Messages sent while the song plays get a bar tag, so everyone knows which bit you mean.</div>';
  state.chat.forEach(msg => box.appendChild(chatLine(msg)));
  scrollChat();
}
function chatRoster(people) {
  const names = new Map(people.map(p => [p.clientId, p.name]));
  if (rosterSeen) {
    names.forEach((n, id) => { if (!rosterSeen.has(id) && id !== me.clientId) addChatLine({ sys: true, text: `${n} joined the session` }); });
    rosterSeen.forEach((n, id) => { if (!names.has(id)) addChatLine({ sys: true, text: `${n} left the session` }); });
  }
  rosterSeen = names;
}
$('chatBtn').onclick = () => toggleChat();
$('chatClose').onclick = () => toggleChat(false);
$('chatIn').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') toggleChat(false); });
$('chatForm').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('chatIn').value.trim(); if (!text) return;
  if (!net.open) { toast("You're not connected right now, so the message wasn't sent."); return; }
  sendRaw({ type: 'chat', text, pos: state.tp.playing ? position() : null });
  $('chatIn').value = '';
});

/* ================= misc UI wiring ================= */
$('playBtn').onclick = togglePlay;
$('stopBtn').onclick = stop;
$('startBtn').onclick = () => { seek(state.loop.on && loopValid() ? state.loop.start : 0); state.scrollX = 0; syncHScroll(); };
$('loopBtn').onclick = toggleLoop;
function toggleLoop() {
  if (!canControl()) return denied();
  let { start, end } = state.loop;
  if (end - start <= 0.05 || end > songDuration() + 0.01) { start = 0; end = Math.min(songDuration(), 240 / state.session.bpm * 4); }
  act({ k: 'loop', on: !state.loop.on, start, end });
  if (state.tp.playing) sendTransport(true, position());
}
$('followBtn').onclick = () => { state.follow = !state.follow; updateTransportUI(); };
$('recBtn').onclick = () => act({ k: 'session', f: { rec: !state.session.rec } });
$('clickBtn').onclick = () => act({ k: 'session', f: { click: !state.session.click } });
$('countBtn').onclick = () => { if (act({ k: 'session', f: { countIn: !state.session.countIn } })) toast(state.session.countIn ? 'Count-in on: playback starts after one bar of clicks.' : 'Count-in off.'); };
$('mixerToggle').onclick = toggleMixer;
function toggleMixer() { $('mixer').classList.toggle('hide'); requestAnimationFrame(() => { resizeCanvases(); syncHScroll(); }); }
$('monitor').addEventListener('input', () => { if (monitor) monitor.gain.setTargetAtTime(monitorGain(), ctx.currentTime, 0.02); store.set('sd.mon', $('monitor').value); });
const savedMon = store.get('sd.mon'); if (savedMon) $('monitor').value = savedMon;
$('bpm').addEventListener('change', e => { const v = clamp(Math.round(+e.target.value) || 120, 40, 240); e.target.value = v; act({ k: 'session', f: { bpm: v } }); });
let taps = [];
$('tapBtn').onclick = () => {
  if (!canControl()) return denied();
  const n = performance.now(); taps = taps.filter(t => n - t < 2500); taps.push(n);
  if (taps.length >= 3) { const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1); const b = clamp(Math.round(60000 / iv), 40, 240); $('bpm').value = b; act({ k: 'session', f: { bpm: b } }); }
};
Object.entries(FIELDS).forEach(([id, k]) => {
  $(id).addEventListener('input', e => { if (canControl()) act({ k: 'session', f: { [k]: e.target.value } }); });
  $(id).addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); });
});
$('studioName').addEventListener('input', () => act({ k: 'session', f: { studio: $('studioName').textContent.trim() } }));
$('studioName').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
$('bpm').addEventListener('keydown', e => e.stopPropagation());
const pick = () => canControl() ? $('fileIn').click() : denied();
$('addBtn').onclick = pick; $('emptyAdd').onclick = pick;
$('fileIn').addEventListener('change', e => { loadFiles(e.target.files); e.target.value = ''; });
let dragN = 0;
addEventListener('dragenter', e => { if (canControl() && [...(e.dataTransfer?.types || [])].includes('Files')) { dragN++; document.body.classList.add('drag'); } });
addEventListener('dragleave', () => { dragN = Math.max(0, dragN - 1); if (!dragN) document.body.classList.remove('drag'); });
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => { e.preventDefault(); dragN = 0; document.body.classList.remove('drag'); if (e.dataTransfer?.files?.length) loadFiles(e.dataTransfer.files); });
addEventListener('keydown', e => {
  if (e.target.closest && e.target.closest('input,select,[contenteditable="true"]')) return;
  if (!net.welcomed || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'Enter' || e.key === 'Home') $('startBtn').click();
  else if (e.key === 'l' || e.key === 'L') toggleLoop();
  else if (e.key === 'x' || e.key === 'X') toggleMixer();
  else if (e.key === 'r' || e.key === 'R') $('recBtn').click();
  else if (e.key === 'c' || e.key === 'C') $('clickBtn').click();
  else if (e.key === 'm' || e.key === 'M') addMarker();
  else if (e.key === 't' || e.key === 'T') { e.preventDefault(); toggleChat(); }
  else if (e.key === 'Escape') { closeRack(); ['bounceModal', 'creditsModal'].forEach(id => $(id).classList.remove('open')); document.querySelectorAll('.pop.open,.people.open,.swatches.open').forEach(p => p.classList.remove('open')); }
  else if (e.key === '+' || e.key === '=') setZoom(state.zoom * 1.25, xt(LW / 2), LW / 2);
  else if (e.key === '-') setZoom(state.zoom / 1.25, xt(LW / 2), LW / 2);
});
new ResizeObserver(() => { resizeCanvases(); syncHScroll(); }).observe(rulerWrap);
new ResizeObserver(() => resizeCanvases()).observe(vscroll);
document.fonts && document.fonts.ready.then(() => state.lanesDirty = true);

/* ================= boot ================= */
state.zoom = zoomFromSlider(+$('zoom').value);
rebuildUI(); updateTransportUI(); renderBounces();
requestAnimationFrame(frame);

if (!CODE) {
  $('landing').classList.add('open');
  $('startForm').addEventListener('submit', async e => {
    e.preventDefault(); $('startGo').disabled = true; $('landErr').textContent = '';
    try {
      const r = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ studio: $('startStudio').value.trim() }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Could not start a session.');
      store.set('sd.key.' + j.code, j.engineerKey);
      location.href = '/s/' + j.code;
    } catch (err) { $('landErr').textContent = err.message || "Couldn't reach the server. Try again."; $('startGo').disabled = false; }
  });
  $('joinForm').addEventListener('submit', e => {
    e.preventDefault(); const c = $('joinCode').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(c)) { $('landErr').textContent = 'Session codes are 6 letters and numbers.'; return; }
    location.href = '/s/' + c;
  });
} else {
  $('codeLabel').textContent = CODE;
  $('inviteUrl').value = `${location.origin}/s/${CODE}`;
  $('gateTitle').textContent = `Session ${CODE}`;
  $('gateEng').hidden = !engineerKey;
  $('gateName').value = me.name;
  $('gate').classList.add('open');
  fetch(`/api/session/${CODE}`).then(r => r.json()).then(j => { if (!j.exists) showEnded('Session not found', "This session doesn't exist or has already ended. Ask the engineer for a new link."); }).catch(() => {});
  $('gateForm').addEventListener('submit', e => {
    e.preventDefault();
    const n = $('gateName').value.trim();
    if (!n) { $('gateErr').textContent = 'Enter a name so the room knows who you are.'; return; }
    me.name = n; store.set('sd.name', n);
    ensureCtx(); ctx.resume().then(() => { if (!state.tp.playing) sleepAudioSoon(); }).catch(() => {});
    demoBuffers();
    $('gate').classList.remove('open');
    connect(); updateLock();
  });
}
})();
