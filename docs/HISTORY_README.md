# API import history

Start the app with the same virtual environment:

    cd C:\mlfloodpredicting
    .\myenv.venv\Scripts\python.exe -m api.api

Restart an already-running server and refresh the page with Ctrl+F5.

Click the API import button to fetch the five measurements, fill the form, and save
an immutable import record. The three manual fields are captured as entered at the
moment of clicking; empty manual fields stay blank. Later edits and predictions do
not change that record. Partial/failed readings are recorded with their status.

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
POST /api/import (request_id UUID, optional month, typhoon_active, soil_moisture)
GET /api/history?offset=0&limit=50
GET /api/history/{id}
GET /api/history/export.xlsx

A reused request_id returns the original record rather than creating a duplicate.
Each new intentional button click has its own request_id.

## Provider failures on hosted deployments

The import can save a history record even when an upstream provider is unavailable.
Check each reading's status and note; a saved record does not mean all five values
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

Run regression checks from the project root:

```powershell
.\myenv.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'
node --test tests/water-import.test.cjs
```
