"""Chiang Mai flood API. Run from the project root: python -m api.api."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import io
import json
import logging
import math
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from uuid import UUID

import joblib
import numpy as np
import pandas as pd
from fastapi import APIRouter, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from pydantic import BaseModel, ConfigDict, Field

BASE_DIR = Path(__file__).resolve().parent.parent
WEBSITE_DIR = BASE_DIR / 'website'


# Realtime weather inputs

BANGKOK = timezone(timedelta(hours=7))
REALTIME_FIELDS = ('month', 'rainfall_24h', 'rainfall_7day', 'upstream_rain',
          'ping_level', 'mae_ngat_storage', 'soil_moisture', 'typhoon_active')
_realtime_lock = threading.Lock()
_cached = None
_cached_at = 0


def fetch_json(url, token=None):
    headers = {'Accept': 'application/json', 'User-Agent': 'ChiangMaiFloodLocal/1.0'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    with urlopen(Request(url, headers=headers), timeout=12) as response:
        return json.load(response)


def normalized_feed(data, now):
    """Contract: values + per-field ISO timestamp, source, and matching units."""
    units = {'month': 'month', 'rainfall_24h': 'mm', 'rainfall_7day': 'mm',
             'upstream_rain': 'mm', 'ping_level': 'm', 'mae_ngat_storage': '%',
             'soil_moisture': 'index_0_1', 'typhoon_active': '0_or_1'}
    values, metadata = {}, {}
    for name in REALTIME_FIELDS:
        item = data.get('fields', {}).get(name, {})
        try:
            value = item['value']
            stamp = datetime.fromisoformat(item['observed_at'].replace('Z', '+00:00'))
            age = (now - stamp).total_seconds()
            if type(value) not in (float, int) or not math.isfinite(value):
                continue
            if stamp.tzinfo is None or not -300 <= age <= 3600:
                continue
            if item.get('unit') != units[name] or not item.get('source'):
                continue
            if name in ('month', 'typhoon_active') and type(value) is not int:
                continue
            if name == 'month' and not 1 <= value <= 12:
                continue
            if name == 'typhoon_active' and value not in (0, 1):
                continue
            if name == 'soil_moisture' and not 0 <= value <= 1:
                continue
            if name == 'mae_ngat_storage' and not 0 <= value <= 100:
                continue
            if name not in ('ping_level',) and value < 0:
                continue
            values[name] = value
            metadata[name] = {'source': str(item['source']), 'observed_at': stamp.isoformat(),
                              'unit': units[name], 'kind': 'provider'}
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
    return values, metadata


def weather_inputs(data, now):
    """Match notebook: one completed day, then seven preceding days excluding it."""
    daily = data['daily']
    if data.get('daily_units', {}).get('rain_sum') != 'mm':
        raise ValueError('Unexpected rainfall unit')
    day = now.date() - timedelta(days=1)
    lookup = dict(zip(daily['time'], daily['rain_sum']))
    dates = [(day - timedelta(days=i)).isoformat() for i in range(8)]
    series = [lookup.get(d) for d in dates]
    if not all(type(v) in (int, float) and math.isfinite(v) and v >= 0 for v in series):
        raise ValueError('Incomplete rainfall window')
    values = {'month': day.month, 'rainfall_24h': round(series[0], 2),
              'rainfall_7day': round(sum(series[1:]), 2)}
    metadata = {name: {'source': 'Open-Meteo weather model / Chiang Mai 18.7883,98.9853',
                       'observed_at': day.isoformat(), 'kind': 'weather_model_estimate',
                       'unit': 'month' if name == 'month' else 'mm'} for name in values}
    return values, metadata


def get_realtime():
    global _cached, _cached_at
    with _realtime_lock:
        now = datetime.now(BANGKOK)
        if _cached is not None and time.monotonic() - _cached_at < 300:
            fresh = all(
                (now - datetime.fromisoformat(m['observed_at'])).total_seconds() <= 3600
                for m in _cached['metadata'].values() if m['kind'] == 'provider')
            if fresh:
                return _cached
        values, metadata, errors = {}, {}, []
        provider = os.environ.get('FLOOD_DATA_URL')
        try:
            if provider:
                values, metadata = normalized_feed(
                    fetch_json(provider, os.environ.get('FLOOD_DATA_TOKEN')), now)
            else:
                url = 'https://api.open-meteo.com/v1/forecast?' + urlencode({
                    'latitude': 18.7883, 'longitude': 98.9853, 'daily': 'rain_sum',
                    'past_days': 8, 'forecast_days': 1, 'timezone': 'Asia/Bangkok'})
                values, metadata = weather_inputs(fetch_json(url), now)
        except Exception:
            # Do not expose upstream URLs, tokens, or response internals.
            errors.append('ดึงข้อมูลจากผู้ให้บริการไม่สำเร็จ กรุณาลองใหม่ภายหลัง')
        missing = [f for f in REALTIME_FIELDS if f not in values]
        result = {'values': values, 'metadata': metadata, 'missing': missing,
                  'complete': not missing, 'fetched_at': now.isoformat(),
                  'refresh_seconds': 300, 'errors': errors,
                  'source_mode': 'configured_provider' if provider else 'open_meteo',
                  'note': ('รับเฉพาะข้อมูลจาก provider ที่อายุไม่เกิน 1 ชั่วโมง'
                           if provider else 'ค่าฝนจากแบบจำลองอากาศของวันล่าสุดที่จบแล้ว ไม่ใช่สถานีวัดสด; ฝน 7 วันไม่รวมวันนั้น')}
        # Cache failures briefly through no cache; successful responses for five minutes.
        if not errors:
            _cached, _cached_at = result, time.monotonic()
        return result


# ThaiWater station measurements

TZ = timezone(timedelta(hours=7))
THAIWATER_BASE = 'https://api-v3.thaiwater.net/api/v1/thaiwater30/'
URLS = {'ping_level': THAIWATER_BASE+'public/waterlevel_load',
        'upstream_rain': THAIWATER_BASE+'public/rain_24h',
        'mae_ngat_storage': THAIWATER_BASE+'analyst/dam'}
_water_cache = None
_water_expires = 0
_water_lock = threading.Lock()

def fetch(url):
    with urlopen(url, timeout=12) as r:
        return json.load(r)

def number(v):
    if v is None or isinstance(v, bool):
        raise ValueError('Missing value')
    n = float(v)
    if not math.isfinite(n):
        raise ValueError('Nonfinite value')
    return n

def stamp(v):
    d = datetime.fromisoformat(v)
    return d.replace(tzinfo=TZ) if d.tzinfo is None else d

def freshness(value, now, daily=False):
    age = (now-stamp(value)).total_seconds()
    return 'fresh' if -300 <= age <= (48*3600 if daily else 3*3600) else 'stale'

def parse(key, data, now):
    if key == 'ping_level':
        rows = [r for r in data['waterlevel_data']['data'] if r['station']['id'] == 3226 and r['station']['tele_station_oldcode'] == 'P.1']
        r = max(rows, key=lambda r: stamp(r['waterlevel_datetime']))
        s = r['station']
        msl, offset = number(r['waterlevel_msl']), number(s['offset'])
        if abs(number(s['critical_level_msl'])-number(s['critical_level_m'])-offset) > 0.05:
            raise ValueError('Datum mismatch')
        v = number(r['waterlevel_m']) if r.get('waterlevel_m') is not None else round(msl-offset, 3)
        result = dict(value=v, unit='ม. ระดับหน้าสถานี', observed_at=r['waterlevel_datetime'], station='P.1 สะพานนวรัฐ', source='ThaiWater / กรมชลประทาน', details={'waterlevel_msl': msl, 'gauge_offset_m': offset}, note='ระดับหน้าสถานี = ระดับเทียบทะเล ลบ offset สถานี')
    elif key == 'upstream_rain':
        r = max([r for r in data['data'] if r['station']['id'] == 570949], key=lambda r: stamp(r['rainfall_datetime']))
        v = number(r['rain_24h'])
        if v < 0:
            raise ValueError('Invalid rain')
        result = dict(value=v, unit='มม. / 24 ชม.', observed_at=r['rainfall_datetime'], station='MOU001 '+r['station']['tele_station_name']['th'], source='ThaiWater / '+r['agency']['agency_name']['th'], note='สถานีตัวแทนต้นน้ำ อ.แม่ริม ไม่ใช่ค่าเฉลี่ยฝนทั้งลุ่มน้ำ')
    else:
        r = max([r for r in data['data']['dam_daily'] if r['dam']['id'] == 23 and r['agency']['id'] == 12], key=lambda r: stamp(r['dam_date']))
        storage, normal, percent = number(r['dam_storage']), number(r['dam']['normal_storage']), number(r['dam_storage_percent'])
        if storage < 0 or normal <= 0 or percent < 0 or abs(percent-storage/normal*100) > 1:
            raise ValueError('Invalid reservoir data')
        result = dict(value=percent, unit='% ความจุปกติ', observed_at=r['dam_date'], station='เขื่อนแม่งัดสมบูรณ์ชล', source='ThaiWater / กรมชลประทาน', note='รายงานรายวัน ใช้เปอร์เซ็นต์ที่ผู้ให้บริการเผยแพร่', details={'storage_million_m3': storage, 'normal_capacity_million_m3': normal, 'maximum_capacity_million_m3': number(r['dam']['max_storage'])})
    result['status'] = freshness(result['observed_at'], now, key == 'mae_ngat_storage')
    result['source_url'] = URLS[key]
    return result

def get_water_summary():
    global _water_cache, _water_expires
    with _water_lock:
        now = datetime.now(TZ)
        if _water_cache is not None and time.monotonic() < _water_expires:
            result = json.loads(json.dumps(_water_cache))
        else:
            result = {'readings': {}, 'fetched_at': now.isoformat(), 'refresh_seconds': 300}
            with ThreadPoolExecutor(max_workers=3) as pool:
                jobs = {k: pool.submit(fetch, url) for k, url in URLS.items()}
                for key, f in jobs.items():
                    try:
                        result['readings'][key] = parse(key, f.result(), now)
                    except Exception:
                        result['readings'][key] = {'status': 'unavailable', 'value': None, 'note': 'ดึงข้อมูลไม่สำเร็จหรือข้อมูลเปลี่ยนรูปแบบ', 'source_url': URLS[key]}
            _water_cache = json.loads(json.dumps(result))
            _water_expires = time.monotonic()+(300 if all(r['status'] != 'unavailable' for r in result['readings'].values()) else 30)
        for k, r in result['readings'].items():
            if r['status'] != 'unavailable':
                r['status'] = freshness(r['observed_at'], now, k == 'mae_ngat_storage')
        result['all_available'] = all(r['status'] == 'fresh' for r in result['readings'].values())
        result['checked_at'] = now.isoformat()
        return result


# Combined measurements

RAIN_URL = 'https://api.open-meteo.com/v1/forecast?' + urlencode({
    'latitude':18.7883, 'longitude':98.9853, 'daily':'rain_sum',
    'past_days':8, 'forecast_days':1, 'timezone':'Asia/Bangkok'})

def get_all_inputs():
    now = datetime.now(TZ)
    with ThreadPoolExecutor(max_workers=2) as pool:
        water = pool.submit(get_water_summary)
        rain = pool.submit(fetch, RAIN_URL)
        result = water.result()
        try:
            values, metadata = weather_inputs(rain.result(), now)
            for key in ('rainfall_24h', 'rainfall_7day'):
                result['readings'][key] = {
                    'value':values[key], 'unit':'มม.', 'status':'fresh',
                    'observed_at':metadata[key]['observed_at'],
                    'source':'Open-Meteo (แบบจำลองอากาศ)',
                    'source_url':RAIN_URL, 'station':'พิกัดเมืองเชียงใหม่ 18.7883, 98.9853',
                    'note':('ฝนของวันล่าสุดที่จบแล้ว ไม่ใช่สถานีวัดสด' if key=='rainfall_24h'
                            else 'ฝนสะสม 7 วันก่อนวันเป้าหมาย ไม่รวมวันเป้าหมาย ตามสูตรฝึกโมเดล')}
        except Exception:
            for key in ('rainfall_24h','rainfall_7day'):
                result['readings'][key] = {'value':None,'status':'unavailable',
                    'note':'ดึงฝนไม่สำเร็จหรือข้อมูลช่วง 8 วันไม่ครบ','source_url':RAIN_URL}
    result['water_fetched_at'] = result['fetched_at']
    result['fetched_at'] = now.isoformat()
    result['all_available'] = all(r['status']=='fresh' for r in result['readings'].values())
    result['manual_fields'] = ['month','typhoon_active','soil_moisture']
    result['note'] = 'ข้อมูลต่างช่วงเวลา: ฝนรายวันเป็นค่าประมาณย้อนหลัง น้ำปิง/ฝนต้นน้ำเป็นค่าล่าสุด เขื่อนเป็นรายวัน โปรดตรวจวันที่ก่อนทำนาย'
    return result


# History storage and Excel export

HISTORY_FIELDS = ['rainfall_24h', 'rainfall_7day', 'upstream_rain', 'ping_level', 'mae_ngat_storage']
HISTORY_MANUAL = ['month', 'typhoon_active', 'soil_moisture']
TZ = timezone(timedelta(hours=7))


class HistoryStore:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.db = self.directory / 'history.sqlite3'
        self.excel = self.directory / 'import_history.xlsx'
        with self.connect() as con:
            con.execute('CREATE TABLE IF NOT EXISTS imports (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT UNIQUE NOT NULL, imported_at TEXT NOT NULL, snapshot TEXT NOT NULL, manual TEXT NOT NULL)')

    @contextmanager
    def connect(self):
        con = sqlite3.connect(self.db, timeout=30)
        con.row_factory = sqlite3.Row
        try:
            with con:
                yield con
        finally:
            con.close()

    @staticmethod
    def decode(row):
        return {'id': row['id'], 'imported_at': row['imported_at'],
                'snapshot': json.loads(row['snapshot']), 'manual': json.loads(row['manual'])}

    def by_request(self, request_id):
        with self.connect() as con:
            row = con.execute('SELECT * FROM imports WHERE request_id=?', (request_id,)).fetchone()
        return self.decode(row) if row else None

    def get(self, record_id):
        with self.connect() as con:
            row = con.execute('SELECT * FROM imports WHERE id=?', (record_id,)).fetchone()
        return self.decode(row) if row else None

    def listing(self, offset=0, limit=50):
        with self.connect() as con:
            count = con.execute('SELECT COUNT(*) FROM imports').fetchone()[0]
            rows = con.execute('SELECT * FROM imports ORDER BY id DESC LIMIT ? OFFSET ?', (limit, offset)).fetchall()
        return {'total': count, 'records': [self.decode(r) for r in rows]}

    def series(self, record_id, limit=200):
        with self.connect() as con:
            rows = con.execute('SELECT * FROM imports WHERE id<=? ORDER BY id DESC LIMIT ?', (record_id, limit)).fetchall()
        return [self.decode(r) for r in reversed(rows)]

    def save(self, request_id, snapshot, manual):
        # Serialize database+mirror updates across processes. Excel failures must not lose history.
        warning = None
        with self.connect() as con:
            con.execute('BEGIN IMMEDIATE')
            con.execute('INSERT OR IGNORE INTO imports(request_id,imported_at,snapshot,manual) VALUES(?,?,?,?)',
                        (request_id, datetime.now(TZ).isoformat(), json.dumps(snapshot, ensure_ascii=False, allow_nan=False), json.dumps(manual, allow_nan=False)))
            record = self.decode(con.execute('SELECT * FROM imports WHERE request_id=?', (request_id,)).fetchone())
            records = [self.decode(r) for r in con.execute('SELECT * FROM imports ORDER BY id')]
            try:
                content = self.workbook(records)
                fd, temporary = tempfile.mkstemp(suffix='.xlsx', dir=self.directory)
                try:
                    with os.fdopen(fd, 'wb') as f:
                        f.write(content)
                    os.replace(temporary, self.excel)
                finally:
                    Path(temporary).unlink(missing_ok=True)
            except Exception:
                warning = 'History saved. Excel mirror could not be updated (it may be open in Excel). Use Download Excel on the history page for a current copy.'
        return record, warning

    def export(self):
        with self.connect() as con:
            records = [self.decode(r) for r in con.execute('SELECT * FROM imports ORDER BY id')]
        return self.workbook(records)

    @staticmethod
    def workbook(records):
        book = Workbook()
        summary = book.active
        summary.title = 'Imports'
        summary.append(['Import ID', 'Imported at (Bangkok)', 'Rain daily (mm)', 'Rain prior 7 days (mm)', 'Upstream rain 24h (mm)', 'Ping gauge level (m)', 'Mae Ngat storage (%)', 'Month (manual)', 'Storm 0/1 (manual)', 'Soil index 0–1 (manual)', 'Fresh API fields / 5'])
        details = book.create_sheet('Reading details')
        details.append(['Import ID', 'Field', 'Value', 'Unit', 'Status at import', 'Observation time (Bangkok)', 'Source', 'Station', 'Source URL', 'Notes', 'Volume (million m3)', 'Normal capacity (million m3)', 'Max capacity (million m3)'])
        for record in records:
            readings = record['snapshot'].get('readings', {})
            summary.append([record['id'], datetime.fromisoformat(record['imported_at']).astimezone(TZ).replace(tzinfo=None),
                            *[readings.get(k, {}).get('value') for k in HISTORY_FIELDS],
                            *[record['manual'].get(k) for k in HISTORY_MANUAL],
                            sum(readings.get(k, {}).get('status') == 'fresh' for k in HISTORY_FIELDS)])
            for key in HISTORY_FIELDS:
                r = readings.get(key, {})
                extra = r.get('details', {})
                details.append([record['id'], key, r.get('value'), r.get('unit'), r.get('status'), r.get('observed_at'), r.get('source'), r.get('station'), r.get('source_url'), r.get('note'), extra.get('storage_million_m3'), extra.get('normal_capacity_million_m3'), extra.get('maximum_capacity_million_m3')])
        for sheet in book:
            sheet.freeze_panes = 'C2'
            sheet.auto_filter.ref = sheet.dimensions
            sheet.sheet_view.showGridLines = False
            sheet.row_dimensions[1].height = 44
            for cell in sheet[1]:
                cell.fill = PatternFill('solid', fgColor='12384B')
                cell.font = Font(color='FFFFFF', bold=True, size=11)
                cell.alignment = Alignment(wrap_text=True, vertical='center')
            for i in range(1, sheet.max_column+1):
                sheet.column_dimensions[get_column_letter(i)].width = 24 if sheet == summary else (38 if i in (7, 8, 9, 10) else 25)
            for row in sheet.iter_rows(min_row=2):
                sheet.row_dimensions[row[0].row].height = 34 if sheet == summary else 60
                for cell in row:
                    # Source strings must never become formulas or executable links.
                    if isinstance(cell.value, str):
                        cell.data_type = 's'
                    cell.alignment = Alignment(vertical='center', wrap_text=True)
                    if cell.row % 2 == 0:
                        cell.fill = PatternFill('solid', fgColor='EEF5F8')
                    if isinstance(cell.value, float):
                        cell.number_format = '0.000'
            sheet.print_title_rows = '1:1'
        for row in summary.iter_rows(min_row=2):
            row[1].number_format = 'yyyy-mm-dd hh:mm:ss'
        stream = io.BytesIO()
        book.save(stream)
        return stream.getvalue()


# Weather outlook endpoints

forecast_router = APIRouter()
LOCATIONS = {
    'city': {'name': 'เมืองเชียงใหม่', 'latitude': 18.7883, 'longitude': 98.9853},
    # Coordinates of ThaiWater station id 570949 (MOU001), not a basin average.
    'upstream': {'name': 'บริเวณสถานี MOU001 อำเภอแม่ริม',
                 'latitude': 18.875978, 'longitude': 98.79428},
}
VARIABLES = {
    'rainfall_24h': {'label': 'ฝนเชียงใหม่สะสม 24 ชั่วโมง', 'unit': 'มม.',
        'note': 'ช่วง 24 ชั่วโมงสิ้นสุด ณ เวลาเป้าหมาย รวม rain + showers; ช่วงที่ผ่านไปเป็นค่าจากแบบจำลองอากาศ'},
    'rainfall_7day': {'label': 'ฝนเชียงใหม่ 7 วันก่อนช่วง 24 ชั่วโมง', 'unit': 'มม.',
        'note': 'รวมช่วงเวลาเป้าหมายลบ 8 วัน ถึงลบ 1 วัน ไม่รวมช่วง 24 ชั่วโมงล่าสุด'},
    'upstream_rain': {'label': 'ฝนต้นน้ำสะสม 24 ชั่วโมง', 'unit': 'มม.',
        'note': 'ค่าจากกริดอากาศใกล้สถานี MOU001 ไม่ใช่ค่าตรวจวัดสถานีหรือค่าเฉลี่ยทั้งลุ่มน้ำ'},
    'ping_level': {'label': 'ระดับน้ำปิง', 'unit': 'ม.',
        'note': 'ยังไม่มีแบบจำลองพยากรณ์ระดับน้ำที่ฝึกและตรวจสอบด้วยประวัติสถานี P.1'},
    'mae_ngat_storage': {'label': 'น้ำในเขื่อนแม่งัด', 'unit': '%',
        'note': 'ต้องมีประวัติน้ำไหลเข้า การระบายน้ำ และแบบจำลองสมดุลน้ำ จึงจะพยากรณ์ความจุที่ใช้ได้'},
    'soil_moisture': {'label': 'ความชื้นดินของโมเดล', 'unit': 'ดัชนี 0–1',
        'note': 'ดัชนีจำลองในโมเดลเดิมยังไม่มีตัวพยากรณ์; ค่าความชื้นดิน m³/m³ จากบริการอากาศใช้แทนโดยตรงไม่ได้'},
    'typhoon_active': {'label': 'มีพายุ', 'unit': '0 / 1',
        'note': 'ยังไม่ได้เชื่อมต่อพยากรณ์เส้นทางพายุสำหรับพื้นที่ ไม่อนุมานสถานะจากปริมาณฝน'},
    'month': {'label': 'เดือน ณ เวลาเป้าหมาย', 'unit': 'เดือน',
        'note': 'คำนวณจากปฏิทินประเทศไทย ไม่ใช่ผลพยากรณ์'},
}
RAIN_KEYS = ('rainfall_24h', 'rainfall_7day', 'upstream_rain')
_forecast_cache = None
_forecast_expires = 0.0
_forecast_lock = threading.Lock()


def source_url(location):
    return 'https://api.open-meteo.com/v1/forecast?' + urlencode({
        'latitude': location['latitude'], 'longitude': location['longitude'],
        'hourly': 'rain,showers', 'past_days': 9, 'forecast_days': 9,
        'timezone': 'Asia/Bangkok', 'timeformat': 'unixtime', 'precipitation_unit': 'mm'})


def hourly_rain(data):
    """Each timestamp ends a one-hour accumulation. Keep missing hours missing."""
    units = data['hourly_units']
    if units.get('time') != 'unixtime' or any(units.get(k) != 'mm' for k in ('rain', 'showers')):
        raise ValueError('Unexpected forecast units')
    h = data['hourly']
    if not h['time'] or len({len(h[k]) for k in ('time', 'rain', 'showers')}) != 1:
        raise ValueError('Invalid forecast arrays')
    result = []
    previous = None
    for stamp, rain, showers in zip(h['time'], h['rain'], h['showers']):
        if isinstance(stamp, bool) or not isinstance(stamp, (int, float)) or not math.isfinite(stamp):
            raise ValueError('Invalid time')
        if previous is not None and stamp - previous < 3600:
            raise ValueError('Overlapping or unsorted forecast intervals')
        previous = stamp
        valid = all(not isinstance(v, bool) and isinstance(v, (int, float))
                    and math.isfinite(v) and v >= 0 for v in (rain, showers))
        result.append((stamp, float(rain + showers) if valid else None))
    return result


def accumulation(series, start, end):
    """Allocate partial hourly totals uniformly. Never extrapolate across gaps."""
    if end < start:
        raise ValueError('Invalid accumulation interval')
    if end == start:
        return 0.0 if series else None
    total = covered = 0.0
    for stamp, value in series:
        overlap = max(0, min(end, stamp) - max(start, stamp - 3600))
        if overlap:
            if value is None:
                return None
            covered += overlap
            total += value * overlap / 3600
    if not math.isclose(covered, end - start, abs_tol=0.01):
        return None
    return round(total, 3)


def weather_sources():
    global _forecast_cache, _forecast_expires
    with _forecast_lock:
        if _forecast_cache is not None and time.monotonic() < _forecast_expires:
            return _forecast_cache
        sources = {}
        with ThreadPoolExecutor(max_workers=2) as pool:
            pending = {key: pool.submit(fetch, source_url(loc)) for key, loc in LOCATIONS.items()}
            for key, future in pending.items():
                source = {**LOCATIONS[key], 'source_url': source_url(LOCATIONS[key]),
                          'series': [], 'status': 'unavailable', 'fetched_at': None}
                try:
                    data = future.result()
                    source.update(series=hourly_rain(data), status='available',
                                  fetched_at=datetime.now(TZ).isoformat(),
                                  grid_latitude=data.get('latitude'), grid_longitude=data.get('longitude'))
                except Exception:
                    logging.exception('Weather outlook fetch failed for %s', key)
                sources[key] = source
        _forecast_cache = sources
        _forecast_expires = time.monotonic() + (600 if all(s['status'] == 'available' for s in sources.values()) else 30)
        return sources


def values_at(target, sources):
    end = target.timestamp()
    city, upstream = sources['city']['series'], sources['upstream']['series']
    return {
        'rainfall_24h': accumulation(city, end - 86400, end),
        'rainfall_7day': accumulation(city, end - 8 * 86400, end - 86400),
        'upstream_rain': accumulation(upstream, end - 86400, end),
        'ping_level': None, 'mae_ngat_storage': None, 'soil_moisture': None,
        'typhoon_active': None, 'month': target.month,
    }


def build_outlook(minutes, sources, now):
    now = now.astimezone(TZ)
    step = 15 if minutes <= 60 else 60 if minutes <= 2880 else 360
    leads = sorted({0, minutes, *range(step, minutes, step)})
    points = []
    for lead in leads:
        target = now + timedelta(minutes=lead)
        points.append({'time': target.isoformat(), 'lead_minutes': lead,
                       'values': values_at(target, sources),
                       'city_rain_until_target': accumulation(sources['city']['series'], now.timestamp(), target.timestamp()),
                       'upstream_rain_until_target': accumulation(sources['upstream']['series'], now.timestamp(), target.timestamp())})
    latest = points[-1]
    variables = {}
    for key, definition in VARIABLES.items():
        value = latest['values'][key]
        variables[key] = {**definition, 'value': value,
                          'status': ('calendar' if key == 'month' else 'weather_estimate') if value is not None else 'unavailable'}
    available = sum(latest['values'][k] is not None for k in RAIN_KEYS)
    return {
        'requested_at': now.isoformat(), 'target_time': latest['time'], 'horizon_minutes': minutes,
        'status': 'available' if available == 3 else 'partial' if available else 'unavailable',
        'weather_resolution_minutes': 60, 'chart_step_minutes': step,
        'variables': variables, 'points': points,
        'sources': {k: {field: value for field, value in s.items() if field != 'series'} for k, s in sources.items()},
        'flood_probability': None, 'can_predict_flood': False,
        'note': 'พยากรณ์อากาศเท่านั้น โมเดลจำแนกน้ำท่วมเดิมไม่ได้ฝึกให้พยากรณ์อนาคต',
        'minute_method': 'แบ่งยอดฝนรายชั่วโมงตามสัดส่วนเวลา โดยสมมติว่าฝนสม่ำเสมอในชั่วโมง ไม่ใช่การพยากรณ์ระดับนาทีจากเรดาร์',
        'rain_window_note': 'ยอดสะสมเลื่อนตามเวลาเป้าหมาย ต่างจากฝนตามวันปฏิทินบนหน้ากรอกข้อมูล จึงไม่นำค่าหน้านี้เข้าโมเดลเดิมอัตโนมัติ',
    }


@forecast_router.get('/api/forecast')
def forecast(horizon_minutes: int = Query(default=60, ge=15, le=10080)):
    sources = weather_sources()
    return build_outlook(horizon_minutes, sources, datetime.now(TZ).replace(second=0, microsecond=0))


@forecast_router.get('/forecast', response_class=FileResponse)
def forecast_page():
    return FileResponse(WEBSITE_DIR / 'forecast.html')


@forecast_router.get('/forecast.js', response_class=FileResponse)
def forecast_script():
    return FileResponse(WEBSITE_DIR / 'forecast.js', media_type='text/javascript')


# History endpoints

store = HistoryStore(os.environ.get('HISTORY_DIR', str(BASE_DIR / 'data')))
history_router = APIRouter()

class ImportRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, allow_inf_nan=False)
    request_id: str
    month: int | None = Field(None, ge=1, le=12)
    typhoon_active: int | None = Field(None, ge=0, le=1)
    soil_moisture: float | None = Field(None, ge=0, le=1)

@history_router.post('/api/import')
def import_snapshot(body: ImportRequest):
    try:
        key = str(UUID(body.request_id))
    except ValueError:
        raise HTTPException(422, 'request_id must be a UUID')
    record = store.by_request(key)
    if record:
        return {**record['snapshot'], 'history_id': record['id'], 'imported_at': record['imported_at'], 'excel_warning': None}
    snapshot = get_all_inputs()
    try:
        record, warning = store.save(key, snapshot, {k: getattr(body, k) for k in ('month', 'typhoon_active', 'soil_moisture')})
    except Exception as exc:
        raise HTTPException(500, 'Import could not be saved. Please retry.') from exc
    return {**record['snapshot'], 'history_id': record['id'], 'imported_at': record['imported_at'], 'excel_warning': warning}

@history_router.get('/history')
def history_page():
    return FileResponse(WEBSITE_DIR / 'history.html')

@history_router.get('/history.js')
def history_script():
    return FileResponse(WEBSITE_DIR / 'history.js', media_type='text/javascript')

@history_router.get('/api/history')
def history(offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200)):
    return store.listing(offset, limit)

@history_router.get('/api/history/export.xlsx')
def export():
    return Response(store.export(), media_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', headers={'Content-Disposition': 'attachment; filename="chiangmai_import_history.xlsx"'})

@history_router.get('/api/history/{record_id}')
def detail(record_id: int):
    record = store.get(record_id)
    if record is None:
        raise HTTPException(404, 'Import not found')
    return {'record': record, 'series': store.series(record_id), 'series_limit': 200}


# Prediction app and entry point

MODEL_DIR = Path(os.environ.get("MODEL_DIR", str(BASE_DIR / "models")))
MODEL_PATH = MODEL_DIR / "chiangmai_flood_model.pkl"
SCALER_PATH = MODEL_DIR / "scaler.pkl"
FEATURES_PATH = MODEL_DIR / "features.csv"

if not MODEL_PATH.exists():
    raise FileNotFoundError(f"Model not found at {MODEL_PATH}")
if not FEATURES_PATH.exists():
    raise FileNotFoundError(f"Feature list not found at {FEATURES_PATH}")

model = joblib.load(MODEL_PATH)
# This saved Gradient Boosting estimator was trained on unscaled features.
if type(model).__name__ != "GradientBoostingClassifier":
    raise ValueError("Expected your unscaled GradientBoostingClassifier. Check preprocessing before switching models.")
FEATURES = pd.read_csv(FEATURES_PATH, header=None)[0].tolist()
EXPECTED_FEATURES = ['rainfall_24h', 'rainfall_7day', 'upstream_rain', 'ping_level',
                     'mae_ngat_storage', 'soil_moisture', 'typhoon_active',
                     'month_sin', 'month_cos']
if FEATURES != EXPECTED_FEATURES:
    raise ValueError("features.csv does not match this API's input schema.")
if model.n_features_in_ != len(FEATURES):
    raise ValueError("Model feature count does not match features.csv.")
if hasattr(model, 'feature_names_in_') and list(model.feature_names_in_) != FEATURES:
    raise ValueError("Model feature order does not match features.csv.")
if set(model.classes_.tolist()) != {0, 1}:
    raise ValueError("Expected labels 0=no flood and 1=flood.")
FLOOD_INDEX = model.classes_.tolist().index(1)

app = FastAPI(title="Chiang Mai Flood Predictor")
app.include_router(forecast_router)
app.include_router(history_router)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class PredictionInput(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, strict=True)
    month: int = Field(..., ge=1, le=12)
    rainfall_24h: float = Field(..., ge=0)
    rainfall_7day: float = Field(..., ge=0)
    upstream_rain: float = Field(..., ge=0)
    ping_level: float
    mae_ngat_storage: float = Field(..., ge=0, le=100)
    soil_moisture: float = Field(..., ge=0, le=1)
    typhoon_active: int = Field(..., ge=0, le=1)


@app.get("/", response_class=FileResponse)
def homepage():
    return FileResponse(WEBSITE_DIR / "index.html")


@app.get("/site.js", response_class=FileResponse)
def site_script():
    return FileResponse(WEBSITE_DIR / "site.js", media_type="text/javascript")


@app.get("/api/info")
def root():
    return {
        "status": "ok",
        "model": str(MODEL_PATH.name),
        "features": FEATURES,
    }


@app.get("/api/realtime")
def realtime_data():
    data = dict(get_realtime())
    data['prediction'] = predict(PredictionInput(**data['values'])) if data['complete'] else None
    return data


@app.get("/api/water-summary")
def water_summary():
    return get_all_inputs()


@app.get("/water-panel.js", response_class=FileResponse)
def water_script():
    return FileResponse(WEBSITE_DIR / "water-panel.js", media_type="text/javascript")


@app.get("/health")
def health():
    return {"status": "healthy", "model": type(model).__name__, "use_scale": False}


@app.get("/features")
def features():
    return {"features": FEATURES, "derived_from_month": ["month_sin", "month_cos"]}


def predict_probability(payload: PredictionInput) -> float:
    row = {
        "rainfall_24h": float(payload.rainfall_24h),
        "rainfall_7day": float(payload.rainfall_7day),
        "upstream_rain": float(payload.upstream_rain),
        "ping_level": float(payload.ping_level),
        "mae_ngat_storage": float(payload.mae_ngat_storage),
        "soil_moisture": float(payload.soil_moisture),
        "typhoon_active": int(payload.typhoon_active),
        "month_sin": float(np.sin(2 * np.pi * payload.month / 12)),
        "month_cos": float(np.cos(2 * np.pi * payload.month / 12)),
    }
    X = pd.DataFrame([row], columns=FEATURES)
    model_input = X if hasattr(model, "feature_names_in_") else X.to_numpy()
    ml_prob = float(model.predict_proba(model_input)[0, FLOOD_INDEX])
    if not np.isfinite(ml_prob) or not 0 <= ml_prob <= 1:
        raise ValueError("Model returned an invalid probability.")
    return ml_prob


@app.post("/predict")
def predict(payload: PredictionInput):
    try:
        prob = predict_probability(payload)
    except Exception as exc:
        logging.exception("Prediction failed")
        raise HTTPException(status_code=500, detail="Prediction failed; check server logs.") from exc
    # Existing UI bands retained as display categories, not validated warnings.
    if prob < 0.20:
        risk_level = "ปลอดภัย"
    elif prob < 0.45:
        risk_level = "เฝ้าระวัง"
    elif prob < 0.70:
        risk_level = "เสี่ยงสูง"
    else:
        risk_level = "อันตราย"
    return {
        "prediction": int(prob > 0.5),
        "probability": round(prob, 6),
        "percent": round(prob * 100, 2),
        "risk_level": risk_level,
        "risk_level_basis": "Unvalidated display bands inherited from the existing API",
        "alert": None,
        "ml_model_probability": round(prob, 6),
        "ping_threshold_exceeded": bool(payload.ping_level >= 3.7),
        "ping_threshold_basis": "Existing app reference value; does not alter model probability",
    }


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            message = await ws.receive_text()
            await ws.send_json({"type": "pong", "message": message})
    except WebSocketDisconnect:
        pass


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "8000")))
