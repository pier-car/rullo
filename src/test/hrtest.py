import asyncio
from playwright.async_api import async_playwright
from fontroute import setup
URL='http://localhost:8765/index.html'
BASE=open('bletest.py').read().split('MOCK = r"""')[1].split('"""')[0]
# mock: trainer (no HR in its data) + a COROS watch exposing the standard Heart Rate service
MOCK=BASE.replace("Object.defineProperty(navigator,'bluetooth',{value:{ requestDevice: async()=>device }});","""
  const hrCh=new EventTarget(); hrCh.startNotifications=async()=>hrCh; let hrOn=false, bpm=118;
  const watch=new EventTarget(); watch.name='COROS PACE 3 A1B2';
  watch.gatt={ connect: async()=>{ hrOn=true; return { getPrimaryService: async u=>{ if(u===0x180D) return { getCharacteristic: async()=>hrCh }; throw new Error('no svc'); } }; }, disconnect(){ hrOn=false; watch.dispatchEvent(new Event('gattserverdisconnected')); } };
  window.__dropWatch=()=>{ hrOn=false; watch.dispatchEvent(new Event('gattserverdisconnected')); };
  setInterval(()=>{ if(!hrOn) return; bpm+= (Math.random()<.5?-1:1); hrCh.value=new DataView(new Uint8Array([0x10,bpm,0x20,0x03]).buffer); hrCh.dispatchEvent(new Event('characteristicvaluechanged')); },1000);
  Object.defineProperty(navigator,'bluetooth',{value:{ requestDevice: async(o)=>{ const wantsHr=o.filters.length===1 && o.filters[0].services[0]===0x180D; if(wantsHr){ if(window.__phoneBusy){const e=new Error('User cancelled the requestDevice() chooser.'); e.name='NotFoundError'; throw e;} return watch; } return device; } }});""")
assert MOCK!=BASE
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/opt/pw-browsers/chromium-1243/chrome-linux64/chrome')
        ctx = await b.new_context(viewport={'width':1366,'height':768}, color_scheme='dark'); await setup(ctx); await ctx.add_init_script(MOCK)
        pg = await ctx.new_page(); errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto(URL); await pg.wait_for_timeout(500); await pg.click('#wGo')
        await pg.evaluate("document.querySelectorAll('.guide').forEach(e=>e.remove()); store.set('connectedOnce',true); showView('ride')")
        await pg.click('#devTrainer'); await pg.wait_for_timeout(1200)
        print('trainer', await pg.evaluate("S.trainerState"), '| bpm before watch:', await pg.inner_text('#mHr'))
        await pg.click('#devHr'); await pg.wait_for_timeout(300)
        print('first tap:', await pg.inner_text('.sheet h2')); await (await pg.query_selector('.sheet')).screenshot(path='coros_sheet.png')
        await pg.evaluate("window.__phoneBusy=true"); await pg.click('#goHr'); await pg.wait_for_timeout(500)
        print('watch busy with phone ->', await pg.inner_text('.sheet h2'))
        await pg.evaluate("window.__phoneBusy=false"); await pg.click('#retryHr'); await pg.wait_for_timeout(2500)
        print('hr state', await pg.evaluate("S.hrState"), '| name', await pg.evaluate("S.hr.name"), '| bpm shown', await pg.inner_text('#mHr'), '| chip', await pg.inner_text('#devHr'))
        await pg.click('#bStart'); await pg.wait_for_timeout(4500)
        print('recorded hr', await pg.evaluate("JSON.stringify(R.data.h)"))
        await pg.evaluate("__dropWatch()"); await pg.wait_for_timeout(400); print('watch dropped ->', await pg.evaluate("S.hrState"))
        await pg.wait_for_timeout(2500); print('auto reconnect ->', await pg.evaluate("S.hrState"), '| ride still', await pg.evaluate("R.state"))
        await pg.click('#bEnd'); await pg.click('#f1'); await pg.wait_for_timeout(900)
        print('summary has cardio:', 'bpm medi' in await pg.inner_text('.sheet'))
        fit = await pg.evaluate("(async()=>{const id=store.get('sessions',[])[0].id; const s=await db.get('s.'+id); return Array.from(Core.buildFit(s, Core.summarize(s,S.profile)))})()")
        open('hr.fit','wb').write(bytes(fit))
        await pg.evaluate("document.querySelectorAll('.sheet-wrap').forEach(e=>e.remove())")
        await pg.click('#devHr'); await pg.wait_for_timeout(300); print('second tap:', await pg.inner_text('.sheet h2'))
        print('errs', errs); await b.close()
asyncio.run(main())
