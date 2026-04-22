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

export async function sendReport({ period = 'weekly', dryRun = false } = {}) {
  if (!PERIODS[period]) {
    throw new Error(`Unsupported period: ${period}`);
  }
  const baseUrl = process.env.APEX_BASE_URL || 'https://apex-app-610g.onrender.com';
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const effectiveDryRun = Boolean(dryRun || process.env.DRY_RUN === '1');
  if (!effectiveDryRun && (!token || !chatId)) throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');

  const lookbackDays = PERIODS[period].lookbackDays;
  const tz = process.env.REPORT_TIMEZONE || 'Europe/Berlin';
  const [metrics, inventory, report, summary] = await Promise.all([
    fetchJson(baseUrl, '/metrics'),
    fetchJson(baseUrl, '/inventory'),
    fetchJson(baseUrl, `/reports/weekly?days=${lookbackDays}&tz=${encodeURIComponent(tz)}`),
    fetchJson(baseUrl, `/reports/summary?period=${encodeURIComponent(period)}&target=${encodeURIComponent(process.env.REVENUE_TARGET || '25000')}`)
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

  const probability = summary?.forecast?.probability || 0;
  const probabilityLabel = summary?.forecast?.label || 'unbekannt';
  const projectedMonthRevenue = summary?.forecast?.projectedMonthRevenue || 0;
  const inventoryCapMonthly = summary?.forecast?.inventoryCapMonthly || 0;
  const topSeller = summary?.topSeller;

  const summaryLines = [
    `📊 ${PERIODS[period].label}`,
    report.range ? `Zeitraum: ${formatRange(report.range)}` : `Zeitraum: letzte ${lookbackDays} Tage`,
    `Bestellmenge: ${report.totals?.orders || summary?.totals?.count || 0}`,
    `Umsatz: ${formatEuro(summary?.totals?.revenue ?? report.totals?.revenue || 0)}`,
    `Gewinn: ${formatEuro(summary?.totals?.profit ?? report.totals?.profit || 0)} (${formatPercent((summary?.totals?.roi || report.totals?.grossMargin || 0) * 100)})`,
    topSeller ? `Top-Seller: ${topSeller.title || topSeller.sku || '-'} (${formatEuro(topSeller.profit || 0)} Gewinn)` : 'Top-Seller: -',
    '',
    '📦 Lager',
    `Einstellwert: ${formatEuro(inventoryTotals.listTotal)}`,
    `Einkaufswert: ${formatEuro(inventoryTotals.ekTotal)}`,
    '',
    '💰 Gesamtstand',
    `Gesamtumsatz: ${formatEuro(totalRevenue)}`,
    `Gesamtgewinn: ${formatEuro(totalProfit)}`,
    `Fortschritt 25k-Ziel: ${progressBar}`,
    `Jahresziel-Wahrscheinlichkeit: ${probability.toFixed(1)}% (${probabilityLabel})`,
    `Monats-Hochrechnung konservativ: ${formatEuro(projectedMonthRevenue)}`,
    `Bestandsdeckel (Einstellwert): ${formatEuro(inventoryCapMonthly)}`,
    '',
    `🧭 Plan: ${planText}`
  ];

  const message = summaryLines.join('\n');
  const reportLogPayload = {
    period,
    from: report?.range?.start || '',
    to: report?.range?.end || '',
    revenue: Number(summary?.totals?.revenue || report?.totals?.revenue || 0),
    profit: Number(summary?.totals?.profit || report?.totals?.profit || 0),
    roi: Number(summary?.totals?.roi || report?.totals?.grossMargin || 0),
    topSeller: topSeller ? (topSeller.title || topSeller.sku || '') : '',
    targetLikelihood: `${probability.toFixed(1)}% (${probabilityLabel})`
  };
  if (effectiveDryRun) {
    return { ok: true, dryRun: true, message, reportLogPayload };
  }
  const telegramUrl = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(telegramUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message })
  });
  const bodyText = await res.text();
  let parsed;
  try { parsed = JSON.parse(bodyText); } catch { parsed = bodyText; }
  if (!res.ok || (parsed && parsed.ok === false)) {
    throw new Error(`Telegram send failed: ${bodyText}`);
  }

  try {
    const logRes = await fetch(`${baseUrl.replace(/\/$/, '')}`, { method: 'GET' });
    void logRes;
  } catch {}

  try {
    await fetch(`${baseUrl.replace(/\/$/, '')}/reports/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reportLogPayload)
    });
  } catch (err) {
    console.error('report log write failed:', err?.message || err);
  }

  return { ok: true, dryRun: false, response: parsed, message, reportLogPayload };
}

async function main() {
  const args = parseArgs();
  const result = await sendReport({ period: args.period || 'weekly', dryRun: Boolean(args['dry-run']) });
  if (result.dryRun) {
    console.log('--- DRY RUN ---');
    console.log(result.message);
    console.log('---------------');
  } else {
    console.log(`Sent report (${result.response?.result?.message_id || 'ok'})`);
  }
}
const directRun = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (directRun) {
  main().catch((err) => {
    console.error('telegramReports error:', err);
    process.exit(1);
  });
}
