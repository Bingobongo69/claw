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
- `/health` OK
- `/sheets/ping` OK
- `/bootstrap` OK
- `/settings` OK and returned default settings

## Newly completed on 2026-04-07
- Settings sheet bootstrap flow
- Todos sheet bootstrap flow
- `/settings` read/write backend endpoints
- `/todos` read/write backend endpoints
- `/bootstrap` endpoint
- `/command` actions for settings/todo/bootstrap
- README expanded with Glide setup guidance

## Ops notes
- OpenClaw memory should always be updated after Apex work
- Use this file as stable project state so prior work is not lost between sessions
