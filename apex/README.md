# Apex

Apex = Glide frontend + Google Sheets backend + server-side logic.

## Apps Script (Google Sheets Web App)

1. Open your Google Sheet.
2. Extensions -> Apps Script
3. Paste `appsscript/Code.gs` into Code.gs
4. Deploy -> New deployment -> Web app
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy the Web app URL.

Test:
- Open `<WEBAPP_URL>?action=ping` in browser => `{ ok: true, ... }`

## Backend server

Set env:
- `APEX_SHEETS_WEBAPP_URL=<your webapp url>`

Run:
- `npm run start`

Endpoints:
- `GET /health`
- `GET /sheets/ping`
- `GET /metrics`
- `POST /sourcing/check` body: `{ expectedVk:number, ek:number, sku?:string }`

## Notes

- Fee model is currently default 12% + 0.35 EUR. Category-based fee mapping will be added.
