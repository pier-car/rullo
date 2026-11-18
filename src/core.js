/* ===================== CORE: protocolli, allenamenti, statistiche, FIT ===================== */
const Core = (() => {
  'use strict';

  /* ---------- Bluetooth FTMS / CPS / HR ---------- */
  const UUID = {
    ftms: 0x1826, bikeData: 0x2AD2, control: 0x2AD9, feature: 0x2ACC, status: 0x2ADA, powerRange: 0x2AD8,
    cps: 0x1818, cpsMeas: 0x2A63, hrs: 0x180D, hrMeas: 0x2A37, csc: 0x1816, cscMeas: 0x2A5B
  };

  function parseIndoorBikeData(dv) {
    const r = {};
    if (dv.byteLength < 2) return r;
    const f = dv.getUint16(0, true);
    let o = 2;
    const has = n => o + n <= dv.byteLength;
    if (!(f & 0x0001)) { if (!has(2)) return r; r.speed = dv.getUint16(o, true) / 100; o += 2; }
    if (f & 0x0002) o += 2;
    if (f & 0x0004) { if (!has(2)) return r; r.cadence = dv.getUint16(o, true) / 2; o += 2; }
    if (f & 0x0008) o += 2;
    if (f & 0x0010) { if (!has(3)) return r; r.distance = dv.getUint16(o, true) + (dv.getUint8(o + 2) << 16); o += 3; }
    if (f & 0x0020) { if (!has(2)) return r; r.resistance = dv.getInt16(o, true); o += 2; }
    if (f & 0x0040) { if (!has(2)) return r; r.power = dv.getInt16(o, true); o += 2; }
    if (f & 0x0080) o += 2;
    if (f & 0x0100) o += 5;
    if (f & 0x0200) { if (!has(1)) return r; const h = dv.getUint8(o); if (h > 0) r.hr = h; o += 1; }
    return r;
  }

  function parseHeartRate(dv) {
    if (dv.byteLength < 2) return null;
    const f = dv.getUint8(0);
    if (f & 1) return dv.byteLength >= 3 ? dv.getUint16(1, true) : null;
    return dv.getUint8(1);
  }

  // cadenza dai giri di pedivella cumulativi (contatore a 16 bit, tempo in 1/1024 s)
  function makeCrank() {
    let lastRev = null, lastTime = null, cad = 0, lastChange = 0;
    return (rev, t, now) => {
      if (lastRev !== null) {
        const dr = (rev - lastRev + 65536) % 65536;
        const dt = ((t - lastTime + 65536) % 65536) / 1024;
        if (dr > 0 && dt > 0 && dr < 20) { cad = Math.min(200, dr / dt * 60); lastChange = now; }
        else if (now - lastChange > 3000) cad = 0;
      } else lastChange = now;
      lastRev = rev; lastTime = t;
      return cad;
    };
  }

  function makeCpsParser() {
    const crank = makeCrank();
    return (dv, now) => {
      const r = {};
      if (dv.byteLength < 4) return r;
      const f = dv.getUint16(0, true);
      r.power = dv.getInt16(2, true);
      let o = 4;
      if (f & 0x01) o += 1;
      if (f & 0x04) o += 2;
      if (f & 0x10) o += 6;
      if ((f & 0x20) && o + 4 <= dv.byteLength) r.cadence = crank(dv.getUint16(o, true), dv.getUint16(o + 2, true), now);
      return r;
    };
  }

  // sensore di cadenza Bluetooth (Cycling Speed and Cadence, 0x2A5B)
  function makeCscParser() {
    const crank = makeCrank();
    return (dv, now) => {
      const r = {};
      if (dv.byteLength < 1) return r;
      const f = dv.getUint8(0);
      let o = 1;
      if (f & 0x01) o += 6;                       // giri ruota (32 bit) + tempo
      if ((f & 0x02) && o + 4 <= dv.byteLength) r.cadence = crank(dv.getUint16(o, true), dv.getUint16(o + 2, true), now);
      return r;
    };
  }

  /* ---------- Cadenza stimata dalla velocità del volano ----------
     Con la Zwift Cog il pignone è uno solo: la velocità che il rullo manda segue le pedalate
     con un rapporto fisso (corona/pignone). rpm = km/h × k. */
  const COG_TEETH = 14, WHEEL_M = 2.105;
  const cadFactor = ring => 60 / (3.6 * (ring / COG_TEETH) * WHEEL_M);
  const cadFromSpeed = (kmh, k) => (kmh > 3 && k > 0) ? Math.min(160, kmh * k) : 0;

  function parseFeatures(dv) {
    if (dv.byteLength < 8) return null;
    const t = dv.getUint32(4, true);
    return { power: !!(t & (1 << 3)), sim: !!(t & (1 << 13)), resistance: !!(t & (1 << 2)) };
  }

  function parsePowerRange(dv) {
    if (dv.byteLength < 6) return null;
    return { min: dv.getInt16(0, true), max: dv.getInt16(2, true), inc: dv.getUint16(4, true) };
  }

  const cmd = {
    requestControl: () => new Uint8Array([0x00]),
    start: () => new Uint8Array([0x07]),
    targetPower: w => {
      const v = Math.max(0, Math.min(2000, Math.round(w)));
      return new Uint8Array([0x05, v & 0xff, (v >> 8) & 0xff]);
    },
    sim: (gradePct, windMs = 0, crr = 0.004, cw = 0.51) => {
      const b = new Uint8Array(7), dv = new DataView(b.buffer);
      b[0] = 0x11;
      dv.setInt16(1, Math.round(windMs * 1000), true);
      dv.setInt16(3, Math.round(gradePct * 100), true);
      b[5] = Math.max(0, Math.min(255, Math.round(crr * 10000)));
      b[6] = Math.max(0, Math.min(255, Math.round(cw * 100)));
      return b;
    }
  };

  /* ---------- Zone ---------- */
  const ZONES = [
    { max: 0.55, name: 'Recupero', color: '#8C97A8' },
    { max: 0.75, name: 'Fondo', color: '#3B82F6' },
    { max: 0.90, name: 'Tempo', color: '#22A86B' },
    { max: 1.05, name: 'Soglia', color: '#E9B32A' },
    { max: 1.20, name: 'VO2max', color: '#F07F2E' },
    { max: 1.50, name: 'Anaerobico', color: '#E2464C' },
    { max: Infinity, name: 'Sprint', color: '#9A5BE0' }
  ];
  const zoneIndex = frac => { for (let i = 0; i < ZONES.length; i++) if (frac < ZONES[i].max) return i; return 6; };
  const HR_ZONES = [0.6, 0.7, 0.8, 0.9, Infinity];
  const hrZoneIndex = frac => { for (let i = 0; i < 5; i++) if (frac < HR_ZONES[i]) return i; return 4; };

  /* ---------- Allenamenti ---------- */
  // blocchi: ramp {d,p0,p1}, steady {d,p}, int {n,d1,p1,d2,p2}, free {d}; abs:true => watt assoluti
  function expand(blocks) {
    const steps = [];
    for (const b of blocks || []) {
      const abs = !!b.abs;
      const d = Math.max(1, Math.round(b.d || 0));
      if (b.t === 'int') {
        const n = Math.max(1, Math.round(b.n || 1));
        for (let i = 0; i < n; i++) {
          steps.push({ d: Math.max(1, Math.round(b.d1)), a: b.p1, b: b.p1, abs, cad: b.cad1 || null, label: `Ripetuta ${i + 1}/${n}`, kind: 'on' });
          if (b.d2 > 0) steps.push({ d: Math.round(b.d2), a: b.p2, b: b.p2, abs, cad: b.cad2 || null, label: 'Recupero', kind: 'off' });
        }
      } else if (b.t === 'free') {
        steps.push({ d, a: 0, b: 0, abs, free: true, label: b.label || 'Libero' });
      } else if (b.t === 'ramp') {
        steps.push({ d, a: b.p0, b: b.p1, abs, cad: b.cad || null, label: b.label || (b.p1 >= b.p0 ? 'Rampa' : 'Defaticamento') });
      } else {
        steps.push({ d, a: b.p, b: b.p, abs, cad: b.cad || null, label: b.label || (abs ? 'Costante' : ZONES[zoneIndex(b.p)].name), auto: !b.label });
      }
    }
    autoLabels(steps);
    steps.forEach(s => { delete s.auto; });
    return steps;
  }

  // Gli allenamenti del coach (CoachPeaking) arrivano come semplici blocchi costanti, senza nomi.
  // I blocchi facili all'inizio diventano "Riscaldamento", quelli alla fine "Defaticamento",
  // quelli facili e brevi accanto a un blocco di lavoro "Recupero".
  function autoLabels(steps) {
    const easy = s => s.auto && !s.abs && !s.free && Math.max(s.a, s.b) < 0.76;
    const hard = s => s && !s.free && !s.abs && Math.max(s.a, s.b) >= 0.85;
    const n = steps.length;
    if (n < 3) return;
    let i = 0;
    while (i < n - 1 && easy(steps[i])) { steps[i].label = 'Riscaldamento'; i++; }
    let j = n - 1;
    while (j > i && easy(steps[j])) { steps[j].label = 'Defaticamento'; j--; }
    for (let k = i; k <= j; k++) {
      if (easy(steps[k]) && steps[k].d <= 600 && (hard(steps[k - 1]) || hard(steps[k + 1]))) steps[k].label = 'Recupero';
    }
  }

  const stepTarget = (s, tIn, ftp) => {
    if (s.free) return null;
    const v = s.a + (s.b - s.a) * Math.min(1, Math.max(0, tIn / s.d));
    return s.abs ? v : v * ftp;
  };
  const totalDur = steps => steps.reduce((a, s) => a + s.d, 0);

  function locate(steps, t) {
    let acc = 0;
    for (let i = 0; i < steps.length; i++) {
      if (t < acc + steps[i].d) return { i, tIn: t - acc, left: acc + steps[i].d - t };
      acc += steps[i].d;
    }
    return null;
  }

  function estimate(steps, ftp) {
    const arr = [];
    for (const s of steps) for (let t = 0; t < s.d; t++) arr.push(s.free ? 0.5 * ftp : stepTarget(s, t, ftp));
    const n = normPower(arr) || 0;
    const IF = n / ftp, dur = arr.length;
    return { dur, IF, tss: dur / 3600 * IF * IF * 100 };
  }

  const num = v => { const x = parseFloat(String(v).replace(',', '.')); return isFinite(x) ? x : null; };

  function parseZwo(text) {
    const name = (text.match(/<name>([\s\S]*?)<\/name>/i) || [])[1];
    const body = (text.match(/<workout>([\s\S]*?)<\/workout>/i) || [, text])[1];
    const re = /<(Warmup|Cooldown|SteadyState|SolidState|Ramp|IntervalsT|FreeRide|Freeride|MaxEffort)\b([^>]*?)\/?>/gi;
    const blocks = [];
    let m;
    while ((m = re.exec(body))) {
      const tag = m[1].toLowerCase(), at = {};
      m[2].replace(/(\w+)\s*=\s*["']([^"']*)["']/g, (_, k, v) => { at[k.toLowerCase()] = v; });
      const d = num(at.duration) || 0;
      const cad = num(at.cadence) || null;
      if (tag === 'warmup' || tag === 'cooldown' || tag === 'ramp') {
        blocks.push({ t: 'ramp', d, p0: num(at.powerlow) ?? 0.5, p1: num(at.powerhigh) ?? 0.5, cad, label: tag === 'warmup' ? 'Riscaldamento' : tag === 'cooldown' ? 'Defaticamento' : undefined });
      } else if (tag === 'steadystate' || tag === 'solidstate') {
        blocks.push({ t: 'steady', d, p: num(at.power) ?? num(at.powerlow) ?? 0.6, cad });
      } else if (tag === 'intervalst') {
        blocks.push({ t: 'int', n: num(at.repeat) || 1, d1: num(at.onduration) || 60, p1: num(at.onpower) ?? 1, d2: num(at.offduration) || 0, p2: num(at.offpower) ?? 0.5, cad1: cad, cad2: num(at.cadenceresting) || null });
      } else {
        blocks.push({ t: 'free', d, label: tag === 'maxeffort' ? 'Massimo sforzo' : 'Libero' });
      }
    }
    if (!blocks.length) throw new Error('Nel file non ho trovato blocchi di allenamento (.zwo).');
    const pw = blocks.flatMap(b => [b.p, b.p0, b.p1, b.p2].filter(v => v != null));
    if (pw.some(v => v > 4)) blocks.forEach(b => { b.abs = true; });
    return { name: (name || '').trim(), blocks };
  }

  function parseErgMrc(text) {
    const up = text.toUpperCase();
    const abs = /MINUTES\s+WATTS/.test(up);
    const pct = /MINUTES\s+PERCENT/.test(up);
    if (!abs && !pct) throw new Error('Formato .erg/.mrc non riconosciuto (manca MINUTES WATTS o MINUTES PERCENT).');
    const name = (text.match(/DESCRIPTION\s*=\s*(.+)/i) || text.match(/FILE NAME\s*=\s*(.+)/i) || [])[1];
    const data = (text.match(/\[COURSE DATA\]([\s\S]*?)\[END COURSE DATA\]/i) || [])[1];
    if (!data) throw new Error('Sezione [COURSE DATA] mancante.');
    const pts = data.split(/\r?\n/).map(l => l.trim().split(/\s+/).map(num)).filter(a => a.length >= 2 && a[0] != null && a[1] != null);
    const blocks = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const [t0, v0] = pts[i], [t1, v1] = pts[i + 1];
      const d = Math.round((t1 - t0) * 60);
      if (d <= 0) continue;
      const a = abs ? v0 : v0 / 100, b = abs ? v1 : v1 / 100;
      blocks.push(Math.abs(a - b) < 1e-9 ? { t: 'steady', d, p: a, abs } : { t: 'ramp', d, p0: a, p1: b, abs });
    }
    if (!blocks.length) throw new Error('Nessun segmento valido nel file.');
    return { name: (name || '').trim(), blocks };
  }

  // nome leggibile dal nome del file: "2026-11-20_Soglia_3x8.zwo" -> "Soglia 3x8"
  function nameFromFile(filename) {
    let n = String(filename || '').replace(/\.[a-z0-9]{2,4}$/i, '');
    n = n.replace(/\s*\(\d+\)$/, '').replace(/^\d{4}[-_.]?\d{2}[-_.]?\d{2}[ _-]*/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!n || /^(workout|allenamento|download|file|export)( ?\(?\d+\)?)?$/i.test(n)) return '';
    return n.charAt(0).toUpperCase() + n.slice(1);
  }

  function parseWorkoutFile(text, filename = '') {
    const f = filename.toLowerCase();
    const t = text.trim();
    let w;
    if (f.endsWith('.json') || t.startsWith('{')) {
      const o = JSON.parse(t);
      if (!Array.isArray(o.blocks)) throw new Error('JSON senza "blocks".');
      w = { name: o.name || '', blocks: o.blocks };
    } else if (f.endsWith('.zwo') || /<workout_file|<workout>/i.test(t)) w = parseZwo(t);
    else w = parseErgMrc(t);
    w.name = w.name || nameFromFile(filename) || 'Allenamento del coach';
    return w;
  }

  /* ---------- Statistiche ---------- */
  function normPower(arr) {
    if (!arr || arr.length < 30) return null;
    let s = 0, s4 = 0, n = 0;
    for (let i = 0; i < arr.length; i++) {
      s += arr[i]; if (i >= 30) s -= arr[i - 30];
      if (i >= 29) { s4 += Math.pow(s / 30, 4); n++; }
    }
    return Math.pow(s4 / n, 0.25);
  }
  function bestAvg(arr, w) {
    if (arr.length < w) return null;
    let s = 0, best = -1;
    for (let i = 0; i < arr.length; i++) { s += arr[i]; if (i >= w) s -= arr[i - w]; if (i >= w - 1 && s > best) best = s; }
    return best / w;
  }
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const max = a => a.length ? a.reduce((x, y) => (y > x ? y : x), -Infinity) : null;

  function summarize(sess, profile) {
    const D = sess.data, ftp = sess.ftp || profile.ftp, hrMax = profile.hrMax || 190;
    const n = D.t.length;
    const p = D.p.map(v => v || 0);
    const cads = D.c.filter(v => v > 0);
    const hrs = D.h.filter(v => v > 0);
    const sp = D.v.map(v => v || 0);
    const NP = normPower(p);
    const IF = NP ? NP / ftp : null;
    const zones = new Array(7).fill(0), hrz = new Array(5).fill(0);
    p.forEach(v => zones[zoneIndex(v / ftp)]++);
    hrs.forEach(v => hrz[hrZoneIndex(v / hrMax)]++);
    let decoupling = null;
    if (n >= 1200 && hrs.length >= n * 0.8) {
      const half = Math.floor(n / 2);
      const r = (a, b) => { const P = mean(p.slice(a, b)), H = mean(D.h.slice(a, b).filter(v => v > 0)); return P && H ? P / H : null; };
      const r1 = r(0, half), r2 = r(half, n);
      if (r1 && r2) decoupling = (r1 - r2) / r1 * 100;
    }
    const laps = [];
    if (D.st && D.st.some(v => v != null && v >= 0)) {
      let cur = null;
      for (let i = 0; i < n; i++) {
        const s = D.st[i];
        if (!cur || cur.step !== s) { cur = { step: s, from: i, to: i }; laps.push(cur); } else cur.to = i;
      }
      laps.forEach(l => {
        const sl = (a) => a.slice(l.from, l.to + 1);
        const tg = sl(D.g).filter(v => v != null);
        l.dur = l.to - l.from + 1;
        l.avgP = mean(sl(p)); l.maxP = max(sl(p));
        l.target = tg.length ? mean(tg) : null;
        l.avgC = mean(sl(D.c).filter(v => v > 0));
        l.avgH = mean(sl(D.h).filter(v => v > 0));
        l.label = (sess.steps && l.step != null && l.step >= 0 && sess.steps[l.step]) ? sess.steps[l.step].label : (l.step === -1 ? 'Libero' : 'Giro');
      });
    }
    const dist = D.d.length ? D.d[n - 1] : 0;
    return {
      dur: n, elapsed: n ? D.t[n - 1] + 1 : 0, dist,
      avgP: mean(p), maxP: max(p), np: NP, IF, tss: NP ? n / 3600 * IF * IF * 100 : null,
      kj: p.reduce((a, b) => a + b, 0) / 1000,
      avgC: mean(cads), maxC: max(cads), avgH: mean(hrs), maxH: max(hrs),
      avgV: mean(sp), maxV: max(sp),
      best: { 5: bestAvg(p, 5), 60: bestAvg(p, 60), 300: bestAvg(p, 300), 1200: bestAvg(p, 1200) },
      zones, hrz, decoupling, laps, ftp, hasHr: hrs.length > 0
    };
  }

  /* ---------- Export FIT (Garmin Flexible & Interoperable Data Transfer) ---------- */
  const FIT_EPOCH = 631065600;
  const CRC_T = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];
  function crc16(crc, byte) {
    let tmp = CRC_T[crc & 0xF]; crc = (crc >> 4) & 0x0FFF; crc = crc ^ tmp ^ CRC_T[byte & 0xF];
    tmp = CRC_T[crc & 0xF]; crc = (crc >> 4) & 0x0FFF; crc = crc ^ tmp ^ CRC_T[(byte >> 4) & 0xF];
    return crc;
  }
  const INVALID = { 0x00: 0xFF, 0x02: 0xFF, 0x84: 0xFFFF, 0x86: 0xFFFFFFFF, 0x8C: 0, 0x83: 0x7FFF };
  const LIMIT = { 0x00: 0xFE, 0x02: 0xFE, 0x84: 0xFFFE, 0x86: 0xFFFFFFFE, 0x8C: 0xFFFFFFFE, 0x83: 0x7FFE };

  function FitWriter() {
    const out = [], defs = {};
    return {
      def(local, global, fields) {
        out.push(0x40 | local, 0, 0, global & 0xff, (global >> 8) & 0xff, fields.length);
        fields.forEach(([n, s, bt]) => out.push(n, s, bt));
        defs[local] = fields;
      },
      rec(local, values) {
        out.push(local & 0x0f);
        defs[local].forEach(([, s, bt], i) => {
          let v = values[i];
          if (v == null || !isFinite(v)) v = INVALID[bt];
          else { v = Math.round(v); if (bt === 0x83 && v < 0) v = Math.max(-0x7FFF, v) + 0x10000; else v = Math.max(0, Math.min(LIMIT[bt], v)); }
          for (let k = 0; k < s; k++) out.push(Math.floor(v / Math.pow(256, k)) % 256);
        });
      },
      bytes() {
        const size = out.length;
        const h = [14, 0x20, 2132 & 0xff, 2132 >> 8, size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >>> 24) & 0xff, 0x2E, 0x46, 0x49, 0x54];
        let hc = 0; h.forEach(b => { hc = crc16(hc, b); });
        h.push(hc & 0xff, hc >> 8);
        const all = h.concat(out);
        let c = 0; all.forEach(b => { c = crc16(c, b); });
        all.push(c & 0xff, c >> 8);
        return new Uint8Array(all);
      }
    };
  }

  function buildFit(sess, sum) {
    const D = sess.data, n = D.t.length;
    const T0 = Math.floor(sess.start / 1000) - FIT_EPOCH;
    const ts = i => T0 + D.t[i];
    const tz = -new Date(sess.start).getTimezoneOffset() * 60;
    const w = FitWriter();
    const U8 = 0x02, U16 = 0x84, U32 = 0x86, EN = 0x00;
    w.def(0, 0, [[0, 1, EN], [1, 2, U16], [2, 2, U16], [3, 4, 0x8C], [4, 4, U32]]);
    w.rec(0, [4, 255, 1, (sess.start / 1000) % 4000000000 || 1, T0]);
    w.def(1, 21, [[253, 4, U32], [0, 1, EN], [1, 1, EN]]);
    w.def(2, 20, [[253, 4, U32], [7, 2, U16], [4, 1, U8], [3, 1, U8], [6, 2, U16], [5, 4, U32]]);
    w.rec(1, [T0 + (n ? D.t[0] : 0), 0, 0]);
    for (let i = 0; i < n; i++) {
      if (i > 0 && D.t[i] - D.t[i - 1] > 1) { w.rec(1, [ts(i - 1), 0, 4]); w.rec(1, [ts(i), 0, 0]); }
      w.rec(2, [ts(i), D.p[i], D.c[i], D.h[i] || null, D.v[i] != null ? D.v[i] / 3.6 * 1000 : null, D.d[i] != null ? D.d[i] * 100 : null]);
    }
    const tEnd = n ? ts(n - 1) : T0;
    w.rec(1, [tEnd, 0, 4]);
    w.def(3, 19, [[253, 4, U32], [254, 2, U16], [0, 1, EN], [1, 1, EN], [2, 4, U32], [7, 4, U32], [8, 4, U32], [9, 4, U32], [11, 2, U16], [13, 2, U16], [14, 2, U16], [15, 1, U8], [16, 1, U8], [17, 1, U8], [18, 1, U8], [19, 2, U16], [20, 2, U16], [24, 1, EN], [25, 1, EN], [39, 1, EN]]);
    const laps = sum.laps && sum.laps.length ? sum.laps : [{ from: 0, to: n - 1 }];
    const p = D.p.map(v => v || 0);
    laps.forEach((l, k) => {
      if (!n) return;
      const sl = a => a.slice(l.from, l.to + 1);
      const lp = sl(p), lc = sl(D.c).filter(v => v > 0), lh = sl(D.h).filter(v => v > 0), lv = sl(D.v).filter(v => v != null);
      const el = D.t[l.to] - D.t[l.from] + 1;
      const dist = (D.d[l.to] || 0) - (l.from > 0 ? D.d[l.from - 1] || 0 : 0);
      w.rec(3, [ts(l.to), k, 9, 1, ts(l.from), el * 1000, lp.length * 1000, dist * 100, lp.reduce((a, b) => a + b, 0) / 1000,
        lv.length ? mean(lv) / 3.6 * 1000 : null, lv.length ? max(lv) / 3.6 * 1000 : null,
        lh.length ? mean(lh) : null, lh.length ? max(lh) : null, lc.length ? mean(lc) : null, lc.length ? max(lc) : null,
        mean(lp), max(lp), k === laps.length - 1 ? 7 : 0, 2, 6]);
    });
    w.def(4, 18, [[253, 4, U32], [254, 2, U16], [0, 1, EN], [1, 1, EN], [2, 4, U32], [5, 1, EN], [6, 1, EN], [7, 4, U32], [8, 4, U32], [9, 4, U32], [11, 2, U16], [14, 2, U16], [15, 2, U16], [16, 1, U8], [17, 1, U8], [18, 1, U8], [19, 1, U8], [20, 2, U16], [21, 2, U16], [25, 2, U16], [26, 2, U16], [28, 1, EN], [34, 2, U16], [35, 2, U16], [36, 2, U16], [45, 2, U16]]);
    w.rec(4, [tEnd, 0, 8, 1, T0 + (n ? D.t[0] : 0), 2, 6, sum.elapsed * 1000, sum.dur * 1000, sum.dist * 100, sum.kj,
      sum.avgV != null ? sum.avgV / 3.6 * 1000 : null, sum.maxV != null ? sum.maxV / 3.6 * 1000 : null,
      sum.avgH, sum.maxH, sum.avgC, sum.maxC, sum.avgP, sum.maxP, 0, laps.length, 0,
      sum.np, sum.tss != null ? sum.tss * 10 : null, sum.IF != null ? sum.IF * 1000 : null, sum.ftp]);
    w.def(5, 34, [[253, 4, U32], [0, 4, U32], [1, 2, U16], [2, 1, EN], [3, 1, EN], [4, 1, EN], [5, 4, U32]]);
    w.rec(5, [tEnd, sum.dur * 1000, 1, 0, 26, 1, tEnd + tz]);
    return w.bytes();
  }

  return { UUID, parseIndoorBikeData, parseHeartRate, makeCpsParser, makeCscParser, cadFactor, cadFromSpeed, COG_TEETH, nameFromFile, parseFeatures, parsePowerRange, cmd,
    ZONES, zoneIndex, hrZoneIndex, expand, stepTarget, totalDur, locate, estimate,
    parseZwo, parseErgMrc, parseWorkoutFile, normPower, bestAvg, summarize, buildFit, mean };
})();
if (typeof module !== 'undefined') module.exports = Core;
