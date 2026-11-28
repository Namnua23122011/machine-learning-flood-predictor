'use strict';
const waterButton=document.getElementById('water-button');
const waterResult=document.getElementById('water-result');
const importFields=['rainfall_24h','rainfall_7day','upstream_rain','ping_level','mae_ngat_storage','soil_moisture_vwc','month','typhoon_active','soil_moisture'];
const readingTitles={rainfall_24h:'ฝนรายวัน',rainfall_7day:'ฝนสะสม 7 วันก่อนหน้า',ping_level:'ระดับน้ำปิง',upstream_rain:'ฝนต้นน้ำ',mae_ngat_storage:'น้ำในเขื่อนแม่งัด',soil_moisture_vwc:'ปริมาณน้ำในดิน 0–1 ซม.',month:'เดือนของข้อมูล',typhoon_active:'มีพายุ',soil_moisture:'ดัชนีความชื้นดินของโมเดล'};
let waterSnapshot=null;
function readingState(key,r,snapshot=waterSnapshot){
 const input=form.elements.namedItem(key);
 const blocked=reason=>({canFill:false,stale:false,message:'ไม่เติมลงช่อง · '+reason});
 if(!Number.isFinite(r.value)||!['fresh','stale'].includes(r.status))return blocked(r.note||'ไม่มีข้อมูลจากผู้ให้บริการ');
 const expectedUnit={soil_moisture_vwc:'m³/m³',soil_moisture:'index_0_1',typhoon_active:'0_or_1',month:'month'}[key];
 if(expectedUnit&&r.unit!==expectedUnit)return blocked('หน่วยไม่ตรงกับช่องนี้');
 const validRange=key==='month'?Number.isInteger(r.value)&&r.value>=1&&r.value<=12:key==='typhoon_active'?[0,1].includes(r.value):['soil_moisture','soil_moisture_vwc'].includes(key)?r.value>=0&&r.value<=1:true;
 if(!validRange||(input.min!==''&&input.min!=null&&r.value<Number(input.min))||(input.max&&r.value>Number(input.max)))return blocked('ค่าอยู่นอกช่วงที่ช่องนี้รับได้');
 const observed=observationDate(r.observed_at).getTime();
 const checked=observationDate(snapshot?.checked_at||snapshot?.fetched_at).getTime();
 const age=((Number.isFinite(checked)?checked:Date.now())-observed)/1000;
 if(!Number.isFinite(age))return blocked('ไม่พบวันเวลารายงานที่ถูกต้อง');
 if(age < -300)return blocked('เวลารายงานอยู่ในอนาคต');
 const maxAge=['month','typhoon_active','soil_moisture'].includes(key)?3600:['mae_ngat_storage','rainfall_24h','rainfall_7day'].includes(key)?48*3600:3*3600;
 const stale=r.status==='stale'||age>maxAge;
 if(stale)return {canFill:true,stale:true,message:'ข้อมูลเก่า · รายงาน '+r.observed_at+' · ตรวจสอบก่อนใช้คำนวณ'};
 return {canFill:true,stale:false,message:'ข้อมูลพร้อมใช้ · รายงาน '+r.observed_at};
}
waterButton.onclick=()=>importMeasurements();
async function importMeasurements(){
 const manualContext={};
 for(const k of ['month','typhoon_active','soil_moisture']){const input=form.elements.namedItem(k);manualContext[k]=input.value!==''&&input.checkValidity()?Number(input.value):null;}
 setMode('manual');const requestGeneration=generation;waterButton.disabled=true;waterResult.textContent=`กำลังดึงข้อมูล ${importFields.length} รายการ…`;waterSnapshot=null;
 const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),90000);
 try{
  const response=await fetch('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_id:crypto.randomUUID(),scope:'all',...manualContext}),signal:abort.signal});
  const data=await response.json().catch(()=>null);
  if(!response.ok)throw new Error('นำเข้าไม่สำเร็จ (HTTP '+response.status+')'+(typeof data?.detail==='string'?': '+data.detail:''));
  if(!data?.readings)throw new Error('API ส่งข้อมูลกลับมาไม่ครบ กรุณาลองใหม่');
  waterSnapshot=data;waterResult.replaceChildren();
  for(const key of importFields){
   const r=data.readings[key]||{};const card=document.createElement('section');card.className='panel';
   const state=readingState(key,r,data);
   const h=document.createElement('h3');h.textContent=readingTitles[key];card.append(h);
   const value=document.createElement('p');value.style='font-size:1.8rem;font-weight:700;margin:12px 0';value.textContent=!Number.isFinite(r.value)?'ไม่มีข้อมูล':key==='typhoon_active'?(r.value===1?'มี':'ไม่มี'):`${r.value.toLocaleString('th-TH',{maximumFractionDigits:3})} ${{month:'เดือน',index_0_1:'ดัชนี 0–1'}[r.unit]||r.unit||''}`;card.append(value);
   for(const text of [state.message,r.station,r.source,r.note]){if(text){const p=document.createElement('p');p.className='hint';p.style.margin='6px 0';p.textContent=text;card.append(p);}}
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
}
function observationDate(value){
 if(typeof value!=='string')return new Date(NaN);
 let time=value.trim().replace(' ','T');
 if(/^\d{4}-\d{2}-\d{2}$/.test(time))time+='T00:00:00';
 if(!/(Z|[+-]\d{2}:?\d{2})$/i.test(time))time+='+07:00';
 return new Date(time);
}
function fillWaterInputs(){
 if(!waterSnapshot)return;let count=0;
 const keys=importFields;const missing=[],stale=[];
 for(const key of keys){
  const r=waterSnapshot.readings[key]||{};
  const input=form.elements.namedItem(key);
  const state=readingState(key,r);
  if(state.canFill){input.value=r.value;count++;if(state.stale)stale.push(readingTitles[key]);}else{input.value='';missing.push(readingTitles[key]);}
  const note=document.getElementById(key+'-import-note');
  if(note){note.textContent=(state.canFill?'นำเข้าแล้ว · ':'')+state.message;note.style.color=state.stale?'#9a4b13':'';}
 }
 const summary=count===0?`ยังนำเข้าข้อมูลไม่ได้ (0/${keys.length} ช่อง) โปรดดูสาเหตุที่ข้อมูลแต่ละแหล่ง`:`เติมข้อมูล ${count}/${keys.length} ช่องแล้ว`;
 clearResult();document.getElementById('example-note').textContent=summary+(stale.length?' · ข้อมูลเก่า: '+stale.join(', '):'')+(missing.length?' · ยังนำเข้าไม่ได้: '+missing.join(', '):'')+' · โปรดตรวจวันที่และหน่วยก่อนคำนวณ';document.getElementById('example-note').hidden=false;
}
