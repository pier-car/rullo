const C = require('../core.js'); const fs=require('fs'); const assert=require('assert');
// Indoor bike data: flags speed(present) + cadence + power + hr => bits 2,6,9 = 0x0244
const b=new Uint8Array([0x44,0x02, 0xC4,0x09, 0xB4,0x00, 0x96,0x00, 0x8A]); // 25.00 km/h, cad 90, 150W, hr 138
const r=C.parseIndoorBikeData(new DataView(b.buffer)); console.log(r);
assert.deepStrictEqual(r,{speed:25,cadence:90,power:150,hr:138});
// More data bit set -> no speed
const b2=new Uint8Array([0x41,0x00,0x2C,0x01]); assert.deepStrictEqual(C.parseIndoorBikeData(new DataView(b2.buffer)),{power:300});
// distance + resistance
const b3=new Uint8Array([0x74,0x00, 0x10,0x27, 0xA0,0x00, 0x10,0x27,0x00, 0x05,0x00, 0xC8,0x00]);
console.log(C.parseIndoorBikeData(new DataView(b3.buffer)));
assert.strictEqual(C.parseHeartRate(new DataView(new Uint8Array([0,72]).buffer)),72);
assert.strictEqual(C.parseHeartRate(new DataView(new Uint8Array([1,0x2c,0x01]).buffer)),300);
console.log([...C.cmd.targetPower(250)], [...C.cmd.sim(-2.5)]);
// cps
const cps=C.makeCpsParser(); const mk=(p,rev,t)=>{const a=new Uint8Array(8);const d=new DataView(a.buffer);d.setUint16(0,0x20,true);d.setInt16(2,p,true);d.setUint16(4,rev,true);d.setUint16(6,t,true);return d;};
cps(mk(200,10,0),0); console.log('cps',cps(mk(200,11,683),700)); // 1 rev in 0.667s=90rpm
// ZWO
const zwo=`<workout_file><name>Soglia coach</name><workout>
<Warmup Duration="600" PowerLow="0.45" PowerHigh="0.75"/>
<IntervalsT Repeat="3" OnDuration="480" OffDuration="240" OnPower="1.0" OffPower="0.55" Cadence="90"/>
<SteadyState Duration="300" Power="0.65"><textevent timeoffset="10" message="ciao"/></SteadyState>
<FreeRide Duration="120" FlatRoad="1"/>
<Cooldown Duration="300" PowerLow="0.6" PowerHigh="0.4"/></workout></workout_file>`;
const w=C.parseZwo(zwo); const st=C.expand(w.blocks); console.log(w.name, st.length, C.totalDur(st), st.map(s=>s.label).join('|'));
assert.strictEqual(C.totalDur(st),600+3*720+300+120+300);
console.log('est',C.estimate(st,200));
const mrc=`[COURSE HEADER]\nVERSION = 2\nDESCRIPTION = Test MRC\nMINUTES PERCENT\n[END COURSE HEADER]\n[COURSE DATA]\n0 50\n10 75\n10 100\n15 100\n15 50\n20 50\n[END COURSE DATA]`;
const m=C.parseWorkoutFile(mrc,'a.mrc'); console.log(m);
const erg=`[COURSE HEADER]\nMINUTES WATTS\n[END COURSE HEADER]\n[COURSE DATA]\n0\t100\n5\t100\n5\t200\n6\t200\n[END COURSE DATA]`;
console.log(JSON.stringify(C.parseWorkoutFile(erg,'x.erg')));
// session synthetic with pause and laps
const start=Date.UTC(2026,10,7,18,0,0); const D={t:[],p:[],c:[],h:[],v:[],d:[],g:[],st:[]}; let dist=0;
for(let i=0;i<3600;i++){ const t = i<1800? i : i+60; const p=150+60*Math.sin(i/60)+(i%7); const v=28+p/50; dist+=v/3.6;
 D.t.push(t);D.p.push(Math.round(p));D.c.push(88);D.h.push(120+Math.round(i/100));D.v.push(Math.round(v*10)/10);D.d.push(Math.round(dist*10)/10);D.g.push(150);D.st.push(Math.floor(i/600)); }
const sess={start,ftp:200,data:D,steps:Array.from({length:6},(_,i)=>({label:'Step '+i}))};
const s=C.summarize(sess,{ftp:200,hrMax:190}); console.log(JSON.stringify({...s,laps:s.laps.length}));
fs.writeFileSync('test.fit',Buffer.from(C.buildFit(sess,s)));
