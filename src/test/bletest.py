import asyncio, json
from playwright.async_api import async_playwright
from fontroute import setup
MOCK = r"""
(() => {
  const log = window.__bleLog = [];
  let mode='idle', target=0, grade=0, pw=0, connected=false;
  class Ch extends EventTarget { constructor(uuid){super();this.uuid=uuid;this.value=null;}
    async startNotifications(){ return this; }
    async readValue(){ if(this.uuid===0x2ACC){const b=new DataView(new ArrayBuffer(8)); b.setUint32(0,0x4086,true); b.setUint32(4,(1<<3)|(1<<13)|(1<<1),true); return b;}
                       if(this.uuid===0x2AD8){const b=new DataView(new ArrayBuffer(6)); b.setInt16(0,0,true); b.setInt16(2,600,true); b.setUint16(4,1,true); return b;} throw new Error('nr'); }
    async writeValueWithResponse(bytes){ if(!connected) throw new Error('GATT disconnected'); const a=[...new Uint8Array(bytes.buffer||bytes)]; log.push(a);
      if(a[0]===0x05){mode='erg'; target=a[1]|(a[2]<<8);} if(a[0]===0x11){mode='sim'; grade=new DataView(new Uint8Array(a).buffer).getInt16(3,true)/100;}
      setTimeout(()=>{ const r=new DataView(new Uint8Array([0x80,a[0],1]).buffer); this.value=r; this.dispatchEvent(new Event('characteristicvaluechanged')); },20); }
  }
  const chars = {}; [0x2AD2,0x2ACC,0x2AD8,0x2AD9,0x2ADA].forEach(u=>chars[u]=new Ch(u));
  // Event.target must be the characteristic: dispatching on it does that.
  const svc = { getCharacteristic: async u => { if(chars[u]) return chars[u]; throw new Error('nf'); } };
  const device = new EventTarget(); device.name='VR D100 mock';
  device.gatt = { connect: async()=>{ connected=true; return { getPrimaryService: async u => { if(u===0x1826) return svc; throw new Error('no svc'); } }; },
                  disconnect(){ connected=false; device.dispatchEvent(new Event('gattserverdisconnected')); } };
  window.__dropLink = () => { connected=false; device.dispatchEvent(new Event('gattserverdisconnected')); };
  setInterval(()=>{ if(!connected) return; const want = mode==='erg'? target : 90+grade*25; pw += (want-pw)*0.5;
     const b=new DataView(new ArrayBuffer(9)); b.setUint16(0,0x0244,true); b.setUint16(2,2800,true); b.setUint16(4,176,true); b.setInt16(6,Math.round(pw),true); b.setUint8(8,0);
     const c=chars[0x2AD2]; c.value=b; c.dispatchEvent(new Event('characteristicvaluechanged')); },250);
  Object.defineProperty(navigator,'bluetooth',{value:{ requestDevice: async()=>device }});
})();
"""
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/opt/pw-browsers/chromium-1243/chrome-linux64/chrome')
        ctx = await b.new_context(viewport={'width':390,'height':763}, device_scale_factor=2, color_scheme='light')
        await setup(ctx); await ctx.add_init_script(MOCK)
        pg = await ctx.new_page(); errs=[]
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto('http://localhost:8765/index.html'); await pg.wait_for_timeout(300); await pg.click('#wGo'); await pg.evaluate("document.querySelectorAll('.guide').forEach(e=>e.remove()); store.set('connectedOnce',true); showView('ride')"); await pg.wait_for_timeout(500)
        await pg.click('#devTrainer'); await pg.wait_for_timeout(800)
        print('state', await pg.evaluate("S.trainerState"), 'canControl', await pg.evaluate("S.trainer.canControl"), 'range', await pg.evaluate("JSON.stringify(S.trainer.range)"))
        await pg.wait_for_timeout(1500)
        print('live', await pg.evaluate("JSON.stringify({p:livePower(),c:S.live.cad,v:S.live.speed})"))
        await pg.click('#bStart'); await pg.wait_for_timeout(1500)
        for _ in range(3): await pg.click('[data-erg="10"]')
        await pg.wait_for_timeout(1500)
        print('log after +30', await pg.evaluate("JSON.stringify(__bleLog)"))
        await pg.click('#modeSeg button[data-mode="sim"]'); await pg.click('[data-grade="0.5"]'); await pg.click('[data-gear="1"]'); await pg.wait_for_timeout(800)
        print('sim cmd', await pg.evaluate("JSON.stringify(__bleLog.slice(-1))"), 'grade', await pg.evaluate("simGrade()"))
        await pg.click('#modeSeg button[data-mode="erg"]'); await pg.wait_for_timeout(500)
        n0 = await pg.evaluate("__bleLog.length")
        await pg.evaluate("__dropLink()"); await pg.wait_for_timeout(300)
        print('after drop', await pg.evaluate("S.trainerState"))
        await pg.wait_for_timeout(2500)
        print('after reconnect', await pg.evaluate("S.trainerState"), await pg.evaluate(f"JSON.stringify(__bleLog.slice({n0}))"))
        await pg.screenshot(path='light_ride.png')
        print('recorded', await pg.evaluate("R.data.t.length"), 'p sample', await pg.evaluate("JSON.stringify(R.data.p.slice(-5))"))
        print('errs', errs)
        await b.close()
asyncio.run(main())
