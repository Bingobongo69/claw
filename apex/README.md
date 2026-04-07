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
6. Call `POST /bootstrap` once from the backend after setting the URL, or manually hit the Apps Script with `{ "action": "bootstrap" }`

This creates:
- `Fees`
- `Settings`
- `Todos`

Test:
- Open `<WEBAPP_URL>?action=ping` in browser => `{ ok: true, ... }`

## Backend server

Set env:
- `APEX_SHEETS_WEBAPP_URL=<your webapp url>`

Run:
- `npm install`
- `npm run start`

Endpoints:
- `GET /health`
- `GET /sheets/ping`
- `GET /metrics`
- `GET /settings`
- `POST /settings` body: `{ key, value, type?, note? }`
- `GET /todos`
- `POST /todos` body: `{ title, status?, owner?, note? }`
- `POST /bootstrap`
- `POST /sourcing/check` body: `{ expectedVk:number, ek:number, sku?:string, categoryHint?:string }`
- `POST /command` body:
  - `{ command:"set_gkv_limit", value:number }`
  - `{ command:"set_profit_goal", value:number }`
  - `{ command:"add_todo", title:string }`
  - `{ command:"bootstrap" }`
- `GET /audit/listings?limit=50`
  - pulls aktive eBay-Angebote, bewertet Titel/Beschreibung/Preis/Bilder/SEO und gibt Score + Vorschläge zurück
  - benötigt `EBAY_CLIENT_ID`, `EBAY_CERT_ID`, `EBAY_REFRESH_TOKEN` in der Umgebung

## Glide setup

Suggested Glide tabs / views:
- **Dashboard**
  - source: `GET /metrics`
  - show: monthly profit, total profit, GKV remaining, goal progress
- **Sourcing Check**
  - input fields: expected VK, EK, SKU, category
  - action: POST `/sourcing/check`
  - output: GO/NO-GO, profit, margin, fees, shipping cost
- **Fees**
  - sheet-backed table from Google Sheet `Fees`
- **Settings**
  - source: `GET /settings`
  - edit via `POST /settings`
- **Todos**
  - source: `GET /todos`
  - create via `POST /todos`

## Notes

- Fee model now supports category-based fee mapping plus Settings-based defaults.
- Settings currently include defaults like `gkvLimit`, `profitGoal`, `defaultFeePct`, `defaultFeeFix`, `currency`.
