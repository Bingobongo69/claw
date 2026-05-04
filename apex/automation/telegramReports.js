#!/usr/bin/env node

const PERIODS = {
  weekly: { label: 'Wöchentlicher Report', lookbackDays: 7, scheduleHint: 'Montag' },
  monthly: { label: 'Monatsreport', lookbackDays: 31, scheduleHint: '1. des Monats' },
  quarterly: { label: 'Quartalsreport', lookbackDays: 92, scheduleHint: '1. Tag des Quartals' },
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
  if (period === 'quarterly') {
    const currentQuarter = Math.floor(now.getMonth() / 3);
    const endMonth = (currentQuarter * 3) + 2;
    const endOfQuarter = new Date(now.getFullYear(), endMonth + 1, 0);
    const diffMs = endOfQuarter - now;
    return Math.max(1, Math.ceil(diffMs / 86400000));
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
  const fmt = (d) => `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.`;
  return `${fmt(start)} – ${fmt(end)}`;
}

function describePeriod({ period, report, lookbackDays, year, month, quarter }) {
  if (period === 'monthly' && year && month) {
    return `Zeitraum: ${String(month).padStart(2, '0')}.${year}`;
  }
  if (period === 'quarterly' && year && quarter) {
    return `Zeitraum: Q${quarter} ${year}`;
  }
  if (period === 'yearly' && year) {
    return `Zeitraum: ${year}`;
  }
  return report.range ? `Zeitraum: ${formatRange(report.range)}` : `Zeitraum: letzte ${lookbackDays} Tage`;
}

function buildPlanText(period, remaining, daysLeft) {
  if (remaining <= 0) return 'Ziel erreicht – Fokus auf Profit und Lagerumschlag.';
  const perDay = remaining / Math.max(1, daysLeft);
  return `Es fehlen ${formatEuro(remaining)} zum Ziel. Empfohlen: ${formatEuro(perDay)} Einstellwert pro Tag (${period}).`;
}

function getMonthlyBounds(year, month) {
  const start = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
  const endDate = new Date(Date.UTC(Number(year), Number(month), 0));
  const end = `${String(endDate.getUTCFullYear()).padStart(4, '0')}-${String(endDate.getUTCMonth() + 1).padStart(2, '0')}-${String(endDate.getUTCDate()).padStart(2, '0')}`;
  return { start, end };
}

function getQuarterBounds(year, quarter) {
  const startMonth = (Number(quarter) - 1) * 3 + 1;
  const start = `${String(year).padStart(4, '0')}-${String(startMonth).padStart(2, '0')}-01`;
  const endDate = new Date(Date.UTC(Number(year), startMonth + 2, 0));
  const end = `${String(endDate.getUTCFullYear()).padStart(4, '0')}-${String(endDate.getUTCMonth() + 1).padStart(2, '0')}-${String(endDate.getUTCDate()).padStart(2, '0')}`;
  return { start, end };
}

function getYearBounds(year) {
  return {
    start: `${String(year).padStart(4, '0')}-01-01`,
    end: `${String(year).padStart(4, '0')}-12-31`
  };
}

function buildComparisonLabel(period) {
  if (period === 'weekly') return 'vs. Vorwoche';
  if (period === 'monthly') return 'vs. Vormonat';
  if (period === 'quarterly') return 'vs. Vorquartal';
  if (period === 'yearly') return 'vs. Vorjahr';
  return 'vs. Vergleichszeitraum';
}

function formatDelta(current, previous, kind = 'currency') {
  const curr = Number(current || 0);
  const prev = Number(previous || 0);
  const diff = curr - prev;
  const pct = prev !== 0 ? (diff / prev) * 100 : null;
  const prefix = diff > 0 ? '+' : diff < 0 ? '-' : '±';
  const abs = Math.abs(diff);
  const valueText = kind === 'percent'
    ? `${prefix}${formatPercent(abs * 100)}`
    : kind === 'count'
      ? `${prefix}${Math.round(abs)}`
      : `${prefix}${formatEuro(abs)}`;
  if (pct === null) return `${valueText} (neu/kein Vergleich)`;
  return `${valueText} / ${prefix}${formatPercent(Math.abs(pct))}`;
}

function buildRecommendation({ periodRevenue, periodProfit, periodRoi, inventoryTotals, forecast, previousRevenue, previousProfit }) {
  const recs = [];
  if (previousRevenue && periodRevenue < previousRevenue) recs.push('Umsatz unter Vergleichszeitraum: Listings-Nachschub und Conversion-Bremsen prüfen.');
  if (previousProfit && periodProfit < previousProfit) recs.push('Gewinn schwächer als Vergleich: Gebühren, EK und Versandkosten bei Ausreißern prüfen.');
  if (periodRoi < 0.35) recs.push('ROI zu niedrig: Fokus auf margenträchtigere Kategorien und strengere Einkaufsfilter.');
  if (inventoryTotals.listTotal > 0 && periodRevenue > 0) {
    const turnover = periodRevenue / inventoryTotals.listTotal;
    if (turnover < 0.25) recs.push('Lagerumschlag niedrig: ältere Bestände priorisiert repricen oder aktiv abverkaufen.');
  }
  if ((forecast?.probability || 0) < 60) recs.push('Zielwahrscheinlichkeit niedrig: Pace bei Listings und umsatzstarken SKUs erhöhen.');
  if (!recs.length) recs.push('Solide Entwicklung: aktuellen Listing- und Margenmix beibehalten, Top-Seller stärker ausbauen.');
  return recs.slice(0, 3);
}

export async function sendReport({ period = 'weekly', dryRun = false, year, month, quarter } = {}) {
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
  const target = Number(process.env.REVENUE_TARGET || 25000);
  const summaryParams = new URLSearchParams({ period, target: String(target) });
  if (year) summaryParams.set('year', String(year));
  if (month) summaryParams.set('month', String(month));
  if (quarter) summaryParams.set('quarter', String(quarter));

  let weeklyPath = `/reports/weekly?days=${lookbackDays}&tz=${encodeURIComponent(tz)}`;
  let comparisonParams = null;
  if (period === 'monthly' && year && month) {
    const { start, end } = getMonthlyBounds(year, month);
    const prevMonth = Number(month) === 1 ? 12 : Number(month) - 1;
    const prevYear = Number(month) === 1 ? Number(year) - 1 : Number(year);
    weeklyPath = `/reports/weekly?days=${lookbackDays}&tz=${encodeURIComponent(tz)}&date=${encodeURIComponent(end)}`;
    summaryParams.set('from', start);
    summaryParams.set('to', end);
    comparisonParams = new URLSearchParams({ period, target: String(target), year: String(prevYear), month: String(prevMonth), from: getMonthlyBounds(prevYear, prevMonth).start, to: getMonthlyBounds(prevYear, prevMonth).end });
  } else if (period === 'quarterly' && year && quarter) {
    const { start, end } = getQuarterBounds(year, quarter);
    const prevQuarter = Number(quarter) === 1 ? 4 : Number(quarter) - 1;
    const prevYear = Number(quarter) === 1 ? Number(year) - 1 : Number(year);
    weeklyPath = `/reports/weekly?days=${lookbackDays}&tz=${encodeURIComponent(tz)}&date=${encodeURIComponent(end)}`;
    summaryParams.set('from', start);
    summaryParams.set('to', end);
    const prevBounds = getQuarterBounds(prevYear, prevQuarter);
    comparisonParams = new URLSearchParams({ period, target: String(target), year: String(prevYear), quarter: String(prevQuarter), from: prevBounds.start, to: prevBounds.end });
  } else if (period === 'yearly' && year) {
    const { start, end } = getYearBounds(year);
    weeklyPath = `/reports/weekly?days=${lookbackDays}&tz=${encodeURIComponent(tz)}&date=${encodeURIComponent(end)}`;
    summaryParams.set('from', start);
    summaryParams.set('to', end);
    const prevBounds = getYearBounds(Number(year) - 1);
    comparisonParams = new URLSearchParams({ period, target: String(target), year: String(Number(year) - 1), from: prevBounds.start, to: prevBounds.end });
  } else if (period === 'weekly') {
    const now = new Date();
    const currentEnd = new Date(now);
    const previousEnd = new Date(now);
    previousEnd.setUTCDate(previousEnd.getUTCDate() - 7);
    comparisonParams = new URLSearchParams({ period, target: String(target), to: previousEnd.toISOString().slice(0, 10) });
    weeklyPath = `/reports/weekly?days=${lookbackDays}&tz=${encodeURIComponent(tz)}&date=${encodeURIComponent(currentEnd.toISOString().slice(0, 10))}`;
  }

  const requests = [
    fetchJson(baseUrl, '/metrics'),
    fetchJson(baseUrl, '/inventory'),
    fetchJson(baseUrl, weeklyPath.trim()),
    fetchJson(baseUrl, `/reports/summary?${summaryParams.toString()}`)
  ];
  if (comparisonParams) requests.push(fetchJson(baseUrl, `/reports/summary?${comparisonParams.toString()}`));

  const [metrics, inventory, report, summary, comparisonSummary] = await Promise.all(requests);

  const inventoryTotals = sumInventory(inventory);
  const totalRevenue = Number(metrics.totalRevenue || 0);
  const totalProfit = Number(metrics.totalProfit || 0);
  const effectiveTarget = Number(process.env.REVENUE_TARGET || metrics.revenueGoal || target || 25000);
  const remaining = Math.max(0, effectiveTarget - totalRevenue);
  const daysLeft = calcDaysLeft(period);
  const planText = buildPlanText(period, remaining, daysLeft);
  const progressPct = effectiveTarget > 0 ? (totalRevenue / effectiveTarget) * 100 : 0;
  const progressBar = buildProgressBar(Math.min(100, progressPct));

  const probability = summary?.forecast?.probability || 0;
  const probabilityLabel = summary?.forecast?.label || 'unbekannt';
  const projectedMonthRevenue = summary?.forecast?.projectedMonthRevenue || 0;
  const inventoryCapMonthly = summary?.forecast?.inventoryCapMonthly || 0;
  const topSeller = summary?.topSeller;
  const orders = report?.totals?.orders || summary?.totals?.count || 0;
  const periodRevenue = summary?.totals?.revenue ?? report?.totals?.revenue ?? 0;
  const periodProfit = summary?.totals?.profit ?? report?.totals?.profit ?? 0;
  const periodRoi = summary?.totals?.roi ?? report?.totals?.grossMargin ?? 0;
  const avgOrderValue = orders > 0 ? periodRevenue / orders : 0;
  const previousRevenue = comparisonSummary?.totals?.revenue || 0;
  const previousProfit = comparisonSummary?.totals?.profit || 0;
  const previousOrders = comparisonSummary?.totals?.count || 0;
  const previousRoi = comparisonSummary?.totals?.roi || 0;
  const neededPerDayRevenue = remaining > 0 ? remaining / Math.max(1, daysLeft) : 0;
  const recommendations = buildRecommendation({
    periodRevenue,
    periodProfit,
    periodRoi,
    inventoryTotals,
    forecast: summary?.forecast,
    previousRevenue,
    previousProfit
  });

  const summaryLines = [
    `📊 ${PERIODS[period].label}`,
    describePeriod({ period, report, lookbackDays, year, month, quarter }),
    '',
    '🎯 KPI',
    `Bestellungen: ${orders} (${buildComparisonLabel(period)} ${formatDelta(orders, previousOrders, 'count')})`,
    `Umsatz: ${formatEuro(periodRevenue)} (${buildComparisonLabel(period)} ${formatDelta(periodRevenue, previousRevenue)})`,
    `Gewinn: ${formatEuro(periodProfit)} (${buildComparisonLabel(period)} ${formatDelta(periodProfit, previousProfit)})`,
    `ROI: ${formatPercent(periodRoi * 100)} (${buildComparisonLabel(period)} ${formatDelta(periodRoi, previousRoi, 'percent')})`,
    `Ø Bestellwert: ${formatEuro(avgOrderValue)}`,
    topSeller ? `Top-Seller: ${topSeller.title || topSeller.sku || '-'} (${formatEuro(topSeller.profit || 0)} Gewinn)` : 'Top-Seller: -',
    '',
    '📦 Lager',
    `Einstellwert: ${formatEuro(inventoryTotals.listTotal)}`,
    `Einkaufswert: ${formatEuro(inventoryTotals.ekTotal)}`,
    `Lagerumschlag grob: ${inventoryTotals.listTotal > 0 ? formatPercent((periodRevenue / inventoryTotals.listTotal) * 100) : '0.0%'}`,
    '',
    '🎯 Ziel & Pace',
    `Gesamtumsatz: ${formatEuro(totalRevenue)}`,
    `Gesamtgewinn: ${formatEuro(totalProfit)}`,
    `Fortschritt 25k-Ziel: ${progressBar}`,
    `Rest zum Ziel: ${formatEuro(remaining)}`,
    `Nötige Pace: ${formatEuro(neededPerDayRevenue)}/Tag`,
    `Jahresziel-Wahrscheinlichkeit: ${probability.toFixed(1)}% (${probabilityLabel})`,
    `Monats-Hochrechnung konservativ: ${formatEuro(projectedMonthRevenue)}`,
    `Bestandsdeckel (Einstellwert): ${formatEuro(inventoryCapMonthly)}`,
    '',
    '🧭 Fokus',
    ...recommendations.map((item, idx) => `${idx + 1}. ${item}`),
    '',
    `Plan: ${planText}`
  ];

  const message = summaryLines.join('\n');
  const reportLogPayload = {
    period,
    from: report?.range?.start || '',
    to: report?.range?.end || '',
    revenue: Number(periodRevenue || 0),
    profit: Number(periodProfit || 0),
    roi: Number(periodRoi || 0),
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
  const result = await sendReport({
    period: args.period || 'weekly',
    dryRun: Boolean(args['dry-run']),
    year: args.year ? Number(args.year) : undefined,
    month: args.month ? Number(args.month) : undefined,
    quarter: args.quarter ? Number(args.quarter) : undefined
  });
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
