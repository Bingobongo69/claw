import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import { z } from "zod";
import { buildListingAudit } from "./lib/audit.js";
import { reviseEbayItem, findCompletedItems } from "./lib/ebay.js";

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

function cleanKeywords(input = "") {
  return String(input)
    .replace(/[_-]/g, " ")
    .replace(/\b(?:EK|VK)[^\s]*\b/gi, "")
    .replace(/\b\d{2}_\d{2}_\d{2}_[^\s]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
  const col = idx["fixkosten"];
  if (col === undefined) return 0;

  for (let i = rows.length - 1; i >= 0; i--) {
    const raw = String(rows[i][col] ?? "").replace(/€/g, "").replace(/\s/g, "").replace(",", ".");
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.max(n, 0);
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

app.get("/sales", async (req, res) => {
  try {
    const data = await callSheets({ action: "getSales" });
    if (!data.ok) return res.status(500).json(data);
    const idx = Object.fromEntries((data.header || []).map((h, i) => [String(h).trim(), i]));
    const iDate = idx["Datum"] ?? 0, iTitle = idx["Titel"] ?? idx["Title"] ?? 1, iProfit = idx["Gewinn"] ?? 8, iVk = idx["VK"] ?? 7, iOrder = idx["Order-ID"] ?? idx["OrderID"] ?? idx["ID"] ?? 9, iShipping = idx["Versand"] ?? 5, iFees = idx["Gebühr"] ?? 6;
    const iSku = idx["SKU"] ?? idx["Sku"] ?? idx["Artikelnummer"] ?? idx["Artikel-Nr"] ?? 2;
    const rows = (data.rows || []).filter((r) => String(r[iOrder] ?? "").trim() !== "").map((r) => ({ date: r[iDate], title: r[iTitle], profit: Number(String(r[iProfit] ?? "0").replace(",", ".")) || 0, vk: Number(String(r[iVk] ?? "0").replace(",", ".")) || 0, shippingCost: Number(String(r[iShipping] ?? "0").replace(",", ".")) || 0, fees: Number(String(r[iFees] ?? "0").replace(",", ".")) || 0, orderId: String(r[iOrder] ?? "").trim(), sku: String(r[iSku] ?? "").trim() })).sort((a, b) => normalizeDateString(b.date).localeCompare(normalizeDateString(a.date)));
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

app.get("/audit/listings", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 50;
    const listings = await buildListingAudit({ limit: Math.min(Math.max(limit, 1), 200) });
    res.json({ ok: true, generatedAt: new Date().toISOString(), count: listings.length, listings });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/audit/sync", async (req, res) => {
  try {
    const limit = Number(req.body?.limit) || 200;
    const listings = await buildListingAudit({ limit: Math.min(Math.max(limit, 1), 500) });
    const rows = listings.map((item) => [
      item.listingId,
      item.sku || "",
      item.title,
      item.price?.value || 0,
      item.price?.currency || "EUR",
      item.quantity ?? 0,
      item.availableQuantity ?? 0,
      item.score ?? 0,
      item.priority || "low",
      item.issues.map((issue) => issue.code).join(", "),
      JSON.stringify(item.issues),
      item.url || "",
      item.image || "",
      new Date().toISOString()
    ]);
    await callSheets({ action: "writeAuditRows", rows });
    res.json({ ok: true, count: rows.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/audit/revise", async (req, res) => {
  try {
    const schema = z.object({
      listingId: z.string().min(1),
      title: z.string().min(5),
      description: z.string().min(10),
      price: z.number().positive()
    });
    const body = schema.parse(req.body);
    await reviseEbayItem({ itemId: body.listingId, title: body.title, description: body.description, price: body.price });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/audit/insight", async (req, res) => {
  try {
    const schema = z.object({
      listingId: z.string().min(1),
      title: z.string().optional(),
      sku: z.string().optional(),
      historyPrice: z.number().positive().optional(),
      currentPrice: z.number().positive().optional()
    });
    const body = schema.parse(req.body || {});
    const cleanedTitle = cleanKeywords(body.title || "");
    const cleanedSku = cleanKeywords(body.sku || "");
    const searchTerm = (cleanedSku || cleanedTitle).slice(0, 80);
    let completed = [];
    if (searchTerm) {
      try {
        completed = await findCompletedItems({ keywords: searchTerm, limit: 15 });
        if (!completed.length && cleanedTitle.includes(" ")) {
          const fallbackTerm = cleanedTitle.split(" ").slice(0, 2).join(" ");
          completed = await findCompletedItems({ keywords: fallbackTerm, limit: 10 });
        }
      } catch (err) {
        console.warn("findCompletedItems failed", err.message || err);
      }
    }
    const competitorCount = completed.length;
    const avgPrice = competitorCount ? completed.reduce((sum, item) => sum + item.price, 0) / competitorCount : null;
    const demandHigh = Boolean(body.historyPrice) || competitorCount >= 5;
    let basePrice = body.historyPrice ?? avgPrice ?? body.currentPrice ?? 0;
    let adjustment = 0;
    if (competitorCount < 3 && demandHigh) adjustment = 0.05;
    else if (competitorCount > 10) adjustment = -0.02;
    const suggestedPrice = Number((basePrice * (1 + adjustment)).toFixed(2));
    const reasonParts = [];
    if (competitorCount) reasonParts.push(`Basis: ${competitorCount} verkaufte Angebote (⌀ ${avgPrice ? avgPrice.toFixed(2) : "-"} €)`);
    if (body.historyPrice) reasonParts.push(`Letzter Verkauf: ${body.historyPrice.toFixed(2)} €`);
    if (adjustment > 0) reasonParts.push("Score hoch → +5 % Aufschlag");
    if (adjustment < 0) reasonParts.push("Viele Wettbewerber → -2 %");
    const reason = reasonParts.join(". ") || "Keine Vergleichsdaten – Basispreis genutzt";
    res.json({ ok: true, competitorCount, averagePrice: avgPrice, demandHigh, suggestedPrice, reason });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.use((req, res, next) => {
  if (["/health", "/sheets/", "/metrics", "/sales", "/inventory", "/sourcing/", "/settings", "/todos", "/fees", "/bootstrap", "/command"].some((p) => req.path.startsWith(p))) return next();
  if (req.method !== "GET") return next();
  res.sendFile(new URL("../public/index.html", import.meta.url).pathname);
});

const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`Apex server listening on :${port}`));
