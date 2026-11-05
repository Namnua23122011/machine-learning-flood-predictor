'use strict';
const waterButton=document.getElementById('water-button');
const waterResult=document.getElementById('water-result');
let waterSnapshot=null;
waterButton.onclick=async()=>{
 const manualContext={};
 for(const k of ['month','typhoon_active','soil_moisture']){const input=form.elements.namedItem(k);if(input.value!==''&&!input.checkValidity()){input.reportValidity();return;}manualContext[k]=input.value===''?null:Number(input.value);}
 setMode('manual');const requestGeneration=generation;waterButton.disabled=true;waterResult.textContent='กำลังดึงข้อมูลทั้ง 5 ช่อง…';waterSnapshot=null;
 const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),30000);
 try{
  const response=await fetch('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_id:crypto.randomUUID(),...manualContext}),signal:abort.signal});if(!response.ok)throw new Error('API ไม่พร้อมใช้งาน');
  const data=await response.json();waterSnapshot=data;waterResult.replaceChildren();
  const titles={rainfall_24h:'ฝนรายวัน',rainfall_7day:'ฝนสะสม 7 วันก่อนหน้า',ping_level:'ระดับน้ำปิง',upstream_rain:'ฝนต้นน้ำ',mae_ngat_storage:'น้ำในเขื่อนแม่งัด'};
  for(const [key,title] of Object.entries(titles)){
   const r=data.readings[key];const card=document.createElement('section');card.className='panel';
   const h=document.createElement('h3');h.textContent=title;card.append(h);
   const value=document.createElement('p');value.style='font-size:1.8rem;font-weight:700;margin:12px 0';value.textContent=r.value===null?'ไม่มีข้อมูล':`${r.value.toLocaleString('th-TH',{maximumFractionDigits:3})} ${r.unit}`;card.append(value);
   for(const text of [r.status==='fresh'?'ข้อมูลล่าสุดตามรอบรายงาน':r.status==='stale'?'ข้อมูลเก่า — ไม่เติมลงแบบฟอร์ม':'แหล่งข้อมูลไม่พร้อม',r.station,r.observed_at?'วันเวลารายงาน: '+r.observed_at+' (ประเทศไทย)':null,r.source,r.note]){if(text){const p=document.createElement('p');p.className='hint';p.style.margin='6px 0';p.textContent=text;card.append(p);}}
   if(key==='mae_ngat_storage'&&r.details){const p=document.createElement('p');p.textContent=`ปริมาณน้ำ ${r.details.storage_million_m3} / ความจุปกติ ${r.details.normal_capacity_million_m3} ล้าน ลบ.ม. (ความจุสูงสุด ${r.details.maximum_capacity_million_m3} ล้าน ลบ.ม.)`;card.append(p);}
   waterResult.append(card);
  }
  document.getElementById('water-time').textContent='บันทึกประวัติ #'+data.history_id+' · ดึงจาก API เมื่อ '+new Date(data.fetched_at).toLocaleString('th-TH')+' · แคชสูงสุด 5 นาที';
  if(generation===requestGeneration && mode==='manual')fillWaterInputs();
  else document.getElementById('water-time').textContent+=' · มีการแก้ไขแบบฟอร์มระหว่างรอ จึงไม่เขียนทับค่า กรุณากดดึงอีกครั้ง';
  const historyLink=document.createElement('a');historyLink.href='/history?id='+data.history_id;historyLink.textContent=' ดูรายการนี้และกราฟ';document.getElementById('water-time').append(historyLink);
  if(data.excel_warning){const warning=document.createElement('p');warning.textContent=data.excel_warning;warning.style.color='#a23b16';waterResult.append(warning);}
 }catch(e){waterResult.textContent=e.name==='AbortError'?'หมดเวลารอ กรุณาลองใหม่':'นำเข้าหรือบันทึกไม่สำเร็จ กรุณาตรวจว่า app.py ทำงานอยู่ และดูประวัติก่อนลองอีกครั้ง';document.getElementById('water-time').textContent='';}
 finally{clearTimeout(timer);waterButton.disabled=false;}
};
function fillWaterInputs(){
 if(!waterSnapshot)return;let count=0;
 for(const key of ['rainfall_24h','rainfall_7day','upstream_rain','ping_level','mae_ngat_storage']){
  const r=waterSnapshot.readings[key];
  const maxAge=['mae_ngat_storage','rainfall_24h','rainfall_7day'].includes(key)?48*3600:3*3600;
  const time=r.observed_at;
  const observed=time?new Date(time.length===10?time+'T00:00:00+07:00':time.replace(' ','T')+':00+07:00'):new Date(NaN);
  const age=(Date.now()-observed.getTime())/1000;
  const input=form.elements.namedItem(key);
  if(r.status==='fresh'&&Number.isFinite(age)&&age>=-300&&age<=maxAge&&!(input.max&&r.value>Number(input.max))){input.value=r.value;count++;}else input.value='';
 }
 clearResult();document.getElementById('example-note').textContent=`เติมข้อมูลล่าสุด ${count}/5 ช่องแล้ว เดือน พายุ และความชื้นดินยังเป็นค่าที่คุณกำหนด โปรดตรวจวันที่ของข้อมูลแต่ละแหล่งก่อนคำนวณ`;document.getElementById('example-note').hidden=false;
};
