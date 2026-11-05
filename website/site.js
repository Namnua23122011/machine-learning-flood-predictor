'use strict';
const $=id=>document.getElementById(id);
const form=$('prediction-form');
const names=['month','rainfall_24h','rainfall_7day','upstream_rain','ping_level','mae_ngat_storage','soil_moisture','typhoon_active'];
let mode='manual',generation=0,controller=null;
function clearResult(){ $('probability').textContent='—';$('fill').style.width='0%';$('status').textContent='ยังไม่มีผลทำนาย';$('detail').textContent='กรอกข้อมูลให้ครบก่อนคำนวณ';$('error').hidden=true; }
function showResult(data,note){const percent=data.probability*100;$('probability').textContent=(percent>0&&percent<0.01?'<0.01':percent<100&&percent>99.99?'>99.99':percent.toFixed(2))+'%';$('fill').style.width=percent+'%';$('status').textContent=data.prediction===1?'โมเดลจัดประเภท: น้ำท่วม':'โมเดลจัดประเภท: ไม่ท่วม';$('detail').textContent=note;}
function capture(){return Object.fromEntries(names.map(n=>[n,form.elements.namedItem(n).value]));}
function fill(values){for(const n of names)form.elements.namedItem(n).value=values[n]??'';}
function setMode(){generation++;controller?.abort();mode='manual';clearResult();$('submit-button').disabled=false;$('example-note').hidden=true;}
async function requestJSON(url,options={}){controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),25000);try{const r=await fetch(url,{...options,signal:controller.signal});const data=await r.json();if(!r.ok)throw new Error(Array.isArray(data.detail)?data.detail.map(e=>e.loc.slice(1).join('.')+': '+e.msg).join('; '):data.detail||'ไม่สามารถดึงข้อมูลได้');return data;}finally{clearTimeout(timeout);}}
form.addEventListener('input',()=>{generation++;controller?.abort();clearResult();$('submit-button').disabled=false;});
$('example-button').onclick=()=>{generation++;controller?.abort();fill({month:9,rainfall_24h:45,rainfall_7day:180,upstream_rain:60,ping_level:3.2,mae_ngat_storage:75,soil_moisture:0.6,typhoon_active:0});clearResult();$('submit-button').disabled=false;$('example-note').textContent='ข้อมูลตัวอย่างเท่านั้น ไม่ใช่สถานการณ์ปัจจุบัน';$('example-note').hidden=false;};
form.onsubmit=async event=>{event.preventDefault();if(mode!=='manual'||!form.reportValidity())return;const token=++generation;const payload=Object.fromEntries(Object.entries(capture()).map(([k,v])=>[k,Number(v)]));clearResult();$('submit-button').disabled=true;$('status').textContent='กำลังคำนวณ…';try{const data=await requestJSON('/predict',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});if(token===generation)showResult(data,'คำนวณจากค่าที่กำหนดเอง');}catch(err){if(token===generation){clearResult();$('error').textContent=err.name==='AbortError'?'หมดเวลารอผล กรุณาลองใหม่':err.message;$('error').hidden=false;}}finally{if(token===generation)$('submit-button').disabled=false;}};
