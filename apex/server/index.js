import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import { z } from "zod";
import { normalizeSettingValue, normalizeDateString } from "./lib/utils.js";
import { buildWeeklyReport } from "./lib/report.js";
import { sendTelegramMessage } from "./lib/telegram.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(new URL("../public", import.meta.url).pathname));

const WEBAPP_URL = process.env.APEX_SHEETS_WEBAPP_URL;
if (!WEBAPP_URL) console.warn("Missing env APEX_SHEETS_WEBAPP_URL (Apps Script Web App URL)");

function requireWebappUrl() { if (!WEBAPP_URL) throw new Error("APEX_SHEETS_WEBAPP_URL not configured"); }

async function callSheets(body) {
  requireWebappUrl();
  const res = await fetch(WEBAPP_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { ok: false, error: "non_json", raw: text }; }
  if (!res.ok) throw new Error(`Sheets webapp HTTP ${res.status}: ${text}`);
  return json;
}

function sourcingDecision({ expectedVk, ek, shippingCost, otherCost = 0, fixedCostShare = 0, feePct, feeFixed }) {
  const fees = expectedVk * feePct + feeFixed;
  const profit = expectedVk - ek - shippingCost - otherCost - fixedCostShare - fees;
  const margin = expectedVk > 0 ? profit / expectedVk : 0;
  const go = profit > 0;
  return { go: go ? "GO" : "NO-GO", profit, margin, fees };
}

const DEFAULT_FEE_PCT = 0.12;
const DEFAULT_FEE_FIXED = 0.35;
const DEFAULT_GKV_LIMIT = 578;
const DEFAULT_PROFIT_GOAL = 15000;
const DEFAULT_REVENUE_GOAL = 15000;
const LOW_STOCK_THRESHOLD = 3;
const euroFormatter = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const salesAlertState = { initialized: false, seen: new Set() };
const inventoryAlertState = { initialized: false, quantities: new Map(), lowStockNotified: new Set() };
const dailyTargetState = { notifiedDate: null };
let dayGoalCache = { value: null, fetchedAt: 0 };

async function getSettingsMap() {
  const r = await callSheets({ action: "getSettings" });
  if (!r.ok) return {};
  const out = {};
  for (const [key, meta] of Object.entries(r.settings || {})) out[key] = normalizeSettingValue(meta?.value, meta?.type || "string");
  return out;
}

async function getMonthlyFixedCosts() {
  const r = await callSheets({ action: "getMonthlyOverview" }).catch(() => null);
  if (!r || !r.ok) return 0;
  let header = (r.header || []).map((h) => String(h || "").trim().toLowerCase());
  let rows = r.rows || [];
  if (!rows.length) return 0;

  const findHeaderInRows = () => {
    const headerRowIndex = rows.findIndex((row) => row.some((cell) => typeof cell === "string" && cell.toLowerCase().includes("fixkosten")));
    if (headerRowIndex === -1) return -1;
    header = rows[headerRowIndex].map((cell) => String(cell || "").trim().toLowerCase());
    rows = rows.slice(headerRowIndex + 1);
    return headerRowIndex;
  };

  let fixColumns = header
    .map((value, index) => ({ value, index }))
    .filter((entry) => entry.value.includes("fixkosten"))
    .map((entry) => entry.index);

  if (!fixColumns.length) {
    const idx = findHeaderInRows();
    if (idx !== -1) {
      fixColumns = header
        .map((value, index) => ({ value, index }))
        .filter((entry) => entry.value.includes("fixkosten"))
        .map((entry) => entry.index);
    }
  }

  if (!fixColumns.length) return 0;

  for (let i = rows.length - 1; i >= 0; i--) {
    for (const col of fixColumns) {
      const raw = String(rows[i][col] ?? "").replace(/€/g, "").replace(/\s/g, "").replace(",", ".");
      const n = Number(raw);
      if (Number.isFinite(n) && n !== 0) return Math.max(n, 0);
    }
  }
  return 0;
}

async function getFeeForCategory(category) {
  const settings = await getSettingsMap().catch(() => ({}));
  const defaultFeePct = Number.isFinite(settings.defaultFeePct) ? settings.defaultFeePct / 100 : DEFAULT_FEE_PCT;
  const defaultFeeFixed = Number.isFinite(settings.defaultFeeFix) ? settings.defaultFeeFix : DEFAULT_FEE_FIXED;
  if (!category) return { feePct: defaultFeePct, feeFixed: defaultFeeFixed, source: "default" };
  const r = await callSheets({ action: "getSheet", sheet: "Fees" });
  if (!r.ok) return { feePct: defaultFeePct, feeFixed: defaultFeeFixed, source: "default_error" };
  const idx = Object.fromEntries((r.header || []).map((h, i) => [String(h).trim(), i]));
  const iCat = idx["Kategorie"] ?? 0;
  const iPct = idx["FeePct"] ?? 1;
  const iFix = idx["FeeFix"] ?? 2;
  const iActive = idx["Active"] ?? 3;
  const row = (r.rows || []).find((row) => !(String(row[iActive] ?? "true").toLowerCase() === "false" || String(row[iActive] ?? "true").toLowerCase() === "0") && String(row[iCat] ?? "").trim().toLowerCase() === String(category).trim().toLowerCase());
  if (!row) return { feePct: defaultFeePct, feeFixed: defaultFeeFixed, source: "default_missing" };
  const pct = Number(String(row[iPct] ?? "").replace(",", "."));
  const fix = Number(String(row[iFix] ?? "").replace(",", "."));
  return { feePct: Number.isFinite(pct) ? pct / 100 : defaultFeePct, feeFixed: Number.isFinite(fix) ? fix : defaultFeeFixed, source: "fees_sheet" };
}

function normalizeSalesRows(data) {
  const idx = Object.fromEntries((data.header || []).map((h, i) => [String(h).trim(), i]));
  const iDate = idx["Datum"] ?? 0;
  const iTitle = idx["Titel"] ?? idx["Title"] ?? 1;
  const iProfit = idx["Gewinn"] ?? 8;
  const iVk = idx["VK"] ?? idx["Umsatz"] ?? idx["Verkaufspreis"] ?? 7;
  const iOrder = idx["Order-ID"] ?? idx["OrderID"] ?? idx["ID"] ?? 9;
  const iShipping = idx["Versand"] ?? 5;
  const iFees = idx["Gebühr"] ?? 6;
  const iSku = idx["SKU"] ?? idx["Sku"] ?? idx["Artikelnummer"] ?? idx["Artikel-Nr"] ?? 2;
  const iCost = idx["EK"] ?? idx["Einkauf"] ?? idx["Einkaufspreis"] ?? idx["Einkaufswert"] ?? idx["Kosten"];
  const iListing = idx["Einstellwert"] ?? idx["ListPrice"] ?? idx["Listing"];
  const iStatus = idx["Status"];
  const iRoi = idx["ROI %"] ?? idx["ROI%"] ?? idx["ROI"];
  return (data.rows || [])
    .filter((r) => String(r[iOrder] ?? "").trim() !== "")
    .map((r) => ({
      date: r[iDate],
      title: r[iTitle],
      profit: Number(String(r[iProfit] ?? "0").replace(",", ".")) || 0,
      vk: Number(String(r[iVk] ?? "0").replace(",", ".")) || 0,
      shippingCost: Number(String(r[iShipping] ?? "0").replace(",", ".")) || 0,
      fees: Number(String(r[iFees] ?? "0").replace(",", ".")) || 0,
      orderId: String(r[iOrder] ?? "").trim(),
      sku: String(r[iSku] ?? "").trim(),
      cost: Number(String(iCost !== undefined ? r[iCost] ?? "0" : "0").replace(",", ".")) || 0,
      listingValue: Number(String(iListing !== undefined ? r[iListing] ?? "0" : "0").replace(",", ".")) || 0,
      status: iStatus !== undefined ? String(r[iStatus] ?? "") : "",
      roi: Number(String(iRoi !== undefined ? r[iRoi] ?? "0" : "0").replace(",", ".")) || 0
    }))
    .sort((a, b) => normalizeDateString(b.date).localeCompare(normalizeDateString(a.date)));
}

function filterSalesRows(rows, query = {}) {
  const now = new Date();
  const todayIso = normalizeDateString(now);
  let from = query.from ? normalizeDateString(query.from) : null;
  let to = query.to ? normalizeDateString(query.to) : null;
  if (query.range === "today") {
    from = todayIso;
    to = todayIso;
  } else if (query.range === "7d") {
    const start = new Date(now);
    start.setUTCDate(start.getUTCDate() - 6);
    from = normalizeDateString(start);
    to = todayIso;
  }
  const search = String(query.search || "").trim().toLowerCase();
  const sort = String(query.sort || "date_desc");
  const filtered = rows.filter((row) => {
    const ds = normalizeDateString(row.date);
    if (from && ds < from) return false;
    if (to && ds > to) return false;
    if (search) {
      const hay = `${String(row.title || "")} ${String(row.sku || "")}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
  const comparators = {
    price_desc: (a, b) => b.vk - a.vk,
    price_asc: (a, b) => a.vk - b.vk,
    profit_desc: (a, b) => b.profit - a.profit,
    profit_asc: (a, b) => a.profit - b.profit,
    date_asc: (a, b) => normalizeDateString(a.date).localeCompare(normalizeDateString(b.date)),
    date_desc: (a, b) => normalizeDateString(b.date).localeCompare(normalizeDateString(a.date))
  };
  filtered.sort(comparators[sort] || comparators.date_desc);
  const totals = filtered.reduce((acc, row) => {
    acc.revenue += row.vk || 0;
    acc.profit += row.profit || 0;
    acc.cost += row.cost || 0;
    return acc;
  }, { revenue: 0, profit: 0, cost: 0 });
  return {
    rows: filtered,
    filter: { from, to, range: query.range || null, search, sort },
    totals: {
      revenue: totals.revenue,
      profit: totals.profit,
      cost: totals.cost,
      roi: totals.cost > 0 ? totals.profit / totals.cost : 0,
      count: filtered.length
    }
  };
}

function calculateYearTargetLikelihood({ metrics, filteredTotals, target = 25000 }) {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const daysElapsed = Math.max(1, Math.ceil((now - monthStart) / 86400000));
  const daysInMonth = Math.max(1, Math.ceil((nextMonthStart - monthStart) / 86400000));
  const currentMonthRevenue = Number(metrics?.monthRevenue || filteredTotals?.revenue || 0);
  const projectedMonthRevenue = (currentMonthRevenue / daysElapsed) * daysInMonth;
  const annualRunRate = projectedMonthRevenue * 12;
  const probability = Math.max(0, Math.min(100, (annualRunRate / target) * 100));
  const label = probability >= 110 ? "sehr hoch" : probability >= 90 ? "gut" : probability >= 70 ? "mittel" : "niedrig";
  return { probability, label, projectedMonthRevenue, annualRunRate, target };
}

app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/sheets/ping", async (req, res) => { try { requireWebappUrl(); const r = await fetch(`${WEBAPP_URL}?action=ping`); res.json(await r.json()); } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); } });

app.get("/metrics", async (req, res) => {
  try {
    const [data, settings, monthlyFixedCosts] = await Promise.all([callSheets({ action: "getSales" }), getSettingsMap().catch(() => ({})), getMonthlyFixedCosts()]);
    if (!data.ok) return res.status(500).json(data);
    const header = data.header;
    const rows = data.rows;
    const idx = Object.fromEntries(header.map((h, i) => [String(h).trim(), i]));
    const iDate = idx["Datum"] ?? 0;
    const iProfit = idx["Gewinn"] ?? 8;
    const iOrder = idx["Order-ID"] ?? idx["OrderID"] ?? idx["ID"] ?? 9;
    const iVk = idx["VK"] ?? idx["Umsatz"] ?? idx["Verkaufspreis"] ?? 7;
    const validRows = rows.filter((r) => String(r[iOrder] ?? "").trim() !== "");
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    let monthProfit = 0, totalProfit = 0, totalRevenue = 0, monthRevenue = 0, count = 0;
    for (const r of validRows) {
      count++;
      const profit = Number(String(r[iProfit] ?? "0").replace(",", ".")) || 0;
      const revenue = Number(String(r[iVk] ?? "0").replace(",", ".")) || 0;
      totalProfit += profit;
      totalRevenue += revenue;
      const ds = normalizeDateString(r[iDate]);
      if (ds.slice(0, 7) === ym) {
        monthProfit += profit;
        monthRevenue += revenue;
      }
    }
    const gkvLimit = Number.isFinite(settings.gkvLimit) ? settings.gkvLimit : DEFAULT_GKV_LIMIT;
    const profitGoal = Number.isFinite(settings.profitGoal) ? settings.profitGoal : DEFAULT_PROFIT_GOAL;
    const revenueGoal = Number.isFinite(settings.revenueGoal) ? settings.revenueGoal : DEFAULT_REVENUE_GOAL;
    res.json({
      ok: true,
      salesCount: count,
      totalProfit,
      totalRevenue,
      monthProfit,
      monthRevenue,
      netMonthProfit: monthProfit - monthlyFixedCosts,
      monthlyFixedCosts,
      gkvLimit,
      gkvRemaining: gkvLimit - monthProfit,
      profitGoal,
      profitGoalProgress: totalProfit,
      roadTo15kGoal: revenueGoal,
      roadTo15kProgress: totalRevenue,
      revenueGoal,
      revenueGoalProgress: totalRevenue,
      settings
    });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

app.post("/sourcing/check", async (req, res) => {
  const schema = z.object({ expectedVk: z.number().positive(), ek: z.number().nonnegative(), shippingCost: z.number().nonnegative().optional(), otherCost: z.number().nonnegative().optional(), categoryHint: z.string().optional() });
  try {
    const body = schema.parse(req.body);
    const [fee, monthlyFixedCosts] = await Promise.all([getFeeForCategory(body.categoryHint), getMonthlyFixedCosts()]);
    const fixedCostShare = monthlyFixedCosts / 30;
    const out = sourcingDecision({ expectedVk: body.expectedVk, ek: body.ek, shippingCost: body.shippingCost ?? 0, otherCost: body.otherCost ?? 0, fixedCostShare, feePct: fee.feePct, feeFixed: fee.feeFixed });
    res.json({ ok: true, ...out, shippingCost: body.shippingCost ?? 0, otherCost: body.otherCost ?? 0, fixedCostShare, monthlyFixedCosts, feePct: fee.feePct, feeFixed: fee.feeFixed, feeSource: fee.source });
  } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});

app.get("/reports/summary", async (req, res) => {
  try {
    const period = String(req.query.period || "monthly");
    const [metrics, salesData] = await Promise.all([
      fetch(`${req.protocol}://${req.get("host")}/metrics`).then((r) => r.json()),
      callSheets({ action: "getSales" })
    ]);
    const rows = normalizeSalesRows(salesData);
    let range = "today";
    if (period === "weekly") range = "7d";
    if (period === "monthly") range = null;
    if (period === "yearly") range = null;
    const filtered = filterSalesRows(rows, {
      range,
      from: req.query.from,
      to: req.query.to,
      search: req.query.search,
      sort: req.query.sort
    });
    const topSeller = filtered.rows.slice().sort((a, b) => b.profit - a.profit)[0] || null;
    const forecast = calculateYearTargetLikelihood({ metrics, filteredTotals: filtered.totals, target: Number(req.query.target || 25000) });
    res.json({ ok: true, period, totals: filtered.totals, topSeller, forecast, rows: filtered.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/reports/log", async (req, res) => {
  try {
    const payload = {
      period: req.body?.period || '',
      from: req.body?.from || '',
      to: req.body?.to || '',
      revenue: Number(req.body?.revenue || 0),
      profit: Number(req.body?.profit || 0),
      roi: Number(req.body?.roi || 0),
      topSeller: req.body?.topSeller || '',
      targetLikelihood: req.body?.targetLikelihood || ''
    };
    const result = await callSheets({ action: 'appendReportLog', ...payload });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/sales", async (req, res) => {
  try {
    const data = await callSheets({ action: "getSales" });
    if (!data.ok) return res.status(500).json(data);
    const rows = normalizeSalesRows(data);
    handleSalesAlerts(rows);
    const filtered = filterSalesRows(rows, req.query || {});
    res.json({ ok: true, rows: filtered.rows, totals: filtered.totals, filter: filtered.filter });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

app.post("/sales/sync-sku-defaults", async (req, res) => {
  try {
    const result = await callSheets({ action: "syncSkuDefaults" });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/dashboard", async (req, res) => {
  try {
    const [salesData, metrics] = await Promise.all([
      callSheets({ action: "getSales" }),
      fetch(`${req.protocol}://${req.get("host")}/metrics`).then((r) => r.json())
    ]);
    if (!salesData.ok) return res.status(500).json(salesData);
    const rows = normalizeSalesRows(salesData);
    const filtered = filterSalesRows(rows, req.query || {});
    const forecast = calculateYearTargetLikelihood({ metrics, filteredTotals: filtered.totals, target: Number(req.query.target || 25000) });
    const topSeller = filtered.rows.slice().sort((a, b) => b.profit - a.profit)[0] || null;
    res.json({ ok: true, rows: filtered.rows, totals: filtered.totals, filter: filtered.filter, topSeller, forecast });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/sales/update", async (req, res) => {
  const schema = z.object({
    orderId: z.string().min(1),
    shippingCost: z.number().optional(),
    purchaseCost: z.number().optional(),
    feePct: z.number().optional(),
    listingValue: z.number().optional()
  });
  try {
    const body = schema.parse(req.body || {});
    const payload = { action: "updateSale", orderId: body.orderId };
    if (body.shippingCost !== undefined) payload.shippingCost = body.shippingCost;
    if (body.purchaseCost !== undefined) payload.purchaseCost = body.purchaseCost;
    if (body.feePct !== undefined) payload.feePct = body.feePct;
    if (body.listingValue !== undefined) payload.listingValue = body.listingValue;
    await callSheets(payload);
    res.json({ ok: true });
  } catch (e) {
    const status = e instanceof z.ZodError ? 400 : 500;
    res.status(status).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/reports/weekly", async (req, res) => {
  try {
    const data = await callSheets({ action: "getSales" });
    if (!data.ok) return res.status(500).json(data);
    const rows = normalizeSalesRows(data);
    const days = Number(req.query.days) || 7;
    const tz = typeof req.query.tz === "string" && req.query.tz.trim() ? req.query.tz : "UTC";
    const targetDate = req.query.date ? new Date(req.query.date) : new Date();
    const today = Number.isNaN(targetDate.getTime()) ? new Date() : targetDate;
    const report = buildWeeklyReport({ salesRows: rows, lookbackDays: days, timezone: tz, today });
    res.json({ ok: true, ...report });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/inventory", async (req, res) => {
  try {
    const payload = await callSheets({ action: "getInventory" });
    res.json(payload);
    handleInventoryAlerts(payload);
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});
app.get("/fees", async (req, res) => { try { res.json(await callSheets({ action: "getSheet", sheet: "Fees" })); } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); } });
app.get("/settings", async (req, res) => { try { res.json({ ok: true, settings: await getSettingsMap() }); } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); } });
app.post("/settings", async (req, res) => {
  const schema = z.object({ key: z.string().min(1), value: z.union([z.string(), z.number(), z.boolean()]), type: z.enum(["string", "number", "boolean"]).optional(), note: z.string().optional() });
  try { const body = schema.parse(req.body); await callSheets({ action: "upsertSetting", key: body.key, value: body.value, type: body.type || typeof body.value, note: body.note || "" }); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});
app.get("/todos", async (req, res) => { try { res.json(await callSheets({ action: "getSheet", sheet: "Todos" })); } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); } });
app.post("/todos", async (req, res) => {
  const schema = z.object({ title: z.string().min(1), status: z.string().optional(), owner: z.string().optional(), note: z.string().optional() });
  try { const body = schema.parse(req.body); res.json(await callSheets({ action: "addTodo", ...body })); }
  catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});
app.post("/bootstrap", async (req, res) => { try { res.json(await callSheets({ action: "bootstrap" })); } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); } });
app.post("/command", async (req, res) => {
  const schema = z.object({ command: z.enum(["set_gkv_limit", "set_profit_goal", "add_todo", "bootstrap"]), value: z.union([z.string(), z.number()]).optional(), title: z.string().optional(), note: z.string().optional() });
  try {
    const body = schema.parse(req.body);
    if (body.command === "bootstrap") return res.json(await callSheets({ action: "bootstrap" }));
    if (body.command === "set_gkv_limit") { await callSheets({ action: "upsertSetting", key: "gkvLimit", value: body.value, type: "number", note: body.note || "Updated via command" }); return res.json({ ok: true, command: body.command }); }
    if (body.command === "set_profit_goal") { await callSheets({ action: "upsertSetting", key: "profitGoal", value: body.value, type: "number", note: body.note || "Updated via command" }); return res.json({ ok: true, command: body.command }); }
    if (body.command === "add_todo") { return res.json({ ok: true, command: body.command, result: await callSheets({ action: "addTodo", title: body.title || String(body.value || ""), note: body.note || "", status: "open", owner: "Raul" }) }); }
    res.status(400).json({ ok: false, error: "unsupported_command" });
  } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});

app.post("/vision/analyze", async (req, res) => {
  try {
    const schema = z.object({ filename: z.string().optional(), size: z.number().optional() });
    const body = schema.parse(req.body || {});
    const base = (body.filename || "Produkt").replace(/\.[^.]+$/, "");
    const tokens = base.split(/[-_\s]+/).filter(Boolean);
    const productName = tokens.slice(0, 2).join(" ") || "Produkt";
    const model = tokens.slice(2).join(" ") || "Modell X";
    const condition = /neu/i.test(base) ? "Neu" : "Gebraucht";
    const estimatedCost = Math.max(5, Math.round((body.size || 400000) / 80000));
    const marketPrice = Math.round(estimatedCost * 2.2);
    res.json({ ok: true, productName, model, condition, estimatedCost, marketPrice });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

function formatEuro(value) {
  return euroFormatter.format(Number(value || 0));
}

function queueTelegram(text) {
  sendTelegramMessage(text).catch((err) => console.error("telegram send error", err));
}

function handleSalesAlerts(rows) {
  if (!Array.isArray(rows) || !rows.length) return;
  if (!salesAlertState.initialized) {
    rows.forEach((row) => { if (row.orderId) salesAlertState.seen.add(row.orderId); });
    salesAlertState.initialized = true;
    return;
  }
  rows.forEach((row) => {
    const id = row.orderId;
    if (!id || salesAlertState.seen.has(id)) return;
    salesAlertState.seen.add(id);
    queueTelegram(`🆕 Verkauf: ${row.title || id} – ${formatEuro(row.vk)}`);
  });
}

function handleInventoryAlerts(payload) {
  const items = mapInventoryItems(payload);
  if (!items.length) return;
  if (!inventoryAlertState.initialized) {
    items.forEach((item) => inventoryAlertState.quantities.set(item.key, item.quantity));
    inventoryAlertState.initialized = true;
  } else {
    items.forEach((item) => {
      const prevQty = inventoryAlertState.quantities.get(item.key);
      inventoryAlertState.quantities.set(item.key, item.quantity);
      if (item.quantity < LOW_STOCK_THRESHOLD && (prevQty === undefined || prevQty >= LOW_STOCK_THRESHOLD) && !inventoryAlertState.lowStockNotified.has(item.key)) {
        queueTelegram(`⚠️ Lagerbestand niedrig: ${item.title}`);
        inventoryAlertState.lowStockNotified.add(item.key);
      } else if (item.quantity >= LOW_STOCK_THRESHOLD && inventoryAlertState.lowStockNotified.has(item.key)) {
        inventoryAlertState.lowStockNotified.delete(item.key);
      }
    });
  }
  checkDailyTargetFromItems(items).catch((err) => console.error("daily target check error", err));
}

function mapInventoryItems(payload) {
  const header = payload?.header || [];
  const rows = payload?.rows || [];
  if (!rows.length) return [];
  const idx = Object.fromEntries(header.map((h, i) => [String(h || "").trim(), i]));
  const skuIdx = idx["SKU"] ?? idx["Sku"] ?? idx["Artikelnummer"] ?? idx["Artikel-Nr"];
  const titleIdx = idx["Titel"] ?? idx["Title"] ?? idx["Name"];
  const qtyIdx = idx["Menge Aktuell"] ?? idx["Menge"] ?? idx["Quantity"];
  const dateIdx = idx["Einstell-Datum"] ?? idx["Datum"] ?? idx["Date"];
  const listIdx = idx["Einstellwert"] ?? idx["ListPrice"] ?? idx["VK"];
  return rows.map((row, i) => {
    const keyRaw = skuIdx !== undefined ? row[skuIdx] : undefined;
    const title = String(row[titleIdx] ?? keyRaw ?? `Artikel ${i + 1}`).trim();
    const key = String(keyRaw ?? title ?? i).trim();
    return {
      key,
      title: title || key,
      quantity: parseNumberInput(row[qtyIdx]),
      date: row[dateIdx],
      listPrice: parseNumberInput(row[listIdx])
    };
  }).filter((item) => item.key);
}

function parseNumberInput(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const normalized = value.replace(/[^0-9,.-]/g, "").replace(",", ".");
    const n = Number(normalized);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function getLocalDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function getDayListingGoal() {
  const now = Date.now();
  if (dayGoalCache.value !== null && now - dayGoalCache.fetchedAt < 30 * 60 * 1000) return dayGoalCache.value;
  const settings = await getSettingsMap().catch(() => ({}));
  const goal = Number(settings.dayListingGoal ?? settings.dayGoal) || 2000;
  dayGoalCache = { value: goal, fetchedAt: now };
  return goal;
}

async function checkDailyTargetFromItems(items) {
  if (!items.length) return;
  const dayGoal = await getDayListingGoal();
  const todayKey = getLocalDateKey();
  const total = items.reduce((sum, item) => {
    return normalizeDateString(item.date) === todayKey ? sum + Number(item.listPrice || 0) : sum;
  }, 0);
  if (total >= dayGoal && dailyTargetState.notifiedDate !== todayKey) {
    queueTelegram("🎯 Tagesziel erreicht!");
    dailyTargetState.notifiedDate = todayKey;
  }
}

app.use((req, res, next) => {
  if (["/health", "/sheets/", "/metrics", "/sales", "/inventory", "/sourcing/", "/settings", "/todos", "/fees", "/bootstrap", "/command"].some((p) => req.path.startsWith(p))) return next();
  if (req.method !== "GET") return next();
  res.sendFile(new URL("../public/index.html", import.meta.url).pathname);
});

const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`Apex server listening on :${port}`));
