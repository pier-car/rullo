import asyncio, json
from playwright.async_api import async_playwright
from fontroute import setup
URL='http://localhost:8765/index.html'
FF = "for(let i=0;i<N;i++){ R.ms+=1000; applyControl(); S.trainer.tick(); S.trainer.tick(); S.live.buf=[]; onSecond(); R.sec++; }"
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/opt/pw-browsers/chromium-1243/chrome-linux64/chrome')
        ctx = await b.new_context(viewport={'width':1440,'height':900}, device_scale_factor=1, color_scheme='dark', accept_downloads=True)
        await setup(ctx); pg = await ctx.new_page(); errs=[]
        pg.on('pageerror', lambda e: errs.append(str(e)))
        # legacy data from v1: a session stored in localStorage
        await pg.goto(URL); await pg.wait_for_timeout(400)
        await pg.evaluate("""(()=>{const D={t:[],p:[],c:[],h:[],v:[],d:[],g:[],st:[]};for(let i=0;i<600;i++){D.t.push(i);D.p.push(120);D.c.push(88);D.h.push(130);D.v.push(27);D.d.push(i*7.5);D.g.push(120);D.st.push(null)}
          localStorage.setItem('rl.s.legacy1',JSON.stringify({id:'legacy1',start:Date.now()-86400000,name:'Vecchia pedalata',ftp:150,steps:null,data:D}));
          localStorage.setItem('rl.sessions',JSON.stringify([{id:'legacy1',start:Date.now()-86400000,name:'Vecchia pedalata',dur:600,dist:4500,avgP:120,np:120,tss:6,avgH:130}]));
          localStorage.setItem('rl.welcomed','true')})()""")
        await pg.reload(); await pg.wait_for_timeout(1500)
        print('migrated: in IDB', await pg.evaluate("db.get('s.legacy1').then(s=>!!s&&s.data.t.length)"), '| still in localStorage', await pg.evaluate("!!localStorage.getItem('rl.s.legacy1')"))
        print('sw controller', await pg.evaluate("navigator.serviceWorker.ready.then(r=>!!r.active)"))
        # desktop ride with keyboard
        await pg.evaluate("loadWorkout('p-ss'); connectDemo()"); await pg.wait_for_timeout(600)
        await pg.keyboard.press('Space'); await pg.wait_for_timeout(400)
        print('space -> state', await pg.evaluate("R.state"))
        await pg.evaluate("const N=1300;"+FF); await pg.wait_for_timeout(2500)
        await pg.keyboard.press('ArrowUp'); await pg.wait_for_timeout(300)
        print('arrow up -> offset', await pg.evaluate("R.offset"), '| scroll', await pg.evaluate("document.documentElement.scrollHeight"))
        await pg.screenshot(path='desktop_ride.png')
        await pg.keyboard.press('Space'); await pg.wait_for_timeout(300); print('space -> state', await pg.evaluate("R.state"))
        await pg.click('#bEnd'); await pg.wait_for_timeout(300); await pg.click('#f1'); await pg.wait_for_timeout(1200)
        await pg.screenshot(path='desktop_session.png')
        await pg.evaluate("document.querySelectorAll('.sheet-wrap').forEach(e=>e.remove())")
        # reload: data persists, history lists both
        await pg.reload(); await pg.wait_for_timeout(1200)
        await pg.click('.tabs button[data-v="history"]'); await pg.wait_for_timeout(400)
        print('history cards after reload', await pg.evaluate("document.querySelectorAll('.card.sess').length"))
        await pg.click('.card.sess[data-id="legacy1"]'); await pg.wait_for_timeout(700)
        print('legacy session opens', await pg.evaluate("!!document.querySelector('#sChart')"))
        # FIT download on desktop
        async with pg.expect_download() as di: await pg.click('#shFit')
        d = await di.value; await d.save_as('desktop.fit'); print('download', d.suggested_filename)
        await pg.evaluate("document.querySelectorAll('.sheet-wrap').forEach(e=>e.remove())")
        # backup roundtrip into a clean browser profile
        await pg.click('.tabs button[data-v="profile"]'); await pg.wait_for_timeout(300)
        await pg.screenshot(path='desktop_profile.png', full_page=True)
        async with pg.expect_download() as di: await pg.click('#pExport')
        d = await di.value; await d.save_as('backup.json')
        bk=json.load(open('backup.json')); print('backup sessions', len(bk['sessions']), 'workouts', len(bk['workouts']))
        await pg.click('#pLogShow'); await pg.wait_for_timeout(300)
        log = await pg.evaluate("document.querySelector('.log').textContent"); print('log lines', len(log.splitlines())); print('\n'.join(log.splitlines()[:3]+log.splitlines()[-4:]))
        await pg.evaluate("document.querySelectorAll('.sheet-wrap').forEach(e=>e.remove())")
        # offline reload served by service worker
        await ctx.set_offline(True); await pg.reload(); await pg.wait_for_timeout(1200)
        print('offline reload ok', await pg.evaluate("typeof Core==='object' && !!document.getElementById('pw')"))
        await ctx.set_offline(False)
        ctx2 = await b.new_context(viewport={'width':412,'height':915}, device_scale_factor=2, color_scheme='light', is_mobile=True, has_touch=True, user_agent='Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36')
        await setup(ctx2); p2 = await ctx2.new_page(); p2.on('pageerror', lambda e: errs.append('ctx2 '+str(e)))
        p2.on('dialog', lambda dlg: asyncio.ensure_future(dlg.accept()))
        await p2.goto(URL); await p2.wait_for_timeout(500); await p2.click('#wGo'); await p2.wait_for_timeout(300); await p2.evaluate("document.querySelectorAll('.guide').forEach(e=>e.remove()); showView('profile')")
        await p2.set_input_files('#pImport','backup.json'); await p2.wait_for_timeout(1500)
        print('android import -> sessions', await p2.evaluate("store.get('sessions',[]).length"), 'in idb', await p2.evaluate("db.get('s.legacy1').then(s=>!!s)"))
        await p2.click('.tabs button[data-v="history"]'); await p2.wait_for_timeout(400); await p2.screenshot(path='android_history.png')
        print('errs', errs)
        await b.close()
asyncio.run(main())
