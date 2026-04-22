# Apex Redeploy Checklist

## 1) Apps Script aktualisieren
- Google Sheet öffnen
- `Erweiterungen -> Apps Script`
- Inhalt von `apex/appsscript/Code.gs` komplett ersetzen
- Speichern

## 2) Web App neu deployen
- `Bereitstellen -> Neue Bereitstellung` oder `Bereitstellungen verwalten -> Bearbeiten`
- Typ: `Web-App`
- Ausführen als: `Ich`
- Zugriff: `Jeder mit dem Link`
- Deploy
- Web-App-URL kopieren

## 3) Render Env prüfen
Web-Service `apex`:
- `APEX_SHEETS_WEBAPP_URL` = neue Apps-Script-Web-App-URL
- `TELEGRAM_BOT_TOKEN` gesetzt
- `TELEGRAM_CHAT_ID` gesetzt

Cron-Services prüfen:
- `APEX_BASE_URL=https://apex-app-610g.onrender.com`
- `REVENUE_TARGET=25000`
- `REPORT_TIMEZONE=Europe/Berlin`
- `TELEGRAM_BOT_TOKEN` gesetzt
- `TELEGRAM_CHAT_ID` gesetzt

## 4) Render neu deployen
- Repo/Branch syncen
- Web service redeployen
- Cron services redeployen

## 5) Smoke Tests
Browser/API testen:
- `/health`
- `/metrics`
- `/sales?range=7d`
- `/dashboard?range=7d`
- `/reports/summary?period=weekly`

Manuell prüfen:
- Sales-Filter funktionieren
- Suche Titel/SKU funktioniert
- Sortierung VK/Gewinn funktioniert
- Retoure setzt Gewinn negativ auf `0 - EK - Versand`
- Leere EK/Versand können per SKU-Sync gefüllt werden
- Telegram-Report sendet
- Report landet zusätzlich im Sheet `Reports`
