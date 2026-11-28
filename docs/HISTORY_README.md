# API import history

Start the app with the same virtual environment:

    cd C:\mlfloodpredicting
    .\myenv.venv\Scripts\python.exe -m api.api

Restart an already-running server and refresh the page with Ctrl+F5.

Click the single API import button to check all nine dashboard fields, fill every
available value, and save an immutable import record. Valid numeric readings also
fill the form when the provider report is old; the card and field both show the
original observation time and an explicit stale-data warning. Missing values,
wrong units, out-of-range values, invalid dates and future timestamps are cleared
with a specific reason beside the field; they are never replaced with zero. A typical import
has seven available fields and two explicitly unavailable model inputs (see below).
Any valid month, storm and model soil-index entries from before the click are saved
separately as manual context, even when the imported fields replace or clear them.
Invalid old entries do not block a new import. Later edits and predictions do not
change that record. Partial/failed readings are recorded with their status.

Open /history or the history link on the main page. Select a record to see its
source timestamps and select a measurement to plot up to 200 imports through that
record. Graph x-axis is import time (Bangkok), not source observation time. Cached
readings may repeat across imports. Stale and missing values create gaps.

Storage:
- data/history.sqlite3: authoritative persistent record database.
- data/import_history.xlsx: automatically refreshed Excel mirror after imports.
- /api/history/export.xlsx: fresh download of all stored records, even if the mirror
  could not be updated because Excel had it open.

Excel has Imports (one row per click, including manual context) and Reading details
(one row per measurement with units, freshness, observation timestamps and sources).
The workbook retains missing readings as blanks and genuine zeroes as numbers.

No previous clicks were saved by the old app. History begins with new imports.
Test records are isolated in the development workspace and were not copied here.

For deployment, keep HISTORY_DIR on persistent storage and install requirements.txt.
Back up the data directory. The page and exports are accessible to anyone who can
access this app; no login system has been added.

New endpoints:
POST /api/import (request_id UUID, optional scope, month, typhoon_active, soil_moisture)
GET /api/soil-moisture
GET /api/rainfall
GET /api/history?offset=0&limit=50
GET /api/history/{id}
GET /api/history/export.xlsx

A reused request_id returns the original record rather than creating a duplicate.
Each new intentional button click has its own request_id.

## Complete dashboard import

The default `all` scope contains the existing six weather/station measurements plus:

- `month`: derived from the latest completed Bangkok calendar day, matching the
  daily rainfall target. On December 1, for example, this is November (11).
- `typhoon_active`: an explicit 0/1 value only when a configured normalized provider
  supplies it. Otherwise it is `null`, with `status: unavailable` and an explanation.
  Missing storm data never means "no storm".
- `soil_moisture`: the classifier's synthetic 0–1 index, only when a configured
  normalized provider supplies that exact input. Otherwise it is `null`; imported
  volumetric soil water content is not substituted.

`available_count`, `requested_count`, and `missing_fields` report the exact import
coverage. `manual_fields` lists prediction inputs still needing an entry. The page
shows all nine reading cards, specific missing-field messages, and inline notes for
month, storm and the model soil index. Importing does not run a prediction.

Cards and form inputs use the same validation. Age is evaluated against the server's
check timestamp, so a misconfigured device clock does not reject a valid reading.
The form summary separates imported stale readings from fields that cannot be
filled. API freshness counts and saved history statuses remain unchanged: a stale
reading may be filled for reference while still appearing in `missing_fields`
(fields without fresh data). History charts continue to leave gaps for stale data.

The existing `FLOOD_DATA_URL` / `FLOOD_DATA_TOKEN` adapter can supply storm and model
soil-index values using the [normalized realtime contract](REALTIME_README.md).
Their required units are `0_or_1` and `index_0_1`, respectively. It must define how
the data corresponds to the trained features. Values must be finite, in range,
timestamped with a timezone, at most one hour old and no more than five minutes in
the future. The month always comes from the calendar-day rainfall target.
Missing, invalid or failed provider data stays unavailable; provider credentials
are not included in history or exports.

History, charts and Excel include all nine fields. Imported month/storm/index
columns are distinct from the manual values captured before import. Older records
remain unchanged and show blanks for fields they did not contain.

## Soil moisture and rainfall imports

`GET /api/soil-moisture` returns `readings.soil_moisture_vwc`: Open-Meteo
volumetric soil water content at 0–1 cm depth for Chiang Mai (18.7883, 98.9853),
in **m³/m³**. The latest hourly timestamp at or before the current Bangkok time
is selected. This is a weather model estimate, not a station observation.
Readings older than three hours are marked stale; future values are excluded.
Wrong units, missing latest values, invalid timestamps, nonfinite values and values
outside 0–1 are unavailable, with no substitution from earlier hours or with zero.
The response includes the source URL, depth, observation time and returned grid coordinates.

This measurement is displayed in its own read-only form field and included in
history, charts and both Excel sheets. It is **not** the synthetic `soil_moisture`
index used by the saved classifier. That index requires a matching normalized
provider or a manual entry;
there is no calibrated conversion from volumetric water content to this model's
index. `model_compatible: false` is included on available soil readings. Old records
remain unchanged and show a blank for the new measurement.

`GET /api/rainfall` returns three readings in millimetres:

- `rainfall_24h`: Open-Meteo `rain_sum` for the latest completed Bangkok calendar day.
- `rainfall_7day`: sum of the seven days before that day, excluding it.
- `upstream_rain`: ThaiWater MOU001 station's latest 24-hour total.

City rainfall keeps the existing `rain_sum` definition; it is not a rolling
24-hour total or the forecast page's `rain + showers` total. Incomplete daily
windows remain unavailable. Genuine zero rainfall is imported as zero.

These GET endpoints never save history. To fetch and persist a snapshot, use
`POST /api/import` with `scope` set to `all` (default, backward compatible),
`rainfall`, or `soil_moisture`, for example:

```json
{
  "request_id": "0a4f762c-4b96-4778-83ec-cb82a672b780",
  "scope": "soil_moisture"
}
```

Generate a new UUID for each new import; reusing this example UUID returns the
original record. Each record's `scope` identifies which readings were requested.
The Excel summary records fresh and requested counts separately, so older and
selective imports do not imply nine readings were requested. Manual
`soil_moisture` in the POST body still means the model index, not imported m³/m³.

Rain and soil data share one cached Open-Meteo response. Each is validated
independently, so missing soil data does not discard valid rainfall, or vice versa.
Soil-only requests do not contact ThaiWater. Provider reference:
[Open-Meteo hourly soil moisture and daily rainfall documentation](https://open-meteo.com/en/docs).

## Provider failures on hosted deployments

The import can save a history record even when an upstream provider is unavailable.
Check each reading's status and note; a saved record does not mean all requested values
were fetched. Unavailable values stay blank, including when the provider returns
HTTP 429 (Too Many Requests).

Open-Meteo responses are shared between imports and realtime requests for five
minutes. Concurrent identical requests share one fetch. Failed requests are cached
for 30 seconds; HTTP 429 pauses all new Open-Meteo requests for the provider's
Retry-After duration (five minutes if absent). Existing unexpired successful cache
entries remain usable. The daily cache resets when the Bangkok calendar day changes.
Transport failures and HTTP 502/503/504 are retried once, but 429 is not immediately
retried. The import button waits up to 90 seconds to allow a sleeping host to start.

If a hosted server continues receiving 429 after the cooldown, caching cannot
restore the provider's quota. Wait for the quota to reset or, if you already have
an Open-Meteo subscription, configure `OPEN_METEO_API_KEY` in the host's environment
and redeploy. This selects the official `customer-api.open-meteo.com` endpoint for
both imports and forecasts. Without a key the free endpoint is used. Keys stay on
the server and are not included in source links, history exports, or error messages.
See https://open-meteo.com/en/pricing for the provider's current limits and plans.

Run regression checks from the project root. The endpoint tests also need
`httpx==0.28.1` in the test environment (not needed to run the app):

```powershell
.\myenv.venv\Scripts\python.exe -m pip install httpx==0.28.1
.\myenv.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'
node --test tests/water-import.test.cjs
```
