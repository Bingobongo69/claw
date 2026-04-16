#!/usr/bin/env node

const PERIODS = {
  weekly: { label: 'Wöchentlicher Report', lookbackDays: 7, scheduleHint: 'Montag' },
  monthly: { label: 'Monatsreport', lookbackDays: 31, scheduleHint: '1. des Monats' },
  yearly: { label: 'Jahresreport', lookbackDays: 365, scheduleHint: '1. Januar' }
};

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
      out[key] = value;
    }
  }
  return out;
}

function formatEuro(value) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Number(value || 0));
}

function formatPercent(value) {
  return `${value.toFixed(1)}%`;
}

function calcDaysLeft(period) {
  const now = new Date();
  if (period === 'weekly') {
    const day = now.getDay();
    const remaining = 7 - day;
    return remaining === 0 ? 7 : remaining;
  }
  if (period === 'monthly') {
    const year = now.getFullYear();
    const month = now.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    return Math.max(1, daysInMonth - now.getDate());
  }
  if (period === 'yearly') {
    const endOfYear = new Date(now.getFullYear(), 11, 31);
    const diffMs = endOfYear - now;
    return Math.max(1, Math.ceil(diffMs / 86400000));
  }
  return 7;
}

function buildProgressBar(progressPct) {
  const steps = 10;
  const filled = Math.min(steps, Math.round((progressPct / 100) * steps));
  const empty = steps - filled;
  return `${'█'.repeat(filled)}${'░'.repeat(empty)} ${progressPct.toFixed(1)}%`;
}

function parseNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const normalized = value.replace(/[^0-9,.-]/g, '').replace(',', '.');
    const n = Number(normalized);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function sumInventory(inventory) {
  const header = inventory.header || [];
  const rows = inventory.rows || [];
  const map = {};
  header.forEach((h, i) => { map[String(h || '').trim()] = i; });
  const listIdx = map['Einstellwert'] ?? map['ListPrice'] ?? map['VK'];
  const ekIdx = map['Einkaufswert'] ?? map['EK'] ?? map['Einkauf'];
  let listTotal = 0;
  let ekTotal = 0;
  for (const row of rows) {
    if (listIdx !== undefined) listTotal += parseNumber(row[listIdx]);
    if (ekIdx !== undefined) ekTotal += parseNumber(row[ekIdx]);
  }
  return { listTotal, ekTotal };
}

async function fetchJson(baseUrl, path) {
  const res = await fetch(`${baseUrl}${path}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} for ${path}: ${text}`);
  }
  return res.json();
}

function formatRange(range) {
  if (!range?.start || !range?.end) return '';
  const start = new Date(range.start);
  const end = new Date(range.end);
  const fmt = (d) => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
  return `${fmt(start)} – ${fmt(end)}`;
}

function buildPlanText(period, remaining, daysLeft) {
  if (remaining <= 0) return 'Ziel erreicht – Fokus auf Profit und Lagerumschlag.';
  const perDay = remaining / Math.max(1, daysLeft);
  return `Es fehlen ${formatEuro(remaining)} zum Ziel. Empfohlen: ${formatEuro(perDay)} Einstellwert pro Tag (${period}).`;
}

async function main() {
  const args = parseArgs();
  const period = args.period || 'weekly';
  if (!PERIODS[period]) {
    throw new Error(`Unsupported period: ${period}`);
  }
  const baseUrl = process.env.APEX_BASE_URL || 'https://apex-app-610g.onrender.com';
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const dryRun = Boolean(args['dry-run'] || process.env.DRY_RUN === '1');
  if (!dryRun && (!token || !chatId)) throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');

  const lookbackDays = PERIODS[period].lookbackDays;
  const tz = process.env.REPORT_TIMEZONE || 'Europe/Berlin';
  const [metrics, inventory, report] = await Promise.all([
    fetchJson(baseUrl, '/metrics'),
    fetchJson(baseUrl, '/inventory'),
    fetchJson(baseUrl, `/reports/weekly?days=${lookbackDays}&tz=${encodeURIComponent(tz)}`)
  ]);

  const inventoryTotals = sumInventory(inventory);
  const totalRevenue = Number(metrics.totalRevenue || 0);
  const totalProfit = Number(metrics.totalProfit || 0);
  const target = Number(process.env.REVENUE_TARGET || metrics.revenueGoal || 25000);
  const remaining = Math.max(0, target - totalRevenue);
  const daysLeft = calcDaysLeft(period);
  const planText = buildPlanText(period, remaining, daysLeft);
  const progressPct = target > 0 ? (totalRevenue / target) * 100 : 0;
  const progressBar = buildProgressBar(Math.min(100, progressPct));

  const summaryLines = [
    `📊 ${PERIODS[period].label}`,
    report.range ? `Zeitraum: ${formatRange(report.range)}` : `Zeitraum: letzte ${lookbackDays} Tage`,
    `Bestellmenge: ${report.totals?.orders || 0}`,
    `Umsatz: ${formatEuro(report.totals?.revenue || 0)}`,
    `Gewinn: ${formatEuro(report.totals?.profit || 0)} (${formatPercent(report.totals?.grossMargin ? report.totals.grossMargin * 100 : 0)})`,
    '',
    '📦 Lager',
    `Einstellwert: ${formatEuro(inventoryTotals.listTotal)}`,
    `Einkaufswert: ${formatEuro(inventoryTotals.ekTotal)}`,
    '',
    '💰 Gesamtstand',
    `Gesamtumsatz: ${formatEuro(totalRevenue)}`,
    `Gesamtgewinn: ${formatEuro(totalProfit)}`,
    `Fortschritt 25k-Ziel: ${progressBar}`,
    '',
    `🧭 Plan: ${planText}`
  ];

  const message = summaryLines.join('\n');
  if (dryRun) {
    console.log('--- DRY RUN ---');
    console.log(message);
    console.log('---------------');
  } else {
    const telegramUrl = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(telegramUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message })
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Telegram send failed: ${text}`);
    }
    console.log(`Sent ${period} report to Telegram chat ${chatId}`);
  }
}

main().catch((err) => {
  console.error('telegramReports error:', err);
  process.exit(1);
});
