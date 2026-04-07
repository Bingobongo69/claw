import express from "express";
import fetch from "node-fetch";
import { z } from "zod";

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

function normalizeSettingValue(raw, type = "string") {
  if (type === "number") {
    const n = Number(String(raw).replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  if (type === "boolean") {
    const s = String(raw).trim().toLowerCase();
    return !(s === "false" || s === "0" || s === "no" || s === "off" || s === "");
  }
  return raw;
}

function normalizeDateString(input) {
  if (!input) return "";
  const d = new Date(input);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  const s = String(input).trim();
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return new Date(`${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T00:00:00Z`).toISOString().slice(0, 10);
  return s.slice(0, 10);
}

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
  const header = r.header || [];
  const rows = r.rows || [];
  if (!rows.length) return 0;
  const idx = Object.fromEntries(header.map((h, i) => [String(h).trim().toLowerCase(), i]));
  const targetCols = ["fixkosten", "fixedcosts", "kosten fix", "monatliche fixkosten"];
  let col = -1;
  for (const key of targetCols) {
    if (idx[key] !== undefined) { col = idx[key]; break; }
  }
  if (col === -1) {
    let sum = 0;
    for (const row of rows) {
      for (const cell of row) {
        const n = Number(String(cell ?? "").replace(",", "."));
        if (Number.isFinite(n) && n > 0) sum = Math.max(sum, n);
      }
    }
    return sum;
  }
  const last = rows[rows.length - 1];
  return Number(String(last[col] ?? "0").replace(",", ".")) || 0;
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
    const validRows = rows.filter((r) => String(r[iOrder] ?? "").trim() !== "");
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    let monthProfit = 0, totalProfit = 0, count = 0;
    for (const r of validRows) {
      count++;
      const profit = Number(String(r[iProfit] ?? "0").replace(",", ".")) || 0;
      totalProfit += profit;
      const ds = normalizeDateString(r[iDate]);
      if (ds.slice(0, 7) === ym) monthProfit += profit;
    }
    const gkvLimit = Number.isFinite(settings.gkvLimit) ? settings.gkvLimit : DEFAULT_GKV_LIMIT;
    const profitGoal = Number.isFinite(settings.profitGoal) ? settings.profitGoal : DEFAULT_PROFIT_GOAL;
    res.json({ ok: true, salesCount: count, totalProfit, monthProfit, netMonthProfit: monthProfit - monthlyFixedCosts, monthlyFixedCosts, gkvLimit, gkvRemaining: gkvLimit - monthProfit, roadTo15kGoal: profitGoal, roadTo15kProgress: totalProfit, settings });
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

app.get("/sales", async (req, res) => {
  try {
    const data = await callSheets({ action: "getSales" });
    if (!data.ok) return res.status(500).json(data);
    const idx = Object.fromEntries((data.header || []).map((h, i) => [String(h).trim(), i]));
    const iDate = idx["Datum"] ?? 0, iTitle = idx["Titel"] ?? idx["Title"] ?? 1, iProfit = idx["Gewinn"] ?? 8, iVk = idx["VK"] ?? 7, iOrder = idx["Order-ID"] ?? idx["OrderID"] ?? idx["ID"] ?? 9, iShipping = idx["Versand"] ?? 5, iFees = idx["Gebühr"] ?? 6;
    const rows = (data.rows || []).filter((r) => String(r[iOrder] ?? "").trim() !== "").map((r) => ({ date: r[iDate], title: r[iTitle], profit: Number(String(r[iProfit] ?? "0").replace(",", ".")) || 0, vk: Number(String(r[iVk] ?? "0").replace(",", ".")) || 0, shippingCost: Number(String(r[iShipping] ?? "0").replace(",", ".")) || 0, fees: Number(String(r[iFees] ?? "0").replace(",", ".")) || 0, orderId: String(r[iOrder] ?? "").trim() })).sort((a, b) => normalizeDateString(b.date).localeCompare(normalizeDateString(a.date)));
    res.json({ ok: true, rows });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

app.get("/inventory", async (req, res) => { try { res.json(await callSheets({ action: "getInventory" })); } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); } });
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

app.use((req, res, next) => {
  if (["/health", "/sheets/", "/metrics", "/sales", "/inventory", "/sourcing/", "/settings", "/todos", "/fees", "/bootstrap", "/command"].some((p) => req.path.startsWith(p))) return next();
  if (req.method !== "GET") return next();
  res.sendFile(new URL("../public/index.html", import.meta.url).pathname);
});

const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`Apex server listening on :${port}`));
