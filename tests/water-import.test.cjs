const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const root = path.join(__dirname, '..');
const keys = ['rainfall_24h','rainfall_7day','upstream_rain','ping_level','mae_ngat_storage','soil_moisture_vwc'];

function fixture(fetchImpl) {
  const html = fs.readFileSync(path.join(root, 'website/index.html'), 'utf8');
  const inputs = Object.fromEntries(keys.map(key => {
    const tag = html.match(new RegExp('<input[^>]+id="'+key+'"[^>]*>'))[0];
    return [key, {value: '', min: tag.match(/min="([^"]+)"/)?.[1] || '', max: tag.match(/max="([^"]+)"/)?.[1] || ''}];
  }));
  for(const key of ['month','typhoon_active','soil_moisture']) {
    inputs[key] = {value: '', checkValidity: () => true};
  }
  function element() {
    return {textContent: '', style: {}, children: [], append(...nodes) {this.children.push(...nodes);},
      replaceChildren(...nodes) {this.children = nodes; this.textContent = '';}};
  }
  const elements = {};
  const context = vm.createContext({
    document: {getElementById: id => html.includes('id="'+id+'"') ? elements[id] ??= element() : null, createElement: element},
    form: {elements: {namedItem: key => inputs[key]}},
    clearResult() {}, setMode() {}, generation: 0, mode: 'manual', Date, Number,
    AbortController, setTimeout, clearTimeout, crypto: {randomUUID}, fetch: fetchImpl,
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'website/water-panel.js'), 'utf8'), context);
  return {context, inputs, elements};
}

test('imports available measurements, preserving zero rain, soil units and storage above normal capacity', () => {
  const {context, inputs, elements} = fixture();
  const readings = Object.fromEntries(keys.map((key, i) => [key, {
    value: [3.5, 1.6, 0, 1.46, 102.2, 0.31][i], status: 'fresh', observed_at: new Date().toISOString(), unit: key==='soil_moisture_vwc'?'m³/m³':'test',
  }]));
  vm.runInContext('waterSnapshot='+JSON.stringify({readings})+';fillWaterInputs()', context);
  for (const key of keys) assert.equal(inputs[key].value, readings[key].value);
  assert.match(elements['example-note'].textContent, /6\/9/);
  assert.equal(inputs.soil_moisture.value, '');
});

test('parses ThaiWater dates and timestamps with seconds or explicit timezone', () => {
  const {context} = fixture();
  for (const stamp of ['2026-11-27 14:00','2026-11-27 14:00:00','2026-11-27T14:00:00+07:00','2026-11-27T07:00:00Z']) {
    assert.equal(vm.runInContext('observationDate('+JSON.stringify(stamp)+').getTime()', context), Date.parse('2026-11-27T07:00:00Z'));
  }
  assert.equal(vm.runInContext('observationDate("2026-11-27").getTime()', context), Date.parse('2026-11-27T00:00:00+07:00'));
});

test('stale readings fill with warnings while missing, future and invalid readings stay blank', () => {
  const {context, inputs, elements} = fixture();
  const now = new Date().toISOString();
  const readings = {
    rainfall_24h: {value: null, status: 'fresh', observed_at: now},
    rainfall_7day: {value: 5, status: 'stale', observed_at: now},
    upstream_rain: {value: 0, status: 'fresh', observed_at: new Date(Date.now()-4*3600000).toISOString()},
    ping_level: {value: 2, status: 'fresh', observed_at: new Date(Date.now()+3600000).toISOString()},
    mae_ngat_storage: {value: 102.2, status: 'fresh', observed_at: 'bad date'},
  };
  vm.runInContext('waterSnapshot='+JSON.stringify({readings})+';fillWaterInputs()', context);
  for (const key of ['rainfall_24h','ping_level','mae_ngat_storage','soil_moisture_vwc']) assert.equal(inputs[key].value, '');
  assert.equal(inputs.rainfall_7day.value, 5);
  assert.equal(inputs.upstream_rain.value, 0);
  assert.match(elements['example-note'].textContent, /2\/9/);
  assert.match(elements['example-note'].textContent, /ข้อมูลเก่า/);
  assert.match(elements['rainfall_7day-import-note'].textContent, /ข้อมูลเก่า/);
});

test('import button displays provider rate limit and still fills available station readings', async () => {
  const readings = Object.fromEntries(keys.map((key, i) => [key, i < 2 ? {
    value: null, status: 'unavailable', error_code: 'rate_limited', http_status: 429,
    retry_after_seconds: 120, note: 'ผู้ให้บริการจำกัดจำนวนคำขอ (HTTP 429)',
  } : {value: [0, 0, 0, 1.46, 102.2][i], status: 'fresh', observed_at: new Date().toISOString(), unit: 'test'}]));
  const calls = [];
  const {context, inputs, elements} = fixture(async (url, options) => {
    calls.push({url, body: JSON.parse(options.body)});
    return {ok: true, json: async () => ({readings, history_id: 12, fetched_at: new Date().toISOString()})};
  });
  await vm.runInContext('waterButton.onclick()', context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/import');
  assert.match(calls[0].body.request_id, /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/);
  assert.equal(calls[0].body.month, null);
  assert.equal(inputs.rainfall_24h.value, '');
  assert.equal(inputs.rainfall_7day.value, '');
  assert.equal(inputs.upstream_rain.value, 0);
  assert.equal(inputs.mae_ngat_storage.value, 102.2);
  assert.match(elements['example-note'].textContent, /3\/9/);
  const rendered = elements['water-result'].children.flatMap(card => card.children.map(node => node.textContent)).join(' ');
  assert.match(rendered, /HTTP 429/);
  assert.match(rendered, /2 นาที/);
  assert.match(elements['water-time'].textContent, /#12/);
  assert.equal(elements['water-button'].disabled, false);
});

test('import button shows HTTP failure even when host returns an HTML error page', async () => {
  const {context, elements} = fixture(async () => ({
    ok: false, status: 503, json: async () => {throw new SyntaxError('HTML response');},
  }));
  await vm.runInContext('waterButton.onclick()', context);
  assert.match(elements['water-result'].textContent, /HTTP 503/);
  assert.doesNotMatch(elements['water-result'].textContent, /app.py/);
  assert.equal(elements['water-button'].disabled, false);
});

test('import completion does not overwrite form edits made while waiting', async () => {
  const readings = Object.fromEntries(keys.map(key => [key, {
    value: 1, status: 'fresh', observed_at: new Date().toISOString(),
  }]));
  const {context, inputs, elements} = fixture(async () => {
    vm.runInContext('generation++', context);
    inputs.ping_level.value = '2.5';
    return {ok: true, json: async () => ({readings, history_id: 13, fetched_at: new Date().toISOString()})};
  });
  await vm.runInContext('waterButton.onclick()', context);
  assert.equal(inputs.ping_level.value, '2.5');
  assert.match(elements['water-time'].textContent, /มีการแก้ไขแบบฟอร์มระหว่างรอ/);
});

test('one import covers nine dashboard fields and identifies unavailable storm and model index', async () => {
  const readings = Object.fromEntries(keys.map((key,i) => [key, {
    value: [0, 28, 0, 2.5, 102.2, 0.31][i], status: 'fresh', observed_at: new Date().toISOString(), unit: key==='soil_moisture_vwc'?'m³/m³':'test',
  }]));
  readings.month = {value: 11, status: 'fresh', observed_at: new Date().toISOString(), unit: 'month'};
  readings.typhoon_active = {value: null, status: 'unavailable', unit: '0_or_1', note: 'ยังไม่มีแหล่งข้อมูลพายุ'};
  readings.soil_moisture = {value: null, status: 'unavailable', unit: 'index_0_1', note: 'ยังไม่มีแหล่งข้อมูลดัชนี'};
  const calls = [];
  const {context, inputs, elements} = fixture(async (url, options) => {
    calls.push({url, body: JSON.parse(options.body)});
    assert.equal(elements['water-button'].disabled, true);
    return {ok: true, json: async () => ({readings, scope: 'all', history_id: 14, fetched_at: new Date().toISOString()})};
  });
  inputs.soil_moisture.value = '0.8';
  await vm.runInContext('waterButton.onclick()', context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/import');
  assert.equal(calls[0].body.scope, 'all');
  assert.equal(calls[0].body.soil_moisture, 0.8);
  for(const key of keys) assert.equal(inputs[key].value, readings[key].value);
  assert.equal(inputs.month.value, 11);
  assert.equal(inputs.soil_moisture.value, '');
  assert.equal(inputs.typhoon_active.value, '');
  assert.match(elements['example-note'].textContent, /7\/9/);
  assert.match(elements['example-note'].textContent, /ยังนำเข้าไม่ได้: มีพายุ, ดัชนีความชื้นดินของโมเดล/);
  assert.match(elements['typhoon_active-import-note'].textContent, /ยังไม่มีแหล่งข้อมูลพายุ/);
  assert.match(elements['soil_moisture-import-note'].textContent, /ยังไม่มีแหล่งข้อมูลดัชนี/);
  assert.equal(elements['water-result'].children.length, 9);
  assert.equal(elements['water-button'].disabled, false);
});

test('invalid or missing soil readings never substitute for a missing model index', () => {
  const {context, inputs} = fixture();
  const valid = {value: 0.31, status: 'fresh', observed_at: new Date().toISOString(), unit: 'm³/m³'};
  inputs.soil_moisture.value = '0.8';
  for (const reading of [undefined, {...valid, value: -0.1}, {...valid, value: 1.1},
    {...valid, value: null}, {...valid, unit: '%'}]) {
    inputs.soil_moisture_vwc.value = '0.45';
    vm.runInContext('waterSnapshot='+JSON.stringify({scope: 'all', readings: {soil_moisture_vwc: reading}})+';fillWaterInputs()', context);
    assert.equal(inputs.soil_moisture_vwc.value, '');
    assert.equal(inputs.soil_moisture.value, '');
  }
});

test('all nine fields import when provider context is available, including explicit no storm', () => {
  const {context, inputs, elements} = fixture();
  const readings = Object.fromEntries(keys.map(key => [key, {
    value: 0.3, status: 'fresh', observed_at: new Date().toISOString(), unit: key==='soil_moisture_vwc'?'m³/m³':'test',
  }]));
  for(const [key, value, unit] of [['month',11,'month'],['typhoon_active',0,'0_or_1'],['soil_moisture',0.8,'index_0_1']]) {
    readings[key] = {value, unit, status: 'fresh', observed_at: new Date().toISOString()};
  }
  vm.runInContext('waterSnapshot='+JSON.stringify({readings})+';fillWaterInputs()', context);
  for(const key of Object.keys(readings)) assert.equal(inputs[key].value, readings[key].value);
  assert.match(elements['example-note'].textContent, /9\/9/);
  assert.doesNotMatch(elements['example-note'].textContent, /ไม่มีข้อมูลล่าสุด/);
});

test('unvalidated context clears old values instead of silently treating them as current', () => {
  const {context, inputs} = fixture();
  for(const [key, value, unit, observed_at] of [
    ['month',13,'month',new Date().toISOString()],
    ['month',1.5,'month',new Date().toISOString()],
    ['typhoon_active',2,'0_or_1',new Date().toISOString()],
    ['soil_moisture',0.3,'m³/m³',new Date().toISOString()],
  ]) {
    inputs[key].value = '1';
    vm.runInContext('waterSnapshot='+JSON.stringify({readings:{[key]:{value, unit, observed_at, status:'fresh'}}})+';fillWaterInputs()', context);
    assert.equal(inputs[key].value, '');
  }
});

test('invalid old manual entries do not block importing replacement values', async () => {
  let body;
  const {context, inputs} = fixture(async (url, options) => {
    body = JSON.parse(options.body);
    return {ok: true, json: async () => ({readings: {}, history_id: 16, fetched_at: new Date().toISOString()})};
  });
  inputs.soil_moisture.value = '2';
  inputs.soil_moisture.checkValidity = () => false;
  await vm.runInContext('waterButton.onclick()', context);
  assert.equal(body.soil_moisture, null);
  assert.equal(inputs.soil_moisture.value, '');
});

test('card and input use the server check time when the device clock is different', async () => {
  const checked_at = '2026-11-28T14:30:00+07:00';
  const readings = {ping_level:{value:1.5, unit:'ม.', status:'fresh', observed_at:'2026-11-28 14:00'}};
  const {context, inputs, elements} = fixture(async () => ({
    ok:true,json:async()=>({readings, checked_at, fetched_at:checked_at, history_id:17}),
  }));
  vm.runInContext('Date=class extends Date {static now(){return Date.parse("2026-11-29T14:30:00+07:00");}}',context);
  await vm.runInContext('waterButton.onclick()', context);
  assert.equal(inputs.ping_level.value, 1.5);
  assert.match(elements['ping_level-import-note'].textContent, /นำเข้าแล้ว/);
  const card = elements['water-result'].children[3].children.map(node=>node.textContent).join(' ');
  assert.match(card, /ข้อมูลพร้อมใช้/);
  assert.doesNotMatch(card, /ไม่เติมลงช่อง/);
});

test('wrong-unit reading shows the same reason on its card and beside its blank input', async () => {
  const readings = {soil_moisture_vwc:{value:31, unit:'%', status:'fresh', observed_at:new Date().toISOString()}};
  const {context, inputs, elements} = fixture(async () => ({
    ok:true,json:async()=>({readings, fetched_at:new Date().toISOString(), history_id:18}),
  }));
  await vm.runInContext('waterButton.onclick()', context);
  assert.equal(inputs.soil_moisture_vwc.value, '');
  assert.match(elements['soil_moisture_vwc-import-note'].textContent, /หน่วยไม่ตรง/);
  const card = elements['water-result'].children[5].children.map(node=>node.textContent).join(' ');
  assert.match(card, /ไม่เติมลงช่อง · หน่วยไม่ตรง/);
  assert.doesNotMatch(card, /ข้อมูลพร้อมใช้/);
});

test('old Ping reading on the card fills its input and keeps the original observation time', async () => {
  const checked_at='2026-11-28T17:00:00+07:00';
  const readings={ping_level:{value:1.5,unit:'ม.',status:'stale',observed_at:'2026-11-28 12:00'}};
  const {context, inputs, elements}=fixture(async()=>({ok:true,json:async()=>({readings,checked_at,fetched_at:checked_at,history_id:19})}));
  await vm.runInContext('waterButton.onclick()',context);
  assert.equal(inputs.ping_level.value,1.5);
  const card=elements['water-result'].children[3].children.map(node=>node.textContent).join(' ');
  assert.match(card,/ข้อมูลเก่า/);
  assert.match(card,/2026-11-28 12:00/);
  assert.match(elements['ping_level-import-note'].textContent,/นำเข้าแล้ว · ข้อมูลเก่า/);
  assert.match(elements['example-note'].textContent,/ข้อมูลเก่า: ระดับน้ำปิง/);
});

test('stale volumetric soil stays separate from the missing model soil index', () => {
  const {context,inputs,elements}=fixture();
  const data={checked_at:'2026-11-28T17:00:00+07:00',readings:{soil_moisture_vwc:{
    value:0.31,status:'stale',unit:'m³/m³',observed_at:'2026-11-28T12:00:00+07:00',
  }}};
  vm.runInContext('waterSnapshot='+JSON.stringify(data)+';fillWaterInputs()',context);
  assert.equal(inputs.soil_moisture_vwc.value,0.31);
  assert.equal(inputs.soil_moisture.value,'');
  assert.match(elements['soil_moisture_vwc-import-note'].textContent,/ข้อมูลเก่า/);
});
