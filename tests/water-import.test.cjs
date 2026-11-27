const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const keys = ['rainfall_24h','rainfall_7day','upstream_rain','ping_level','mae_ngat_storage'];

function fixture() {
  const html = fs.readFileSync(path.join(root, 'website/index.html'), 'utf8');
  const inputs = Object.fromEntries(keys.map(key => {
    const tag = html.match(new RegExp('<input[^>]+id="'+key+'"[^>]*>'))[0];
    return [key, {value: '', max: tag.match(/max="([^"]+)"/)?.[1] || ''}];
  }));
  const elements = {};
  const context = vm.createContext({
    document: {getElementById: id => elements[id] ??= {}},
    form: {elements: {namedItem: key => inputs[key]}},
    clearResult() {}, Date, Number,
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'website/water-panel.js'), 'utf8'), context);
  return {context, inputs, elements};
}

test('imports all five readings, preserving zero rain and storage above normal capacity', () => {
  const {context, inputs, elements} = fixture();
  const readings = Object.fromEntries(keys.map((key, i) => [key, {
    value: [3.5, 1.6, 0, 1.46, 102.2][i], status: 'fresh', observed_at: new Date().toISOString(),
  }]));
  vm.runInContext('waterSnapshot='+JSON.stringify({readings})+';fillWaterInputs()', context);
  for (const key of keys) assert.equal(inputs[key].value, readings[key].value);
  assert.match(elements['example-note'].textContent, /5\/5/);
});

test('parses ThaiWater dates and timestamps with seconds or explicit timezone', () => {
  const {context} = fixture();
  for (const stamp of ['2026-11-27 14:00','2026-11-27 14:00:00','2026-11-27T14:00:00+07:00','2026-11-27T07:00:00Z']) {
    assert.equal(vm.runInContext('observationDate('+JSON.stringify(stamp)+').getTime()', context), Date.parse('2026-11-27T07:00:00Z'));
  }
  assert.equal(vm.runInContext('observationDate("2026-11-27").getTime()', context), Date.parse('2026-11-27T00:00:00+07:00'));
});

test('missing, stale, expired, future and invalid readings stay blank', () => {
  const {context, inputs} = fixture();
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
});
