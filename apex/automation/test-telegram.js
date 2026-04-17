#!/usr/bin/env node
import { sendReport } from './telegramReports.js';

async function run() {
  const period = process.argv[2] || 'weekly';
  const result = await sendReport({ period, dryRun: false });
  console.log(JSON.stringify(result.response, null, 2));
}

run().catch((err) => {
  console.error('test-telegram error:', err);
  process.exit(1);
});
