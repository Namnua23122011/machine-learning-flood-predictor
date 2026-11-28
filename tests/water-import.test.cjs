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
    document: {getElementById: id => elements[id] ??= element(), createElement: element},
    form: {elements: {namedItem: key => inputs[key]}},
    clearResult() {}, setMode() {}, generation: 0, mode: 'manual', Date, Number,
    AbortController, setTimeout, clearTimeout, crypto: {randomUUID}, fetch: fetchImpl,
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'website/water-panel.js'), 'utf8'), context);
  return {context, inputs, elements};
}

test('imports all six readings, preserving zero rain, soil units and storage above normal capacity', () => {
  const {context, inputs, elements} = fixture();
  const readings = Object.fromEntries(keys.map((key, i) => [key, {
    value: [3.5, 1.6, 0, 1.46, 102.2, 0.31][i], status: 'fresh', observed_at: new Date().toISOString(), unit: key==='soil_moisture_vwc'?'m³/m³':'test',
  }]));
  vm.runInContext('waterSnapshot='+JSON.stringify({readings})+';fillWaterInputs()', context);
  for (const key of keys) assert.equal(inputs[key].value, readings[key].value);
  assert.match(elements['example-note'].textContent, /6\/6/);
  assert.equal(inputs.soil_moisture.value, '');
});

test('parses ThaiWater dates and timestamps with seconds or explicit timezone', () => {
  const {context} = fixture();
  for (const stamp of ['2026-11-27 14:00','2026-11-27 14:00:00','2026-11-27T14:00:00+07:00','2026-11-27T07:00:00Z']) {
    assert.equal(vm.runInContext('observationDate('+JSON.stringify(stamp)+').getTime()', context), Date.parse('2026-11-27T07:00:00Z'));
  }
  assert.equal(vm.runInContext('observationDate("2026-11-27").getTime()', context), Date.parse('2026-11-27T00:00:00+07:00'));
});

test('missing, stale, expired, future and invalid readings stay blank', () => {
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
  for (const key of keys) assert.equal(inputs[key].value, '');
  assert.match(elements['example-note'].textContent, /ยังนำเข้าข้อมูลล่าสุดไม่ได้ \(0\/6/);
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
  assert.match(elements['example-note'].textContent, /3\/6/);
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

test('rain-only button saves and fills rainfall without changing other inputs', async () => {
  const readings = Object.fromEntries(keys.slice(0,3).map((key,i) => [key, {
    value: [0, 28, 0][i], status: 'fresh', observed_at: new Date().toISOString(), unit: 'มม.',
  }]));
  let body;
  const {context, inputs, elements} = fixture(async (url, options) => {
    body = JSON.parse(options.body);
    return {ok: true, json: async () => ({readings, scope: 'rainfall', history_id: 14, fetched_at: new Date().toISOString()})};
  });
  inputs.ping_level.value = '2.5';
  inputs.soil_moisture.value = '0.8';
  inputs.soil_moisture_vwc.value = '0.31';
  await vm.runInContext('rainButton.onclick()', context);
  assert.equal(body.scope, 'rainfall');
  assert.equal(inputs.rainfall_24h.value, 0);
  assert.equal(inputs.rainfall_7day.value, 28);
  assert.equal(inputs.upstream_rain.value, 0);
  assert.equal(inputs.ping_level.value, '2.5');
  assert.equal(inputs.soil_moisture.value, '0.8');
  assert.equal(inputs.soil_moisture_vwc.value, '0.31');
  assert.match(elements['example-note'].textContent, /3\/3/);
  assert.equal(elements['water-result'].children.length, 3);
});

test('soil-only button imports volumetric moisture without changing the model index or rain', async () => {
  let body;
  const {context, inputs, elements} = fixture(async (url, options) => {
    body = JSON.parse(options.body);
    return {ok: true, json: async () => ({readings: {soil_moisture_vwc: {
      value: 0, status: 'fresh', observed_at: new Date().toISOString(), unit: 'm³/m³',
    }}, scope: 'soil_moisture', history_id: 15, fetched_at: new Date().toISOString()})};
  });
  inputs.soil_moisture.value = '0.8';
  inputs.rainfall_24h.value = '12';
  await vm.runInContext('soilButton.onclick()', context);
  assert.equal(body.scope, 'soil_moisture');
  assert.equal(body.soil_moisture, 0.8);
  assert.equal(inputs.soil_moisture_vwc.value, 0);
  assert.equal(inputs.soil_moisture.value, '0.8');
  assert.equal(inputs.rainfall_24h.value, '12');
  assert.match(elements['example-note'].textContent, /1\/1/);
  assert.equal(elements['water-result'].children.length, 1);
  for(const key of ['water-button','rain-button','soil-button']) assert.equal(elements[key].disabled, false);
});

test('invalid, missing or expired soil readings clear previous imported soil only', () => {
  const {context, inputs} = fixture();
  const valid = {value: 0.31, status: 'fresh', observed_at: new Date().toISOString(), unit: 'm³/m³'};
  inputs.soil_moisture.value = '0.8';
  for (const reading of [undefined, {...valid, value: -0.1}, {...valid, value: 1.1},
    {...valid, value: null}, {...valid, unit: '%'}, {...valid, status: 'stale'},
    {...valid, observed_at: new Date(Date.now()-4*3600000).toISOString()}]) {
    inputs.soil_moisture_vwc.value = '0.45';
    vm.runInContext('waterSnapshot='+JSON.stringify({scope: 'soil_moisture', readings: {soil_moisture_vwc: reading}})+';fillWaterInputs()', context);
    assert.equal(inputs.soil_moisture_vwc.value, '');
    assert.equal(inputs.soil_moisture.value, '0.8');
  }
});
