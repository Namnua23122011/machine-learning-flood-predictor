# Future outlook

Open http://localhost:8000/forecast, or select **พยากรณ์ล่วงหน้า / Future outlook** on the homepage. Choose 15/30 minutes, 1/3/6/12 hours, 1/3 days, or 1 week. Changing the horizon reloads the outlook. The metric selector changes the graph and the expandable table.

API: `GET /api/forecast?horizon_minutes=60` (integer from 15 to 10080). Open `/docs` to try it. No API key or additional Python package is required. The server needs internet access to Open-Meteo. Successful source responses are cached for 10 minutes; failures for 30 seconds. The button reuses that cache when valid. Source fetch timestamps are displayed; they are not weather model issue times. The API uses HTTP 200 with `status=partial` or `unavailable` for source outages, with missing numeric values represented by JSON null.

## Available values

- Chiang Mai rain: hourly Open-Meteo `rain + showers` at 18.7883, 98.9853, integrated over the last 24 hours ending at the selected future time.
- Previous seven days: local rain from target minus eight days through target minus one day, excluding the most recent 24 hours.
- Upstream rain: the same 24-hour calculation at 18.875978, 98.79428, the coordinates published for ThaiWater station 570949 / MOU001. This is a weather model grid estimate near the station, not a station measurement or catchment average. The API/UI also expose the actual returned grid coordinates.
- Two additional totals: rain from the outlook start through the selected future time, for city and upstream locations.
- Month: Bangkok calendar month at the target time.

All time windows use Bangkok time. Hourly rain timestamps mark the end of an accumulation interval. A partial hour receives a proportional share of that hour's total, assuming uniform rain within the hour. This is an estimate, not minute-resolution radar nowcasting. The graphs use 15-minute points through one hour, hourly points through two days, then six-hour points, including the exact selected endpoint. Graph sampling frequency does not increase source accuracy. Missing intervals, null/invalid amounts, wrong units, and incomplete coverage never become zero or an extrapolated number.

The endpoint requests nine past and nine forecast calendar days to cover a full rolling eight-day history and seven days ahead even late in the current day. Historical values in the window also come from the weather model, not measured observations. These rolling totals differ from the main form's calendar-day totals. Outlook rainfall includes `showers` as well as `rain`; the older form's `rain_sum` source uses its existing definition. Outlook values are therefore not automatically inserted into the old classifier.

## Variables that still need forecasting models

`ping_level`, `mae_ngat_storage`, `soil_moisture`, and `typhoon_active` are null at every future time. The API sets `can_predict_flood=false` and `flood_probability=null`. It never calls or retrains the saved Gradient Boosting classifier. That model was trained on synthetic contemporaneous daily features, with the flood label generated from river level. It is not a model trained to predict future values.

As of installation, the import database contained three snapshots, insufficient to train and evaluate station forecasting models. To add river forecasts, collect timestamped P.1 gauge levels, upstream rain/flow and local rain over multiple wet seasons and flood events. Dam storage forecasts additionally require inflow, release and operating information. Preserve observation times and units, remove duplicate cached observations, train separate lead-time targets, and test on later periods/events rather than randomly splitting adjacent rows. Fit preprocessing on training periods only and compare against persistence/seasonal baselines. Use archived forecasts available at each historical forecast issue time when testing weather-driven predictions. The synthetic soil index needs a defined real-world counterpart and calibration; volumetric soil moisture is not directly interchangeable. A cyclone track feed needs a documented rule for the binary storm feature.

The forecast page neither writes weather forecasts into observation history nor changes the saved PKL files. The existing API-import button and Excel history remain in place.

Source reference: https://open-meteo.com/en/docs (hourly variable definitions, UNIX timestamps and forecast range). Files: `api/api.py`, `website/forecast.html`, `website/forecast.js`; all backend endpoints are in `api/api.py`.
