import asyncio, json, re
from playwright.async_api import async_playwright
from fontroute import setup

W = 'https://worker.test'
src = open('../../index.html', encoding='utf-8').read()
assert "const STRAVA = { workerUrl: '', clientId: '' };" in src
open('../../index_t.html', 'w', encoding='utf-8').write(src.replace("const STRAVA = { workerUrl: '', clientId: '' };", f"const STRAVA = {{ workerUrl: '{W}', clientId: '12345' }};"))

MOCK = r"""
(() => {
  const cfg = window.__cfg = { ftmsCad: false, cps: true };
  let mode='idle', target=0, pw=0, connected=false;
  class Ch extends EventTarget { constructor(u){super();this.uuid=u;this.value=null;}
    async startNotifications(){return this;}
    async readValue(){ if(this.uuid===0x2ACC){const b=new DataView(new ArrayBuffer(8)); b.setUint32(4,(1<<3)|(1<<13)|(1<<1),true); return b;}
                       if(this.uuid===0x2AD8){const b=new DataView(new ArrayBuffer(6)); b.setInt16(2,600,true); b.setUint16(4,1,true); return b;} throw new Error('nr'); }
    async writeValueWithResponse(bytes){ const a=[...new Uint8Array(bytes.buffer||bytes)]; if(a[0]===0x05){mode='erg';target=a[1]|(a[2]<<8);}
      setTimeout(()=>{ this.value=new DataView(new Uint8Array([0x80,a[0],1]).buffer); this.dispatchEvent(new Event('characteristicvaluechanged')); },20); } }
  const chars = {}; [0x2AD2,0x2ACC,0x2AD8,0x2AD9,0x2ADA,0x2A63].forEach(u=>chars[u]=new Ch(u));
  const ftms = { uuid:'00001826-0000-1000-8000-00805f9b34fb', getCharacteristic: async u => { if(chars[u]) return chars[u]; throw new Error('nf'); } };
  const cps = { uuid:'00001818-0000-1000-8000-00805f9b34fb', getCharacteristic: async u => { if(u===0x2A63) return chars[0x2A63]; throw new Error('nf'); } };
  const device = new EventTarget(); device.name='VR D100 mock';
  device.gatt = { connect: async()=>{ connected=true; return { getPrimaryService: async u => { if(u===0x1826) return ftms; if(u===0x1818 && cfg.cps) return cps; throw new Error('no svc'); },
                    getPrimaryServices: async()=> cfg.cps ? [ftms,cps] : [ftms] }; }, disconnect(){ connected=false; } };
  let t0=performance.now(), rev=0, lastEv=0, evT=0;
  setInterval(()=>{ if(!connected) return; pw += (target-pw)*0.5;
    let b;
    if(cfg.ftmsCad){ b=new DataView(new ArrayBuffer(9)); b.setUint16(0,0x0244,true); b.setUint16(2,2800,true); b.setUint16(4,176,true); b.setInt16(6,Math.round(pw),true); b.setUint8(8,0); }
    else { b=new DataView(new ArrayBuffer(7)); b.setUint16(0,0x0240,true); b.setUint16(2,2800,true); b.setInt16(4,Math.round(pw),true); b.setUint8(6,0); }
    chars[0x2AD2].value=b; chars[0x2AD2].dispatchEvent(new Event('characteristicvaluechanged'));
    // servizio potenza con cadenza 90 rpm: un evento di pedivella ogni 0,667 s
    const now=(performance.now()-t0)/1000;
    if(now-lastEv>=0.6667){ lastEv=now; rev++; evT=Math.floor(now*1024)&0xFFFF; }
    const c=new DataView(new ArrayBuffer(8)); c.setUint16(0,0x0020,true); c.setInt16(2,Math.round(pw),true); c.setUint16(4,rev&0xFFFF,true); c.setUint16(6,evT,true);
    chars[0x2A63].value=c; chars[0x2A63].dispatchEvent(new Event('characteristicvaluechanged'));
  },250);
  Object.defineProperty(navigator,'bluetooth',{value:{ requestDevice: async()=>device }});
})();
"""

calls = []
state = {'upload': 'ok', 'status_err': None, 'status_calls': 0, 'refresh_calls': 0, 'first401': False}
CORS = {'access-control-allow-origin': '*', 'access-control-allow-headers': 'Authorization, Content-Type', 'access-control-allow-methods': 'GET, POST, OPTIONS'}

async def worker(route):
    r = route.request
    if r.method == 'OPTIONS': return await route.fulfill(status=204, headers=CORS)
    path = r.url.replace(W, '').split('?')[0]
    def js(obj, status=200): return route.fulfill(status=status, headers={**CORS, 'content-type': 'application/json'}, body=json.dumps(obj))
    if path == '/token':
        calls.append(('token', json.loads(r.post_data)))
        return await js({'access_token': 'AT1', 'refresh_token': 'RT1', 'expires_at': 9999999999, 'athlete': {'firstname': 'Giulia', 'lastname': 'Test'}})
    if path == '/refresh':
        state['refresh_calls'] += 1; calls.append(('refresh', json.loads(r.post_data)))
        return await js({'access_token': 'AT2', 'refresh_token': 'RT2', 'expires_at': 9999999999})
    if path == '/upload':
        body = r.post_data_buffer; auth = r.headers.get('authorization')
        calls.append(('upload', auth, len(body or b''), b'.FIT' in (body or b'')[:2000] or b'.FIT' in (body or b'')))
        if state['upload'] == 'abort': return await route.abort('failed')
        if state['upload'] == '401-once' and auth == 'Bearer AT1':
            return await js({'message': 'Authorization Error'}, 401)
        return await js({'id': 4242, 'status': 'Your activity is still being processed.', 'activity_id': None, 'error': None}, 201)
    if path == '/status':
        state['status_calls'] += 1
        if state['status_err']: return await js({'id': 4242, 'error': state['status_err'], 'activity_id': None})
        return await js({'id': 4242, 'status': 'ok', 'activity_id': 999, 'error': None})
    return await js({'error': 'nf'}, 404)

async def fresh(b, mock=False):
    ctx = await b.new_context(viewport={'width': 1280, 'height': 800})
    await setup(ctx); await ctx.route(W + '/**', worker)
    if mock: await ctx.add_init_script(MOCK)
    pg = await ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    return ctx, pg, errs

async def boot(pg, url='http://localhost:8765/index_t.html'):
    await pg.goto(url); await pg.wait_for_timeout(400)
    await pg.evaluate("document.querySelectorAll('.welcome,.guide').forEach(e=>e.remove()); store.set('welcomed',true); store.set('connectedOnce',true)")

SESS = """(async()=>{ const n=400, t=[],p=[],c=[],h=[],v=[],d=[],g=[],st=[];
  for(let i=0;i<n;i++){t.push(i);p.push(100+(i%30));c.push(85);h.push(null);v.push(7);d.push(i*7);g.push(0);st.push(0);}
  const sess={id:'s_test1',start:Date.now()-3600000,name:'Prova sessione',ftp:150,steps:null,rampFtp:null,data:{t,p,c,h,v,d,g,st}};
  await persistSession(sess); return sess.id; })()"""

ok = lambda name, cond, extra='': print(('PASS ' if cond else 'FAIL ') + name + (' ' + str(extra) if extra else ''))

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/opt/pw-browsers/chromium-1243/chrome-linux64/chrome')

        # --- 1) senza configurazione la sezione non si vede
        ctx, pg, errs = await fresh(b)
        await boot(pg, 'http://localhost:8765/index.html'); await pg.evaluate("showView('profile')")
        ok('senza config: sezione Strava nascosta', await pg.evaluate("document.querySelector('#pStrava').closest('.section').hidden") is True)
        ok('versione 2.3', 'Versione 2.3' in await pg.inner_text('#ver'))
        await ctx.close()

        # --- 2) collegamento, sessione recente inviata
        ctx, pg, errs = await fresh(b)
        await boot(pg)
        sid = await pg.evaluate(SESS)
        await pg.evaluate("showView('profile')")
        ok('config: sezione visibile con Collega', await pg.is_visible('#stConnect'))
        await pg.evaluate("store.set('strava.nonce','abc')")
        await pg.goto('http://localhost:8765/index_t.html?state=abc&code=XYZ&scope=read,activity:write'); await pg.wait_for_timeout(300)
        await pg.evaluate("document.querySelectorAll('.welcome,.guide').forEach(e=>e.remove())")
        await pg.wait_for_timeout(6000)
        acct = await pg.evaluate("JSON.stringify(Strava.acct())")
        ok('token salvato', 'AT1' in acct and 'Giulia' in acct, acct)
        ok('url ripulito', 'code=' not in pg.url, pg.url)
        done = await pg.evaluate("JSON.stringify(store.get('strava.done',{}))")
        ok('sessione recente inviata', sid in done and '999' in done, done)
        up = [c for c in calls if c[0] == 'upload']
        ok('upload con file FIT', len(up) == 1 and up[0][2] > 1000 and up[0][3], up)
        await pg.evaluate("showView('history')"); await pg.evaluate(f"openSession('{sid}')"); await pg.wait_for_timeout(600)
        ok('sessione: "Su Strava ✓"', 'Su Strava' in await pg.inner_text('#sStrava'))
        await pg.screenshot(path='v23_session.png')
        await pg.evaluate("document.querySelectorAll('.sheet-wrap').forEach(e=>e.remove()); showView('profile')")
        ok('profilo: collegato come Giulia', 'Giulia' in await pg.inner_text('#pStrava'))
        await pg.screenshot(path='v23_profile.png', full_page=True)

        # stato falsato -> rifiutato
        calls.clear()
        await pg.evaluate("store.set('strava.nonce','giusto')")
        await pg.goto('http://localhost:8765/index_t.html?state=sbagliato&code=ZZZ&scope=read,activity:write'); await pg.wait_for_timeout(1500)
        ok('state diverso: nessun /token', not [c for c in calls if c[0] == 'token'])

        # --- 3) fine allenamento: ERG automatico + invio
        await pg.goto('http://localhost:8765/index_t.html'); await pg.wait_for_timeout(500)
        await pg.evaluate("document.querySelectorAll('.welcome,.guide').forEach(e=>e.remove()); connectDemo(); showView('ride')")
        await pg.wait_for_timeout(600)
        await pg.evaluate("loadWorkout(store.get('workouts',[])[0] ? store.get('workouts',[])[0].id : 'p-ramp')")
        await pg.evaluate("R.wk = R.wk || null")
        wk = await pg.evaluate("!!R.wk")
        await pg.click('#modeSeg button[data-mode="sim"]')
        ok('prima di Avvia: modalità pendenza', await pg.evaluate("R.mode") == 'sim')
        await pg.click('#bStart'); await pg.wait_for_timeout(500)
        ok('Avvia con allenamento: passa a ERG', wk and await pg.evaluate("R.mode") == 'erg', await pg.evaluate("R.mode"))
        log = await pg.evaluate("LOG.join('\\n')")
        ok('registro: cambi di modalità', '→ sim' in log and 'passata a ERG' in log)
        # dati sufficienti e termina
        await pg.evaluate("""(()=>{ const D=R.data; for(let i=D.t.length;i<150;i++){D.t.push(i);D.p.push(120);D.c.push(85);D.h.push(null);D.v.push(7);D.d.push(i*7);D.g.push(0);D.st.push(0);} R.sec=150; })()""")
        calls.clear(); state['upload'] = 'abort'
        await pg.evaluate("saveRide()"); await pg.wait_for_timeout(2500)
        q = await pg.evaluate("JSON.stringify(Strava.queue())")
        ok('rete assente: resta in coda', q != '[]', q)
        state['upload'] = 'ok'; await pg.evaluate("document.querySelectorAll('.sheet-wrap').forEach(e=>e.remove())")
        await pg.evaluate("Strava.sync()"); await pg.wait_for_timeout(5000)
        ok('ritorna la rete: coda vuota e inviato', await pg.evaluate("Strava.queue().length") == 0 and len(await pg.evaluate("Object.keys(store.get('strava.done',{}))")) == 2)

        # --- 4) 401 -> refresh -> riuscito
        calls.clear(); state['upload'] = '401-once'; state['refresh_calls'] = 0
        await pg.evaluate("store.del('strava.done'); const a=Strava.acct(); a.access='AT1'; a.exp=9999999999; store.set('strava',a); store.set('strava.q',['s_test1'])")
        await pg.evaluate("Strava.sync()"); await pg.wait_for_timeout(5000)
        ok('401: rinnovo token e invio', state['refresh_calls'] == 1 and 's_test1' in await pg.evaluate("JSON.stringify(store.get('strava.done',{}))"), state)

        # --- 5) duplicato
        state['upload'] = 'ok'; state['status_err'] = '2026-11-18_x.fit duplicate of activity 555'
        await pg.evaluate("store.del('strava.done'); store.set('strava.q',['s_test1'])")
        await pg.evaluate("Strava.sync()"); await pg.wait_for_timeout(3500)
        d = await pg.evaluate("JSON.stringify(store.get('strava.done',{}))")
        ok('duplicato: segnato come già presente', '"dup":true' in d and '555' in d, d)
        state['status_err'] = None

        # --- 6) scollega
        await pg.evaluate("showView('profile')")
        pg.on('dialog', lambda dlg: asyncio.ensure_future(dlg.accept()))
        await pg.click('#stOff'); await pg.wait_for_timeout(300)
        ok('scollegato: torna Collega', await pg.is_visible('#stConnect'))
        ok('nessun errore JS', not errs, errs)
        await ctx.close()

        # --- 7) Bluetooth: cadenza solo da servizio potenza + registro grezzo
        ctx, pg, errs = await fresh(b, mock=True)
        await boot(pg); await pg.evaluate("showView('ride')")
        await pg.click('#devTrainer'); await pg.wait_for_timeout(1000)
        await pg.evaluate("document.querySelectorAll('.sheet-wrap').forEach(e=>e.remove())")
        await pg.wait_for_timeout(3500)
        cad = await pg.evaluate("S.live.cad")
        ok('cadenza dal servizio potenza (~90)', cad and 70 < cad < 120, cad)
        log = await pg.evaluate("LOG.join('\\n')")
        ok('registro: servizi', 'servizi: 1826, 1818' in log, [l for l in log.split('\\n') if 'servizi' in l])
        ok('registro: primo pacchetto', 'primo pacchetto dati: 40 02' in log)
        ok('registro: CPS con cadenza', 'servizio potenza (CPS) presente' in log and 'cadenza sì' in log)
        # con cadenza nel flusso principale vince quella
        await pg.evaluate("__cfg.ftmsCad = true"); await pg.wait_for_timeout(1500)
        ok('con FTMS cadenza: valore 88', abs(await pg.evaluate("S.live.cad") - 88) < 6, await pg.evaluate("S.live.cad"))
        ok('nessun errore JS (BLE)', not errs, errs)
        await ctx.close()
        await b.close()
asyncio.run(main())
