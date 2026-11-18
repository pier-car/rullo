# Prove della 2.4: cadenza (stima dalla velocità, taratura, sensore Bluetooth), nomi ed etichette degli allenamenti importati.
import asyncio, json, os, re
from playwright.async_api import async_playwright
from fontroute import setup

# Rullo come il D100: FTMS con velocità e potenza, SENZA cadenza. Sensore di cadenza CSC a parte.
MOCK = r"""
(() => {
  const cfg = window.__cfg = { kmh: 28, sensorRpm: 80 };
  let mode='idle', target=0, pw=0, connected=false, cadOn=false;
  class Ch extends EventTarget { constructor(u){super();this.uuid=u;this.value=null;}
    async startNotifications(){return this;}
    async readValue(){ if(this.uuid===0x2ACC){const b=new DataView(new ArrayBuffer(8)); b.setUint32(4,(1<<3)|(1<<13),true); return b;}
                       if(this.uuid===0x2AD8){const b=new DataView(new ArrayBuffer(6)); b.setInt16(2,600,true); b.setUint16(4,1,true); return b;} throw new Error('nr'); }
    async writeValueWithResponse(bytes){ const a=[...new Uint8Array(bytes.buffer||bytes)]; if(a[0]===0x05){mode='erg';target=a[1]|(a[2]<<8);}
      setTimeout(()=>{ this.value=new DataView(new Uint8Array([0x80,a[0],1]).buffer); this.dispatchEvent(new Event('characteristicvaluechanged')); },20); } }
  const chars = {}; [0x2AD2,0x2ACC,0x2AD8,0x2AD9,0x2ADA,0x2A5B].forEach(u=>chars[u]=new Ch(u));
  const ftms = { getCharacteristic: async u => { if(chars[u] && u!==0x2A5B) return chars[u]; throw new Error('nf'); } };
  const trainer = new EventTarget(); trainer.name='VANRYSEL-HT-mock';
  trainer.gatt = { connect: async()=>{ connected=true; return { getPrimaryService: async u => { if(u===0x1826) return ftms; throw new Error('no svc'); }, getPrimaryServices: async()=>[{uuid:'00001826-0000-1000-8000-00805f9b34fb'}] }; }, disconnect(){ connected=false; trainer.dispatchEvent(new Event('gattserverdisconnected')); } };
  const csc = { getCharacteristic: async u => { if(u===0x2A5B) return chars[0x2A5B]; throw new Error('nf'); } };
  const sensor = new EventTarget(); sensor.name='CADENCE-mock';
  sensor.gatt = { connect: async()=>{ cadOn=true; return { getPrimaryService: async u => { if(u===0x1816) return csc; throw new Error('no svc'); } }; }, disconnect(){ cadOn=false; sensor.dispatchEvent(new Event('gattserverdisconnected')); } };
  setInterval(()=>{ if(!connected) return; pw += (target-pw)*0.5;
    const b=new DataView(new ArrayBuffer(6)); b.setUint16(0,0x0040,true); b.setUint16(2,Math.round(cfg.kmh*100),true); b.setInt16(4,Math.round(pw),true);
    chars[0x2AD2].value=b; chars[0x2AD2].dispatchEvent(new Event('characteristicvaluechanged')); },250);
  let rev=0, evT=0, base=0, tb=performance.now()/1000, lastRpm=null;
  setInterval(()=>{ if(!cadOn) return; const now=performance.now()/1000;
    if(cfg.sensorRpm!==lastRpm){ base=rev; tb=now; lastRpm=cfg.sensorRpm; }
    const n=Math.floor((now-tb)*cfg.sensorRpm/60);
    if(base+n>rev){ rev=base+n; evT=Math.floor((tb+n*60/cfg.sensorRpm)*1024)&0xFFFF; }
    const c=new DataView(new ArrayBuffer(5)); c.setUint8(0,0x02); c.setUint16(1,rev&0xFFFF,true); c.setUint16(3,evT,true);
    chars[0x2A5B].value=c; chars[0x2A5B].dispatchEvent(new Event('characteristicvaluechanged')); },250);
  Object.defineProperty(navigator,'bluetooth',{value:{ requestDevice: async(o)=> (o.filters[0].services[0]===0x1816 ? sensor : trainer) }});
})();
"""
ok = lambda name, cond, extra='': print(('PASS ' if cond else 'FAIL ') + name + (' ' + str(extra) if extra else ''))
FF = "for(let i=0;i<N;i++){ R.ms+=1000; S.live.lastData=performance.now(); onSecond(); R.sec++; }"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 390, 'height': 800})
        await setup(ctx); await ctx.add_init_script(MOCK)
        pg = await ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto('http://localhost:8765/index.html'); await pg.wait_for_timeout(400)
        await pg.evaluate("document.querySelectorAll('.welcome,.guide').forEach(e=>e.remove()); store.set('welcomed',true); store.set('connectedOnce',true); showView('ride')")

        # --- funzioni di base
        r = await pg.evaluate("""(()=>{ const C=Core, crank=C.makeCscParser(); const mk=(rev,t)=>{const d=new DataView(new ArrayBuffer(5)); d.setUint8(0,2); d.setUint16(1,rev,true); d.setUint16(3,t,true); return d;};
          crank(mk(10,0),0); const a=crank(mk(11,683),700).cadence;
          const w=new DataView(new ArrayBuffer(11)); w.setUint8(0,3); w.setUint32(1,5,true); w.setUint16(5,0,true); w.setUint16(7,12,true); w.setUint16(9,0,true);
          const both=C.makeCscParser(); both(w,0); w.setUint16(7,13,true); w.setUint16(9,1024,true); const b2=both(w,1000).cadence;
          return {a, b2, k34:C.cadFactor(34), k50:C.cadFactor(50), est:C.cadFromSpeed(26.3,C.cadFactor(34)), slow:C.cadFromSpeed(2,3)} })()""")
        ok('sensore CSC: 1 giro in 0,667 s = 90 rpm', abs(r['a'] - 90) < 1, round(r['a'], 1))
        ok('sensore CSC con ruota + pedivella: 60 rpm', abs(r['b2'] - 60) < 1, round(r['b2'], 1))
        ok('stima: 26,3 km/h con corona 34 = circa 86 rpm', abs(r['est'] - 86) < 1.5, round(r['est'], 1))
        ok('stima: sotto 3 km/h vale 0', r['slow'] == 0)
        lab = await pg.evaluate("""(()=>{ const f=150, st=w=>({t:'steady',d:w[0],p:w[1]/f});
          return Core.expand([[600,72],[180,99],[120,125],[60,155],[60,99],[60,154],[300,72],[60,162],[600,71]].map(st)).map(s=>s.label) })()""")
        ok('etichette: riscaldamento all’inizio', lab[0] == 'Riscaldamento' and lab[1] == 'Riscaldamento', lab)
        ok('etichette: defaticamento alla fine', lab[-1] == 'Defaticamento')
        ok('etichette: recupero tra le ripetute', lab[4] == 'Recupero' and lab[6] == 'Recupero')
        ok('etichette: lavoro con il nome della zona', lab[3] == 'Soglia' and lab[7] == 'VO2max')
        pre = await pg.evaluate("Core.expand(PRESETS.find(p=>p.id==='p-ss').blocks).map(s=>s.label)")
        ok('allenamenti pronti: etichette invariate', pre[0] == 'Riscaldamento' and pre[1] == 'Ripetuta 1/3' and pre[-1] == 'Defaticamento', pre)
        nm = await pg.evaluate("""[Core.nameFromFile('2026-11-20_Soglia_3x8.zwo'), Core.nameFromFile('workout.zwo'), Core.nameFromFile('fondo lungo (2).zwo'),
          Core.parseWorkoutFile('<workout_file><name></name><workout><SteadyState Duration="60" Power="0.5"/></workout></workout_file>','2026-11-20_Soglia_3x8.zwo').name,
          Core.parseWorkoutFile('<workout_file><workout><SteadyState Duration="60" Power="0.5"/></workout></workout_file>','').name,
          Core.parseWorkoutFile('<workout_file><name>Medio 2x20</name><workout><SteadyState Duration="60" Power="0.5"/></workout></workout_file>','x.zwo').name]""")
        ok('nome dal file', nm[0] == 'Soglia 3x8' and nm[1] == '' and nm[2] == 'Fondo lungo', nm)
        ok('nome: file senza nome', nm[3] == 'Soglia 3x8' and nm[4] == 'Allenamento del coach' and nm[5] == 'Medio 2x20', nm[3:])

        # --- importazione dal coach: file senza <name>
        fn = os.path.abspath('2026-11-20_Soglia_3x8.zwo')
        open(fn, 'w').write('<workout_file><name></name><sportType>bike</sportType><workout>' + ''.join(f'<SteadyState Duration="{d}" Power="{w/150:.3f}"/>' for d, w in [(600,72),(180,99),(60,155),(60,99),(60,154),(600,71)]) + '</workout></workout_file>')
        await pg.click('.tabs button[data-v="workouts"]'); await pg.click('#wkImport'); await pg.wait_for_timeout(300)
        await pg.set_input_files('#impFile', fn); await pg.wait_for_timeout(700)
        os.remove(fn)
        h2 = await pg.inner_text('.sheet h2'); tbl = await pg.inner_text('.sheet .tbl')
        ok('importato con il nome del file', h2 == 'Soglia 3x8', h2)
        ok('tabella con riscaldamento e defaticamento', 'Riscaldamento' in tbl and 'Defaticamento' in tbl and 'Recupero' in tbl)
        await pg.click('#useW'); await pg.wait_for_timeout(300)

        # --- rullo senza cadenza: stima dalla velocità
        await pg.click('#devTrainer'); await pg.wait_for_timeout(1500)
        cad = await pg.inner_text('#mCad'); lbl = await pg.inner_text('#mCadL')
        exp = round(28 * await pg.evaluate("Core.cadFactor(34)"))
        ok('rpm stimati a 28 km/h', cad == str(exp) and lbl == 'rpm stimati', (cad, lbl, exp))
        await pg.click('#bStart'); await pg.wait_for_timeout(300)
        await pg.evaluate("const N=200;" + FF)
        rec = await pg.evaluate("R.data.c.slice(5,10)")
        ok('cadenza stimata registrata', all(v == exp for v in rec), rec)
        ok('protezione ERG non scatta con la cadenza stimata', await pg.evaluate("R.rescue") is False)
        lg = await pg.evaluate("LOG.join('\\n')")
        ok('registro: fonte della cadenza', 'stimata dalla velocità del rullo (corona 34' in lg)
        await pg.click('#bEnd'); await pg.wait_for_timeout(200); await pg.click('#f1'); await pg.wait_for_timeout(900)
        st = await pg.inner_text('.sheet .stats')
        ok('scheda: rpm medi (stimati)', 'rpm medi (stimati)' in st)
        s = await pg.evaluate("(async()=>{const id=store.get('sessions',[])[0].id; const s=await db.get('s.'+id); const sum=Core.summarize(s,S.profile); return {est:s.cadEst, name:s.name, txt:coachText(s,sum), fit:Array.from(Core.buildFit(s,sum)).length, avgC:sum.avgC}})()")
        ok('sessione: segnata come stimata', s['est'] is True and s['name'] == 'Soglia 3x8', s['name'])
        ok('messaggio coach: cadenza (stimata)', '(stimata)' in s['txt'], s['txt'].split('\n')[4])
        ok('cadenza nel riepilogo', abs(s['avgC'] - exp) < 1, s['avgC'])
        await pg.evaluate("document.querySelectorAll('.sheet-wrap').forEach(e=>e.remove())")

        # --- corona grande: cambia il fattore
        await pg.click('#mCadBox'); await pg.wait_for_timeout(300)
        await pg.fill('#cRing', '50'); await pg.dispatch_event('#cRing', 'change'); await pg.wait_for_timeout(1200)
        cad50 = await pg.inner_text('#mCad'); exp50 = round(28 * await pg.evaluate("Core.cadFactor(50)"))
        ok('corona 50: stima più bassa', cad50 == str(exp50), (cad50, exp50))

        # --- taratura: 45 giri in 30 s a 28 km/h => 90 rpm
        await pg.click('#cCal'); await pg.wait_for_timeout(200); await pg.click('#cGo')
        await pg.wait_for_timeout(31500)
        await pg.fill('#cCnt', '45'); await pg.click('#cOk'); await pg.wait_for_timeout(1300)
        k = await pg.evaluate("S.profile.cadK"); cadT = await pg.inner_text('#mCad')
        ok('taratura salvata', k and abs(k - 90 / 28) < 0.02, k)
        ok('dopo la taratura: 90 rpm', cadT == '90', cadT)
        ok('profilo: taratura ricordata', await pg.evaluate("JSON.parse(localStorage.getItem('rl.profile')).cadK") == k)
        await pg.click('#cCalOff'); await pg.wait_for_timeout(200)
        ok('togli taratura', await pg.evaluate("S.profile.cadK") is None)

        # --- stima spenta
        await pg.click('#cEst'); await pg.wait_for_timeout(1200)
        ok('stima spenta: niente cadenza', await pg.inner_text('#mCad') == '–')
        await pg.click('#cEst'); await pg.wait_for_timeout(200)

        # --- sensore di cadenza: ha la precedenza
        await pg.click('#cSens'); await pg.wait_for_timeout(2500)
        now = await pg.inner_text('#cNow')
        cs = await pg.evaluate("cadNow()")
        ok('sensore collegato: 80 rpm dal sensore', cs['src'] == 'sensor' and abs(cs['v'] - 80) < 3, cs)
        ok('pannello: fonte sensore', 'dal sensore' in now, now)
        ok('riquadro: rpm (non stimati)', await pg.inner_text('#mCadL') == 'rpm')
        await pg.evaluate("document.querySelectorAll('.sheet-wrap').forEach(e=>e.remove()); loadWorkout(''); R.mode='erg'; R.ergW=150")
        await pg.click('#bStart'); await pg.wait_for_timeout(300)
        await pg.evaluate("S.live.lastSensor=performance.now(); const N=30;" + FF)
        ok('con sensore: cadenza misurata registrata', all(abs(v - 80) < 3 for v in await pg.evaluate("R.data.c.slice(3,8)")))
        await pg.evaluate("window.__cfg.sensorRpm=30"); await pg.wait_for_timeout(3000)
        ok('con sensore: la protezione usa la cadenza (30 rpm)', await pg.evaluate("(()=>{ for(let i=0;i<6;i++){ R.ms+=1000; S.live.lastData=performance.now(); onSecond(); R.sec++; } return R.rescue; })()") is True, await pg.evaluate("cadNow()"))
        await pg.evaluate("resetRide()")
        await pg.click('.tabs button[data-v="profile"]'); await pg.wait_for_timeout(300)
        ok('profilo: sezione cadenza', 'Scollega CADENCE-mock' in await pg.inner_text('#pCad'))
        await pg.click('#pCad #cSens'); await pg.wait_for_timeout(300)
        ok('sensore scollegato', await pg.evaluate("S.cadDev") is None and 'Collega sensore' in await pg.inner_text('#pCad'))
        ok('nessun errore JS', not errs, errs)
        await b.close()

asyncio.run(main())
