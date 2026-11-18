import asyncio
from playwright.async_api import async_playwright
from fontroute import setup
FF = "for(let i=0;i<N;i++){ R.ms+=1000; applyControl(); S.trainer.tick(); S.trainer.tick(); S.live.buf=[]; onSecond(); R.sec++; }"
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/opt/pw-browsers/chromium-1243/chrome-linux64/chrome')
        ctx = await b.new_context(viewport={'width':390,'height':763}, device_scale_factor=2, color_scheme='dark', is_mobile=True, has_touch=True)
        await setup(ctx); pg = await ctx.new_page(); errs=[]
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto('http://localhost:8765/index.html'); await pg.wait_for_timeout(300); await pg.click('#wGo'); await pg.evaluate("document.querySelectorAll('.guide').forEach(e=>e.remove()); store.set('connectedOnce',true); showView('ride')"); await pg.wait_for_timeout(500)
        # import coach file
        await pg.click('.tabs button[data-v="workouts"]'); await pg.click('#wkImport'); await pg.wait_for_timeout(300)
        await pg.set_input_files('#impFile','zwo_test.zwo'); await pg.wait_for_timeout(800)
        await (await pg.query_selector('.sheet')).screenshot(path='wk_detail.png')
        await pg.click('#useW'); await pg.wait_for_timeout(300)
        await pg.evaluate("connectDemo()"); await pg.click('#bStart')
        await pg.evaluate("const N=2900;"+FF)
        await pg.click('#bEnd'); await pg.wait_for_timeout(300); await pg.click('#f1'); await pg.wait_for_timeout(900)
        sh = await pg.query_selector('.sheet')
        await pg.evaluate("document.querySelector('.sheet').style.maxHeight='none'")
        await pg.set_viewport_size({'width':390,'height':2600}); await pg.wait_for_timeout(400)
        await sh.screenshot(path='session_full.png')
        await pg.set_viewport_size({'width':390,'height':763})
        await pg.evaluate("document.querySelectorAll('.sheet-wrap').forEach(e=>e.remove())")
        await pg.click('.tabs button[data-v="history"]'); await pg.wait_for_timeout(300); await pg.screenshot(path='history.png')
        await pg.click('.tabs button[data-v="workouts"]'); await pg.wait_for_timeout(400); await pg.screenshot(path='workouts.png')
        await pg.click('#wkNew'); await pg.wait_for_timeout(500); await pg.click('[data-add="int"]'); await pg.wait_for_timeout(300)
        await (await pg.query_selector('.sheet')).screenshot(path='builder.png')
        await pg.evaluate("document.querySelectorAll('.sheet-wrap').forEach(e=>e.remove())")
        await pg.click('.tabs button[data-v="profile"]'); await pg.wait_for_timeout(300); await pg.screenshot(path='profile.png')
        # FIT export validity from stored session
        fit = await pg.evaluate("(async()=>{const id=store.get('sessions',[])[0].id; const s=await db.get('s.'+id); return [Array.from(Core.buildFit(s, Core.summarize(s,S.profile))), db.usingIdb, !!localStorage.getItem('rl.s.'+id)]})()")
        open('app_export.fit','wb').write(bytes(fit[0])); print('idb',fit[1],'legacy copy in localStorage',fit[2])
        print('errs', errs)
        await b.close()
asyncio.run(main())
