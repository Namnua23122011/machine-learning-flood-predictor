'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const date = value => new Intl.DateTimeFormat('th-TH', {timeZone:'Asia/Bangkok', day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value));
  const shortDate = value => new Intl.DateTimeFormat('th-TH', {timeZone:'Asia/Bangkok',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(value));
  const numeric = value => typeof value === 'number' && Number.isFinite(value);
  const fmt = value => numeric(value) ? value.toLocaleString('th-TH', {maximumFractionDigits:2}) : '—';
  const el = (tag, text, className) => {const node = document.createElement(tag);if (text !== undefined) node.textContent = text;if (className) node.className = className;return node;};
  let data = null, controller = null, generation = 0;
  const cumulative = {city_rain_until_target:'ฝนเชียงใหม่สะสมตั้งแต่ตอนนี้',upstream_rain_until_target:'ฝนต้นน้ำสะสมตั้งแต่ตอนนี้'};
  function draw() {
    if (!data) return;
    const key = $('metric').value, def = data.variables[key];
    const label = cumulative[key] || def.label, unit = def?.unit || 'มม.';
    const points = data.points.map(p => ({time:p.time, value: cumulative[key] ? p[key] : p.values[key]}));
    $('timeline-label').textContent = `${label} (${unit})`;
    $('timeline-rows').replaceChildren(...points.map(p => {const tr = el('tr');tr.append(el('td',date(p.time)),el('td',fmt(p.value)));return tr;}));
    $('chart').replaceChildren();
    $('chart-note').textContent = `${label} (${unit}) · จุดห่างกัน ${data.chart_step_minutes} นาที (จุดสุดท้ายอาจสั้นกว่า) · ความละเอียดข้อมูลต้นทางรายชั่วโมง`;
    const valid = points.filter(p => numeric(p.value));
    if (!valid.length) {$('chart').append(el('p',def?.note || 'ข้อมูลอากาศช่วงนี้ไม่ครบ กรุณาลองโหลดใหม่','muted'));return;}
    const ns = 'http://www.w3.org/2000/svg';
    const svgEl = (tag, attrs={}, text) => {const n = document.createElementNS(ns,tag);for (const [k,v] of Object.entries(attrs)) n.setAttribute(k,v);if (text !== undefined) n.textContent = text;return n;};
    const svg = svgEl('svg',{viewBox:'0 0 980 330',role:'img','aria-label':`${label} (${unit}) ตามเวลาเป้าหมาย`});
    svg.append(svgEl('title',{},`${label}: ${valid.length} จุดที่มีข้อมูล ดูค่าทั้งหมดในตารางด้านล่าง`));
    const times = points.map(p => Date.parse(p.time));
    const max = Math.max(1,...valid.map(p => p.value)) * 1.12;
    const x = t => 68 + (t - times[0]) / Math.max(1,times.at(-1)-times[0]) * 855;
    const y = v => 256 - v / max * 222;
    for (let i=0;i<=4;i++) {
      const value = max*i/4, yy = y(value);
      svg.append(svgEl('line',{x1:68,x2:923,y1:yy,y2:yy,stroke:'#dce6ec'}),svgEl('text',{x:58,y:yy+5,'text-anchor':'end',fill:'#536a7b','font-size':12},fmt(value)));
    }
    const indices = [...new Set([0,Math.floor((points.length-1)/2),points.length-1])];
    for (const i of indices) svg.append(svgEl('text',{x:x(times[i]),y:290,'text-anchor':i===0?'start':i===points.length-1?'end':'middle',fill:'#536a7b','font-size':12},shortDate(points[i].time)));
    let path = '', connected = false;
    points.forEach((p,i) => {if (!numeric(p.value)){connected=false;return;}path += `${connected?'L':'M'}${x(times[i])},${y(p.value)} `;connected=true;});
    svg.append(svgEl('path',{d:path,fill:'none',stroke:'#087d89','stroke-width':3}));
    points.forEach((p,i) => {if (!numeric(p.value)) return;const dot = svgEl('circle',{cx:x(times[i]),cy:y(p.value),r:i===points.length-1?5:3.5,fill:i===points.length-1?'#be681d':'#087d89'});dot.append(svgEl('title',{},`${date(p.time)}: ${fmt(p.value)} ${unit}`));svg.append(dot);});
    $('chart').append(svg);
  }
  function render() {
    $('target').textContent = `เริ่ม: ${date(data.requested_at)} → เวลาเป้าหมาย: ${date(data.target_time)}`;
    const target = data.points.at(-1);
    const cards = Object.entries(cumulative).map(([key,label]) => {const card=el('div',undefined,'card');card.append(el('div',label),el('p',`${fmt(target[key])} มม.`,'value'),el('small','ยอดฝนตั้งแต่เวลาเริ่มจนถึงเวลาเป้าหมาย'));return card;});
    const timeCard=el('div',undefined,'card');timeCard.append(el('div','ช่วงเวลาล่วงหน้า'),el('p',$('horizon').selectedOptions[0].textContent,'value'),el('small','ประมาณการอากาศ ไม่ใช่คำเตือนน้ำท่วม'));cards.push(timeCard);$('totals').replaceChildren(...cards);
    $('variables').replaceChildren(...Object.values(data.variables).map(v => {const tr=el('tr'),status=el('td');status.append(el('span',v.status==='calendar'?'ปฏิทิน':v.status==='weather_estimate'?'ประมาณการอากาศ':'ยังไม่มีพยากรณ์',`pill${v.status==='unavailable'?' missing':''}`));tr.append(el('td',v.label),el('td',`${fmt(v.value)} ${v.unit}`),status,el('td',v.note));return tr;}));
    $('sources').replaceChildren(...Object.values(data.sources).map(s => {const box=el('p',undefined,'source');const link=el('a',s.name);link.href=s.source_url;link.target='_blank';link.rel='noreferrer';box.append(link,el('br'),el('small',s.status==='available'?`ดึงข้อมูล: ${date(s.fetched_at)} · กริดที่ได้ ${s.grid_latitude}, ${s.grid_longitude} · เวลาโหลดไม่ใช่เวลาที่แบบจำลองออกพยากรณ์`:'ดึงข้อมูลไม่สำเร็จ กรุณาลองอีกครั้ง'));return box;}));
    $('window-note').textContent=data.rain_window_note;
    $('results').hidden=false;
    draw();
  }
  async function load() {
    const ticket=++generation;controller?.abort();controller=new AbortController();
    const currentController=controller;
    $('results').hidden=true;$('error').hidden=true;$('load').disabled=true;$('status').textContent='กำลังโหลดพยากรณ์…';
    const timeout=setTimeout(()=>currentController.abort(),35000);
    try {
      const response=await fetch(`/api/forecast?horizon_minutes=${encodeURIComponent($('horizon').value)}`,{signal:currentController.signal});
      if (!response.ok) throw new Error(`API ตอบกลับ ${response.status}`);
      const result=await response.json();if(ticket!==generation)return;
      data=result;render();
      $('status').textContent=data.status==='available'?'โหลดข้อมูลอากาศแล้ว':data.status==='partial'?'ข้อมูลอากาศพร้อมใช้บางส่วน':'ข้อมูลอากาศยังไม่พร้อม';
      if (data.status!=='available') {$('error').textContent='ข้อมูลบางช่วงหรือบางพื้นที่ขาดหาย ค่าที่ไม่มีข้อมูลจะแสดง — โปรดลองใหม่ภายหลัง';$('error').hidden=false;}
    } catch(error) {
      if(ticket!==generation)return;
      data=null;$('error').textContent=error.name==='AbortError'?'โหลดเกินเวลาที่กำหนด กรุณาลองอีกครั้ง':`โหลดพยากรณ์ไม่สำเร็จ: ${error.message}`;$('error').hidden=false;$('status').textContent='โหลดไม่สำเร็จ';
    } finally {clearTimeout(timeout);if(ticket===generation)$('load').disabled=false;}
  }
  $('load').addEventListener('click',load);
  $('horizon').addEventListener('change',load);
  $('metric').addEventListener('change',draw);
  load();
})();
