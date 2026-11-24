# Prove 2.4: su iPhone senza Bluetooth l'app consiglia Bluefy (banner, guida, pulsante del rullo).
import asyncio
from playwright.async_api import async_playwright
from fontroute import setup
IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
ok = lambda name, cond, extra='': print(('PASS ' if cond else 'FAIL ') + name + (' ' + str(extra) if extra else ''))
URL = 'http://localhost:8765/index.html'

async def page(b, ua=None, bt=False):
    ctx = await b.new_context(viewport={'width': 390, 'height': 800}, is_mobile=True, has_touch=True, **({'user_agent': ua} if ua else {}))
    await setup(ctx)
    await ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin='http://localhost:8765')
    if bt: await ctx.add_init_script("Object.defineProperty(navigator,'bluetooth',{value:{requestDevice:async()=>{throw Object.assign(new Error('x'),{name:'NotFoundError'})}}})")
    pg = await ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    return ctx, pg, errs

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        # 1) iPhone con Safari: guida al primo avvio
        ctx, pg, errs = await page(b, IPHONE)
        await pg.goto(URL); await pg.wait_for_timeout(400); await pg.click('#wGo'); await pg.wait_for_timeout(300)
        g = await pg.inner_text('.guide')
        ok('guida: Bluefy consigliata', 'Bluefy' in g and 'Copia indirizzo' in g, g[:80])
        href = await pg.get_attribute('.guide a[href*="apps.apple.com"]', 'href')
        ok('guida: link App Store', href == 'https://apps.apple.com/app/id1492822055', href)
        await pg.click('.guide [data-copy-url]'); await pg.wait_for_timeout(200)
        clip = await pg.evaluate("navigator.clipboard.readText()")
        ok('copia indirizzo', clip == 'http://localhost:8765/', clip)
        ok('pulsante: Copiato', 'Copiato' in await pg.inner_text('.guide [data-copy-url]'))
        await ctx.close()
        # 2) iPhone con Safari, già guidata: banner e foglio
        ctx, pg, errs = await page(b, IPHONE)
        await pg.goto(URL); await pg.wait_for_timeout(200)
        await pg.evaluate("store.set('welcomed',true); store.set('guided',true)"); await pg.reload(); await pg.wait_for_timeout(500)
        ban = await pg.inner_text('#banner')
        ok('banner Bluefy all’avvio', 'Bluefy' in ban and not await pg.evaluate("$('banner').hidden"), ban)
        await pg.click('#banner'); await pg.wait_for_timeout(300)
        ok('tocco sul banner: istruzioni', 'Su iPhone usa Bluefy' in await pg.inner_text('.sheet'))
        await pg.evaluate("document.querySelectorAll('.sheet-wrap').forEach(e=>e.remove())")
        await pg.click('#devTrainer'); await pg.wait_for_timeout(300)
        ok('Collega rullo: istruzioni Bluefy', 'Su iPhone usa Bluefy' in await pg.inner_text('.sheet'))
        await pg.click('#bfDemo'); await pg.wait_for_timeout(800)
        ok('demo da iPhone', await pg.evaluate("!!(S.trainer && S.trainer.isDemo)"))
        ok('registro: Bluefy consigliata', 'consigliata Bluefy' in await pg.evaluate("LOG.join('\\n')"))
        ok('nessun errore JS (iPhone)', not errs, errs)
        await ctx.close()
        # 3) iPhone dentro Bluefy (Bluetooth presente): niente banner
        ctx, pg, errs = await page(b, IPHONE, bt=True)
        await pg.goto(URL); await pg.wait_for_timeout(200)
        await pg.evaluate("store.set('welcomed',true); store.set('guided',true)"); await pg.reload(); await pg.wait_for_timeout(500)
        ok('Bluefy: nessun banner', await pg.evaluate("$('banner').hidden"))
        await ctx.close()
        # 4) computer senza Bluetooth (es. Safari su Mac): consiglio Chrome
        ctx, pg, errs = await page(b)
        await pg.goto(URL); await pg.wait_for_timeout(200)
        await pg.evaluate("store.set('welcomed',true); store.set('guided',true)"); await pg.reload(); await pg.wait_for_timeout(500)
        ok('computer: nessun banner iPhone', await pg.evaluate("$('banner').hidden"))
        await pg.click('#devTrainer'); await pg.wait_for_timeout(300)
        t = await pg.inner_text('.sheet')
        ok('computer: consiglia Chrome', 'Chrome' in t and 'Bluetooth non disponibile' in t)
        await ctx.close()
        await b.close()
asyncio.run(main())
