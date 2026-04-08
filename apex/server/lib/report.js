import { normalizeDateString } from "./utils.js";

const DAY_MS = 86_400_000;

function clampDays(days) {
  if (!Number.isFinite(days)) return 7;
  return Math.min(Math.max(Math.round(days), 1), 31);
}

function asIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

export function buildWeeklyReport({ salesRows = [], lookbackDays = 7, today = new Date(), timezone = "UTC" }) {
  const days = clampDays(lookbackDays);
  const end = new Date(today);
  const endUtc = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  const startUtc = new Date(endUtc);
  startUtc.setUTCDate(startUtc.getUTCDate() - (days - 1));

  const byDayMap = new Map();
  for (let i = 0; i < days; i++) {
    const date = new Date(startUtc.getTime() + i * DAY_MS);
    byDayMap.set(asIsoDate(date), { date: asIsoDate(date), orders: 0, revenue: 0, profit: 0 });
  }

  const totals = { orders: 0, revenue: 0, profit: 0, shipping: 0, fees: 0 };
  const productMap = new Map();
  const lowMarginOrders = [];

  for (const row of salesRows) {
    const ds = normalizeDateString(row.date);
    if (!ds) continue;
    const bucket = byDayMap.get(ds);
    if (!bucket) continue; // outside window

    const revenue = Number(row.vk) || 0;
    const profit = Number(row.profit) || 0;
    const shipping = Number(row.shippingCost) || 0;
    const fees = Number(row.fees) || 0;

    bucket.orders += 1;
    bucket.revenue += revenue;
    bucket.profit += profit;

    totals.orders += 1;
    totals.revenue += revenue;
    totals.profit += profit;
    totals.shipping += shipping;
    totals.fees += fees;

    const productKey = row.sku || row.title || "Unbekannt";
    if (!productMap.has(productKey)) {
      productMap.set(productKey, { sku: row.sku || null, title: row.title || "Unbekannt", orders: 0, revenue: 0, profit: 0 });
    }
    const product = productMap.get(productKey);
    product.orders += 1;
    product.revenue += revenue;
    product.profit += profit;

    const margin = revenue > 0 ? profit / revenue : null;
    if (margin !== null && (margin < 0.15 || profit < 3)) {
      lowMarginOrders.push({
        date: ds,
        orderId: row.orderId,
        title: row.title,
        revenue,
        profit,
        margin
      });
    }
  }

  const byDay = Array.from(byDayMap.values());
  const topProducts = Array.from(productMap.values())
    .sort((a, b) => b.profit - a.profit)
    .slice(0, 5);
  const lowMarginSample = lowMarginOrders.sort((a, b) => (a.margin ?? 0) - (b.margin ?? 0)).slice(0, 5);

  const avgOrderValue = totals.orders ? totals.revenue / totals.orders : 0;
  const avgProfitPerOrder = totals.orders ? totals.profit / totals.orders : 0;
  const grossMargin = totals.revenue ? totals.profit / totals.revenue : 0;

  const summaryParts = [];
  if (totals.orders) {
    summaryParts.push(`${totals.orders} Verkäufe`, `${totals.revenue.toFixed(2)} € Umsatz`, `${totals.profit.toFixed(2)} € Gewinn`, `Margin ${(grossMargin * 100).toFixed(1)}%`);
  } else {
    summaryParts.push("Keine Verkäufe in diesem Zeitraum");
  }
  const summaryText = summaryParts.join(" · ");

  const insights = [];
  if (!totals.orders) {
    insights.push("Keine Verkäufe registriert – Listings pushen oder Kampagnen prüfen.");
  } else {
    if (grossMargin < 0.18) insights.push("Gesamtmarge <18 % – Gebühren/Fracht prüfen oder Preise anpassen.");
    if (lowMarginOrders.length) insights.push(`${lowMarginOrders.length} Orders <15 % Margin – Kandidaten für Repricing.`);
    if (topProducts.length && totals.revenue > 0) {
      const contrib = topProducts[0].revenue / totals.revenue;
      if (contrib > 0.4) insights.push(`${topProducts[0].title} liefert ${(contrib * 100).toFixed(0)} % vom Umsatz – Bestand & Nachschub sichern.`);
    }
    const bestDay = byDay.slice().sort((a, b) => b.revenue - a.revenue)[0];
    if (bestDay && bestDay.revenue) insights.push(`Bester Tag: ${bestDay.date} mit ${bestDay.revenue.toFixed(2)} € Umsatz.`);
  }

  return {
    generatedAt: new Date().toISOString(),
    timezone,
    range: { start: asIsoDate(startUtc), end: asIsoDate(endUtc), days },
    totals: {
      orders: totals.orders,
      revenue: totals.revenue,
      profit: totals.profit,
      avgOrderValue,
      avgProfitPerOrder,
      grossMargin,
      shipping: totals.shipping,
      fees: totals.fees
    },
    byDay,
    topProducts,
    lowMarginOrders: lowMarginSample,
    insights,
    summaryText
  };
}
