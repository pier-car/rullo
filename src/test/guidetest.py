import asyncio
from playwright.async_api import async_playwright
from fontroute import setup
URL='http://localhost:8765/index.html'
MOCK=open('bletest.py').read().split('MOCK = r"""')[1].split('"""')[0]
FAIL=MOCK.replace("requestDevice: async()=>device","requestDevice: async()=>{ if(window.__busy){const e=new Error('User cancelled the requestDevice() chooser.'); e.name='NotFoundError'; throw e;} return device; }")
assert FAIL!=MOCK
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/opt/pw-browsers/chromium-1243/chrome-linux64/chrome')
        errs=[]
        # A) Windows laptop with Bluetooth: full guided path, Zwift still open at first
        ctx = await b.new_context(viewport={'width':1366,'height':768}, color_scheme='dark'); await setup(ctx); await ctx.add_init_script(FAIL)
        pg = await ctx.new_page(); pg.on('pageerror', lambda e: errs.append('A '+str(e)))
        await pg.goto(URL); await pg.wait_for_timeout(600)
        await pg.click('#wGo'); await pg.wait_for_timeout(300)
        print('A step1:', await pg.inner_text('.guide h2'), '|', (await pg.inner_text('.g-ok'))[:45])
        await pg.click('[data-go="1"]'); await pg.fill('#gName','Ali'); await pg.fill('#gW','56'); await pg.fill('#gHr','188'); await pg.fill('#gFtp','165')
        await pg.screenshot(path='guide2.png')
        await pg.click('[data-go="2"]'); await pg.wait_for_timeout(200)
        print('A profile saved:', await pg.evaluate("JSON.stringify([S.profile.name,S.profile.weight,S.profile.hrMax,S.profile.ftp])"))
        print('A step3:', await pg.inner_text('.guide h2'))
        await pg.screenshot(path='guide3.png')
        await pg.evaluate("window.__busy=true"); await pg.click('#gConn'); await pg.wait_for_timeout(600)
        print('A zwift open -> warn:', (await pg.inner_text('.g-warn'))[:70], '| extra sheet:', await pg.evaluate("!!document.querySelector('.sheet-wrap')"))
        await pg.evaluate("window.__busy=false"); await pg.click('#gConn'); await pg.wait_for_timeout(2500)
        print('A step4:', await pg.inner_text('.guide h2'), '| watts', await pg.inner_text('#gPw'), '|', await pg.inner_text('#gCtl'))
        await pg.screenshot(path='guide4.png')
        await pg.click('#gEnd'); await pg.wait_for_timeout(300)
        print('A after guide: overlay', await pg.evaluate("!!document.querySelector('.guide')"), 'ride view', await pg.evaluate("!document.getElementById('v-ride').hidden"), 'guided', await pg.evaluate("store.get('guided')"), 'connectedOnce', await pg.evaluate("store.get('connectedOnce')"))
        await pg.click('#bStart'); await pg.wait_for_timeout(3500)
        print('A riding:', await pg.evaluate("R.state"), 'recorded', await pg.evaluate("R.data.t.length"), 'cmds', await pg.evaluate("JSON.stringify(__bleLog.slice(-2))"))
        await pg.reload(); await pg.wait_for_timeout(700)
        print('A reload: welcome again?', await pg.evaluate("!!document.querySelector('.welcome')"))
        await ctx.close()
        # B) first connect from the ride view (guide skipped): Zwift reminder, then failure help, then retry
        ctx = await b.new_context(viewport={'width':1366,'height':768}); await setup(ctx); await ctx.add_init_script(FAIL)
        pg = await ctx.new_page(); pg.on('pageerror', lambda e: errs.append('B '+str(e)))
        await pg.goto(URL); await pg.wait_for_timeout(500); await pg.click('#wGo'); await pg.click('[data-go="1"]'); await pg.click('[data-go="2"]'); await pg.click('[data-go="3"]'); await pg.click('#gEnd'); await pg.wait_for_timeout(200)
        await pg.click('#devTrainer'); await pg.wait_for_timeout(300)
        print('B reminder:', await pg.inner_text('.sheet h2')); await pg.screenshot(path='zwift_sheet.png')
        await pg.evaluate("window.__busy=true"); await pg.click('#goConn'); await pg.wait_for_timeout(500)
        print('B help:', await pg.inner_text('.sheet h2'))
        await pg.evaluate("window.__busy=false"); await pg.click('#retry'); await pg.wait_for_timeout(1500)
        print('B after retry:', await pg.evaluate("S.trainerState"), '| sheets left', await pg.evaluate("document.querySelectorAll('.sheet-wrap').length"))
        await pg.click('#devTrainer'); await pg.wait_for_timeout(300); print('B second tap shows:', await pg.inner_text('.sheet h2'))
        await ctx.close()
        # C) iPhone Safari (no Bluetooth): warning + demo path
        ctx = await b.new_context(viewport={'width':390,'height':763}, device_scale_factor=2, is_mobile=True, has_touch=True, user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'); await setup(ctx)
        pg = await ctx.new_page(); pg.on('pageerror', lambda e: errs.append('C '+str(e)))
        await pg.goto(URL); await pg.wait_for_timeout(500); await pg.click('#wGo'); await pg.wait_for_timeout(200)
        print('C iphone:', (await pg.inner_text('.g-warn'))[:60], '| bluefy mentioned', 'Bluefy' in await pg.inner_text('.guide'))
        await pg.screenshot(path='guide1_iphone.png')
        await pg.click('[data-go="1"]'); await pg.click('[data-go="2"]'); await pg.wait_for_timeout(200)
        print('C scroll fits:', await pg.evaluate("(()=>{const g=document.querySelector('.guide');return g.scrollHeight+' / '+g.clientHeight})()"))
        await pg.screenshot(path='guide3_iphone.png')
        await pg.click('#gDemo'); await pg.wait_for_timeout(300); print('C demo step4:', await pg.inner_text('.guide h2')); await pg.click('#gEnd')
        print('C demo on:', await pg.evaluate("S.trainer.isDemo"))
        print('errs', errs); await b.close()
asyncio.run(main())
