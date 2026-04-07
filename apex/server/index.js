import express from "express";
import fetch from "node-fetch";
import { z } from "zod";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(new URL("../public", import.meta.url).pathname));

const WEBAPP_URL = process.env.APEX_SHEETS_WEBAPP_URL;
if (!WEBAPP_URL) {
  console.warn("Missing env APEX_SHEETS_WEBAPP_URL (Apps Script Web App URL)");
}

function requireWebappUrl() {
  if (!WEBAPP_URL) throw new Error("APEX_SHEETS_WEBAPP_URL not configured");
}

async function callSheets(body) {
  requireWebappUrl();
  const res = await fetch(WEBAPP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { ok: false, error: "non_json", raw: text }; }
  if (!res.ok) throw new Error(`Sheets webapp HTTP ${res.status}: ${text}`);
  return json;
}

function parseSkuParts(sku = "") {
  const norm = String(sku).trim();
  const tokens = norm.split("_").filter(Boolean);

  function readNumberAt(idx) {
    if (idx < 0 || idx >= tokens.length) return null;
    const raw = tokens[idx].replace(",", ".");
    const m = raw.match(/^(-?\d+(?:\.\d+)?)$/);
    return m ? Number(m[1]) : null;
  }

  let ek = null;
  let vk = null;
  let vp = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    if (t.startsWith("EK")) {
      const raw = t.slice(2).replace(",", ".");
      const m = raw.match(/^(-?\d+(?:\.\d+)?)$/);
      if (m) ek = Number(m[1]);
      else {
        const n = readNumberAt(i + 1);
        if (n !== null) ek = n;
      }
    }

    if (t === "VK" || t.startsWith("VK")) {
      if (t === "VK") {
        const n = readNumberAt(i + 1);
        if (n !== null) vk = n;
      } else {
        const raw = t.slice(2).replace(",", ".");
        const m = raw.match(/^(-?\d+(?:\.\d+)?)$/);
        if (m) vk = Number(m[1]);
      }
    }

    if (t === "VP" || t.startsWith("VP")) {
      if (t === "VP") {
        const n = readNumberAt(i + 1);
        if (n !== null) vp = n;
      } else {
        const raw = t.slice(2).replace(",", ".");
        const m = raw.match(/^(-?\d+(?:\.\d+)?)$/);
        if (m) vp = Number(m[1]);
      }
    }
  }

  return { ek, vk, vp };
}

function sourcingDecision({ expectedVk, ek, shippingCost, feePct, feeFixed }) {
  const fees = expectedVk * feePct + feeFixed;
  const profit = expectedVk - ek - shippingCost - fees;
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

async function getSettingsMap() {
  const r = await callSheets({ action: "getSettings" });
  if (!r.ok) return {};
  const out = {};
  for (const [key, meta] of Object.entries(r.settings || {})) {
    out[key] = normalizeSettingValue(meta?.value, meta?.type || "string");
  }
  return out;
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

  const row = (r.rows || []).find((row) => {
    const active = String(row[iActive] ?? "true").toLowerCase();
    const ok = !(active === "false" || active === "0");
    return ok && String(row[iCat] ?? "").trim().toLowerCase() === String(category).trim().toLowerCase();
  });

  if (!row) return { feePct: defaultFeePct, feeFixed: defaultFeeFixed, source: "default_missing" };

  const pct = Number(String(row[iPct] ?? "").replace(",", "."));
  const fix = Number(String(row[iFix] ?? "").replace(",", "."));

  const feePct = isFinite(pct) ? pct / 100 : defaultFeePct;
  const feeFixed = isFinite(fix) ? fix : defaultFeeFixed;

  return { feePct, feeFixed, source: "fees_sheet" };
}

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/sheets/ping", async (req, res) => {
  try {
    requireWebappUrl();
    const r = await fetch(`${WEBAPP_URL}?action=ping`);
    const json = await r.json();
    res.json(json);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/metrics", async (req, res) => {
  try {
    const [data, settings] = await Promise.all([
      callSheets({ action: "getSales" }),
      getSettingsMap().catch(() => ({})),
    ]);
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

    let monthProfit = 0;
    let totalProfit = 0;
    let count = 0;

    for (const r of validRows) {
      count++;
      const profit = Number(String(r[iProfit] ?? "0").replace(",", ".")) || 0;
      totalProfit += profit;
      const d = r[iDate];
      const ds = d instanceof Date ? d.toISOString().slice(0, 7) : String(d).slice(0, 7);
      if (ds === ym) monthProfit += profit;
    }

    const gkvLimit = Number.isFinite(settings.gkvLimit) ? settings.gkvLimit : DEFAULT_GKV_LIMIT;
    const profitGoal = Number.isFinite(settings.profitGoal) ? settings.profitGoal : DEFAULT_PROFIT_GOAL;

    res.json({
      ok: true,
      salesCount: count,
      totalProfit,
      monthProfit,
      gkvLimit,
      gkvRemaining: gkvLimit - monthProfit,
      roadTo15kGoal: profitGoal,
      roadTo15kProgress: totalProfit,
      settings,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/sourcing/check", async (req, res) => {
  const schema = z.object({
    expectedVk: z.number().positive(),
    ek: z.number().nonnegative(),
    sku: z.string().optional(),
    categoryHint: z.string().optional(),
  });

  try {
    const body = schema.parse(req.body);
    const { vp } = parseSkuParts(body.sku || "");
    const shippingCost = (vp ?? 0);
    const fee = await getFeeForCategory(body.categoryHint);
    const out = sourcingDecision({
      expectedVk: body.expectedVk,
      ek: body.ek,
      shippingCost,
      feePct: fee.feePct,
      feeFixed: fee.feeFixed,
    });

    res.json({ ok: true, ...out, shippingCost, feePct: fee.feePct, feeFixed: fee.feeFixed, feeSource: fee.source });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/sales", async (req, res) => {
  try {
    const data = await callSheets({ action: "getSales" });
    if (!data.ok) return res.status(500).json(data);
    const idx = Object.fromEntries((data.header || []).map((h, i) => [String(h).trim(), i]));
    const iDate = idx["Datum"] ?? 0;
    const iTitle = idx["Titel"] ?? idx["Title"] ?? 1;
    const iProfit = idx["Gewinn"] ?? 8;
    const iVk = idx["VK"] ?? 7;
    const iOrder = idx["Order-ID"] ?? idx["OrderID"] ?? idx["ID"] ?? 9;
    const rows = (data.rows || [])
      .filter((r) => String(r[iOrder] ?? "").trim() !== "")
      .map((r) => ({
        date: r[iDate],
        title: r[iTitle],
        profit: Number(String(r[iProfit] ?? "0").replace(",", ".")) || 0,
        vk: Number(String(r[iVk] ?? "0").replace(",", ".")) || 0,
        orderId: String(r[iOrder] ?? "").trim(),
      }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/inventory", async (req, res) => {
  try {
    const data = await callSheets({ action: "getInventory" });
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/fees", async (req, res) => {
  try {
    const data = await callSheets({ action: "getSheet", sheet: "Fees" });
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/settings", async (req, res) => {
  try {
    const settings = await getSettingsMap();
    res.json({ ok: true, settings });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/settings", async (req, res) => {
  const schema = z.object({
    key: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean()]),
    type: z.enum(["string", "number", "boolean"]).optional(),
    note: z.string().optional(),
  });

  try {
    const body = schema.parse(req.body);
    await callSheets({ action: "upsertSetting", key: body.key, value: body.value, type: body.type || typeof body.value, note: body.note || "" });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/todos", async (req, res) => {
  try {
    const data = await callSheets({ action: "getSheet", sheet: "Todos" });
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/todos", async (req, res) => {
  const schema = z.object({
    title: z.string().min(1),
    status: z.string().optional(),
    owner: z.string().optional(),
    note: z.string().optional(),
  });

  try {
    const body = schema.parse(req.body);
    const out = await callSheets({ action: "addTodo", ...body });
    res.json(out);
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/bootstrap", async (req, res) => {
  try {
    const out = await callSheets({ action: "bootstrap" });
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/command", async (req, res) => {
  const schema = z.object({
    command: z.enum(["set_gkv_limit", "set_profit_goal", "add_todo", "bootstrap"]),
    value: z.union([z.string(), z.number()]).optional(),
    title: z.string().optional(),
    note: z.string().optional(),
  });

  try {
    const body = schema.parse(req.body);

    if (body.command === "bootstrap") {
      return res.json(await callSheets({ action: "bootstrap" }));
    }
    if (body.command === "set_gkv_limit") {
      await callSheets({ action: "upsertSetting", key: "gkvLimit", value: body.value, type: "number", note: body.note || "Updated via command" });
      return res.json({ ok: true, command: body.command });
    }
    if (body.command === "set_profit_goal") {
      await callSheets({ action: "upsertSetting", key: "profitGoal", value: body.value, type: "number", note: body.note || "Updated via command" });
      return res.json({ ok: true, command: body.command });
    }
    if (body.command === "add_todo") {
      const out = await callSheets({ action: "addTodo", title: body.title || String(body.value || ""), note: body.note || "", status: "open", owner: "Raul" });
      return res.json({ ok: true, command: body.command, result: out });
    }

    res.status(400).json({ ok: false, error: "unsupported_command" });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.use((req, res, next) => {
  if (["/health", "/sheets/", "/metrics", "/sales", "/inventory", "/sourcing/", "/settings", "/todos", "/fees", "/bootstrap", "/command"].some((p) => req.path.startsWith(p))) {
    return next();
  }
  if (req.method !== "GET") return next();
  res.sendFile(new URL("../public/index.html", import.meta.url).pathname);
});

const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`Apex server listening on :${port}`));
