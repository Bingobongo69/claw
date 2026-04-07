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
- richer settings/commands flow
- full dashboard command path
- polished end-to-end setup docs for Raul
- likely Glide wiring / final integration pass

## Ops notes
- OpenClaw memory should always be updated after Apex work
- Use this file as stable project state so prior work is not lost between sessions
