'use strict';
const waterButton=document.getElementById('water-button');
const waterResult=document.getElementById('water-result');
let waterSnapshot=null;
waterButton.onclick=async()=>{
 const manualContext={};
 for(const k of ['month','typhoon_active','soil_moisture']){const input=form.elements.namedItem(k);if(input.value!==''&&!input.checkValidity()){input.reportValidity();return;}manualContext[k]=input.value===''?null:Number(input.value);}
 setMode('manual');const requestGeneration=generation;waterButton.disabled=true;waterResult.textContent='กำลังดึงข้อมูลทั้ง 5 ช่อง…';waterSnapshot=null;
 const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),90000);
 try{
  const response=await fetch('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_id:crypto.randomUUID(),...manualContext}),signal:abort.signal});
  const data=await response.json().catch(()=>null);
  if(!response.ok)throw new Error('นำเข้าไม่สำเร็จ (HTTP '+response.status+')'+(typeof data?.detail==='string'?': '+data.detail:''));
  if(!data?.readings)throw new Error('API ส่งข้อมูลกลับมาไม่ครบ กรุณาลองใหม่');
  waterSnapshot=data;waterResult.replaceChildren();
  const titles={rainfall_24h:'ฝนรายวัน',rainfall_7day:'ฝนสะสม 7 วันก่อนหน้า',ping_level:'ระดับน้ำปิง',upstream_rain:'ฝนต้นน้ำ',mae_ngat_storage:'น้ำในเขื่อนแม่งัด'};
  for(const [key,title] of Object.entries(titles)){
   const r=data.readings[key];const card=document.createElement('section');card.className='panel';
   const h=document.createElement('h3');h.textContent=title;card.append(h);
   const value=document.createElement('p');value.style='font-size:1.8rem;font-weight:700;margin:12px 0';value.textContent=r.value===null?'ไม่มีข้อมูล':`${r.value.toLocaleString('th-TH',{maximumFractionDigits:3})} ${r.unit}`;card.append(value);
   for(const text of [r.status==='fresh'?'ข้อมูลล่าสุดตามรอบรายงาน':r.status==='stale'?'ข้อมูลเก่า — ไม่เติมลงแบบฟอร์ม':'แหล่งข้อมูลไม่พร้อม',r.station,r.observed_at?'วันเวลารายงาน: '+r.observed_at+' (ประเทศไทย)':null,r.source,r.note]){if(text){const p=document.createElement('p');p.className='hint';p.style.margin='6px 0';p.textContent=text;card.append(p);}}
   if(r.retry_after_seconds){const p=document.createElement('p');p.className='hint';p.textContent=`ลองดึงอีกครั้งได้ในประมาณ ${Math.ceil(r.retry_after_seconds/60)} นาที หากยังถูกจำกัดอาจต้องรอให้โควตาของผู้ให้บริการคืนค่า`;card.append(p);}
   if(key==='mae_ngat_storage'&&r.details){const p=document.createElement('p');p.textContent=`ปริมาณน้ำ ${r.details.storage_million_m3} / ความจุปกติ ${r.details.normal_capacity_million_m3} ล้าน ลบ.ม. (ความจุสูงสุด ${r.details.maximum_capacity_million_m3} ล้าน ลบ.ม.)`;card.append(p);}
   waterResult.append(card);
  }
  document.getElementById('water-time').textContent='บันทึกประวัติ #'+data.history_id+' · ดึงจาก API เมื่อ '+new Date(data.fetched_at).toLocaleString('th-TH')+' · แคชสูงสุด 5 นาที';
  if(generation===requestGeneration && mode==='manual')fillWaterInputs();
  else document.getElementById('water-time').textContent+=' · มีการแก้ไขแบบฟอร์มระหว่างรอ จึงไม่เขียนทับค่า กรุณากดดึงอีกครั้ง';
  const historyLink=document.createElement('a');historyLink.href='/history?id='+data.history_id;historyLink.textContent=' ดูรายการนี้และกราฟ';document.getElementById('water-time').append(historyLink);
  if(data.excel_warning){const warning=document.createElement('p');warning.textContent=data.excel_warning;warning.style.color='#a23b16';waterResult.append(warning);}
 }catch(e){waterResult.textContent=e.name==='AbortError'?'หมดเวลารอเซิร์ฟเวอร์ กรุณาดูประวัติก่อนลองอีกครั้ง':e instanceof TypeError?'เชื่อมต่อ API ไม่สำเร็จ กรุณาตรวจอินเทอร์เน็ตและสถานะเซิร์ฟเวอร์ แล้วดูประวัติก่อนลองอีกครั้ง':e.message;document.getElementById('water-time').textContent='';}
 finally{clearTimeout(timer);waterButton.disabled=false;}
};
function observationDate(value){
 if(typeof value!=='string')return new Date(NaN);
 let time=value.trim().replace(' ','T');
 if(/^\d{4}-\d{2}-\d{2}$/.test(time))time+='T00:00:00';
 if(!/(Z|[+-]\d{2}:?\d{2})$/i.test(time))time+='+07:00';
 return new Date(time);
}
function fillWaterInputs(){
 if(!waterSnapshot)return;let count=0;
 for(const key of ['rainfall_24h','rainfall_7day','upstream_rain','ping_level','mae_ngat_storage']){
  const r=waterSnapshot.readings[key];
  const maxAge=['mae_ngat_storage','rainfall_24h','rainfall_7day'].includes(key)?48*3600:3*3600;
  const observed=observationDate(r.observed_at);
  const age=(Date.now()-observed.getTime())/1000;
  const input=form.elements.namedItem(key);
  if(r.status==='fresh'&&Number.isFinite(r.value)&&Number.isFinite(age)&&age>=-300&&age<=maxAge&&!(input.max&&r.value>Number(input.max))){input.value=r.value;count++;}else input.value='';
 }
 const summary=count===0?'ยังนำเข้าข้อมูลล่าสุดไม่ได้ (0/5 ช่อง) โปรดดูสาเหตุที่ข้อมูลแต่ละแหล่ง':`เติมข้อมูลล่าสุด ${count}/5 ช่องแล้ว${count<5?' ช่องที่เหลือไม่มีข้อมูลล่าสุดพร้อมใช้':''}`;
 clearResult();document.getElementById('example-note').textContent=summary+' · เดือน พายุ และความชื้นดินยังเป็นค่าที่คุณกำหนด โปรดตรวจวันที่ของข้อมูลแต่ละแหล่งก่อนคำนวณ';document.getElementById('example-note').hidden=false;
};
