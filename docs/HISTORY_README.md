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
