import express from "express";
import fetch from "node-fetch";
import { z } from "zod";

const app = express();
app.use(express.json({ limit: "1mb" }));

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

// --- Domain logic ---

function parseSkuParts(sku = "") {
  // Raul example: 01_01_01_01_EK2_VK_5
  // We'll accept variants like EK2.5, EK2,50, VK_5, VP3 etc.
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

// For now: default fee if category not known.
const DEFAULT_FEE_PCT = 0.12;
const DEFAULT_FEE_FIXED = 0.35;

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
    const data = await callSheets({ action: "getSales" });
    if (!data.ok) return res.status(500).json(data);

    const header = data.header;
    const rows = data.rows;

    // indices by header name (robust if columns moved)
    const idx = Object.fromEntries(header.map((h, i) => [String(h).trim(), i]));
    const iDate = idx["Datum"] ?? 0;
    const iProfit = idx["Gewinn"] ?? 8;

    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    let monthProfit = 0;
    let totalProfit = 0;
    let count = 0;

    for (const r of rows) {
      count++;
      const profit = Number(String(r[iProfit] ?? "0").replace(",", ".")) || 0;
      totalProfit += profit;

      const d = r[iDate];
      const ds = d instanceof Date ? d.toISOString().slice(0, 7) : String(d).slice(0, 7);
      if (ds === ym) monthProfit += profit;
    }

    res.json({
      ok: true,
      salesCount: count,
      totalProfit,
      monthProfit,
      gkvLimit: 578,
      gkvRemaining: 578 - monthProfit,
      roadTo15kGoal: 15000,
      roadTo15kProgress: totalProfit,
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

    // TODO: category-based fee lookup (we will implement once we have mapping source)
    const feePct = DEFAULT_FEE_PCT;
    const feeFixed = DEFAULT_FEE_FIXED;

    const out = sourcingDecision({
      expectedVk: body.expectedVk,
      ek: body.ek,
      shippingCost,
      feePct,
      feeFixed,
    });

    res.json({ ok: true, ...out, shippingCost, feePct, feeFixed });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/command", async (req, res) => {
  // Placeholder for goal edits. Next: write/read Settings tab via Apps Script.
  res.json({ ok: false, error: "not_implemented_yet" });
});

const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`Apex server listening on :${port}`));
