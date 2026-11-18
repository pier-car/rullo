import asyncio
from playwright.async_api import async_playwright
from fontroute import setup
MOCK=open('bletest.py').read().split('MOCK = r"""')[1].split('"""')[0].replace("b.setUint16(0,0x0244,true)","b.setUint16(0,0x0240,true)").replace("b.setUint16(4,176,true); b.setInt16(6,Math.round(pw),true)","b.setInt16(4,Math.round(pw),true)").replace("const want = mode==='erg'? target : 90+grade*25;","const want = window.__stop? 0 : (mode==='erg'? target : 90+grade*25);")
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/opt/pw-browsers/chromium-1243/chrome-linux64/chrome')
        ctx = await b.new_context(viewport={'width':390,'height':763}); await setup(ctx); await ctx.add_init_script(MOCK)
        pg = await ctx.new_page(); errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto('http://localhost:8765/index.html'); await pg.wait_for_timeout(300); await pg.click('#wGo'); await pg.evaluate("document.querySelectorAll('.guide').forEach(e=>e.remove()); store.set('connectedOnce',true); showView('ride')"); await pg.wait_for_timeout(400)
        await pg.click('#devTrainer'); await pg.wait_for_timeout(1000)
        await pg.click('#bStart'); await pg.wait_for_timeout(7000)
        print('pedaling: rescue', await pg.evaluate("R.rescue"), 'cad rec', await pg.evaluate("JSON.stringify(R.data.c.slice(-3))"), 'cadSeen', await pg.evaluate("!!S.live.cadSeen"))
        await pg.evaluate("window.__stop=true"); await pg.wait_for_timeout(7000)
        print('stopped: rescue', await pg.evaluate("R.rescue"), 'last cmd', await pg.evaluate("JSON.stringify(__bleLog.slice(-1))"))
        await pg.evaluate("window.__stop=false"); await pg.wait_for_timeout(6000)
        print('resumed: rescue', await pg.evaluate("R.rescue"), 'last cmd', await pg.evaluate("JSON.stringify(__bleLog.slice(-1))"))
        print(errs); await b.close()
asyncio.run(main())
