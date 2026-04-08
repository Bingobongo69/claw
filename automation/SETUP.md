# SETUP – SMTP für Auto-Mailings

1. SMTP-Zugang anlegen (z. B. mailbox.org, Sendgrid o. Ä.).
2. `.env` erweitern:
   ```
   SMTP_HOST=smtp.example.com
   SMTP_PORT=587
   SMTP_USER=ankauf@example.com
   SMTP_PASS=***
   SMTP_FROM="Raul | Apex" <ankauf@example.com>
   ```
3. In `automation/mailer.js` (noch zu erstellen) werden die Werte automatisch eingelesen.
4. Testlauf:
   ```bash
   node automation/mailer.js --template warmup --to test@firma.de
   ```
5. Nach erfolgreichem Test Terminierung definieren (z. B. via cron oder Render Cron Job).
