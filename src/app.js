/* ===================== APP ===================== */
'use strict';
/* ================= PERSONALIZZA QUI =================
   Puoi modificare questi testi anche da GitHub (icona matita sul file).
   name: il suo nome. message: il tuo messaggio (puoi andare a capo).
   birthday: giorno del compleanno in formato MM-GG; quel giorno compare birthdayMessage. */
const WELCOME = {
  name: '',
  message: `Questa l’ho fatta per te.
Niente abbonamenti: solo i tuoi allenamenti, i tuoi dati e quelli del tuo coach.
Collega il rullo, scegli cosa fare e pedala. Al resto pensa lei.`,
  signature: 'Pier',
  birthday: '12-18',
  birthdayMessage: `Buon compleanno!
Oggi l’allenamento migliore è quello che hai voglia di fare.`
};
/* ==================================================== */
/* ============ COLLEGAMENTO A STRAVA (per CoachPeaking) ============
   Serve per mandare in automatico l'allenamento al coach. Lascia vuoto per disattivarlo.
   workerUrl: indirizzo del servizio su Cloudflare (vedi STRAVA_SETUP.md)
   clientId:  l'ID dell'app Strava creata dall'atleta */
const STRAVA = { workerUrl: '', clientId: '' };
/* ================================================================ */
const APP_VERSION = '2.4';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const NF = d => new Intl.NumberFormat('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d });
const nf = [NF(0), NF(1), NF(2)];
const fmt = (v, d = 0) => (v == null || !isFinite(v)) ? '–' : nf[d].format(v);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function fmtDur(s) {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
}
function fmtMin(s) {
  const m = Math.round((s || 0) / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}′` : `${m}′`;
}
const fmtDate = ms => new Date(ms).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const store = {
  get(k, d) { try { const v = localStorage.getItem('rl.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) {
    try { localStorage.setItem('rl.' + k, JSON.stringify(v)); return true; }
    catch (e) { toast('Spazio pieno sul telefono: esporta un backup dal Profilo e cancella gli allenamenti più vecchi.'); return false; }
  },
  del(k) { try { localStorage.removeItem('rl.' + k); } catch (e) { } }
};

/* ---------- Registro diagnostico ---------- */
const LOG = store.get('log', []);
function logEvent(tag, msg) {
  LOG.push(`${new Date().toISOString().slice(5, 19).replace('T', ' ')} [${tag}] ${msg}`);
  if (LOG.length > 300) LOG.splice(0, LOG.length - 300);
  clearTimeout(logEvent._t);
  logEvent._t = setTimeout(() => { try { localStorage.setItem('rl.log', JSON.stringify(LOG)); } catch (e) { } }, 1500);
}
const flushLog = () => { try { localStorage.setItem('rl.log', JSON.stringify(LOG)); } catch (e) { } };
window.addEventListener('pagehide', flushLog);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushLog(); });
window.addEventListener('error', e => logEvent('errore', `${e.message} @${e.lineno || '?'}`));
window.addEventListener('unhandledrejection', e => logEvent('errore', 'promise: ' + ((e.reason && e.reason.message) || e.reason)));

/* ---------- Archivio allenamenti: IndexedDB (capiente), con ripiego su localStorage ---------- */
const db = (() => {
  let opening = null;
  const open = () => opening || (opening = new Promise((res, rej) => {
    if (!('indexedDB' in window)) return rej(new Error('IndexedDB assente'));
    const rq = indexedDB.open('rullo', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error || new Error('apertura fallita'));
    rq.onblocked = () => rej(new Error('archivio bloccato'));
  }));
  const tx = async (mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction('kv', mode);
      const r = fn(t.objectStore('kv'));
      t.oncomplete = () => res(r ? r.result : undefined);
      t.onerror = t.onabort = () => rej(t.error || new Error('transazione fallita'));
    });
  };
  return {
    usingIdb: true,
    async get(k) {
      try { const v = await tx('readonly', s => s.get(k)); if (v !== undefined) return v; }
      catch (e) { logEvent('archivio', 'lettura: ' + e.message); }
      return store.get(k, null);
    },
    async set(k, v) {
      try { await tx('readwrite', s => s.put(v, k)); return true; }
      catch (e) { this.usingIdb = false; logEvent('archivio', 'scrittura: ' + e.message); return store.set(k, v); }
    },
    async del(k) {
      try { await tx('readwrite', s => s.delete(k)); } catch (e) { logEvent('archivio', 'cancellazione: ' + e.message); }
      store.del(k);
    }
  };
})();
// sposta in IndexedDB gli allenamenti salvati dalle versioni precedenti
async function migrateSessions() {
  for (const s of store.get('sessions', [])) {
    const old = store.get('s.' + s.id, null);
    if (!old) continue;
    let ok = false;
    try { ok = (await db.set('s.' + s.id, old)) && !!(await db.get('s.' + s.id)) && db.usingIdb; } catch (e) { }
    if (ok) { try { localStorage.removeItem('rl.s.' + s.id); } catch (e) { } }
  }
}

/* ---------- Stato ---------- */
// cadRing: denti della corona usata sul rullo; cadK: fattore tarato (rpm per km/h), null = calcolato dalla corona
const DEFAULT_PROFILE = { name: '', ftp: 150, weight: 60, hrMax: 190, sound: true, coachPhone: '', endMsg: '', cadEst: true, cadRing: 34, cadK: null };
const S = {
  profile: Object.assign({}, DEFAULT_PROFILE, store.get('profile', {})),
  custom: store.get('workouts', []),
  trainer: null, trainerState: 'off', hr: null, hrState: 'off', cadDev: null, cadState: 'off',
  live: { power: null, cad: null, speed: null, hr: null, trainerHr: null, lastData: 0, lastHr: 0, buf: [], sensorCad: null, lastSensor: 0 }
};
const R = {
  state: 'idle', wk: null, mode: 'erg', ergW: 120, intensity: 100, offset: 0, grade: 0, gear: 6,
  ms: 0, sec: 0, lastTick: performance.now(), data: null, start: 0, dist: 0, stepIdx: -1,
  sent: null, rescue: false, lowCad: 0, highCad: 0, wkDone: false, rampFtp: null, rampLow: 0, banner: null
};

/* ---------- Allenamenti pronti ---------- */
const W = (t, d, a, b, x = {}) => Object.assign({ t, d }, t === 'ramp' ? { p0: a, p1: b } : t === 'steady' ? { p: a } : {}, x);
const WARM = W('ramp', 600, 0.45, 0.75, { label: 'Riscaldamento' });
const COOL = W('ramp', 300, 0.6, 0.4, { label: 'Defaticamento' });
const PRESETS = [
  { id: 'p-z2', name: 'Fondo aerobico', desc: 'La base del triathlon: ritmo a cui riesci a parlare. Tieni la cadenza tra 85 e 95.',
    blocks: [W('ramp', 600, 0.45, 0.65, { label: 'Riscaldamento' }), W('steady', 1800, 0.68, null, { cad: 90 }), W('ramp', 300, 0.6, 0.45, { label: 'Defaticamento' })] },
  { id: 'p-cad', name: 'Agilità di pedalata', desc: 'Fondo con allunghi ad alta cadenza: pedalata più rotonda ed economica.',
    blocks: [W('ramp', 480, 0.45, 0.65, { label: 'Riscaldamento' }), { t: 'int', n: 6, d1: 60, p1: 0.7, cad1: 105, d2: 120, p2: 0.62, cad2: 90 }, W('steady', 360, 0.65), W('ramp', 300, 0.6, 0.45, { label: 'Defaticamento' })] },
  { id: 'p-ss', name: 'Sweet spot 3×10′', desc: 'Intensità alta ma sostenibile: il miglior rapporto fatica/beneficio per la bici.',
    blocks: [WARM, { t: 'int', n: 3, d1: 600, p1: 0.9, d2: 300, p2: 0.55 }, COOL] },
  { id: 'p-thr', name: 'Soglia 4×6′', desc: 'Ripetute alla FTP: alzano la potenza che riesci a tenere a lungo.',
    blocks: [WARM, W('steady', 120, 0.55), { t: 'int', n: 4, d1: 360, p1: 1.0, d2: 180, p2: 0.5 }, COOL] },
  { id: 'p-vo2', name: 'VO2max 5×3′', desc: 'Ripetute dure e brevi. Recupero pieno, cadenza alta.',
    blocks: [WARM, W('steady', 180, 0.55), { t: 'int', n: 5, d1: 180, p1: 1.15, d2: 180, p2: 0.5, cad1: 95 }, COOL] },
  { id: 'p-brick', name: 'Brick: bici prima della corsa', desc: 'Ultimi 10 minuti a ritmo gara, poi scendi e corri subito per abituare le gambe al cambio.',
    blocks: [W('ramp', 600, 0.45, 0.7, { label: 'Riscaldamento' }), W('steady', 1200, 0.7), W('steady', 600, 0.85, null, { label: 'Ritmo gara', cad: 90 }), W('steady', 120, 0.5, null, { label: 'Sciolta, poi corsa' })] },
  { id: 'p-rec', name: 'Recupero attivo', desc: 'Gambe che girano senza fatica, il giorno dopo un allenamento duro.',
    blocks: [W('steady', 1800, 0.5, null, { cad: 90, label: 'Recupero' })] },
  { id: 'p-ramp', name: 'Test FTP a rampa', rampTest: true,
    desc: '+20 W ogni minuto finché non riesci più a tenere la pedalata. La FTP stimata è il 75% del miglior minuto.',
    blocks: [W('ramp', 300, 60, 100, { abs: true, label: 'Riscaldamento' })]
      .concat(Array.from({ length: 27 }, (_, i) => W('steady', 60, 80 + i * 20, null, { abs: true, label: `Gradino ${80 + i * 20} W` }))) }
];
const allWorkouts = () => S.custom.concat(PRESETS);
const findWorkout = id => allWorkouts().find(w => w.id === id);

/* ---------- Audio e schermo ---------- */
let actx = null, wakeLock = null;
function unlockAudio() {
  try { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (e) { }
}
function beep(freq = 880, dur = 0.12) {
  if (!S.profile.sound || !actx) return;
  try {
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = freq; o.type = 'sine';
    g.gain.setValueAtTime(0.0001, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.4, actx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
    o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + dur + 0.02);
  } catch (e) { }
}
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && R.state !== 'idle') keepAwake(true); });

/* ---------- Dispositivi ---------- */
const U = Core.UUID;
class BleTrainer {
  constructor(cb) { this.cb = cb; this.q = Promise.resolve(); this.canControl = false; this.userClose = false; this.next = null; this.pumping = false; this.range = null; this.features = null; this.name = 'Rullo'; }
  async connect() {
    this.dev = await navigator.bluetooth.requestDevice({ filters: [{ services: [U.ftms] }, { services: [U.cps] }], optionalServices: [U.ftms, U.cps, U.hrs] });
    this.name = this.dev.name || 'Rullo';
    logEvent('rullo', 'scelto ' + this.name);
    this.dev.addEventListener('gattserverdisconnected', () => this.onDisc());
    this.cb.state('connecting');
    await this.setup();
  }
  async setup() {
    const srv = await this.dev.gatt.connect();
    let svc = null;
    try { svc = await srv.getPrimaryService(U.ftms); } catch (e) { }
    if (svc) {
      const bd = await svc.getCharacteristic(U.bikeData);
      this.st = { n: 0, cadFlag: 0, cadNz: 0, t0: 0, rep: 0 };
      bd.addEventListener('characteristicvaluechanged', e => {
        const dv = e.target.value, r = Core.parseIndoorBikeData(dv);
        this.noteFrame(dv, r);
        this.cb.data(r);
      });
      await bd.startNotifications();
      try { this.features = Core.parseFeatures(await (await svc.getCharacteristic(U.feature)).readValue()); } catch (e) { }
      try { this.range = Core.parsePowerRange(await (await svc.getCharacteristic(U.powerRange)).readValue()); } catch (e) { }
      try {
        this.cp = await svc.getCharacteristic(U.control);
        this.cp.addEventListener('characteristicvaluechanged', e => this.onResp(e.target.value));
        await this.cp.startNotifications();
        await this.write(Core.cmd.requestControl());
        await this.write(Core.cmd.start()).catch(() => { });
        this.canControl = true;
      } catch (e) { this.canControl = false; logEvent('rullo', 'controllo negato: ' + e.message + (e.code ? ' cod.' + e.code : '')); toast('Il rullo invia i dati ma non accetta comandi: ' + e.message); }
      // alcuni rulli mandano la cadenza solo nel servizio di potenza: lo ascolto in più, solo per la cadenza
      try {
        const cs = await srv.getPrimaryService(U.cps);
        const ch = await cs.getCharacteristic(U.cpsMeas);
        const parse = Core.makeCpsParser();
        let first = true;
        ch.addEventListener('characteristicvaluechanged', e => {
          const r = parse(e.target.value, performance.now());
          if (first) { first = false; logEvent('rullo', `servizio potenza (CPS) presente: flag 0x${e.target.value.getUint16(0, true).toString(16)}, cadenza ${r.cadence != null ? 'sì' : 'no'}`); }
          if (r.cadence != null) this.cb.cad2(r.cadence);
        });
        await ch.startNotifications();
        this.hasCps = true;
      } catch (e) { this.hasCps = false; }
    } else {
      const cs = await srv.getPrimaryService(U.cps);
      const ch = await cs.getCharacteristic(U.cpsMeas);
      const parse = Core.makeCpsParser();
      ch.addEventListener('characteristicvaluechanged', e => this.cb.data(parse(e.target.value, performance.now())));
      await ch.startNotifications();
      this.canControl = false;
    }
    try { const all = await srv.getPrimaryServices(); logEvent('rullo', 'servizi: ' + all.map(x => x.uuid.slice(4, 8)).join(', ')); } catch (e) { logEvent('rullo', 'servizi non leggibili: ' + e.message); }
    logEvent('rullo', `collegato (${svc ? 'FTMS' : 'solo potenza'}), controllo ${this.canControl ? 'sì' : 'no'}, funzioni ${JSON.stringify(this.features)}, potenza ${JSON.stringify(this.range)}`);
    this.cb.state('on');
  }
  // statistiche dei pacchetti FTMS: servono a capire se il rullo manda la cadenza
  noteFrame(dv, r) {
    const st = this.st; if (!st) return;
    const now = performance.now(); st.n++;
    if (st.n === 1) {
      st.t0 = now;
      logEvent('rullo', `primo pacchetto dati: ${[...new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)].map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
    }
    if (dv.byteLength >= 2 && (dv.getUint16(0, true) & 4)) st.cadFlag++;
    if (r.cadence > 0) st.cadNz++;
    const mins = (now - st.t0) / 60000;
    if (st.rep === 0 && mins >= 1 || st.rep === 1 && mins >= 10) {
      st.rep++;
      logEvent('rullo', `dopo ${Math.round(mins)} min: ${st.n} pacchetti, con campo cadenza ${st.cadFlag}, cadenza > 0 ${st.cadNz}`);
    }
  }
  write(bytes) {
    const run = async () => {
      if (!this.cp) throw new Error('nessun canale di controllo');
      let done;
      const wait = new Promise(res => { done = res; this.pending = res; setTimeout(() => res(null), 1500); });
      if (this.cp.writeValueWithResponse) await this.cp.writeValueWithResponse(bytes); else await this.cp.writeValue(bytes);
      const r = await wait;
      if (this.pending === done) this.pending = null;
      if (r && r.result !== 1) { const err = new Error('comando rifiutato'); err.code = r.result; throw err; }
      return r;
    };
    const p = this.q.then(run, run);
    this.q = p.catch(() => { });
    return p;
  }
  onResp(dv) {
    if (dv.byteLength >= 3 && dv.getUint8(0) === 0x80 && this.pending) this.pending({ op: dv.getUint8(1), result: dv.getUint8(2) });
  }
  send(bytes) {
    this.next = bytes;
    if (this.pumping) return;
    this.pumping = true;
    (async () => {
      while (this.next) {
        const b = this.next; this.next = null;
        try { await this.write(b); }
        catch (e) {
          logEvent('rullo', `comando 0x${b[0].toString(16)} fallito: ${e.message}${e.code ? ' cod.' + e.code : ''}`);
          if (e.code === 5) { try { await this.write(Core.cmd.requestControl()); await this.write(b); } catch (_) { } }
        }
      }
      this.pumping = false;
    })();
  }
  setPower(w) { if (this.canControl) this.send(Core.cmd.targetPower(w)); }
  setSim(g) { if (this.canControl) this.send(Core.cmd.sim(g)); }
  async onDisc() {
    this.canControl = false; this.cp = null;
    if (this.userClose) { this.cb.state('off'); return; }
    logEvent('rullo', 'connessione caduta');
    this.cb.state('reconnecting');
    for (const s of [1, 2, 3, 5, 5, 8, 8, 10, 15, 15]) {
      await sleep(s * 1000);
      if (this.userClose) return;
      try { await this.setup(); this.cb.reconnected(); return; } catch (e) { }
    }
    this.cb.state('off');
    logEvent('rullo', 'riconnessione non riuscita');
    toast('Connessione al rullo persa. Tocca “Rullo” per ricollegarlo: l’allenamento continua a registrare.');
  }
  disconnect() { this.userClose = true; try { this.dev.gatt.disconnect(); } catch (e) { } this.cb.state('off'); }
}

class BleHr {
  constructor(cb) { this.cb = cb; this.userClose = false; }
  async connect() {
    this.dev = await navigator.bluetooth.requestDevice({ filters: [{ services: [U.hrs] }] });
    this.name = this.dev.name || 'Cardio';
    this.dev.addEventListener('gattserverdisconnected', () => this.onDisc());
    this.cb.state('connecting');
    await this.setup();
  }
  async setup() {
    const srv = await this.dev.gatt.connect();
    const ch = await (await srv.getPrimaryService(U.hrs)).getCharacteristic(U.hrMeas);
    ch.addEventListener('characteristicvaluechanged', e => { const v = Core.parseHeartRate(e.target.value); if (v) this.cb.hr(v); });
    await ch.startNotifications();
    this.cb.state('on');
  }
  async onDisc() {
    if (this.userClose) { this.cb.state('off'); return; }
    this.cb.state('reconnecting');
    for (const s of [1, 2, 4, 8, 10, 15]) { await sleep(s * 1000); if (this.userClose) return; try { await this.setup(); return; } catch (e) { } }
    this.cb.state('off');
  }
  disconnect() { this.userClose = true; try { this.dev.gatt.disconnect(); } catch (e) { } this.cb.state('off'); }
}

class BleCad {
  constructor(cb) { this.cb = cb; this.userClose = false; }
  async connect() {
    this.dev = await navigator.bluetooth.requestDevice({ filters: [{ services: [U.csc] }] });
    this.name = this.dev.name || 'Sensore cadenza';
    this.dev.addEventListener('gattserverdisconnected', () => this.onDisc());
    this.cb.state('connecting');
    await this.setup();
  }
  async setup() {
    const srv = await this.dev.gatt.connect();
    const ch = await (await srv.getPrimaryService(U.csc)).getCharacteristic(U.cscMeas);
    const parse = Core.makeCscParser();
    let first = true;
    ch.addEventListener('characteristicvaluechanged', e => {
      const r = parse(e.target.value, performance.now());
      if (first) { first = false; logEvent('cadenza', `sensore: flag 0x${e.target.value.getUint8(0).toString(16)}, giri pedivella ${r.cadence != null ? 'sì' : 'no'}`); }
      if (r.cadence != null) this.cb.cad(r.cadence);
    });
    await ch.startNotifications();
    this.cb.state('on');
  }
  async onDisc() {
    if (this.userClose) { this.cb.state('off'); return; }
    logEvent('cadenza', 'sensore: connessione caduta');
    this.cb.state('reconnecting');
    for (const s of [1, 2, 4, 8, 10, 15]) { await sleep(s * 1000); if (this.userClose) return; try { await this.setup(); return; } catch (e) { } }
    this.cb.state('off');
  }
  disconnect() { this.userClose = true; try { this.dev.gatt.disconnect(); } catch (e) { } this.cb.state('off'); }
}

class DemoTrainer {
  constructor(cb) { this.cb = cb; this.canControl = true; this.name = 'Demo'; this.mode = 'sim'; this.tw = 0; this.g = 0; this.p = 0; this.hr = 92; this.range = { min: 0, max: 600, inc: 1 }; this.features = { power: true, sim: true }; this.isDemo = true; }
  async connect() { this.cb.state('on'); this.iv = setInterval(() => this.tick(), 500); }
  setPower(w) { this.mode = 'erg'; this.tw = w; }
  setSim(g) { this.mode = 'sim'; this.g = g; }
  powerAt(v, grade) { const m = (S.profile.weight || 60) + 9, vs = v / 3.6; return Math.max(0, (0.004 * m * 9.81 + m * 9.81 * grade / 100 + 0.5 * 1.2 * 0.32 * vs * vs) * vs / 0.97); }
  speedFor(p) { let lo = 0, hi = 80; for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (this.powerAt(mid, 0) < p) lo = mid; else hi = mid; } return lo; }
  tick() {
    const pedal = R.state !== 'paused';
    let cad = pedal ? 88 + Math.sin(Date.now() / 7000) * 4 + (Math.random() - 0.5) * 3 : 0;
    const step = R.wk && Core.locate(R.wk.steps, R.sec);
    if (pedal && step && R.wk.steps[step.i].cad) cad = R.wk.steps[step.i].cad + (Math.random() - 0.5) * 3;
    let target;
    if (!pedal) target = 0;
    else if (this.mode === 'erg') target = this.tw;
    else target = this.powerAt(cad * 0.3, this.g);
    this.p += (target - this.p) * 0.35 + (pedal ? (Math.random() - 0.5) * 8 : 0);
    this.p = Math.max(0, this.p);
    this.hr += ((pedal ? 62 + 0.42 * this.p : 80) - this.hr) * 0.02;
    this.cb.data({ power: Math.round(this.p), cadence: Math.round(cad), speed: pedal ? this.speedFor(this.p) : 0, hr: Math.round(this.hr) });
  }
  disconnect() { clearInterval(this.iv); this.cb.state('off'); }
}

const trainerCb = {
  state: s => { S.trainerState = s; renderDevices(); },
  data: r => {
    const L = S.live, now = performance.now();
    if (r.power != null) { L.power = r.power; L.buf.push([now, r.power]); }
    if (r.cadence != null) { L.cad = r.cadence; if (r.cadence > 0) { L.cadSeen = true; L.ftmsCad = now; } }
    if (r.speed != null) L.speed = r.speed;
    if (r.hr) L.trainerHr = r.hr;
    L.lastData = now;
  },
  // cadenza dal servizio di potenza: vale solo se il flusso principale non la dà
  cad2: c => {
    const L = S.live, now = performance.now();
    if (L.ftmsCad && now - L.ftmsCad < 5000) return;
    L.cad = c; if (c > 0) L.cadSeen = true;
  },
  reconnected: () => { R.sent = null; logEvent('rullo', 'ricollegato'); toast('Rullo ricollegato'); }
};
const hrCb = {
  state: s => { S.hrState = s; renderDevices(); },
  hr: v => { S.live.hr = v; S.live.lastHr = performance.now(); }
};
const cadCb = {
  state: s => { S.cadState = s; if (S.cadPanel) S.cadPanel(); },
  cad: v => { S.live.sensorCad = v; S.live.lastSensor = performance.now(); }
};

/* ---------- Cadenza: sensore, rullo o stima dalla velocità ---------- */
// Il Van Rysel D100 non misura la cadenza. Con la Zwift Cog (un solo pignone) la velocità del volano
// segue le pedalate con un rapporto fisso: la cadenza si stima da lì, e si può tarare contando le pedalate.
const cadK = () => S.profile.cadK > 0 ? S.profile.cadK : Core.cadFactor(S.profile.cadRing || 34);
function cadNow() {
  const L = S.live, now = performance.now();
  if (L.sensorCad != null && now - L.lastSensor < 3000) return { v: L.sensorCad, src: 'sensor' };
  if (!fresh()) return { v: null, src: null };
  if (L.cadSeen && L.cad != null) return { v: L.cad, src: 'trainer' };
  if (S.profile.cadEst && L.speed != null) return { v: Core.cadFromSpeed(L.speed, cadK()), src: 'est' };
  return { v: null, src: null };
}
const CAD_SRC = { sensor: 'dal sensore', trainer: 'dal rullo', est: 'stimata dalla velocità del rullo' };

function bluetoothMissing() {
  sheet(`<h2>Bluetooth non disponibile qui</h2>
    <p>Questo browser non permette alle pagine web di usare il Bluetooth.</p>
    <p><b>Su Mac, PC e Android:</b> apri questo indirizzo con <b>Chrome</b> (o Edge). Su Mac non funziona con Safari.</p>
    <p><b>Su iPhone e iPad:</b> installa l’app gratuita <b>Bluefy</b> dall’App Store e apri questo indirizzo da lì.</p>
    <div class="row"><button class="btn primary" id="tryDemo">Prova in modalità demo</button></div>`,
    { onMount: (el, close) => { el.querySelector('#tryDemo').onclick = () => { close(); connectDemo(); }; } });
}
async function connectTrainer() {
  if (S.trainer && S.trainerState !== 'off') {
    const name = S.trainer.name;
    sheet(`<h2>${esc(name)}</h2><p>${S.trainer.isDemo ? 'Modalità demo: i dati sono simulati.' : S.trainer.canControl ? 'Collegato: dati e controllo della resistenza attivi.' : 'Collegato in sola lettura (senza controllo della resistenza).'}</p>
      ${S.trainer.range ? `<p class="muted">Potenza gestibile dal rullo: ${S.trainer.range.min}–${S.trainer.range.max} W.</p>` : ''}
      <div class="row"><button class="btn danger" id="disc">Scollega</button></div>`,
      { onMount: (el, close) => { el.querySelector('#disc').onclick = () => { S.trainer.disconnect(); S.trainer = null; close(); }; } });
    return;
  }
  if (!navigator.bluetooth) return bluetoothMissing();
  if (store.get('connectedOnce', false)) return doConnectTrainer();
  sheet(`<h2>Prima chiudi Zwift</h2>${ZWIFT_STEPS}
    <div class="row"><button class="btn primary" id="goConn">Fatto, collega il rullo</button></div>`,
    { onMount: (el, close) => { el.querySelector('#goConn').onclick = () => { close(); doConnectTrainer(); }; } });
}
const ZWIFT_STEPS = `<p>Il rullo parla con una sola app alla volta. Finché è collegato a Zwift, qui non compare.</p>
  <ol class="steps">
    <li><b>Chiudi Zwift sul computer</b>: esci del tutto dal programma, non basta ridurlo a icona.</li>
    <li><b>Chiudi Zwift Companion sul telefono</b>, se la usi, e anche OneLap Fit.</li>
    <li>Controlla che il rullo sia <b>acceso</b> (spina inserita) e dai due pedalate per svegliarlo.</li>
  </ol>`;
// collega davvero il rullo; restituisce true se riuscito
async function doConnectTrainer() {
  const t = new BleTrainer(trainerCb);
  try {
    await t.connect(); S.trainer = t; R.sent = null;
    store.set('connectedOnce', true);
    toast(`${t.name} collegato`);
    return true;
  } catch (e) {
    S.trainerState = 'off'; renderDevices();
    logEvent('rullo', 'collegamento fallito: ' + e.name + ' ' + (e.message || ''));
    connectHelp(e);
    return false;
  }
}
function connectHelp(e) {
  if (document.querySelector('.guide')) return;          // la guida iniziale mostra già l'aiuto
  const cancelled = e && e.name === 'NotFoundError';
  sheet(`<h2>${cancelled ? 'Il rullo non compare?' : 'Collegamento non riuscito'}</h2>
    ${cancelled ? '' : `<p class="muted">${esc((e && e.message) || e)}</p>`}
    ${ZWIFT_STEPS}
    <p class="muted">Se ancora non va: spegni e riaccendi il Bluetooth del computer, oppure stacca e riattacca la spina del rullo.</p>
    <div class="row"><button class="btn primary" id="retry">Riprova</button><button class="btn" id="hDemo">Prova in demo</button></div>`,
    { onMount: (el, close) => {
      el.querySelector('#retry').onclick = () => { close(); doConnectTrainer(); };
      el.querySelector('#hDemo').onclick = () => { close(); connectDemo(); };
    } });
}
function connectDemo() {
  if (S.trainer) S.trainer.disconnect();
  S.trainer = new DemoTrainer(trainerCb); S.trainer.connect(); R.sent = null;
  toast('Modalità demo attiva: dati simulati');
}
async function connectHr() {
  if (S.hr && S.hrState !== 'off') {
    sheet(`<h2>${esc(S.hr.name)}</h2><p>Fascia o orologio collegato.</p><div class="row"><button class="btn danger" id="disc">Scollega</button></div>`,
      { onMount: (el, close) => { el.querySelector('#disc').onclick = () => { S.hr.disconnect(); S.hr = null; S.live.hr = null; close(); }; } });
    return;
  }
  if (!navigator.bluetooth) return bluetoothMissing();
  if (store.get('hrOnce', false)) return doConnectHr();
  sheet(`<h2>Collega il COROS</h2>${COROS_STEPS}
    <div class="row"><button class="btn primary" id="goHr">Fatto, collega il cardio</button></div>`,
    { onMount: (el, close) => { el.querySelector('#goHr').onclick = () => { close(); doConnectHr(); }; } });
}
const COROS_STEPS = `<p>L’orologio può inviare i battiti all’app come una fascia cardio. Va bene anche una normale fascia Bluetooth.</p>
  <ol class="steps">
    <li><b>Spegni il Bluetooth del telefono</b> (o chiudi l’app COROS): l’orologio accetta un solo collegamento Bluetooth alla volta, e di solito è occupato dal telefono.</li>
    <li>Sull’orologio, dal quadrante <b>tieni premuto il tasto Indietro</b>: si apre il menu degli strumenti.</li>
    <li>Scegli <b>Trasmetti FC</b> (in inglese “Broadcast HR”) e lascia l’orologio su quella schermata.</li>
    <li>Qui tocca il pulsante e scegli il COROS dall’elenco.</li>
  </ol>`;
async function doConnectHr() {
  const h = new BleHr(hrCb);
  try {
    await h.connect(); S.hr = h;
    store.set('hrOnce', true);
    logEvent('cardio', 'collegato ' + h.name); toast(`${h.name} collegato`);
    return true;
  } catch (e) {
    logEvent('cardio', 'collegamento fallito: ' + e.name + ' ' + (e.message || ''));
    S.hrState = 'off'; renderDevices();
    const cancelled = e.name === 'NotFoundError';
    sheet(`<h2>${cancelled ? 'L’orologio non compare?' : 'Cardio non collegato'}</h2>
      ${cancelled ? '' : `<p class="muted">${esc(e.message || e)}</p>`}
      ${COROS_STEPS}
      <p class="muted">L’allenamento funziona anche senza cardio: i battiti servono solo per le statistiche.</p>
      <div class="row"><button class="btn primary" id="retryHr">Riprova</button></div>`,
      { onMount: (el, close) => { el.querySelector('#retryHr').onclick = () => { close(); doConnectHr(); }; } });
    return false;
  }
}

/* ---------- Cadenza: pannello (dal riquadro rpm e dal Profilo) ---------- */
async function connectCad() {
  if (!navigator.bluetooth) return bluetoothMissing();
  const c = new BleCad(cadCb);
  try {
    await c.connect(); S.cadDev = c;
    logEvent('cadenza', 'sensore collegato ' + c.name); toast(`${c.name} collegato`);
  } catch (e) {
    S.cadState = 'off'; if (S.cadPanel) S.cadPanel();
    logEvent('cadenza', 'sensore: collegamento fallito: ' + e.name + ' ' + (e.message || ''));
    if (e.name !== 'NotFoundError') toast('Sensore non collegato: ' + (e.message || e));
    else toast('Nessun sensore scelto. Gira la pedivella per svegliarlo e riprova.');
  }
}
function cadSheet() { sheet('<h2>Cadenza</h2><div id="cadP"></div>', { onMount: el => cadPanel(el.querySelector('#cadP')) }); }
function cadPanel(el) {
  if (!el) return;
  if (el.dataset.cal) return;                       // taratura in corso: non ridisegnare
  const P = S.profile, sensorOn = S.cadDev && S.cadState !== 'off';
  const nowText = () => { const cn = cadNow(); return cn.v != null ? `${Math.round(cn.v)} rpm, ${CAD_SRC[cn.src]}` : 'nessun dato (collega il rullo e pedala)'; };
  el.innerHTML = `<div class="pz"><span>Adesso</span><em id="cNow">${esc(nowText())}</em></div>
    <p class="muted">Il rullo D100 non misura la cadenza. Con la Zwift Cog però c’è un solo pignone, quindi la velocità del rullo segue le pedalate: l’app la ricava da lì. Per un valore esatto collega un sensore di cadenza.</p>
    <label class="switch"><input type="checkbox" id="cEst" ${P.cadEst ? 'checked' : ''}> Stima la cadenza dalla velocità del rullo</label>
    <div class="form"><label class="fld wide"><span>Denti della corona usata sul rullo</span><input id="cRing" type="number" inputmode="numeric" value="${esc(P.cadRing)}"><span class="hint muted">Piccola: di solito 34. Grande: 50.</span></label></div>
    <p class="muted">${P.cadK ? `Tarata: ${fmt(P.cadK, 2)} rpm ogni km/h.` : 'Non ancora tarata: il valore viene dalla corona. Con la taratura diventa più preciso.'}</p>
    <div class="row"><button class="btn" id="cCal">Tara in 30 secondi</button>${P.cadK ? '<button class="btn subtle" id="cCalOff">Togli la taratura</button>' : ''}</div>
    <div id="cCalBox"></div>
    <h3>Sensore di cadenza</h3>
    <p class="muted">Un sensore Bluetooth da pedivella (20–35 €, profilo “cadence” o “CSC”). Quando è collegato ha la precedenza sulla stima.</p>
    <div class="row"><button class="btn ${sensorOn ? 'danger subtle' : 'primary'}" id="cSens">${sensorOn ? (S.cadState === 'on' ? 'Scollega ' + esc(S.cadDev.name) : 'Riconnessione…') : 'Collega sensore'}</button></div>`;
  S.cadPanel = () => { if (el.isConnected) cadPanel(el); };
  clearInterval(el._iv);
  el._iv = setInterval(() => { if (!el.isConnected) return clearInterval(el._iv); const n = el.querySelector('#cNow'); if (n) n.textContent = nowText(); }, 1000);
  const save = () => { store.set('profile', P); };
  el.querySelector('#cEst').onchange = e => { P.cadEst = e.target.checked; save(); logEvent('cadenza', 'stima ' + (P.cadEst ? 'attiva' : 'spenta')); };
  el.querySelector('#cRing').onchange = e => {
    const v = Math.round(parseFloat(e.target.value));
    if (!(v >= 20 && v <= 60)) { toast('Scrivi i denti della corona, tra 20 e 60'); e.target.value = P.cadRing; return; }
    if (v !== P.cadRing) { P.cadRing = v; P.cadK = null; save(); logEvent('cadenza', 'corona ' + v); cadPanel(el); }
  };
  const off = el.querySelector('#cCalOff'); if (off) off.onclick = () => { P.cadK = null; save(); logEvent('cadenza', 'taratura tolta'); cadPanel(el); };
  el.querySelector('#cSens').onclick = () => {
    if (sensorOn) { S.cadDev.disconnect(); S.cadDev = null; S.live.sensorCad = null; cadPanel(el); return; }
    connectCad();
  };
  el.querySelector('#cCal').onclick = () => calibrate(el);
}
// taratura: 30 s di pedalata regolare, lei conta i giri, l'app li confronta con la velocità media del rullo
function calibrate(el) {
  const box = el.querySelector('#cCalBox');
  if (!S.trainer || S.trainerState !== 'on' || !fresh() || !(S.live.speed > 3)) { toast('Collega il rullo e pedala, poi tocca di nuovo Tara'); return; }
  unlockAudio();
  el.dataset.cal = '1';
  const stop = () => { delete el.dataset.cal; clearInterval(box._iv); };
  box.innerHTML = `<div class="card"><p>Pedala <b>regolare</b>. Quando tocchi Via, conta quante volte il <b>piede destro</b> passa in basso, per 30 secondi.</p>
    <div class="row"><button class="btn primary" id="cGo">Via</button><button class="btn subtle" id="cNo">Annulla</button></div></div>`;
  box.querySelector('#cNo').onclick = () => { stop(); box.innerHTML = ''; };
  box.querySelector('#cGo').onclick = () => {
    const samples = []; let left = 30;
    beep(880, 0.2);
    box.innerHTML = `<div class="card"><p>Conta… <b id="cLeft">30</b> s</p></div>`;
    box._iv = setInterval(() => {
      if (fresh() && S.live.speed != null) samples.push(S.live.speed);
      left -= 0.5;
      const l = box.querySelector('#cLeft'); if (l) l.textContent = Math.ceil(left);
      if (left > 0) return;
      clearInterval(box._iv); beep(1175, 0.4);
      const v = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
      if (samples.length < 40 || v < 5) { stop(); box.innerHTML = '<p class="g-warn">Durante la prova il rullo non ha mandato abbastanza dati. Riprova pedalando regolare.</p>'; return; }
      box.innerHTML = `<div class="card"><div class="form"><label class="fld"><span>Giri contati in 30 secondi</span><input id="cCnt" type="number" inputmode="numeric"></label></div>
        <div class="row"><button class="btn primary" id="cOk">Salva taratura</button><button class="btn subtle" id="cNo2">Annulla</button></div></div>`;
      box.querySelector('#cNo2').onclick = () => { stop(); box.innerHTML = ''; };
      box.querySelector('#cOk').onclick = () => {
        const n = parseFloat(box.querySelector('#cCnt').value);
        const k = n * 2 / v;
        if (!(n >= 15 && n <= 75) || !(k > 1.2 && k < 6)) { toast('Valore strano: ricontrolla il numero o rifai la prova'); return; }
        S.profile.cadK = Math.round(k * 1000) / 1000; store.set('profile', S.profile);
        logEvent('cadenza', `taratura: ${n} giri in 30 s a ${fmt(v, 1)} km/h, fattore ${fmt(k, 2)} (dalla corona sarebbe ${fmt(Core.cadFactor(S.profile.cadRing), 2)})`);
        toast(`Taratura salvata: ${Math.round(n * 2)} rpm`);
        stop(); cadPanel(el);
      };
    }, 500);
  };
}

/* ---------- Motore allenamento ---------- */
const fresh = () => performance.now() - S.live.lastData < 3000;
function livePower() {
  const now = performance.now(), L = S.live;
  L.buf = L.buf.filter(x => now - x[0] < 3000);
  if (!fresh() || !L.buf.length) return null;
  return L.buf.reduce((a, x) => a + x[1], 0) / L.buf.length;
}
function liveHr() {
  if (S.live.hr && performance.now() - S.live.lastHr < 5000) return S.live.hr;
  if (S.live.trainerHr && fresh()) return S.live.trainerHr;
  return null;
}
const maxW = () => (S.trainer && S.trainer.range && S.trainer.range.max > 0) ? S.trainer.range.max : 2000;
function curLoc() { return R.wk ? Core.locate(R.wk.steps, R.sec) : null; }
function curStep() { const l = curLoc(); return l ? R.wk.steps[l.i] : null; }
function inFree() { if (!R.wk) return false; const s = curStep(); return !s || s.free; }
function targetW() {
  if (R.wk) {
    const l = curLoc();
    if (!l) return null;
    const s = R.wk.steps[l.i];
    if (s.free) return null;
    return clamp(Core.stepTarget(s, l.tIn, S.profile.ftp) * R.intensity / 100 + R.offset, 0, maxW());
  }
  return clamp(R.ergW, 0, maxW());
}
const simGrade = () => Math.round(clamp(R.grade + (R.gear - 6) * 0.8, -10, 20) * 10) / 10;
const ergActive = () => R.mode === 'erg' && !inFree() && !(R.wk && R.state === 'idle') && !(R.rampFtp != null);

function applyControl() {
  const t = S.trainer;
  if (!t || !t.canControl || S.trainerState !== 'on') return;
  let want;
  if (ergActive()) { let w = targetW(); if (R.rescue) w = Math.max(50, w * 0.5); want = { k: 'p', v: Math.round(w) }; }
  else want = { k: 's', v: simGrade() };
  const s = R.sent;
  if (s && s.k === want.k && Math.abs(s.v - want.v) < (want.k === 'p' ? 1 : 0.05)) return;
  R.sent = want;
  want.k === 'p' ? t.setPower(want.v) : t.setSim(want.v);
}

function startRide() {
  unlockAudio();
  if (!S.trainer || S.trainerState === 'off') {
    sheet(`<h2>Rullo non collegato</h2><p>Puoi collegarlo ora oppure registrare comunque (senza dati del rullo non vedrai potenza e cadenza).</p>
      <div class="row"><button class="btn primary" id="c1">Collega il rullo</button><button class="btn" id="c2">Prova in demo</button></div>`,
      { onMount: (el, close) => { el.querySelector('#c1').onclick = () => { close(); connectTrainer(); }; el.querySelector('#c2').onclick = () => { close(); connectDemo(); }; } });
    return;
  }
  Object.assign(R, { state: 'running', ms: 0, sec: 0, start: Date.now(), dist: 0, stepIdx: -1, offset: 0, rescue: false, lowCad: 0, highCad: 0, wkDone: false, rampFtp: null, rampLow: 0, banner: null, sent: null, cadSrc: {},
    data: { t: [], p: [], c: [], h: [], v: [], d: [], g: [], st: [] } });
  R.lastTick = performance.now();
  R.gapWarned = false;
  if (R.wk && R.mode !== 'erg') { R.mode = 'erg'; R.sent = null; logEvent('modalità', 'passata a ERG all’avvio (allenamento caricato)'); toast('Modalità ERG attivata per seguire i watt dell’allenamento'); }
  logEvent('allenamento', `avvio: ${R.wk ? R.wk.name : 'libero'}, FTP ${S.profile.ftp}, ${R.mode}`);
  keepAwake(true);
  beep(660, 0.15);
  document.body.classList.add('riding');
  renderRide(true);
}
function pauseRide() { if (R.state === 'running') { R.state = 'paused'; autosave(); renderRide(true); } }
function resumeRide() { if (R.state === 'paused') { R.state = 'running'; R.lastTick = performance.now(); unlockAudio(); renderRide(true); } }
function skipStep() {
  const l = curLoc();
  if (!l) return;
  R.ms += l.left * 1000;
  while (R.sec < Math.floor(R.ms / 1000)) R.sec++;
  R.offset = 0; R.sent = null;
  renderRide(true);
}

function onSecond() {
  const L = S.live, ok = fresh();
  const p = ok ? (L.power ?? 0) : 0, v = ok ? (L.speed ?? 0) : 0, h = liveHr();
  // cadenza misurata (sensore o rullo): serve alla protezione ERG e al test a rampa
  const cn = cadNow();
  const hasCad = !!L.cadSeen || cn.src === 'sensor';
  const c = (cn.src === 'sensor' || cn.src === 'trainer') ? cn.v : (hasCad ? 0 : null);
  // cadenza registrata: anche quella stimata
  const cRec = cn.v != null ? cn.v : (hasCad ? 0 : null);
  if (cn.src && R.cadSrc) { R.cadSrc[cn.src] = (R.cadSrc[cn.src] || 0) + 1; if (R.cadSrc[cn.src] === 1) logEvent('cadenza', `in uso ${CAD_SRC[cn.src]}${cn.src === 'est' ? ` (corona ${S.profile.cadRing}, fattore ${fmt(cadK(), 2)}${S.profile.cadK ? ' tarato' : ''})` : ''}`); }
  R.dist += v / 3.6;
  const loc = curLoc();
  const D = R.data;
  const t = Math.max(D.t.length ? D.t[D.t.length - 1] + 1 : 0, Math.round((Date.now() - R.start) / 1000));
  const tg = (R.mode === 'erg' || R.wk) ? targetW() : null;
  D.t.push(t); D.p.push(Math.round(p)); D.c.push(cRec == null ? null : Math.round(cRec)); D.h.push(h ? Math.round(h) : null);
  D.v.push(Math.round(v * 10) / 10); D.d.push(Math.round(R.dist * 10) / 10);
  D.g.push(tg != null ? Math.round(tg) : null); D.st.push(R.wk ? (loc ? loc.i : -1) : null);

  // cambio step e segnali acustici
  if (R.wk) {
    if (loc && loc.i !== R.stepIdx) {
      if (R.stepIdx !== -1) beep(1175, 0.35);
      R.stepIdx = loc.i; R.offset = 0; R.sent = null;
    }
    if (loc && loc.left <= 3 && loc.left >= 1 && Core.locate(R.wk.steps, R.sec + loc.left)) beep(880, 0.09);
    if (!loc && !R.wkDone) {
      R.wkDone = true; R.stepIdx = -1; beep(1175, 0.6);
      R.banner = { text: 'Allenamento completato. Puoi continuare a pedalare libera o toccare Termina per salvare.', kind: 'ok' };
    }
  }
  // test a rampa: fine automatica quando la cadenza crolla
  if (R.wk && R.wk.rampTest && loc && loc.i > 0 && R.rampFtp == null) {
    const rt = targetW() || 0;
    const failing = hasCad ? c < 55 : (rt > 0 && p < rt * 0.6);
    R.rampLow = failing ? R.rampLow + 1 : 0;
    if (R.rampLow >= 8) endRampTest();
  }
  // protezione "spirale" ERG: se la cadenza crolla, dimezza i watt finché riparte
  if (ergActive() && !(R.wk && R.wk.rampTest) && R.state === 'running') {
    const tw = targetW() || 0;
    if (!R.rescue) {
      const struggling = hasCad ? c < 45 : p < tw * 0.4;
      R.lowCad = (struggling && tw >= 90 && ok) ? R.lowCad + 1 : 0;
      if (R.lowCad >= 4) { logEvent('allenamento', 'protezione ERG attivata'); R.rescue = true; R.highCad = 0; R.banner = { text: hasCad ? 'Cadenza troppo bassa: resistenza dimezzata. Torna sopra 70 rpm e i watt tornano all’obiettivo.' : 'Pedalata in calo: resistenza dimezzata. Riprendi ritmo e i watt tornano all’obiettivo.', kind: 'warn' }; }
    } else {
      R.highCad = (hasCad ? c >= 70 : p >= Math.max(50, tw * 0.5) * 0.85) ? R.highCad + 1 : 0;
      if (R.highCad >= 3) { R.rescue = false; R.lowCad = 0; R.banner = null; toast('Watt obiettivo ripristinati'); }
    }
  }
  if (R.sec % 15 === 0) autosave();
}
function endRampTest() {
  const best = Core.bestAvg(R.data.p, 60);
  R.rampFtp = best ? Math.round(best * 0.75) : null;
  R.mode = 'sim'; R.grade = 0; R.gear = 4; R.sent = null;
  logEvent('modalità', 'test FTP finito: passata a pendenza');
  beep(1175, 0.6);
  R.banner = { text: R.rampFtp ? `Test finito. FTP stimata: ${R.rampFtp} W. Pedala piano qualche minuto, poi tocca Termina.` : 'Test finito: dati insufficienti per stimare la FTP.', kind: 'ok' };
  R.ms = Math.max(R.ms, (Core.totalDur(R.wk.steps)) * 1000);
}

function tick() {
  const now = performance.now();
  const dt = Math.min(5000, now - R.lastTick);
  R.lastTick = now;
  if (R.state === 'running') {
    R.ms += dt;
    let guard = 0;
    while (R.sec < Math.floor(R.ms / 1000) && guard++ < 10) { onSecond(); R.sec++; }
    if (R.sec < Math.floor(R.ms / 1000)) R.ms = R.sec * 1000;
  }
  // sorveglianza: rullo collegato ma senza dati
  if (R.state === 'running' && S.trainer && S.trainerState === 'on') {
    const gap = now - S.live.lastData;
    if (gap > 6000 && !R.gapWarned) {
      R.gapWarned = true; logEvent('rullo', 'nessun dato da 6 s');
      if (!R.banner) R.banner = { text: 'Il rullo non sta inviando dati. Se non riparte da solo, tocca “Rullo” in alto e ricollegalo: la registrazione continua.', kind: 'warn', gap: true };
    } else if (gap < 3000 && R.gapWarned) {
      R.gapWarned = false; logEvent('rullo', 'dati ripresi');
      if (R.banner && R.banner.gap) R.banner = null;
    }
  }
  applyControl();
  const full = R.sec !== R._fullSec;
  R._fullSec = R.sec;
  renderRide(full);
}

function finishRide() {
  pauseRide();
  const dur = R.data ? R.data.t.length : 0;
  sheet(`<h2>Terminare l’allenamento?</h2><p>${fmtDur(dur)} registrati.</p>
    <div class="row"><button class="btn primary" id="f1">Salva</button><button class="btn" id="f2">Continua</button></div>
    <div class="row"><button class="btn danger subtle" id="f3">Elimina senza salvare</button></div>`,
    { onMount: (el, close) => {
      el.querySelector('#f1').onclick = () => { close(); saveRide(); };
      el.querySelector('#f2').onclick = () => { close(); resumeRide(); };
      el.querySelector('#f3').onclick = () => { if (confirm('Eliminare definitivamente questo allenamento?')) { close(); resetRide(); } };
    } });
}
function resetRide() {
  Object.assign(R, { state: 'idle', ms: 0, sec: 0, data: null, dist: 0, stepIdx: -1, offset: 0, rescue: false, banner: null, wkDone: false, rampFtp: null, sent: null });
  store.del('live');
  keepAwake(false);
  document.body.classList.remove('riding');
  renderRide(true);
}
async function saveRide() {
  if (!R.data || !R.data.t.length) { resetRide(); return; }
  const sess = {
    id: uid('s'), start: R.start, name: R.wk ? R.wk.name : 'Pedalata libera', ftp: S.profile.ftp,
    steps: R.wk ? R.wk.steps.map(s => ({ label: s.label, d: s.d })) : null,
    rampFtp: R.rampFtp ?? (R.wk && R.wk.rampTest ? Math.round((Core.bestAvg(R.data.p, 60) || 0) * 0.75) || null : null),
    cadEst: cadMostlyEst(),
    data: R.data
  };
  autosave();
  if (await persistSession(sess)) {
    logEvent('allenamento', `salvato ${fmtDur(sess.data.t.length)}`);
    const toStrava = Strava.enqueue(sess.id);
    resetRide(); renderHistory(); await openSession(sess.id, true);
    if (toStrava) Strava.sync();
  } else toast('Salvataggio non riuscito: l’allenamento resta recuperabile dallo Storico.');
}
async function persistSession(sess) {
  const sum = Core.summarize(sess, S.profile);
  if (!(await db.set('s.' + sess.id, sess))) return false;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });
  const idx = store.get('sessions', []).filter(s => s.id !== sess.id);
  idx.unshift({ id: sess.id, start: sess.start, name: sess.name, dur: sum.dur, dist: sum.dist, avgP: sum.avgP, np: sum.np, tss: sum.tss, avgH: sum.avgH });
  store.set('sessions', idx);
  return true;
}
function autosave() {
  if (!R.data || R.state === 'idle') return;
  store.set('live', { start: R.start, name: R.wk ? R.wk.name : 'Pedalata libera', ftp: S.profile.ftp, steps: R.wk ? R.wk.steps.map(s => ({ label: s.label, d: s.d })) : null, data: R.data, rampFtp: R.rampFtp, cadEst: cadMostlyEst() });
}
function cadMostlyEst() { const c = R.cadSrc || {}; return (c.est || 0) > (c.sensor || 0) + (c.trainer || 0); }

/* ---------- UI: struttura ---------- */
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3800);
}
function sheet(html, { onMount, wide } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="sheet-bg"></div><div class="sheet${wide ? ' wide' : ''}" role="dialog" aria-modal="true"><button class="sheet-x" aria-label="Chiudi">✕</button><div class="sheet-body">${html}</div></div>`;
  $('sheets').appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector('.sheet-bg').onclick = close;
  wrap.querySelector('.sheet-x').onclick = close;
  if (onMount) requestAnimationFrame(() => onMount(wrap.querySelector('.sheet-body'), close));
  return close;
}
function showView(v) {
  document.querySelectorAll('.view').forEach(s => { s.hidden = s.id !== 'v-' + v; });
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-current', b.dataset.v === v ? 'page' : 'false'));
  if (v === 'workouts') renderWorkouts();
  if (v === 'history') renderHistory();
  if (v === 'profile') renderProfile();
  if (v === 'ride') renderRide(true);
}

/* ---------- Disegno ---------- */
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function canvasCtx(c) {
  const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, r.width), h = Math.max(10, r.height);
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}
const zoneColor = frac => Core.ZONES[Core.zoneIndex(frac)].color;

function drawWorkout(c, steps, ftp, opt = {}) {
  const { ctx, w, h } = canvasCtx(c);
  const total = Core.totalDur(steps) || 1;
  const span = Math.max(total, opt.span || 0);
  let top = ftp * 1.25;
  steps.forEach(s => { if (!s.free) top = Math.max(top, Core.stepTarget(s, 0, ftp), Core.stepTarget(s, s.d, ftp)); });
  if (opt.trace) opt.trace.forEach(v => { if (v) top = Math.max(top, v); });
  top *= 1.08;
  const X = t => t / span * w, Y = v => h - v / top * h;
  // linea FTP
  ctx.strokeStyle = css('--line'); ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
  ctx.beginPath(); ctx.moveTo(0, Y(ftp)); ctx.lineTo(w, Y(ftp)); ctx.stroke(); ctx.setLineDash([]);
  let acc = 0;
  steps.forEach(s => {
    const x0 = X(acc), x1 = X(acc + s.d);
    if (s.free) {
      ctx.fillStyle = css('--surface2'); ctx.fillRect(x0, Y(ftp * 0.5), x1 - x0, h - Y(ftp * 0.5));
    } else {
      const a = Core.stepTarget(s, 0, ftp), b = Core.stepTarget(s, s.d, ftp);
      ctx.fillStyle = zoneColor((a + b) / 2 / ftp);
      ctx.beginPath(); ctx.moveTo(x0, h); ctx.lineTo(x0, Y(a)); ctx.lineTo(x1, Y(b)); ctx.lineTo(x1, h); ctx.closePath(); ctx.fill();
    }
    if (x1 - x0 > 1.5) { ctx.fillStyle = css('--surface'); ctx.fillRect(x1 - 0.5, 0, 1, h); }
    acc += s.d;
  });
  if (opt.cursor != null) {
    ctx.fillStyle = css('--veil'); ctx.fillRect(0, 0, X(opt.cursor), h);
  }
  if (opt.trace && opt.trace.length) {
    ctx.strokeStyle = css('--ink'); ctx.lineWidth = 1.6; ctx.beginPath();
    opt.trace.forEach((v, i) => { const x = X(i), y = Y(v || 0); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  }
  if (opt.cursor != null) {
    ctx.fillStyle = css('--ink'); ctx.fillRect(X(opt.cursor) - 1, 0, 2, h);
  }
}
function drawFreeTrace(c, data, ftp) {
  const { ctx, w, h } = canvasCtx(c);
  const win = 600, p = data ? data.p.slice(-win) : [];
  const top = Math.max(ftp * 1.4, ...p) * 1.05;
  ctx.strokeStyle = css('--line'); ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(0, h - ftp / top * h); ctx.lineTo(w, h - ftp / top * h); ctx.stroke(); ctx.setLineDash([]);
  const bw = w / win;
  p.forEach((v, i) => { ctx.fillStyle = zoneColor(v / ftp); const bh = v / top * h; ctx.fillRect(i * bw, h - bh, Math.max(1, bw + 0.3), bh); });
  if (!p.length) { ctx.fillStyle = css('--ink2'); ctx.font = `500 13px ${css('--font')}`; ctx.fillText('Gli ultimi 10 minuti di potenza compariranno qui', 8, h / 2 + 4); }
}
function drawSessionChart(c, sess, sum) {
  const { ctx, w, h } = canvasCtx(c);
  const D = sess.data, n = D.t.length, ftp = sess.ftp;
  if (!n) return;
  const padB = 18, H = h - padB;
  const top = Math.max(ftp * 1.3, sum.maxP || 0) * 1.05;
  const cols = Math.min(n, Math.floor(w));
  const bin = n / cols, cw = w / cols;
  for (let k = 0; k < cols; k++) {
    const a = Math.floor(k * bin), b = Math.max(a + 1, Math.floor((k + 1) * bin));
    let s = 0; for (let i = a; i < b; i++) s += D.p[i] || 0;
    const v = s / (b - a), bh = v / top * H;
    ctx.fillStyle = zoneColor(v / ftp); ctx.fillRect(k * cw, H - bh, cw + 0.4, bh);
  }
  // obiettivo
  ctx.strokeStyle = css('--ink'); ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]); ctx.beginPath();
  let pen = false;
  for (let k = 0; k < cols; k++) { const i = Math.floor(k * bin), g = D.g[i]; if (g == null) { pen = false; continue; } const y = H - g / top * H; pen ? ctx.lineTo(k * cw, y) : ctx.moveTo(k * cw, y); pen = true; }
  ctx.stroke(); ctx.setLineDash([]);
  // cardio
  if (sum.hasHr) {
    const hmin = 60, hmax = Math.max(180, sum.maxH || 0);
    ctx.strokeStyle = css('--hr'); ctx.lineWidth = 1.8; ctx.beginPath(); pen = false;
    for (let k = 0; k < cols; k++) { const v = D.h[Math.floor(k * bin)]; if (!v) { pen = false; continue; } const y = H - (v - hmin) / (hmax - hmin) * H; pen ? ctx.lineTo(k * cw, y) : ctx.moveTo(k * cw, y); pen = true; }
    ctx.stroke();
  }
  ctx.fillStyle = css('--ink2'); ctx.font = `500 11px ${css('--font')}`;
  const ticks = n > 3600 ? 1800 : n > 1200 ? 600 : 300;
  for (let t = ticks; t < n; t += ticks) { const x = t / n * w; ctx.fillRect(x, H, 1, 4); ctx.fillText(fmtMin(t), x + 3, h - 4); }
}

/* ---------- UI: Allenati ---------- */
let lastProfDraw = -1;
function renderDevices() {
  const set = (el, st, label, sub) => { el.dataset.state = st; el.querySelector('span').textContent = label; el.title = sub || ''; };
  const ts = S.trainerState;
  set($('devTrainer'), ts, ts === 'on' ? (S.trainer?.isDemo ? 'Demo' : 'Rullo') : ts === 'reconnecting' ? 'Riconnessione…' : ts === 'connecting' ? 'Collego…' : 'Collega rullo');
  const hs = S.hrState;
  set($('devHr'), hs === 'off' && S.trainer?.isDemo ? 'on' : hs, hs === 'on' ? 'Cardio' : hs === 'reconnecting' ? 'Riconnessione…' : hs === 'connecting' ? 'Collego…' : (S.trainer?.isDemo ? 'Cardio demo' : 'Collega cardio'));
}
function renderRide(full) {
  if ($('v-ride').hidden) return;
  const ftp = S.profile.ftp;
  const pw = livePower(), hr = liveHr(), L = S.live, ok = fresh();
  const loc = curLoc(), step = loc ? R.wk.steps[loc.i] : null;
  const tg = targetW();
  $('pw').innerHTML = pw == null ? '<span class="ph">0</span>' : Math.round(pw);
  $('hero').style.setProperty('--zc', pw == null ? css('--ink') : zoneColor(pw / ftp));
  // riga obiettivo
  const erg = ergActive();
  if (R.wk && R.state === 'idle') $('tgtLine').innerHTML = `Primo blocco <b>${R.wk.steps[0].free ? 'libero' : Math.round(Core.stepTarget(R.wk.steps[0], 0, ftp)) + ' W'}</b>`;
  else if (R.rampFtp != null) $('tgtLine').innerHTML = `FTP stimata <b>${R.rampFtp} W</b>`;
  else if (erg) $('tgtLine').innerHTML = `Obiettivo <b>${Math.round(R.rescue ? Math.max(50, tg * 0.5) : tg)} W</b>${R.wk && R.intensity !== 100 ? ` <span class="pill">${R.intensity}%</span>` : ''}${R.offset ? ` <span class="pill">${R.offset > 0 ? '+' : ''}${R.offset} W</span>` : ''}`;
  else if (R.wk && tg != null) $('tgtLine').innerHTML = `Obiettivo <b>${Math.round(tg)} W</b> <span class="pill">ERG spento</span>`;
  else $('tgtLine').innerHTML = `Pendenza <b>${fmt(simGrade(), 1)}%</b> <span class="pill">marcia ${R.gear}</span>`;
  // nastro zone
  const top = 1.6;
  $('marker').style.left = pw == null ? '-20px' : `calc(${clamp(pw / ftp / top, 0, 1) * 100}% - 1px)`;
  $('tmark').style.left = (erg || (R.wk && tg != null)) && tg != null ? `calc(${clamp(tg / ftp / top, 0, 1) * 100}% - 1px)` : '-20px';
  // step
  if (R.wk) {
    if (step) {
      const next = R.wk.steps[loc.i + 1];
      $('stepName').innerHTML = `<i style="background:${step.free ? 'var(--ink2)' : zoneColor(Core.stepTarget(step, loc.tIn, ftp) / ftp)}"></i>${esc(step.label)}${step.cad ? ` <span class="muted">a ${step.cad} rpm</span>` : ''}`;
      $('stepNext').textContent = next ? `Poi ${fmtDur(next.d)} ${next.free ? 'libero' : 'a ' + Math.round(Core.stepTarget(next, 0, ftp) * R.intensity / 100) + ' W'}` : 'Ultimo blocco';
      $('stepLeft').textContent = fmtDur(loc.left);
      $('stepLeft').classList.toggle('soon', loc.left <= 5 && R.state === 'running');
    } else {
      $('stepName').innerHTML = `<i style="background:var(--ink2)"></i>${esc(R.wk.name)}`;
      $('stepNext').textContent = R.rampFtp != null ? 'Defaticamento libero' : 'Completato: pedalata libera';
      $('stepLeft').textContent = ''; $('stepLeft').classList.remove('soon');
    }
    $('wkTotal').textContent = `${fmtDur(Math.min(R.sec, Core.totalDur(R.wk.steps)))} / ${fmtDur(Core.totalDur(R.wk.steps))}`;
  } else {
    const z = pw == null ? null : Core.ZONES[Core.zoneIndex(pw / ftp)];
    $('stepName').innerHTML = `<i style="background:${z ? z.color : 'var(--ink2)'}"></i>${z ? 'Zona ' + z.name.toLowerCase() : 'Pedalata libera'}`;
    $('stepNext').textContent = S.profile.name && R.state === 'idle' ? `Ciao ${S.profile.name}, quando vuoi tocca Avvia.` : 'Nessun allenamento caricato';
    $('stepLeft').textContent = ''; $('wkTotal').textContent = '';
  }
  // metriche
  const cn = cadNow();
  $('mCad').textContent = cn.v != null ? Math.round(cn.v) : '–';
  $('mCadL').textContent = cn.src === 'est' ? 'rpm stimati' : 'rpm';
  $('mHr').textContent = hr ? Math.round(hr) : '–';
  $('mSpd').textContent = ok && L.speed != null ? fmt(L.speed, 1) : '–';
  $('mDist').textContent = fmt(R.dist / 1000, 1);
  const D = R.data;
  $('mAvg').textContent = D && D.p.length ? Math.round(Core.mean(D.p)) : '–';
  $('mKj').textContent = D ? Math.round(D.p.reduce((a, b) => a + b, 0) / 1000) : 0;
  $('clock').textContent = fmtDur(R.sec);
  const cadBox = $('mCad').parentElement;
  cadBox.classList.toggle('off', !!(step && step.cad && cn.v != null && Math.abs(cn.v - step.cad) > 8));
  // banner
  const b = $('banner');
  if (R.banner) { b.hidden = false; b.dataset.kind = R.banner.kind; b.textContent = R.banner.text; } else b.hidden = true;
  // grafico (1 volta al secondo)
  if (full || lastProfDraw !== R.sec) {
    lastProfDraw = R.sec;
    if (R.wk) drawWorkout($('prof'), R.wk.steps, ftp, { cursor: R.state === 'idle' ? null : R.sec, trace: R.data ? R.data.p : null, span: R.sec });
    else drawFreeTrace($('prof'), R.data, ftp);
  }
  if (!full) return;
  // controlli
  $('pickWorkout').innerHTML = `<span>${esc(R.wk ? R.wk.name : 'Pedalata libera')}${R.wk ? ` <span class="muted">${fmtMin(Core.totalDur(R.wk.steps))}</span>` : ''}</span><small>${R.wk ? 'Cambia' : 'Scegli allenamento'}</small>`;
  $('pickWorkout').disabled = R.state !== 'idle';
  document.querySelectorAll('#modeSeg button').forEach(x => x.setAttribute('aria-pressed', x.dataset.mode === R.mode));
  const simShown = R.mode === 'sim' || inFree();
  const st0 = R.state;
  const wkIdle = !!R.wk && st0 === 'idle';
  $('adjErg').hidden = simShown || wkIdle;
  $('adjSim').hidden = !simShown;
  $('adjInt').hidden = !R.wk || simShown || wkIdle;
  $('ergLabel').textContent = R.wk ? 'Correggi questo blocco' : 'Watt obiettivo';
  $('ergVal').textContent = R.wk ? (R.offset > 0 ? '+' : '') + R.offset : R.ergW;
  $('intVal').textContent = R.intensity;
  $('gradeVal').textContent = fmt(R.grade, 1);
  $('gearVal').textContent = R.gear;
  const st = R.state;
  $('bStart').hidden = st !== 'idle';
  $('bPause').hidden = st !== 'running';
  $('bResume').hidden = st !== 'paused';
  $('bSkip').hidden = st === 'idle' || !R.wk || !curLoc();
  $('bEnd').hidden = st === 'idle';
}

function pickWorkoutSheet() {
  const items = [{ id: '', name: 'Pedalata libera', desc: 'Scegli tu i watt o la pendenza' }].concat(allWorkouts());
  sheet(`<h2>Scegli allenamento</h2><div class="list">${items.map(w => {
    const steps = w.id ? Core.expand(w.blocks) : null;
    return `<button class="item" data-id="${esc(w.id)}"><div class="item-h"><b>${esc(w.name)}</b><span>${steps ? fmtMin(Core.totalDur(steps)) : ''}</span></div>${steps ? `<canvas class="mini" data-mini="${esc(w.id)}"></canvas>` : `<p class="muted">${esc(w.desc)}</p>`}</button>`;
  }).join('')}</div>`, {
    onMount: (el, close) => {
      el.querySelectorAll('canvas[data-mini]').forEach(cv => { const w = findWorkout(cv.dataset.mini); drawWorkout(cv, Core.expand(w.blocks), S.profile.ftp); });
      el.querySelectorAll('.item').forEach(b => b.onclick = () => { loadWorkout(b.dataset.id); close(); });
    }
  });
}
function loadWorkout(id) {
  if (!id) { R.wk = null; }
  else { const w = findWorkout(id); R.wk = { id: w.id, name: w.name, steps: Core.expand(w.blocks), rampTest: !!w.rampTest }; R.mode = 'erg'; }
  R.intensity = 100; R.offset = 0; R.sent = null;
  showView('ride');
}

function bindRide() {
  $('devTrainer').onclick = connectTrainer;
  $('devHr').onclick = connectHr;
  $('mCadBox').onclick = cadSheet;
  $('pickWorkout').onclick = pickWorkoutSheet;
  $('modeSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; if (R.mode !== b.dataset.mode) logEvent('modalità', `${R.mode} → ${b.dataset.mode}${R.state !== 'idle' ? ' durante l’allenamento (' + fmtDur(R.sec) + ')' : ''}`); R.mode = b.dataset.mode; R.sent = null; renderRide(true); };
  const adj = (fn) => () => { fn(); R.sent = null; renderRide(true); };
  document.querySelectorAll('[data-erg]').forEach(b => b.onclick = adj(() => { const d = +b.dataset.erg; if (R.wk) R.offset = clamp(R.offset + d, -300, 300); else R.ergW = clamp(R.ergW + d, 0, maxW()); }));
  document.querySelectorAll('[data-int]').forEach(b => b.onclick = adj(() => { R.intensity = clamp(R.intensity + +b.dataset.int, 50, 150); }));
  document.querySelectorAll('[data-grade]').forEach(b => b.onclick = adj(() => { R.grade = Math.round(clamp(R.grade + +b.dataset.grade, -10, 15) * 10) / 10; }));
  document.querySelectorAll('[data-gear]').forEach(b => b.onclick = adj(() => { R.gear = clamp(R.gear + +b.dataset.gear, 1, 11); }));
  $('bStart').onclick = startRide;
  $('bPause').onclick = pauseRide;
  $('bResume').onclick = resumeRide;
  $('bSkip').onclick = skipStep;
  $('bEnd').onclick = finishRide;
}

/* ---------- UI: Allenamenti ---------- */
function workoutCard(w) {
  const steps = Core.expand(w.blocks), est = Core.estimate(steps, S.profile.ftp);
  return `<button class="card wk" data-id="${esc(w.id)}"><div class="item-h"><b>${esc(w.name)}</b><span>${fmtMin(est.dur)}</span></div>
    <canvas class="mini" data-mini="${esc(w.id)}"></canvas>
    <div class="meta"><span>TSS ${fmt(w.rampTest ? null : est.tss)}</span><span>IF ${w.rampTest ? '–' : fmt(est.IF, 2)}</span>${w.source === 'coach' ? '<span class="tag">dal coach</span>' : ''}</div></button>`;
}
function renderWorkouts() {
  const mine = S.custom;
  $('wkMine').innerHTML = mine.length ? mine.map(workoutCard).join('') : `<p class="empty">Qui finiscono gli allenamenti che crei o che importi dal coach (file .zwo, .erg, .mrc).</p>`;
  $('wkPresets').innerHTML = PRESETS.map(workoutCard).join('');
  requestAnimationFrame(() => {
    document.querySelectorAll('#v-workouts canvas[data-mini]').forEach(cv => { const w = findWorkout(cv.dataset.mini); if (w) drawWorkout(cv, Core.expand(w.blocks), S.profile.ftp); });
  });
}
function stepRows(steps) {
  const ftp = S.profile.ftp;
  return `<table class="tbl"><thead><tr><th>Blocco</th><th>Durata</th><th>Watt</th></tr></thead><tbody>${steps.map(s => {
    const a = Core.stepTarget(s, 0, ftp), b = Core.stepTarget(s, s.d, ftp);
    const w = s.free ? 'libero' : Math.round(a) === Math.round(b) ? `${Math.round(a)}` : `${Math.round(a)} → ${Math.round(b)}`;
    return `<tr><td><i class="dot" style="background:${s.free ? 'var(--ink2)' : zoneColor((a + b) / 2 / ftp)}"></i>${esc(s.label)}${s.cad ? ` <span class="muted">${s.cad} rpm</span>` : ''}</td><td>${fmtDur(s.d)}</td><td>${w}</td></tr>`;
  }).join('')}</tbody></table>`;
}
function openWorkout(id) {
  const w = findWorkout(id); if (!w) return;
  const steps = Core.expand(w.blocks), est = Core.estimate(steps, S.profile.ftp), mine = !!S.custom.find(x => x.id === id);
  sheet(`<h2>${esc(w.name)}</h2>${w.desc ? `<p>${esc(w.desc)}</p>` : ''}
    <canvas class="wkbig" id="wkBig"></canvas>
    <div class="stats3"><div><b>${fmtMin(est.dur)}</b><span>durata</span></div><div><b>${w.rampTest ? '–' : fmt(est.tss)}</b><span>TSS stimato</span></div><div><b>${w.rampTest ? '–' : fmt(est.IF, 2)}</b><span>IF</span></div></div>
    <div class="row"><button class="btn primary" id="useW">Usa ora</button>${mine ? '<button class="btn" id="editW">Modifica</button>' : '<button class="btn" id="dupW">Duplica e modifica</button>'}</div>
    ${stepRows(steps)}
    <p class="muted">Watt calcolati sulla FTP attuale di ${S.profile.ftp} W.</p>
    ${mine ? '<div class="row"><button class="btn" id="expW">Esporta .zwo</button><button class="btn danger subtle" id="delW">Elimina</button></div>' : ''}`,
    { onMount: (el, close) => {
      drawWorkout(el.querySelector('#wkBig'), steps, S.profile.ftp);
      el.querySelector('#useW').onclick = () => { if (R.state !== 'idle') return toast('Termina prima l’allenamento in corso'); close(); loadWorkout(id); };
      if (mine) {
        el.querySelector('#editW').onclick = () => { close(); builder(w); };
        el.querySelector('#delW').onclick = () => { if (!confirm('Eliminare questo allenamento?')) return; S.custom = S.custom.filter(x => x.id !== id); store.set('workouts', S.custom); close(); renderWorkouts(); };
        el.querySelector('#expW').onclick = () => shareFile(new Blob([toZwo(w)], { type: 'application/xml' }), safeName(w.name) + '.zwo');
      } else el.querySelector('#dupW').onclick = () => { close(); builder({ name: w.name + ' (mio)', blocks: JSON.parse(JSON.stringify(w.blocks)) }); };
    } });
}
function toZwo(w) {
  const a = v => w.blocks.some(b => b.abs) ? v : +(+v).toFixed(3);
  const els = w.blocks.map(b => {
    if (b.t === 'ramp') return `<Ramp Duration="${b.d}" PowerLow="${a(b.p0)}" PowerHigh="${a(b.p1)}"/>`;
    if (b.t === 'int') return `<IntervalsT Repeat="${b.n}" OnDuration="${b.d1}" OffDuration="${b.d2}" OnPower="${a(b.p1)}" OffPower="${a(b.p2)}"${b.cad1 ? ` Cadence="${b.cad1}"` : ''}/>`;
    if (b.t === 'free') return `<FreeRide Duration="${b.d}"/>`;
    return `<SteadyState Duration="${b.d}" Power="${a(b.p)}"${b.cad ? ` Cadence="${b.cad}"` : ''}/>`;
  });
  return `<workout_file>\n  <name>${esc(w.name)}</name>\n  <sportType>bike</sportType>\n  <workout>\n    ${els.join('\n    ')}\n  </workout>\n</workout_file>\n`;
}
const safeName = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'allenamento';

function importSheet() {
  sheet(`<h2>Importa allenamento</h2>
    <p><b>Da CoachPeaking:</b> dal computer apri l’allenamento nel calendario e premi “scarica file zwo”, poi sceglilo qui sotto.</p>
    <p class="muted">Vanno bene anche i file .zwo, .erg e .mrc di TrainingPeaks, intervals.icu e Zwift. I watt vengono calcolati sulla tua FTP: tienila uguale a quella impostata dal coach.</p>
    <label class="btn primary file">Scegli file<input type="file" id="impFile" accept=".zwo,.erg,.mrc,.json,.xml,.txt,text/xml,application/xml,text/plain"></label>
    <p class="muted">Oppure incolla qui il contenuto del file (utile se il coach lo manda su WhatsApp o per mail):</p>
    <textarea id="impText" rows="6" placeholder="<workout_file> … oppure [COURSE HEADER] …"></textarea>
    <div class="row"><button class="btn" id="impGo">Importa testo</button></div>`,
    { onMount: (el, close) => {
      const done = (text, name) => {
        try {
          const w = Core.parseWorkoutFile(text, name);
          const rec = { id: uid('w'), name: w.name, blocks: w.blocks, source: 'coach' };
          S.custom.unshift(rec); store.set('workouts', S.custom);
          close(); showView('workouts'); toast('Allenamento importato'); openWorkout(rec.id);
        } catch (e) { toast('Non riesco a leggerlo: ' + e.message); }
      };
      el.querySelector('#impFile').onchange = e => { const f = e.target.files[0]; if (!f) return; f.text().then(t => done(t, f.name)); };
      el.querySelector('#impGo').onclick = () => done(el.querySelector('#impText').value, '');
    } });
}

function builder(src) {
  const model = { id: src && src.id, name: (src && src.name) || 'Nuovo allenamento', blocks: src ? JSON.parse(JSON.stringify(src.blocks)) : [W('ramp', 600, 0.45, 0.7, { label: 'Riscaldamento' }), W('steady', 1200, 0.7), W('ramp', 300, 0.6, 0.4, { label: 'Defaticamento' })], source: src && src.source };
  const unit = b => b.abs ? 'W' : '% FTP';
  const pv = (b, v) => b.abs ? Math.round(v) : Math.round(v * 100);
  const fromInput = (b, v) => b.abs ? v : v / 100;
  const mins = s => Math.round(s / 60 * 100) / 100;
  const typeName = { ramp: 'Rampa', steady: 'Costante', int: 'Ripetute', free: 'Libero' };
  const fld = (k, label, val, step = 1) => `<label class="fld"><span>${label}</span><input type="number" inputmode="decimal" step="${step}" data-k="${k}" value="${val ?? ''}"></label>`;
  const blockHtml = (b, i) => `<div class="blk" data-i="${i}"><div class="blk-h"><b>${i + 1}. ${typeName[b.t]}${b.label ? ' <span class="muted">' + esc(b.label) + '</span>' : ''}</b>
      <span class="blk-ctl"><button data-act="up" aria-label="Sposta su">↑</button><button data-act="down" aria-label="Sposta giù">↓</button><button data-act="del" aria-label="Elimina">✕</button></span></div><div class="flds">${
    b.t === 'int' ? fld('n', 'Volte', b.n) + fld('d1', 'Lavoro (min)', mins(b.d1), 0.25) + fld('p1', unit(b), pv(b, b.p1)) + fld('d2', 'Recupero (min)', mins(b.d2), 0.25) + fld('p2', unit(b), pv(b, b.p2)) + fld('cad1', 'Cadenza (opz.)', b.cad1)
      : b.t === 'ramp' ? fld('d', 'Durata (min)', mins(b.d), 0.25) + fld('p0', 'Da ' + unit(b), pv(b, b.p0)) + fld('p1', 'A ' + unit(b), pv(b, b.p1))
        : b.t === 'free' ? fld('d', 'Durata (min)', mins(b.d), 0.25)
          : fld('d', 'Durata (min)', mins(b.d), 0.25) + fld('p', unit(b), pv(b, b.p)) + fld('cad', 'Cadenza (opz.)', b.cad)}</div></div>`;
  sheet(`<h2>${model.id ? 'Modifica allenamento' : 'Crea allenamento'}</h2>
    <label class="fld wide"><span>Nome</span><input type="text" id="bName" value="${esc(model.name)}"></label>
    <canvas class="wkbig" id="bPrev"></canvas><p class="muted" id="bSum"></p>
    <div id="bList"></div>
    <div class="addrow"><span>Aggiungi:</span><button data-add="ramp">Rampa</button><button data-add="steady">Costante</button><button data-add="int">Ripetute</button><button data-add="free">Libero</button></div>
    <div class="row"><button class="btn primary" id="bSave">Salva</button></div>`, {
    wide: true,
    onMount: (el, close) => {
      const list = el.querySelector('#bList');
      const preview = () => {
        const steps = Core.expand(model.blocks);
        if (!steps.length) { el.querySelector('#bSum').textContent = 'Aggiungi almeno un blocco.'; canvasCtx(el.querySelector('#bPrev')); return; }
        const est = Core.estimate(steps, S.profile.ftp);
        el.querySelector('#bSum').textContent = `${fmtMin(est.dur)}, TSS stimato ${fmt(est.tss)}, IF ${fmt(est.IF, 2)} (FTP ${S.profile.ftp} W)`;
        drawWorkout(el.querySelector('#bPrev'), steps, S.profile.ftp);
      };
      const draw = () => { list.innerHTML = model.blocks.map(blockHtml).join(''); preview(); };
      list.oninput = e => {
        const inp = e.target, i = +inp.closest('.blk').dataset.i, b = model.blocks[i], k = inp.dataset.k;
        const v = parseFloat(String(inp.value).replace(',', '.'));
        if (!isFinite(v)) { if (k.startsWith('cad')) b[k] = null; return; }
        if (k === 'd' || k === 'd1' || k === 'd2') b[k] = Math.max(k === 'd2' ? 0 : 5, Math.round(v * 60));
        else if (k === 'n') b.n = clamp(Math.round(v), 1, 50);
        else if (k.startsWith('cad')) b[k] = v > 0 ? clamp(Math.round(v), 40, 140) : null;
        else b[k] = fromInput(b, Math.max(0, v));
        preview();
      };
      list.onclick = e => {
        const btn = e.target.closest('button'); if (!btn) return;
        const i = +btn.closest('.blk').dataset.i, a = btn.dataset.act;
        if (a === 'del') model.blocks.splice(i, 1);
        if (a === 'up' && i > 0) model.blocks.splice(i - 1, 0, model.blocks.splice(i, 1)[0]);
        if (a === 'down' && i < model.blocks.length - 1) model.blocks.splice(i + 1, 0, model.blocks.splice(i, 1)[0]);
        draw();
      };
      el.querySelector('.addrow').onclick = e => {
        const t = e.target.dataset.add; if (!t) return;
        const abs = model.blocks.some(b => b.abs);
        const k = abs ? S.profile.ftp : 1;
        model.blocks.push(t === 'int' ? { t, n: 4, d1: 240, p1: 1.0 * k, d2: 120, p2: 0.5 * k, abs } : t === 'ramp' ? { t, d: 300, p0: 0.5 * k, p1: 0.75 * k, abs } : t === 'free' ? { t, d: 300 } : { t, d: 600, p: 0.7 * k, abs });
        draw(); list.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
      el.querySelector('#bSave').onclick = () => {
        if (!model.blocks.length) return toast('Aggiungi almeno un blocco');
        model.name = el.querySelector('#bName').value.trim() || 'Allenamento';
        const rec = { id: model.id || uid('w'), name: model.name, blocks: model.blocks, source: model.source };
        const i = S.custom.findIndex(x => x.id === rec.id);
        if (i >= 0) S.custom[i] = rec; else S.custom.unshift(rec);
        store.set('workouts', S.custom);
        close(); showView('workouts'); toast('Allenamento salvato');
      };
      draw();
    }
  });
}

/* ---------- UI: Storico ---------- */
function renderHistory() {
  const idx = store.get('sessions', []);
  const now = new Date(), wd = (now.getDay() + 6) % 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - wd).getTime();
  const wk = idx.filter(s => s.start >= monday);
  $('weekSum').innerHTML = `<div><b>${wk.length}</b><span>uscite</span></div><div><b>${fmtMin(wk.reduce((a, s) => a + s.dur, 0))}</b><span>tempo</span></div><div><b>${fmt(wk.reduce((a, s) => a + (s.tss || 0), 0))}</b><span>TSS</span></div><div><b>${fmt(wk.reduce((a, s) => a + (s.dist || 0), 0) / 1000, 0)}</b><span>km</span></div>`;
  const live = store.get('live', null);
  $('histList').innerHTML = (live && R.state === 'idle' ? `<div class="card warn"><b>Allenamento non salvato</b><p>${fmtDate(live.start)}: ${fmtDur(live.data.t.length)} registrati prima che l’app si chiudesse.</p><div class="row"><button class="btn primary" id="recSave">Salva</button><button class="btn" id="recDrop">Scarta</button></div></div>` : '')
    + (idx.length ? idx.map(s => `<button class="card sess" data-id="${s.id}"><div class="item-h"><b>${esc(s.name)}</b><span>${fmtDate(s.start)}</span></div>
      <div class="meta"><span>${fmtDur(s.dur)}</span><span>${fmt(s.avgP)} W medi</span><span>NP ${fmt(s.np)}</span><span>TSS ${fmt(s.tss)}</span>${s.avgH ? `<span>${fmt(s.avgH)} bpm</span>` : ''}</div></button>`).join('')
      : `<p class="empty">Ancora nessun allenamento. Il primo che salvi comparirà qui, con tutte le statistiche e il file da mandare al coach.</p>`);
  if ($('recSave')) {
    $('recSave').onclick = async () => { live.id = uid('s'); if (await persistSession(live)) { store.del('live'); R.banner = null; renderHistory(); toast('Allenamento recuperato'); } };
    $('recDrop').onclick = () => { if (confirm('Scartare l’allenamento non salvato?')) { store.del('live'); renderHistory(); } };
  }
}
function coachText(sess, sum) {
  const lines = [
    `🚴 ${sess.name} (${fmtDate(sess.start)})`,
    `Durata ${fmtDur(sum.dur)}, ${fmt(sum.dist / 1000, 1)} km`,
    `Potenza media ${fmt(sum.avgP)} W, NP ${fmt(sum.np)} W, max ${fmt(sum.maxP)} W`,
    `IF ${fmt(sum.IF, 2)}, TSS ${fmt(sum.tss)}, ${fmt(sum.kj)} kJ (FTP ${sum.ftp} W)`,
    [sum.avgC != null ? `Cadenza media ${fmt(sum.avgC)} rpm${sess.cadEst ? ' (stimata)' : ''}` : '', sum.hasHr ? `FC media ${fmt(sum.avgH)} / max ${fmt(sum.maxH)} bpm` : ''].filter(Boolean).join(', ')
  ].filter(Boolean);
  if (sum.decoupling != null) lines.push(`Disaccoppiamento potenza/FC ${fmt(sum.decoupling, 1)}%`);
  const work = sum.laps.filter(l => l.target != null && l.dur >= 30 && sess.steps && sess.steps[l.step] && /Ripetuta|Soglia|VO2|Tempo|Ritmo/i.test(l.label));
  if (work.length) lines.push('', 'Blocchi di lavoro:', ...work.map(l => `${l.label}: ${fmt(l.avgP)} W (obiettivo ${fmt(l.target)})` + (l.avgH ? `, ${fmt(l.avgH)} bpm` : '') + (l.avgC != null ? `, ${fmt(l.avgC)} rpm` : '')));
  if (sess.rampFtp) lines.push('', `Test a rampa: FTP stimata ${sess.rampFtp} W`);
  return lines.join('\n');
}
async function shareFile(blob, name) {
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast('File pronto: ' + name);
}
async function openSession(id, justSaved) {
  const sess = await db.get('s.' + id);
  if (!sess) return toast('Allenamento non trovato');
  const sum = Core.summarize(sess, S.profile);
  const z = sum.zones, zt = z.reduce((a, b) => a + b, 0) || 1;
  const hz = sum.hrz, ht = hz.reduce((a, b) => a + b, 0) || 1;
  const stat = (v, l) => `<div><b>${v}</b><span>${l}</span></div>`;
  const hrMax = S.profile.hrMax, hrB = [0, 0.6, 0.7, 0.8, 0.9, 1];
  sheet(`${justSaved && S.profile.endMsg ? `<p class="dedica">${esc(S.profile.endMsg)}</p>` : ''}
    <h2>${esc(sess.name)}</h2><p class="muted">${new Date(sess.start).toLocaleString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</p>
    ${sess.rampFtp ? `<div class="card ok"><b>FTP stimata: ${sess.rampFtp} W</b><p>Attuale: ${S.profile.ftp} W. Con la nuova FTP tutti gli allenamenti si ricalibrano.</p><div class="row"><button class="btn primary" id="setFtp">Usa ${sess.rampFtp} W come FTP</button></div></div>` : ''}
    <div class="stats">${stat(fmtDur(sum.dur), 'tempo')}${stat(fmt(sum.dist / 1000, 1), 'km')}${stat(fmt(sum.avgP), 'W medi')}${stat(fmt(sum.np), 'NP')}${stat(fmt(sum.IF, 2), 'IF')}${stat(fmt(sum.tss), 'TSS')}${stat(fmt(sum.kj), 'kJ')}${stat(fmt(sum.avgC), sess.cadEst ? 'rpm medi (stimati)' : 'rpm medi')}${stat(fmt(sum.maxP), 'W max')}${sum.hasHr ? stat(fmt(sum.avgH), 'bpm medi') + stat(fmt(sum.maxH), 'bpm max') : ''}${stat(fmt(sum.avgV, 1), 'km/h medi')}</div>
    <canvas class="chart" id="sChart"></canvas>
    <p class="legend"><i style="background:var(--z4)"></i>potenza per zona <i class="dash"></i>obiettivo ${sum.hasHr ? '<i style="background:var(--hr)"></i>cardio' : ''}</p>
    <h3>Tempo nelle zone di potenza</h3>
    <div class="zones">${Core.ZONES.map((zz, i) => `<div class="zr"><span>${zz.name}</span><div class="zb"><i style="width:${z[i] / zt * 100}%;background:${zz.color}"></i></div><em>${fmtMin(z[i])}</em></div>`).join('')}</div>
    ${sum.hasHr ? `<h3>Tempo nelle zone cardio</h3><div class="zones">${hz.map((v, i) => `<div class="zr"><span>Z${i + 1} ${i === 0 ? '&lt; ' + Math.round(hrB[1] * hrMax) : i === 4 ? '&gt; ' + Math.round(hrB[4] * hrMax) : Math.round(hrB[i] * hrMax) + '–' + (Math.round(hrB[i + 1] * hrMax) - 1)}</span><div class="zb"><i style="width:${v / ht * 100}%;background:var(--hr)"></i></div><em>${fmtMin(v)}</em></div>`).join('')}</div>` : ''}
    <h3>Migliori potenze</h3>
    <div class="stats4">${[[5, '5″'], [60, '1′'], [300, '5′'], [1200, '20′']].map(([k, l]) => stat(fmt(sum.best[k]), l)).join('')}</div>
    ${sum.decoupling != null ? `<p><b>Disaccoppiamento potenza/cardio: ${fmt(sum.decoupling, 1)}%.</b> <span class="muted">Sotto il 5% su un lungo in Z2 indica una buona base aerobica.</span></p>` : ''}
    ${sum.laps.length > 1 ? `<h3>Blocchi</h3><table class="tbl"><thead><tr><th>Blocco</th><th>Tempo</th><th>W</th><th>Obiett.</th><th>rpm</th>${sum.hasHr ? '<th>bpm</th>' : ''}</tr></thead><tbody>${sum.laps.map(l => `<tr><td>${esc(l.label)}</td><td>${fmtDur(l.dur)}</td><td><b>${fmt(l.avgP)}</b></td><td>${fmt(l.target)}</td><td>${fmt(l.avgC)}</td>${sum.hasHr ? `<td>${fmt(l.avgH)}</td>` : ''}</tr>`).join('')}</tbody></table>` : ''}
    <h3>Condividi</h3>
    <p class="muted">Il file .FIT si carica su Strava, intervals.icu, TrainingPeaks, Garmin Connect e COROS Training Hub, con potenza, cadenza, cardio e blocchi.</p>
    <div class="row"><button class="btn primary" id="shFit">File .FIT</button><button class="btn" id="shTxt">Messaggio per il coach</button></div>
    <div id="sStrava"></div>
    <div class="row"><button class="btn danger subtle" id="delS">Elimina allenamento</button></div>`, {
    wide: true,
    onMount: (el, close) => {
      drawSessionChart(el.querySelector('#sChart'), sess, sum);
      Strava.mountSession(el.querySelector('#sStrava'), id);
      el.querySelector('#shFit').onclick = () => shareFile(new Blob([Core.buildFit(sess, sum)], { type: 'application/octet-stream' }), `${new Date(sess.start).toISOString().slice(0, 10)}_${safeName(sess.name)}.fit`);
      el.querySelector('#shTxt').onclick = async () => {
        const text = coachText(sess, sum);
        const phone = (S.profile.coachPhone || '').replace(/[^\d]/g, '');
        if (phone) { location.href = `https://wa.me/${phone}?text=${encodeURIComponent(text)}`; return; }
        try { if (navigator.share) { await navigator.share({ text }); return; } } catch (e) { if (e.name === 'AbortError') return; }
        try { await navigator.clipboard.writeText(text); toast('Riepilogo copiato: incollalo nella chat del coach'); } catch (e) { location.href = `https://wa.me/?text=${encodeURIComponent(text)}`; }
      };
      el.querySelector('#delS').onclick = async () => {
        if (!confirm('Eliminare questo allenamento dallo storico?')) return;
        await db.del('s.' + id); store.set('sessions', store.get('sessions', []).filter(s => s.id !== id));
        close(); renderHistory();
      };
      const sf = el.querySelector('#setFtp');
      if (sf) sf.onclick = () => { S.profile.ftp = sess.rampFtp; store.set('profile', S.profile); toast(`FTP aggiornata a ${sess.rampFtp} W`); sf.disabled = true; };
    }
  });
}

/* ---------- Strava → CoachPeaking ---------- */
const Strava = (() => {
  const enabled = () => !!(STRAVA.workerUrl && STRAVA.clientId);
  const base = () => STRAVA.workerUrl.replace(/\/+$/, '');
  const acct = () => store.get('strava', null);
  const done = () => store.get('strava.done', {});
  const queue = () => store.get('strava.q', []);
  const redirect = () => location.origin + location.pathname.replace(/index\.html$/, '');
  const netErr = e => e instanceof TypeError;
  let busy = false, retryT = null, mounted = null, last = null;

  function connect() {
    if (!enabled()) return toast('Il collegamento a Strava non è configurato');
    const nonce = uid('n'); store.set('strava.nonce', nonce);
    const u = new URL('https://www.strava.com/oauth/authorize');
    u.search = new URLSearchParams({ client_id: STRAVA.clientId, redirect_uri: redirect(), response_type: 'code', approval_prompt: 'auto', scope: 'activity:write', state: nonce }).toString();
    logEvent('strava', 'avvio collegamento');
    location.href = u.toString();
  }
  async function post(path, body) {
    const r = await fetch(base() + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.detail || d.error || 'errore ' + r.status); e.status = r.status; throw e; }
    return d;
  }
  async function handleRedirect() {
    const q = new URLSearchParams(location.search);
    if (!q.has('state') || !(q.has('code') || q.has('error'))) return;
    const clean = () => { try { history.replaceState(null, '', redirect()); } catch (e) { } };
    const mine = q.get('state') === store.get('strava.nonce', null);
    if (!mine) return;
    store.del('strava.nonce'); clean();
    if (q.get('error')) { logEvent('strava', 'autorizzazione negata'); toast('Collegamento a Strava annullato'); return; }
    if (!(q.get('scope') || '').includes('activity:write')) { toast('Per caricare gli allenamenti serve lasciare spuntata la scrittura delle attività. Riprova.'); return; }
    try {
      const d = await post('/token', { code: q.get('code') });
      const name = d.athlete ? [d.athlete.firstname, d.athlete.lastname].filter(Boolean).join(' ') : '';
      store.set('strava', { access: d.access_token, refresh: d.refresh_token, exp: d.expires_at, name, auto: true });
      logEvent('strava', 'collegato');
      // gli allenamenti degli ultimi 3 giorni non ancora inviati partono subito
      const dn = done(), recent = store.get('sessions', []).filter(s => Date.now() - s.start < 3 * 86400000 && !dn[s.id]).map(s => s.id);
      if (recent.length) { store.set('strava.q', [...new Set([...queue(), ...recent])]); toast(`Strava collegato. Invio ${recent.length === 1 ? 'l’allenamento recente' : 'gli allenamenti recenti'}…`); }
      else toast('Strava collegato');
    } catch (e) { logEvent('strava', 'collegamento fallito: ' + e.message); toast('Collegamento a Strava non riuscito: ' + e.message); }
  }
  async function token() {
    const a = acct(); if (!a) throw new Error('Strava non collegato');
    if (a.exp - 120 > Date.now() / 1000) return a.access;
    let d;
    try { d = await post('/refresh', { refresh_token: a.refresh }); }
    catch (e) { if (e.status === 400 || e.status === 401) { e.auth = true; e.message = 'Strava non autorizza più l’app: ricollegalo dal Profilo'; } throw e; }
    Object.assign(a, { access: d.access_token, refresh: d.refresh_token, exp: d.expires_at, bad: false }); store.set('strava', a);
    return a.access;
  }
  async function sendOne(id) {
    const sess = await db.get('s.' + id);
    if (!sess || !sess.data) return 'gone';
    if (sess.data.t.length < 120) return 'short';
    const fit = Core.buildFit(sess, Core.summarize(sess, S.profile));
    for (let attempt = 0; attempt < 2; attempt++) {
      const tk = await token();
      const fd = new FormData();
      fd.append('file', new Blob([fit], { type: 'application/octet-stream' }), 'rullo.fit');
      fd.append('name', sess.name); fd.append('trainer', '1'); fd.append('external_id', 'rullo-' + sess.id);
      const r = await fetch(base() + '/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + tk }, body: fd });
      const d = await r.json().catch(() => ({}));
      if (r.status === 401 && attempt === 0) { const a = acct(); a.exp = 0; store.set('strava', a); continue; }
      if (r.status === 401) { const e = new Error('Strava non autorizza più l’app: ricollegalo dal Profilo'); e.auth = true; throw e; }
      if (r.status === 429) throw new Error('Strava ha troppe richieste: riprovo più tardi');
      if (!r.ok || !d.id) throw new Error(d.message || d.error || 'errore ' + r.status);
      let up = d;
      for (let i = 0; i < 8 && !up.activity_id && !up.error; i++) {
        await sleep(2500);
        const s2 = await fetch(`${base()}/status?id=${d.id}`, { headers: { Authorization: 'Bearer ' + tk } }).catch(() => null);
        if (s2 && s2.ok) up = await s2.json().catch(() => up);
      }
      if (up.error) {
        if (/duplicate/i.test(up.error)) return { u: d.id, a: (up.error.match(/activity (\d+)/) || [])[1] || null, dup: true };
        throw new Error(up.error);
      }
      return { u: d.id, a: up.activity_id || null };
    }
  }
  function enqueue(id) {
    const a = acct();
    if (!enabled() || !a || !a.auto || done()[id]) return false;
    const q = queue(); if (!q.includes(id)) { q.push(id); store.set('strava.q', q); }
    return true;
  }
  async function sync({ quiet } = {}) {
    const a = acct();
    if (busy || !enabled() || !a || a.bad || !queue().length) return;
    busy = true; render();
    try {
      for (const id of queue().slice()) {
        try {
          const res = await sendOne(id);
          store.set('strava.q', queue().filter(x => x !== id));
          if (res === 'gone' || res === 'short') { logEvent('strava', `saltato ${id}: ${res === 'short' ? 'troppo breve' : 'non trovato'}`); continue; }
          const dn = done(); dn[id] = { u: res.u, a: res.a, t: Date.now(), dup: !!res.dup }; store.set('strava.done', dn);
          last = { ok: true, t: Date.now() };
          logEvent('strava', `inviato ${id}${res.dup ? ' (già presente)' : ''}${res.a ? ', attività ' + res.a : ', in elaborazione'}`);
          toast(res.dup ? 'Già presente su Strava' : 'Allenamento inviato a Strava: arriverà a CoachPeaking tra pochi minuti');
        } catch (e) {
          const off = netErr(e);
          last = { ok: false, msg: off ? 'nessuna connessione' : e.message, t: Date.now() };
          logEvent('strava', `invio fallito ${id}: ${off ? 'rete' : e.message}`);
          if (e.auth) { const b = acct(); b.bad = true; store.set('strava', b); }
          if (!quiet || !off) toast(off ? 'Nessuna connessione: l’allenamento resta in coda e parte appena torna la rete' : 'Invio a Strava non riuscito: ' + e.message);
          if (!e.auth) { clearTimeout(retryT); retryT = setTimeout(() => sync({ quiet: true }), 120000); }
          break;
        }
      }
    } finally { busy = false; render(); }
  }
  function disconnect() {
    store.del('strava'); store.del('strava.q'); last = null;
    logEvent('strava', 'scollegato'); render();
  }
  function setAuto(v) { const a = acct(); if (a) { a.auto = v; store.set('strava', a); } }

  // --- schermate ---
  function renderProfileBox() {
    const el = $('pStrava'); if (!el) return;
    const box = el.closest('.section'); if (box) box.hidden = !enabled();
    if (!enabled()) return;
    const a = acct(), q = queue().length;
    if (!a || a.bad) {
      el.innerHTML = `<p class="muted">${a && a.bad ? 'Strava non risponde più: ricollegalo per riprendere l’invio.' : 'Appena salvi un allenamento, l’app lo manda a Strava e da lì arriva a CoachPeaking, così il coach lo vede senza che tu faccia altro.'}</p>
        <div class="row"><button class="btn primary" id="stConnect">${a && a.bad ? 'Ricollega Strava' : 'Collega Strava'}</button></div>
        <p class="muted">Serve anche che Strava sia collegato su CoachPeaking (Calendario › menu › Account › Connessioni).</p>`;
    } else {
      el.innerHTML = `<div class="pz"><span>Strava</span><em>collegato${a.name ? ' · ' + esc(a.name) : ''}</em></div>
        <label class="switch"><input id="stAuto" type="checkbox" ${a.auto ? 'checked' : ''}> Invia in automatico a fine allenamento</label>
        ${q ? `<p class="muted">In coda: ${q} ${q === 1 ? 'allenamento' : 'allenamenti'}${last && !last.ok ? ' · ' + esc(last.msg) : ''}</p><div class="row"><button class="btn" id="stNow" ${busy ? 'disabled' : ''}>${busy ? 'Invio in corso…' : 'Invia ora'}</button></div>` : `<p class="muted">${last && last.ok ? 'Ultimo invio riuscito.' : 'Niente in coda.'}</p>`}
        <div class="row"><button class="btn subtle" id="stOff">Scollega</button></div>`;
    }
    const on = (id, fn) => { const b = el.querySelector('#' + id); if (b) b.onclick = fn; };
    on('stConnect', connect); on('stNow', () => sync()); on('stOff', () => { if (confirm('Scollegare Strava? Gli allenamenti non verranno più inviati.')) disconnect(); });
    const au = el.querySelector('#stAuto'); if (au) au.onchange = () => setAuto(au.checked);
  }
  function mountSession(el, id) {
    mounted = { el, id };
    const a = acct();
    if (!enabled() || !el) { if (el) el.innerHTML = ''; return; }
    const d = done()[id], inQ = queue().includes(id);
    let html;
    if (!a || a.bad) html = `<p class="muted">Per mandare gli allenamenti al coach collega Strava dal Profilo.</p>`;
    else if (d) html = `<p><b>Su Strava ✓</b> <span class="muted">inviato ${new Date(d.t).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}. Arriva a CoachPeaking in pochi minuti.</span></p>`;
    else if (inQ) html = `<p><b>${busy ? 'Invio a Strava…' : 'In coda per Strava'}</b>${last && !last.ok ? ` <span class="muted">${esc(last.msg)}</span>` : ''}</p><div class="row"><button class="btn" id="stSend" ${busy ? 'disabled' : ''}>Invia ora</button></div>`;
    else html = `<div class="row"><button class="btn" id="stSend">Invia a Strava</button></div>`;
    el.innerHTML = `<h3>Coach (Strava → CoachPeaking)</h3>${html}`;
    const b = el.querySelector('#stSend');
    if (b) b.onclick = () => { enqueue(id) || (() => { const q = queue(); if (!q.includes(id)) { q.push(id); store.set('strava.q', q); } })(); sync(); mountSession(el, id); };
  }
  function render() {
    renderProfileBox();
    if (mounted && mounted.el.isConnected) mountSession(mounted.el, mounted.id);
  }
  return { enabled, connect, handleRedirect, enqueue, sync, render, mountSession, acct, queue };
})();

/* ---------- UI: Profilo ---------- */
function renderProfile() {
  const P = S.profile;
  $('pName').value = P.name; $('pFtp').value = P.ftp; $('pW').value = P.weight; $('pHr').value = P.hrMax;
  $('pCoach').value = P.coachPhone; $('pMsg').value = P.endMsg; $('pSound').checked = P.sound;
  $('pWkg').textContent = P.ftp && P.weight ? `${fmt(P.ftp / P.weight, 2)} W/kg` : '';
  const lo = [0, 0.55, 0.75, 0.9, 1.05, 1.2, 1.5];
  $('pZones').innerHTML = Core.ZONES.map((z, i) => `<div class="pz"><i class="dot" style="background:${z.color}"></i><span>Z${i + 1} ${z.name}</span><em>${i === 6 ? `oltre ${Math.round(lo[i] * P.ftp)} W` : `${Math.round(lo[i] * P.ftp)}–${Math.round(z.max * P.ftp) - 1} W`}</em></div>`).join('');
  $('ver').textContent = 'Versione ' + APP_VERSION;
  cadPanel($('pCad'));
  Strava.render();
  $('pInstall').hidden = !installEvt;
  $('pSupport').innerHTML = `<div class="pz"><span>Bluetooth per rullo e cardio</span><em>${navigator.bluetooth ? 'disponibile' : 'non disponibile in questo browser'}</em></div>
    <div class="pz"><span>Schermo sempre acceso</span><em>${'wakeLock' in navigator ? 'disponibile' : 'disattiva il blocco schermo a mano'}</em></div>
    <div class="pz"><span>Allenamenti in archivio</span><em>${store.get('sessions', []).length}</em></div>`;
}
function bindProfile() {
  const save = () => {
    const P = S.profile, n = (id, a, b, d) => { const v = parseFloat($(id).value); return isFinite(v) ? clamp(Math.round(v), a, b) : d; };
    P.name = $('pName').value.trim(); P.ftp = n('pFtp', 40, 600, P.ftp); P.weight = n('pW', 30, 150, P.weight); P.hrMax = n('pHr', 120, 230, P.hrMax);
    P.coachPhone = $('pCoach').value.trim(); P.endMsg = $('pMsg').value.trim(); P.sound = $('pSound').checked;
    store.set('profile', P);
    $('pWkg').textContent = P.ftp && P.weight ? `${fmt(P.ftp / P.weight, 2)} W/kg` : '';
  };
  ['pName', 'pFtp', 'pW', 'pHr', 'pCoach', 'pMsg', 'pSound'].forEach(id => $(id).addEventListener('change', () => { save(); renderProfile(); }));
  $('pRamp').onclick = () => { if (R.state !== 'idle') return toast('Termina prima l’allenamento in corso'); loadWorkout('p-ramp'); };
  $('pExport').onclick = async () => {
    const sessions = (await Promise.all(store.get('sessions', []).map(s => db.get('s.' + s.id)))).filter(Boolean);
    const out = { app: 'rullo', v: 1, profile: S.profile, workouts: S.custom, sessions };
    shareFile(new Blob([JSON.stringify(out)], { type: 'application/json' }), `backup_rullo_${new Date().toISOString().slice(0, 10)}.json`);
  };
  $('pImport').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const o = JSON.parse(await f.text());
      if (o.app !== 'rullo') throw new Error('non è un backup di questa app');
      if (!confirm(`Importare ${o.sessions.length} allenamenti svolti e ${o.workouts.length} allenamenti salvati? Quelli già presenti restano.`)) return;
      Object.assign(S.profile, o.profile); store.set('profile', S.profile);
      const ids = new Set(S.custom.map(w => w.id)); o.workouts.forEach(w => { if (!ids.has(w.id)) S.custom.push(w); }); store.set('workouts', S.custom);
      const have = new Set(store.get('sessions', []).map(s => s.id));
      for (const s of o.sessions.filter(s => s && s.id && s.data && !have.has(s.id)).sort((a, b) => a.start - b.start)) await persistSession(s);
      const idx = store.get('sessions', []).sort((a, b) => b.start - a.start); store.set('sessions', idx);
      toast('Backup importato'); renderProfile();
    } catch (err) { toast('Backup non valido: ' + err.message); }
    e.target.value = '';
  };
  $('pDemo').onclick = () => { connectDemo(); showView('ride'); };
  const diagText = () => [`Rullo ${APP_VERSION}`, navigator.userAgent, `Bluetooth web: ${navigator.bluetooth ? 'sì' : 'no'}; schermo acceso: ${'wakeLock' in navigator ? 'sì' : 'no'}; archivio: ${db.usingIdb ? 'IndexedDB' : 'localStorage'}; installata: ${matchMedia('(display-mode: standalone)').matches ? 'sì' : 'no'}`, `Allenamenti salvati: ${store.get('sessions', []).length}`, '', ...LOG].join('\n');
  $('pLogShow').onclick = () => sheet(`<h2>Registro diagnostico</h2><p class="muted">Gli ultimi eventi di collegamento e allenamento. Se qualcosa non va, condividilo.</p><pre class="log">${esc(diagText())}</pre>`, { wide: true });
  $('pLogShare').onclick = () => shareFile(new Blob([diagText()], { type: 'text/plain' }), `registro_rullo_${new Date().toISOString().slice(0, 10)}.txt`);
  $('pInstall').onclick = async () => {
    if (!installEvt) return;
    installEvt.prompt();
    try { await installEvt.userChoice; } catch (e) { }
    installEvt = null; $('pInstall').hidden = true;
  };
  $('pWelcome').onclick = () => welcome('welcome');
  $('pGuide').onclick = guide;
}

/* ---------- Benvenuto ---------- */
function welcome(kind = 'welcome') {
  const name = (S.profile.name || WELCOME.name || '').trim();
  const isB = kind === 'birthday';
  const title = isB ? (name ? `Auguri, ${name}` : 'Auguri!') : (name ? `Benvenuta, ${name}` : 'Benvenuta');
  const text = isB ? WELCOME.birthdayMessage : WELCOME.message;
  const ov = document.createElement('div');
  ov.className = 'welcome';
  ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
  ov.innerHTML = `<div class="w-in">
    <div class="w-ribbon">${Core.ZONES.map((z, i) => `<span style="background:${z.color};animation-delay:${i * 110}ms"></span>`).join('')}</div>
    <h1>${esc(title)}</h1>
    <p class="w-msg">${esc(text).replace(/\n/g, '<br>')}</p>
    ${WELCOME.signature ? `<p class="w-sig">${esc(WELCOME.signature)}</p>` : ''}
    <button class="btn primary big" id="wGo">${isB ? 'Grazie!' : 'Iniziamo'}</button></div>`;
  document.body.appendChild(ov);
  ov.querySelector('#wGo').onclick = () => {
    ov.remove();
    if (isB) { store.set('bday-' + new Date().getFullYear(), true); return; }
    const first = !store.get('welcomed', false);
    store.set('welcomed', true);
    if (first) {
      if (!S.profile.name && WELCOME.name) { S.profile.name = WELCOME.name; store.set('profile', S.profile); }
      guide();
    }
  };
}

/* ---------- Guida al primo avvio ---------- */
function guide() {
  document.querySelectorAll('.guide').forEach(e => e.remove());
  const ov = document.createElement('div');
  ov.className = 'welcome guide';
  ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
  document.body.appendChild(ov);
  let step = 0, timer = null, err = null;
  const hasBt = !!navigator.bluetooth;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const done = () => { clearInterval(timer); ov.remove(); store.set('guided', true); showView('ride'); };
  const connected = () => S.trainer && !S.trainer.isDemo && S.trainerState === 'on';
  const fld = (id, label, val, type = 'number') => `<label class="fld"><span>${label}</span><input id="${id}" type="${type}" ${type === 'number' ? 'inputmode="numeric"' : 'autocomplete="given-name"'} value="${esc(val)}"></label>`;
  const screens = [
    () => `<h2>Dove la stai usando</h2>
      ${hasBt ? `<p class="g-ok">Questo browser può collegarsi al rullo: sei a posto.</p>
        <p class="muted">Usa sempre questo stesso dispositivo e questo stesso browser: gli allenamenti restano salvati qui.</p>`
      : `<p class="g-warn">Questo browser non può usare il Bluetooth, quindi da qui il rullo non si collega.</p>
        ${ios ? '<p><b>Su iPhone e iPad:</b> installa l’app gratuita <b>Bluefy</b> dall’App Store, aprila e incolla lì questo indirizzo.</p><p>In alternativa usa il computer con Chrome.</p>'
              : '<p><b>Su computer (Windows o Mac) e su Android:</b> apri questo stesso indirizzo con <b>Chrome</b> o <b>Edge</b>.</p>'}
        <p class="muted">Puoi comunque andare avanti e guardarti l’app in modalità demo.</p>`}
      <div class="g-nav"><button class="btn primary big" data-go="1">Avanti</button></div>`,
    () => `<h2>I tuoi dati</h2>
      <p class="muted">Servono per calcolare zone e watt degli allenamenti. Li cambi quando vuoi dal Profilo.</p>
      <div class="form">${fld('gName', 'Nome', S.profile.name, 'text')}${fld('gW', 'Peso (kg)', S.profile.weight)}${fld('gHr', 'FC massima (bpm)', S.profile.hrMax)}${fld('gFtp', 'FTP (watt)', S.profile.ftp)}</div>
      <p class="muted">La FTP è la potenza che riesci a tenere per circa un’ora. Se il coach te l’ha data su CoachPeaking, metti quella. Se non la conosci lascia 150: la troverai con il test a rampa che c’è tra gli allenamenti.</p>
      <div class="g-nav"><button class="btn big" data-go="0">Indietro</button><button class="btn primary big" data-go="2">Avanti</button></div>`,
    () => `<h2>Chiudi Zwift, poi collega</h2>
      ${ZWIFT_STEPS}
      ${err ? `<p class="g-warn">${err}</p>` : ''}
      <div class="g-nav"><button class="btn big" data-go="1">Indietro</button>${hasBt ? '<button class="btn primary big" id="gConn">Ho chiuso Zwift: collega</button>' : '<button class="btn primary big" id="gDemo">Continua in demo</button>'}</div>
      <p class="g-skip"><button class="btn subtle" data-go="3">Lo collego dopo</button></p>`,
    () => `<h2>${connected() ? 'Rullo collegato' : 'Tutto pronto'}</h2>
      ${connected() ? `<p>Prova a pedalare: qui sotto devono comparire i watt.</p><div class="g-live"><b id="gPw">–</b><span>watt</span></div>
        <p class="muted" id="gCtl">${S.trainer.canControl ? 'L’app può regolare la resistenza del rullo.' : 'Il rullo invia i dati ma non accetta comandi: chiudi le altre app e ricollegalo.'}</p>`
      : `<p>${S.trainer && S.trainer.isDemo ? 'Sei in modalità demo: i dati sono simulati, così puoi provare tutto senza rullo.' : 'Quando vuoi collegare il rullo, tocca “Collega rullo” in alto nella schermata Allenati.'}</p>`}
      <ol class="steps">
        <li>In <b>Allenati</b> tocca “Scegli allenamento”, oppure pedala libera.</li>
        <li>Tocca <b>Avvia</b>. In modalità ERG scegli tu i watt e il rullo si regola da solo: tieni 80–95 pedalate al minuto.</li>
        <li>Alla fine tocca <b>Termina</b> e poi <b>Salva</b>: trovi statistiche e file per il coach nello Storico.</li>
        <li>Per vedere anche i battiti, tocca <b>Collega cardio</b>: l’app ti spiega come usare il COROS.</li>
      </ol>
      <div class="g-nav"><button class="btn primary big" id="gEnd">Inizia</button></div>`
  ];
  const saveData = () => {
    const P = S.profile, v = id => ov.querySelector('#' + id), n = (id, lo, hi, d) => { const x = parseFloat(v(id).value); return isFinite(x) ? clamp(Math.round(x), lo, hi) : d; };
    if (!v('gName')) return;
    P.name = v('gName').value.trim(); P.weight = n('gW', 30, 150, P.weight); P.hrMax = n('gHr', 120, 230, P.hrMax); P.ftp = n('gFtp', 40, 600, P.ftp);
    store.set('profile', P);
  };
  const show = () => {
    clearInterval(timer);
    ov.innerHTML = `<div class="w-in"><div class="g-dots">${screens.map((_, i) => `<i class="${i === step ? 'on' : i < step ? 'done' : ''}"></i>`).join('')}</div><p class="g-count">Passo ${step + 1} di ${screens.length}</p>${screens[step]()}</div>`;
    ov.scrollTop = 0;
    ov.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { saveData(); err = null; step = +b.dataset.go; show(); });
    const c = ov.querySelector('#gConn');
    if (c) c.onclick = async () => {
      c.disabled = true; c.textContent = 'Scegli il rullo nell’elenco…';
      const ok = await doConnectTrainer();
      if (ok) { err = null; step = 3; }
      else err = 'Collegamento non riuscito. Se nell’elenco il rullo non compariva, quasi sempre è ancora agganciato a Zwift: chiudilo del tutto (anche Zwift Companion sul telefono) e riprova.';
      show();
    };
    const d = ov.querySelector('#gDemo');
    if (d) d.onclick = () => { connectDemo(); step = 3; show(); };
    const e = ov.querySelector('#gEnd');
    if (e) e.onclick = done;
    if (ov.querySelector('#gPw')) timer = setInterval(() => { const el = ov.querySelector('#gPw'); if (!el) return clearInterval(timer); const p = livePower(); el.textContent = p == null ? '–' : Math.round(p); }, 500);
  };
  show();
}
function maybeWelcome() {
  const d = new Date(), md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (!store.get('welcomed', false)) welcome('welcome');
  else if (WELCOME.birthday === md && !store.get('bday-' + d.getFullYear(), false)) welcome('birthday');
}

/* ---------- App installabile e scorciatoie ---------- */
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; const b = $('pInstall'); if (b) b.hidden = false; });
function registerSW() {
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || local)) {
    navigator.serviceWorker.register('sw.js').catch(e => logEvent('app', 'service worker: ' + e.message));
  }
}
function bindKeys() {
  document.addEventListener('keydown', e => {
    if (e.target.closest('input,textarea,select') || document.querySelector('.sheet-wrap,.welcome') || $('v-ride').hidden) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Space' && e.target.closest('button,a,label')) return;
    const click = sel => { const b = document.querySelector(sel); if (b && !b.hidden && !b.closest('[hidden]')) { b.click(); e.preventDefault(); } };
    if (e.code === 'Space') click(R.state === 'idle' ? '#bStart' : R.state === 'running' ? '#bPause' : '#bResume');
    else if (e.key === 'ArrowUp') click($('adjSim').hidden ? '[data-erg="5"]' : '[data-grade="0.5"]');
    else if (e.key === 'ArrowDown') click($('adjSim').hidden ? '[data-erg="-5"]' : '[data-grade="-0.5"]');
    else if (e.key === 'ArrowRight' && !$('adjSim').hidden) click('[data-gear="1"]');
    else if (e.key === 'ArrowLeft' && !$('adjSim').hidden) click('[data-gear="-1"]');
  });
}

/* ---------- Avvio ---------- */
function init() {
  logEvent('app', `avvio ${APP_VERSION}`);
  registerSW(); bindKeys(); migrateSessions();
  document.querySelector('.tabs').onclick = e => { const b = e.target.closest('button'); if (b) showView(b.dataset.v); };
  $('wkNew').onclick = () => builder(null);
  $('wkImport').onclick = importSheet;
  $('v-workouts').addEventListener('click', e => { const c = e.target.closest('.card.wk'); if (c) openWorkout(c.dataset.id); });
  $('histList').addEventListener('click', e => { const c = e.target.closest('.card.sess'); if (c) openSession(c.dataset.id); });
  bindRide(); bindProfile();
  renderDevices();
  if (store.get('live', null)) R.banner = { text: 'C’è un allenamento non salvato: lo trovi in Storico.', kind: 'warn' };
  showView('ride');
  maybeWelcome();
  Strava.handleRedirect().then(() => { Strava.render(); Strava.sync({ quiet: true }); });
  window.addEventListener('online', () => Strava.sync({ quiet: true }));
  setInterval(tick, 250);
  window.addEventListener('resize', () => renderRide(true));
  window.addEventListener('beforeunload', e => { if (R.state !== 'idle') { autosave(); e.preventDefault(); e.returnValue = ''; } });
}
document.addEventListener('DOMContentLoaded', init);
