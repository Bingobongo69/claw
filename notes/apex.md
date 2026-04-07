# Apex project note

## What it is
- E-commerce app
- Glide frontend
- Google Sheets backend via Apps Script
- Node/Express backend in `apex/`

## Current status (2026-04-07)
- Apps Script API exists in `apex/appsscript/Code.gs`
- Node server exists in `apex/server/index.js`
- Endpoints implemented:
  - `GET /health`
  - `GET /sheets/ping`
  - `GET /metrics`
  - `POST /sourcing/check`
- Fee lookup from `Fees` sheet is implemented
- SKU parsing exists for EK/VK/VP-style tokens

## Still incomplete
- final Glide wiring / visual setup pass inside Glide
- optional richer dashboard polish beyond current API endpoints

## Verified on 2026-04-07
- Google Apps Script Web App URL received and saved in `apex/.env`
- Local `/health` OK
- Local `/sheets/ping` OK
- Local `/bootstrap` OK
- Local `/settings` OK and returned default settings
- Render service created successfully
- Public backend URL live: `https://apex-app-610g.onrender.com`
- Public `/health` OK
- Public `/settings` OK

## Newly completed on 2026-04-07
- Settings sheet bootstrap flow
- Todos sheet bootstrap flow
- `/settings` read/write backend endpoints
- `/todos` read/write backend endpoints
- `/bootstrap` endpoint
- `/command` actions for settings/todo/bootstrap
- README expanded with Glide setup guidance
- `/metrics` now reports Umsatz (VK) progress vs Jahresgoal and exposes revenue totals
- Monatsübersicht → Fixkosten column is read bottom-up so the newest monthly fixed-cost value drives sourcing + metrics

## Ops notes
- OpenClaw memory should always be updated after Apex work
- Use this file as stable project state so prior work is not lost between sessions
