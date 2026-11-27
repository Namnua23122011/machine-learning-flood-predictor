import io
import json
import os
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

# Importing the app initializes its history store; never touch the user's history.
with tempfile.TemporaryDirectory() as directory:
    with patch.dict(os.environ, {'HISTORY_DIR': directory}):
        from api import api


class WeatherFetchTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {'OPEN_METEO_API_KEY': ''})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        api._weather_responses.clear()
        api._weather_cooldowns.clear()
        api._weather_request_locks.clear()

    def test_success_cache_shared_by_concurrent_requests_and_expires(self):
        def response(_):
            time.sleep(0.02)
            return {'daily': {'rain_sum': [0, 3.5]}}

        with patch.object(api, 'fetch_json', side_effect=response) as fetch:
            with patch.object(api.time, 'monotonic', return_value=10) as clock:
                with ThreadPoolExecutor(max_workers=5) as pool:
                    results = list(pool.map(api.fetch, [api.RAIN_URL] * 5))
                self.assertEqual(fetch.call_count, 1)
                results[0]['daily']['rain_sum'][0] = 999
                self.assertEqual(api.fetch(api.RAIN_URL)['daily']['rain_sum'][0], 0)
                clock.return_value = 311
                api.fetch(api.RAIN_URL)
                self.assertEqual(fetch.call_count, 2)

    def test_daily_cache_resets_at_bangkok_midnight(self):
        class Tomorrow(datetime):
            @classmethod
            def now(cls, tz=None):
                return datetime.now(tz) + timedelta(days=1)

        with patch.object(api, 'fetch_json', return_value={'ok': True}) as fetch:
            api.fetch(api.RAIN_URL)
            with patch.object(api, 'datetime', Tomorrow):
                api.fetch(api.RAIN_URL)
            self.assertEqual(fetch.call_count, 2)

    def test_429_cooldown_shared_with_forecast_and_respects_retry_after(self):
        limited = HTTPError(api.RAIN_URL, 429, 'Too Many Requests', {'Retry-After': '120'}, None)
        with patch.object(api, 'fetch_json', side_effect=[limited, {'ok': True}]) as fetch:
            with patch.object(api.time, 'monotonic', return_value=10) as clock:
                with self.assertRaises(api.ProviderError) as first:
                    api.fetch(api.RAIN_URL)
                self.assertEqual(first.exception.details['retry_after_seconds'], 120)
                clock.return_value = 40
                with self.assertRaises(api.ProviderError) as second:
                    api.fetch(api.source_url(api.LOCATIONS['city']))
                self.assertEqual(second.exception.details['retry_after_seconds'], 90)
                self.assertEqual(fetch.call_count, 1)
                clock.return_value = 131
                self.assertEqual(api.fetch(api.RAIN_URL), {'ok': True})
                self.assertEqual(fetch.call_count, 2)

    def test_429_preserves_unexpired_success_but_not_expired_values(self):
        limited = HTTPError(api.RAIN_URL, 429, 'Limited', {}, None)
        with patch.object(api, 'fetch_json', side_effect=[{'ok': True}, limited]) as fetch:
            with patch.object(api.time, 'monotonic', return_value=10) as clock:
                api.fetch(api.RAIN_URL)
                clock.return_value = 100
                with self.assertRaises(api.ProviderError):
                    api.fetch(api.source_url(api.LOCATIONS['city']))
                self.assertEqual(api.fetch(api.RAIN_URL), {'ok': True})
                clock.return_value = 311
                with self.assertRaises(api.ProviderError):
                    api.fetch(api.RAIN_URL)
                self.assertEqual(fetch.call_count, 2)

    def test_retry_after_http_date_and_invalid_header(self):
        from email.utils import format_datetime
        deadline = api.datetime.now(api.timezone.utc) + timedelta(seconds=120)
        for header, lower, upper in [(format_datetime(deadline), 119, 120),
                                     ('invalid', 300, 300), ('nan', 300, 300)]:
            error = HTTPError(api.RAIN_URL, 429, 'Limited', {'Retry-After': header}, None)
            delay = api.provider_error(error)['retry_after_seconds']
            self.assertGreaterEqual(delay, lower)
            self.assertLessEqual(delay, upper)

    def test_timeout_failure_recovers_after_short_cache(self):
        with patch.object(api, 'fetch_json', side_effect=[TimeoutError(), {'ok': True}]) as fetch:
            with patch.object(api.time, 'monotonic', return_value=10) as clock:
                for _ in range(2):
                    with self.assertRaises(api.ProviderError) as failure:
                        api.fetch(api.RAIN_URL)
                    self.assertEqual(failure.exception.details['error_code'], 'timeout')
                self.assertEqual(fetch.call_count, 1)
                clock.return_value = 41
                self.assertEqual(api.fetch(api.RAIN_URL), {'ok': True})

    def test_customer_key_used_only_in_outbound_request(self):
        with patch.dict(os.environ, {'OPEN_METEO_API_KEY': 'test-secret'}):
            with patch.object(api, 'fetch_json', return_value={'ok': True}) as fetch:
                api.fetch(api.RAIN_URL)
                request_url = urlsplit(fetch.call_args.args[0])
                self.assertEqual(request_url.hostname, 'customer-api.open-meteo.com')
                self.assertEqual(parse_qs(request_url.query)['apikey'], ['test-secret'])
                self.assertNotIn('test-secret', api.RAIN_URL)
                self.assertNotIn('apikey', api.source_url(api.LOCATIONS['city']))
        with patch.object(api, 'fetch_json', return_value={'ok': True}) as fetch:
            api.fetch(api.RAIN_URL)
            self.assertEqual(urlsplit(fetch.call_args.args[0]).hostname, 'api.open-meteo.com')

    def test_errors_and_logs_do_not_expose_customer_key(self):
        secret_url = 'https://customer-api.open-meteo.com/v1/forecast?apikey=test-secret'
        limited = HTTPError(secret_url, 429, 'test-secret', {}, None)
        with patch.dict(os.environ, {'OPEN_METEO_API_KEY': 'test-secret'}):
            with patch.object(api, 'fetch_json', side_effect=limited):
                with self.assertLogs(level='WARNING') as logs:
                    with self.assertRaises(api.ProviderError) as failure:
                        api.fetch(api.RAIN_URL)
                self.assertNotIn('test-secret', str(failure.exception))
                self.assertNotIn('test-secret', json.dumps(failure.exception.details))
                self.assertNotIn('test-secret', '\n'.join(logs.output))

    def test_transport_retries_timeout_but_not_rate_limit(self):
        with patch.object(api, 'urlopen', side_effect=[TimeoutError(), io.StringIO('{"ok":true}')]) as open_url:
            with patch.object(api.time, 'sleep'):
                self.assertEqual(api.fetch_json(api.RAIN_URL), {'ok': True})
            self.assertEqual(open_url.call_count, 2)
        limited = HTTPError(api.RAIN_URL, 429, 'Limited', {}, None)
        with patch.object(api, 'urlopen', side_effect=limited) as open_url:
            with self.assertRaises(HTTPError):
                api.fetch_json(api.RAIN_URL)
            self.assertEqual(open_url.call_count, 1)

    def test_partial_import_saves_station_values_and_rate_limit_reason(self):
        now = api.datetime.now(api.TZ).isoformat()
        station_data = {
            'fetched_at': now,
            'readings': {key: {'value': value, 'status': 'fresh', 'observed_at': now}
                         for key, value in [('ping_level', 1.46), ('upstream_rain', 0),
                                            ('mae_ngat_storage', 102.2)]},
        }
        limited = HTTPError(api.RAIN_URL, 429, 'Limited', {}, None)
        request = api.ImportRequest(request_id='c7537b13-4471-4e75-8e12-1ab4e1517c42')
        with tempfile.TemporaryDirectory() as directory:
            history = api.HistoryStore(directory)
            with patch.object(api, 'store', history):
                with patch.object(api, 'get_water_summary', return_value=station_data):
                    with patch.object(api, 'fetch_json', side_effect=limited) as fetch:
                        result = api.import_snapshot(request)
                        repeated = api.import_snapshot(request)
                        self.assertEqual(fetch.call_count, 1)
            self.assertEqual(result['history_id'], repeated['history_id'])
            self.assertEqual(history.listing()['total'], 1)
            self.assertFalse(result['all_available'])
            self.assertEqual(result['readings']['upstream_rain']['value'], 0)
            self.assertEqual(result['readings']['mae_ngat_storage']['value'], 102.2)
            for key in ('rainfall_24h', 'rainfall_7day'):
                reading = result['readings'][key]
                self.assertIsNone(reading['value'])
                self.assertEqual(reading['error_code'], 'rate_limited')
                self.assertEqual(reading['http_status'], 429)
                self.assertEqual(reading['retry_after_seconds'], 300)
            self.assertIsNone(result['excel_warning'])
            self.assertTrue(history.excel.exists())


if __name__ == '__main__':
    unittest.main()
