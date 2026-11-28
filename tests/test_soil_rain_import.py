import copy
import io
import os
import tempfile
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient
from openpyxl import load_workbook

with tempfile.TemporaryDirectory() as directory:
    with patch.dict(os.environ, {'HISTORY_DIR': directory}):
        from api import api


NOW = datetime(2026, 11, 28, 14, 30, tzinfo=api.TZ)
SOIL = 'soil_moisture_0_to_1cm'


class FixedDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz) if tz else NOW.replace(tzinfo=None)


def weather_payload():
    return {
        'latitude': 18.75, 'longitude': 99.0,
        'timezone': 'Asia/Bangkok', 'utc_offset_seconds': 25200,
        'daily_units': {'rain_sum': 'mm'},
        'daily': {'time': [(NOW.date() - timedelta(days=i)).isoformat() for i in range(8, -1, -1)],
                  'rain_sum': [1, 2, 3, 4, 5, 6, 7, 0, 999]},
        'hourly_units': {'time': 'iso8601', SOIL: 'm³/m³'},
        'hourly': {'time': ['2026-11-28T13:00', '2026-11-28T14:00', '2026-11-28T15:00'],
                   SOIL: [0.2, 0.31, 0.99]},
    }


def station_payload():
    return {'fetched_at': NOW.isoformat(), 'refresh_seconds': 300,
            'readings': {key: {'value': value, 'status': 'fresh', 'observed_at': NOW.isoformat()}
                         for key, value in [('ping_level', 1.46), ('upstream_rain', 0),
                                            ('mae_ngat_storage', 102.2)]}}


class SoilParserTests(unittest.TestCase):
    def test_latest_nonfuture_hour_retains_units_depth_and_grid(self):
        reading = api.soil_moisture_reading(weather_payload(), NOW)
        self.assertEqual(reading['value'], 0.31)
        self.assertEqual(reading['observed_at'], '2026-11-28T14:00:00+07:00')
        self.assertEqual(reading['unit'], 'm³/m³')
        self.assertEqual(reading['status'], 'fresh')
        self.assertEqual(reading['details'], {'depth_cm': '0–1', 'grid_latitude': 18.75, 'grid_longitude': 99.0})
        self.assertFalse(reading['model_compatible'])

    def test_invalid_latest_value_does_not_fall_back_to_earlier_hour(self):
        for value in [None, True, False, '0.3', float('nan'), float('inf'), -0.1, 1.1]:
            with self.subTest(value=value):
                data = weather_payload()
                data['hourly'][SOIL][1] = value
                with self.assertRaises(ValueError):
                    api.soil_moisture_reading(data, NOW)

    def test_zero_and_one_are_valid_soil_values(self):
        for value in (0, 1):
            data = weather_payload()
            data['hourly'][SOIL][1] = value
            self.assertEqual(api.soil_moisture_reading(data, NOW)['value'], value)

    def test_stale_and_future_only_data(self):
        data = weather_payload()
        data['hourly'] = {'time': ['2026-11-28T10:00'], SOIL: [0.3]}
        self.assertEqual(api.soil_moisture_reading(data, NOW)['status'], 'stale')
        data['hourly']['time'] = ['2026-11-28T15:00']
        with self.assertRaises(ValueError):
            api.soil_moisture_reading(data, NOW)

    def test_invalid_units_timezone_arrays_and_timestamps(self):
        variants = [
            {'hourly_units': {'time': 'iso8601', SOIL: '%'}},
            {'hourly_units': {'time': 'unixtime', SOIL: 'm³/m³'}},
            {'timezone': 'UTC'}, {'utc_offset_seconds': 0},
            {'hourly': {'time': [], SOIL: []}},
            {'hourly': {'time': ['2026-11-28T14:00'], SOIL: [0.1, 0.2]}},
            {'hourly': {'time': ['bad'], SOIL: [0.1]}},
            {'hourly': {'time': ['2026-11-28T14:00'] * 2, SOIL: [0.1, 0.2]}},
            {'hourly': {'time': ['2026-11-28T14:00', '2026-11-28T13:00'], SOIL: [0.1, 0.2]}},
        ]
        for changes in variants:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                api.soil_moisture_reading({**weather_payload(), **changes}, NOW)


class ImportEndpointTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = api.HistoryStore(directory.name)
        self.payload = weather_payload()
        patches = [patch.object(api, 'store', self.store),
                   patch.object(api, 'datetime', FixedDatetime),
                   patch.object(api, 'fetch', side_effect=lambda _: copy.deepcopy(self.payload)),
                   patch.object(api, 'get_water_summary', side_effect=station_payload)]
        self.mocks = [p.start() for p in patches]
        for p in patches:
            self.addCleanup(p.stop)
        self.client = TestClient(api.app)
        self.addCleanup(self.client.close)

    def test_dedicated_get_endpoints_read_without_saving(self):
        for url, keys in [('/api/soil-moisture', {'soil_moisture_vwc'}),
                          ('/api/rainfall', {'rainfall_24h', 'rainfall_7day', 'upstream_rain'})]:
            result = self.client.get(url)
            self.assertEqual(result.status_code, 200)
            self.assertEqual(set(result.json()['readings']), keys)
            self.assertTrue(result.json()['all_available'])
        self.assertEqual(self.mocks[-1].call_count, 1)  # Soil needs no ThaiWater request.
        self.assertEqual(self.store.listing()['total'], 0)

    def test_all_import_persists_soil_and_rain_and_exports_distinct_manual_index(self):
        request = {'request_id': str(uuid4()), 'soil_moisture': 0.8, 'month': 11, 'typhoon_active': 0}
        result = self.client.post('/api/import', json=request)
        self.assertEqual(result.status_code, 200)
        data = result.json()
        self.assertEqual(len(data['readings']), 6)
        self.assertEqual(data['readings']['rainfall_24h']['value'], 0)
        self.assertEqual(data['readings']['rainfall_7day']['value'], 28)
        self.assertEqual(data['readings']['soil_moisture_vwc']['value'], 0.31)
        self.assertTrue(data['all_available'])
        repeated = self.client.post('/api/import', json=request).json()
        self.assertEqual(repeated['history_id'], data['history_id'])
        self.assertEqual(self.mocks[-2].call_count, 1)
        saved = self.client.get('/api/history/' + str(data['history_id'])).json()['record']
        self.assertEqual(saved['manual']['soil_moisture'], 0.8)
        self.assertEqual(saved['snapshot']['readings'], data['readings'])
        exported = self.client.get('/api/history/export.xlsx')
        book = load_workbook(io.BytesIO(exported.content))
        self.addCleanup(book.close)
        rows = list(book['Imports'].values)
        row = dict(zip(rows[0], rows[1]))
        self.assertEqual(row['Soil water content 0–1 cm (m³/m³)'], 0.31)
        self.assertEqual(row['Soil index 0–1 (manual)'], 0.8)
        self.assertEqual(row['Rain daily (mm)'], 0)
        self.assertEqual(row['Fresh API fields'], 6)
        self.assertEqual(row['Requested API fields'], 6)
        details = list(book['Reading details'].values)
        soil = dict(zip(details[0], next(r for r in details[1:] if r[1] == 'soil_moisture_vwc')))
        self.assertEqual(soil['Soil depth (cm)'], '0–1')
        self.assertEqual(soil['Grid latitude'], 18.75)
        self.assertEqual(soil['Unit'], 'm³/m³')

    def test_selective_imports_save_only_requested_readings(self):
        for scope in ('rainfall', 'soil_moisture'):
            result = self.client.post('/api/import', json={'request_id': str(uuid4()), 'scope': scope})
            self.assertEqual(result.status_code, 200)
            data = result.json()
            self.assertEqual(set(data['readings']), set(api.IMPORT_FIELDS[scope]))
            self.assertEqual(data['scope'], scope)
            self.assertEqual(self.store.get(data['history_id'])['snapshot']['scope'], scope)
        self.assertEqual(self.store.listing()['total'], 2)

    def test_rain_and_soil_parse_failures_are_independent(self):
        self.payload['hourly'][SOIL][1] = None
        data = self.client.get('/api/water-summary').json()
        self.assertEqual(data['readings']['soil_moisture_vwc']['status'], 'unavailable')
        self.assertEqual(data['readings']['rainfall_24h']['value'], 0)
        self.assertFalse(data['all_available'])
        self.payload = weather_payload()
        self.payload['daily']['rain_sum'][0] = None
        data = self.client.get('/api/water-summary').json()
        self.assertEqual(data['readings']['rainfall_7day']['status'], 'unavailable')
        self.assertEqual(data['readings']['soil_moisture_vwc']['value'], 0.31)

    def test_wrong_rain_units_and_incomplete_windows_do_not_import(self):
        for changes in [
            {'daily_units': {'rain_sum': 'inch'}},
            {'daily': {'time': ['2026-11-27'], 'rain_sum': [3]}},
            {'daily': {'time': ['2026-11-27'] * 9, 'rain_sum': [3] * 9}},
            {'daily': {'time': weather_payload()['daily']['time'], 'rain_sum': [3]}},
        ]:
            with self.subTest(changes=changes):
                self.payload = {**weather_payload(), **changes}
                data = self.client.get('/api/rainfall').json()
                self.assertIsNone(data['readings']['rainfall_24h']['value'])
                self.assertIsNone(data['readings']['rainfall_7day']['value'])
                self.assertEqual(data['readings']['upstream_rain']['value'], 0)

    def test_provider_failure_is_saved_without_zero_substitution(self):
        self.mocks[-2].side_effect = TimeoutError()
        data = self.client.post('/api/import', json={'request_id': str(uuid4())}).json()
        for key in ('soil_moisture_vwc', 'rainfall_24h', 'rainfall_7day'):
            self.assertIsNone(data['readings'][key]['value'])
            self.assertEqual(data['readings'][key]['error_code'], 'timeout')
        self.assertEqual(data['readings']['upstream_rain']['value'], 0)
        self.assertEqual(self.store.listing()['total'], 1)

    def test_invalid_scope_and_request_id_rejected_before_fetch(self):
        for body in [{'request_id': str(uuid4()), 'scope': 'wrong'},
                     {'request_id': 'not-a-uuid'}, {'request_id': str(uuid4()), 'scope': None}]:
            self.assertEqual(self.client.post('/api/import', json=body).status_code, 422)
        self.mocks[-2].assert_not_called()
        self.assertEqual(self.store.listing()['total'], 0)

    def test_legacy_records_without_soil_export_as_blank(self):
        self.store.save(str(uuid4()), station_payload(), {'soil_moisture': 0.8})
        book = load_workbook(io.BytesIO(self.store.export()))
        self.addCleanup(book.close)
        rows = list(book['Imports'].values)
        row = dict(zip(rows[0], rows[1]))
        self.assertIsNone(row['Soil water content 0–1 cm (m³/m³)'])
        self.assertEqual(row['Soil index 0–1 (manual)'], 0.8)


if __name__ == '__main__':
    unittest.main()
