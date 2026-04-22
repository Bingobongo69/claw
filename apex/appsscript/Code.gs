/**
 * Apex Apps Script API
 *
 * Deploy:
 * 1) Extensions -> Apps Script
 * 2) Paste this file as Code.gs
 * 3) Deploy -> New deployment -> Web app
 *    - Execute as: Me
 *    - Who has access: Anyone (or Anyone with the link)
 *
 * Endpoints:
 *   GET  ?action=ping
 *   POST (JSON) {action:"getSales"}
 *   POST (JSON) {action:"getSheet", sheet:"Fees"}
 *   POST (JSON) {action:"upsertFee", category:"Elektronik", feePct:12, feeFix:0.35}
 */

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || "ping";
  if (action === "ping") {
    return _json({ ok: true, ts: new Date().toISOString(), spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId() });
  }
  return _json({ ok: false, error: "unknown_action", action: action });
}

function doPost(e) {
  try {
    var body = e && e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
    var action = body.action;

    if (action === "getSales") {
      var salesSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Verkäufe");
      if (!salesSheet) return _json({ ok: false, error: "sheet_not_found", sheet: "Verkäufe" });
      var salesLastRow = salesSheet.getLastRow();
      if (salesLastRow < 2) return _json({ ok: true, header: salesSheet.getRange(1,1,1,10).getValues()[0], rows: [] });
      var salesHeader = salesSheet.getRange(1,1,1,10).getValues()[0];
      var salesRows = salesSheet.getRange(2,1,salesLastRow-1,10).getValues();
      return _json({ ok: true, header: salesHeader, rows: salesRows });
    }

    if (action === "getInventory") {
      var stockSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Warenbestand");
      if (!stockSheet) return _json({ ok: false, error: "sheet_not_found", sheet: "Warenbestand" });
      var stockLastRow = stockSheet.getLastRow();
      var stockLastCol = stockSheet.getLastColumn();
      if (stockLastRow < 2) return _json({ ok: true, header: stockSheet.getRange(1,1,1,stockLastCol).getValues()[0], rows: [] });
      var stockHeader = stockSheet.getRange(1,1,1,stockLastCol).getValues()[0];
      var stockRows = stockSheet.getRange(2,1,stockLastRow-1,stockLastCol).getValues();
      return _json({ ok: true, header: stockHeader, rows: stockRows });
    }

    if (action === "getMonthlyOverview") {
      var monthSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Monatsübersicht");
      if (!monthSheet) return _json({ ok: false, error: "sheet_not_found", sheet: "Monatsübersicht" });
      var monthLastRow = monthSheet.getLastRow();
      var monthLastCol = monthSheet.getLastColumn();
      if (monthLastRow < 2) return _json({ ok: true, header: monthSheet.getRange(1,1,1,monthLastCol).getValues()[0], rows: [] });
      var monthHeader = monthSheet.getRange(1,1,1,monthLastCol).getValues()[0];
      var monthRows = monthSheet.getRange(2,1,monthLastRow-1,monthLastCol).getValues();
      return _json({ ok: true, header: monthHeader, rows: monthRows });
    }

    if (action === "ensureFeesSheet") {
      ensureFeesSheet_();
      return _json({ ok: true });
    }

    if (action === "ensureSettingsSheet") {
      ensureSettingsSheet_();
      return _json({ ok: true });
    }

    if (action === "ensureTodosSheet") {
      ensureTodosSheet_();
      return _json({ ok: true });
    }

    if (action === "bootstrap") {
      ensureFeesSheet_();
      ensureSettingsSheet_();
      ensureTodosSheet_();
      ensureSalesSheetConfig_();
      ensureReportsSheet_();
      return _json({ ok: true });
    }

    if (action === "getSheet") {
      var name = body.sheet;
      var anySheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
      if (!anySheet) return _json({ ok: false, error: "sheet_not_found", sheet: name });
      var lastRow = anySheet.getLastRow();
      var lastCol = anySheet.getLastColumn();
      if (lastRow === 0 || lastCol === 0) return _json({ ok: true, header: [], rows: [] });
      var header = anySheet.getRange(1,1,1,lastCol).getValues()[0];
      var rows = lastRow > 1 ? anySheet.getRange(2,1,lastRow-1,lastCol).getValues() : [];
      return _json({ ok: true, header: header, rows: rows });
    }

    if (action === "getSettings") {
      var settings = readSettingsMap_();
      return _json({ ok: true, settings: settings });
    }

    if (action === "upsertSetting") {
      var key = String(body.key || "").trim();
      if (!key) return _json({ ok: false, error: "missing_key" });
      upsertSetting_(key, body.value, body.type || "string", body.note || "");
      return _json({ ok: true });
    }

    if (action === "upsertFee") {
      var category = (body.category || "").trim();
      if (!category) return _json({ ok: false, error: "missing_category" });
      var feePct = body.feePct;
      var feeFix = body.feeFix;

      var feeSheet = ensureFeesSheet_();
      var feeLastRow = feeSheet.getLastRow();
      var feeData = feeLastRow > 1 ? feeSheet.getRange(2,1,feeLastRow-1,4).getValues() : [];
      var feeRowIndex = -1;
      for (var i=0;i<feeData.length;i++) {
        if (String(feeData[i][0]).trim().toLowerCase() === category.toLowerCase()) { feeRowIndex = i + 2; break; }
      }

      var feeValues = [[category, feePct, feeFix, true]];
      if (feeRowIndex === -1) {
        feeSheet.appendRow(feeValues[0]);
      } else {
        feeSheet.getRange(feeRowIndex,1,1,4).setValues(feeValues);
      }
      return _json({ ok: true });
    }

    if (action === "addTodo") {
      var title = String(body.title || "").trim();
      if (!title) return _json({ ok: false, error: "missing_title" });
      var todoSheet = ensureTodosSheet_();
      todoSheet.appendRow([new Date().toISOString(), title, body.status || "open", body.owner || "Raul", body.note || ""]);
      return _json({ ok: true });
    }

    if (action === "writeAuditRows") {
      writeAuditRows_(body.rows || []);
      return _json({ ok: true, count: (body.rows || []).length });
    }

    if (action === "updateSale") {
      var orderId = String(body.orderId || "").trim();
      if (!orderId) return _json({ ok: false, error: "missing_order_id" });
      var result = updateSaleRow_(orderId, {
        shippingCost: body.shippingCost,
        purchaseCost: body.purchaseCost,
        feePct: body.feePct,
        listingValue: body.listingValue,
        status: body.status
      });
      return _json(result);
    }

    if (action === "syncSkuDefaults") {
      var syncResult = syncSkuDefaults_(body || {});
      return _json(syncResult);
    }

    if (action === "computeReport") {
      return _json(computeReport_(body || {}));
    }

    if (action === "appendReportLog") {
      appendReportLog_(body || {});
      return _json({ ok: true });
    }

    return _json({ ok: false, error: "unknown_action", action: action });
  } catch (err) {
    return _json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function ensureFeesSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Fees");
  if (!sheet) {
    sheet = ss.insertSheet("Fees");
    sheet.getRange(1,1,1,4).setValues([["Kategorie","FeePct","FeeFix","Active"]]);
  }
  return sheet;
}

function ensureSettingsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Settings");
  if (!sheet) {
    sheet = ss.insertSheet("Settings");
    sheet.getRange(1,1,1,4).setValues([["Key","Value","Type","Note"]]);
    sheet.getRange(2,1,5,4).setValues([
      ["gkvLimit", 578, "number", "Monthly target / cap"],
      ["profitGoal", 15000, "number", "Total profit target"],
      ["defaultFeePct", 12, "number", "Fallback fee percent"],
      ["defaultFeeFix", 0.35, "number", "Fallback fee fixed euro"],
      ["currency", "EUR", "string", "Display currency"]
    ]);
  }
  return sheet;
}

function ensureTodosSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Todos");
  if (!sheet) {
    sheet = ss.insertSheet("Todos");
    sheet.getRange(1,1,1,5).setValues([["CreatedAt","Title","Status","Owner","Note"]]);
  }
  return sheet;
}

function ensureReportsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Reports");
  if (!sheet) {
    sheet = ss.insertSheet("Reports");
    sheet.getRange(1,1,1,9).setValues([["CreatedAt","Period","From","To","Revenue","Profit","ROI","TopSeller","TargetLikelihood"]]);
  }
  return sheet;
}

function ensureSalesSheetConfig_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Verkäufe");
  if (!sheet) return null;
  var lastCol = sheet.getLastColumn();
  if (lastCol < 12) return sheet;
  var header = sheet.getRange(1,1,1,lastCol).getValues()[0];
  var statusCol = findHeaderIndex_(header, ["Status"]);
  var profitCol = findHeaderIndex_(header, ["Gewinn", "Profit"]);
  var costCol = findHeaderIndex_(header, ["EK", "EK-Gesamt", "Einkauf", "Einkaufspreis", "Einkaufswert", "Kosten"]);
  var shippingCol = findHeaderIndex_(header, ["Versand", "Versandkosten", "Shipping"]);
  var roiCol = findHeaderIndex_(header, ["ROI %", "ROI%", "ROI"]);
  if (sheet.getLastRow() >= 2) {
    if (statusCol !== -1) {
      var statusRange = sheet.getRange(2, statusCol + 1, Math.max(sheet.getLastRow() - 1, 1), 1);
      var rule = SpreadsheetApp.newDataValidation().requireValueInList(["Offen", "Bezahlt", "Versendet", "Retoure"], true).setAllowInvalid(true).build();
      statusRange.setDataValidation(rule);
    }
    if (profitCol !== -1 && costCol !== -1 && shippingCol !== -1) {
      for (var row = 2; row <= sheet.getLastRow(); row++) {
        var formula = '=IF($' + columnToLetter_(statusCol + 1) + row + '="Retoure",0-$' + columnToLetter_(costCol + 1) + row + '-$' + columnToLetter_(shippingCol + 1) + row + ',' + columnToLetter_(profitCol + 1) + row + ')';
        // do not write formula into profit cell here because app/backend may write direct values
      }
    }
    if (roiCol !== -1 && costCol !== -1) {
      for (var row2 = 2; row2 <= sheet.getLastRow(); row2++) {
        var roiFormula = '=IFERROR(ROUND(' + columnToLetter_(profitCol + 1) + row2 + '/' + columnToLetter_(costCol + 1) + row2 + ';4),0)';
        sheet.getRange(row2, roiCol + 1).setFormula(roiFormula);
      }
    }
  }
  return sheet;
}

function readSettingsMap_() {
  var sheet = ensureSettingsSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};
  var rows = sheet.getRange(2,1,lastRow-1,4).getValues();
  var out = {};
  for (var i=0;i<rows.length;i++) {
    var key = String(rows[i][0] || "").trim();
    if (!key) continue;
    out[key] = {
      value: rows[i][1],
      type: rows[i][2],
      note: rows[i][3]
    };
  }
  return out;
}

function ensureAuditSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Audit");
  if (!sheet) {
    sheet = ss.insertSheet("Audit");
  }
  return sheet;
}

function writeAuditRows_(rows) {
  var headers = ["ListingID","SKU","Title","Price","Currency","Quantity","Available","Score","Priority","IssueCodes","IssueDetails","URL","Image","LastAudit"];
  var sheet = ensureAuditSheet_();
  sheet.clearContents();
  sheet.getRange(1,1,1,headers.length).setValues([headers]);
  if (!rows || !rows.length) return;
  sheet.getRange(2,1,rows.length,headers.length).setValues(rows);
}

function updateSaleRow_(orderId, payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Verkäufe");
  if (!sheet) return { ok: false, error: "sheet_not_found" };
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2) return { ok: false, error: "no_rows" };
  var header = sheet.getRange(1,1,1,lastCol).getValues()[0];
  var rows = sheet.getRange(2,1,lastRow-1,lastCol).getValues();
  var orderIdx = findHeaderIndex_(header, ["Order-ID","OrderID","ID"]);
  if (orderIdx === -1) return { ok: false, error: "order_column_missing" };
  var targetRow = -1;
  for (var i=0;i<rows.length;i++) {
    var value = String(rows[i][orderIdx] || "").trim();
    if (value && value === orderId) {
      targetRow = i + 2;
      break;
    }
  }
  if (targetRow === -1) return { ok: false, error: "order_not_found" };

  var updates = [];
  var rowValues = rows[targetRow - 2];
  var shippingCol = findHeaderIndex_(header, ["Versand", "Versandkosten", "Shipping"]);
  var costCol = findHeaderIndex_(header, ["EK", "EK-Gesamt", "Einkauf", "Einkaufspreis", "Einkaufswert", "Kosten"]);
  var revenueCol = findHeaderIndex_(header, ["VK", "Umsatz", "Verkaufspreis"]);
  var feeAmountCol = findHeaderIndex_(header, ["Gebühr", "Gebühren", "Fee", "Fees"]);
  var listingCol = findHeaderIndex_(header, ["Einstellwert","Listenpreis","ListPrice","Listing"]);
  var profitCol = findHeaderIndex_(header, ["Gewinn", "Profit"]);
  var statusCol = findHeaderIndex_(header, ["Status"]);
  var roiCol = findHeaderIndex_(header, ["ROI %", "ROI%", "ROI"]);

  if (shippingCol !== -1 && payload.shippingCost !== undefined && payload.shippingCost !== null) {
    updates.push({ col: shippingCol + 1, value: Number(payload.shippingCost) });
  }
  if (costCol !== -1 && payload.purchaseCost !== undefined && payload.purchaseCost !== null) {
    updates.push({ col: costCol + 1, value: Number(payload.purchaseCost) });
  }
  if (listingCol !== -1 && payload.listingValue !== undefined && payload.listingValue !== null) {
    updates.push({ col: listingCol + 1, value: Number(payload.listingValue) });
  }
  if (statusCol !== -1 && payload.status !== undefined && payload.status !== null) {
    updates.push({ col: statusCol + 1, value: String(payload.status) });
  }

  var revenue = revenueCol !== -1 ? Number(rowValues[revenueCol] || 0) : 0;
  var feeAmount = payload.feePct !== undefined && payload.feePct !== null && feeAmountCol !== -1
    ? (revenue > 0 ? (revenue * Number(payload.feePct) / 100) : 0)
    : Number(feeAmountCol !== -1 ? rowValues[feeAmountCol] || 0 : 0);
  if (payload.feePct !== undefined && payload.feePct !== null && feeAmountCol !== -1) {
    updates.push({ col: feeAmountCol + 1, value: feeAmount });
  }

  var cost = payload.purchaseCost !== undefined && payload.purchaseCost !== null
    ? Number(payload.purchaseCost)
    : Number(costCol !== -1 ? rowValues[costCol] || 0 : 0);
  var shipping = payload.shippingCost !== undefined && payload.shippingCost !== null
    ? Number(payload.shippingCost)
    : Number(shippingCol !== -1 ? rowValues[shippingCol] || 0 : 0);
  var status = payload.status !== undefined && payload.status !== null
    ? String(payload.status)
    : String(statusCol !== -1 ? rowValues[statusCol] || "" : "");
  var profit = status.toLowerCase() === "retoure"
    ? (0 - cost - shipping)
    : (revenue - cost - shipping - feeAmount);
  if (profitCol !== -1) {
    updates.push({ col: profitCol + 1, value: profit });
  }
  if (roiCol !== -1) {
    updates.push({ col: roiCol + 1, value: cost > 0 ? Math.round((profit / cost) * 10000) / 10000 : 0 });
  }

  if (!updates.length) return { ok: false, error: "no_matching_columns", header: header };

  updates.forEach(function(update) {
    sheet.getRange(targetRow, update.col).setValue(update.value);
  });

  return { ok: true, updated: updates.length, profit: profit, roi: cost > 0 ? Math.round((profit / cost) * 10000) / 10000 : 0 };
}

function syncSkuDefaults_(options) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Verkäufe");
  if (!sheet) return { ok: false, error: "sheet_not_found" };
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2) return { ok: true, updated: 0 };
  var header = sheet.getRange(1,1,1,lastCol).getValues()[0];
  var rows = sheet.getRange(2,1,lastRow-1,lastCol).getValues();
  var skuCol = findHeaderIndex_(header, ["SKU", "Sku"]);
  var costCol = findHeaderIndex_(header, ["EK", "EK-Gesamt", "Einkauf", "Einkaufspreis", "Einkaufswert", "Kosten"]);
  var shippingCol = findHeaderIndex_(header, ["Versand", "Versandkosten", "Shipping"]);
  if (skuCol === -1 || costCol === -1 || shippingCol === -1) return { ok: false, error: "required_columns_missing" };
  var updated = 0;
  for (var i = 0; i < rows.length; i++) {
    var sku = String(rows[i][skuCol] || "").trim();
    if (!sku) continue;
    var parsed = parseSkuDefaults_(sku);
    if (!parsed) continue;
    var rowNumber = i + 2;
    var currentCost = rows[i][costCol];
    var currentShipping = rows[i][shippingCol];
    if ((currentCost === "" || currentCost === null) && parsed.purchaseCost !== null) {
      sheet.getRange(rowNumber, costCol + 1).setValue(parsed.purchaseCost);
      updated++;
    }
    if ((currentShipping === "" || currentShipping === null) && parsed.shippingCost !== null) {
      sheet.getRange(rowNumber, shippingCol + 1).setValue(parsed.shippingCost);
      updated++;
    }
  }
  ensureSalesSheetConfig_();
  return { ok: true, updated: updated };
}

function parseSkuDefaults_(sku) {
  var out = { purchaseCost: null, shippingCost: null };
  var costMatch = String(sku).match(/(?:^|_)EK([0-9]+(?:[\.,][0-9]+)?)(?:_|$)/i);
  if (costMatch) out.purchaseCost = Number(String(costMatch[1]).replace(',', '.'));
  var shippingMatch = String(sku).match(/(?:^|_)(?:VS|SHIP|VERSAND|VK)([0-9]+(?:[\.,][0-9]+)?)(?:_|$)/i);
  if (shippingMatch) out.shippingCost = Number(String(shippingMatch[1]).replace(',', '.'));
  if (out.purchaseCost === null && out.shippingCost === null) return null;
  return out;
}

function computeReport_(options) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Verkäufe");
  if (!sheet) return { ok: false, error: "sheet_not_found" };
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2) return { ok: true, rows: [], kpis: { revenue: 0, profit: 0, roi: 0 }, topSeller: null };
  var header = sheet.getRange(1,1,1,lastCol).getValues()[0];
  var rows = sheet.getRange(2,1,lastRow-1,lastCol).getValues();
  var idx = {
    date: findHeaderIndex_(header, ["Datum", "Date"]),
    title: findHeaderIndex_(header, ["Titel", "Title"]),
    sku: findHeaderIndex_(header, ["SKU", "Sku"]),
    revenue: findHeaderIndex_(header, ["VK", "Umsatz", "Verkaufspreis"]),
    profit: findHeaderIndex_(header, ["Gewinn", "Profit"]),
    cost: findHeaderIndex_(header, ["EK", "EK-Gesamt", "Einkauf", "Einkaufspreis", "Einkaufswert", "Kosten"]),
    roi: findHeaderIndex_(header, ["ROI %", "ROI%", "ROI"]),
    status: findHeaderIndex_(header, ["Status"])
  };
  var from = options.from ? normalizeDateValue_(options.from) : null;
  var to = options.to ? normalizeDateValue_(options.to) : null;
  var filtered = [];
  var revenue = 0;
  var profit = 0;
  var cost = 0;
  var sellers = {};
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var dateValue = idx.date !== -1 ? normalizeDateValue_(row[idx.date]) : null;
    if (from && dateValue && dateValue < from) continue;
    if (to && dateValue && dateValue > to) continue;
    filtered.push(row);
    var rowRevenue = idx.revenue !== -1 ? Number(row[idx.revenue] || 0) : 0;
    var rowProfit = idx.profit !== -1 ? Number(row[idx.profit] || 0) : 0;
    var rowCost = idx.cost !== -1 ? Number(row[idx.cost] || 0) : 0;
    revenue += rowRevenue;
    profit += rowProfit;
    cost += rowCost;
    var sellerKey = idx.title !== -1 ? String(row[idx.title] || row[idx.sku] || 'Unbekannt') : String(row[idx.sku] || 'Unbekannt');
    if (!sellers[sellerKey]) sellers[sellerKey] = { key: sellerKey, revenue: 0, profit: 0, count: 0 };
    sellers[sellerKey].revenue += rowRevenue;
    sellers[sellerKey].profit += rowProfit;
    sellers[sellerKey].count += 1;
  }
  var topSeller = null;
  for (var key in sellers) {
    if (!topSeller || sellers[key].profit > topSeller.profit) topSeller = sellers[key];
  }
  return {
    ok: true,
    rowCount: filtered.length,
    kpis: {
      revenue: revenue,
      profit: profit,
      roi: cost > 0 ? Math.round((profit / cost) * 10000) / 10000 : 0
    },
    topSeller: topSeller,
    from: from,
    to: to
  };
}

function appendReportLog_(payload) {
  var sheet = ensureReportsSheet_();
  sheet.appendRow([
    new Date().toISOString(),
    payload.period || '',
    payload.from || '',
    payload.to || '',
    payload.revenue || 0,
    payload.profit || 0,
    payload.roi || 0,
    payload.topSeller || '',
    payload.targetLikelihood || ''
  ]);
}

function findHeaderIndex_(header, names) {
  for (var i=0;i<header.length;i++) {
    var value = String(header[i] || "").trim();
    for (var j=0;j<names.length;j++) {
      if (value.toLowerCase() === String(names[j]).toLowerCase()) return i;
    }
  }
  return -1;
}

function upsertSetting_(key, value, type, note) {
  var sheet = ensureSettingsSheet_();
  var lastRow = sheet.getLastRow();
  var rows = lastRow > 1 ? sheet.getRange(2,1,lastRow-1,4).getValues() : [];
  var rowIndex = -1;
  for (var i=0;i<rows.length;i++) {
    if (String(rows[i][0] || "").trim() === key) {
      rowIndex = i + 2;
      break;
    }
  }
  var values = [[key, value, type || "string", note || ""]];
  if (rowIndex === -1) sheet.appendRow(values[0]);
  else sheet.getRange(rowIndex,1,1,4).setValues(values);
}

function normalizeDateValue_(value) {
  if (!value) return '';
  var d = new Date(value);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0,10);
  var s = String(value).trim();
  var m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return new Date(m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) + 'T00:00:00Z').toISOString().slice(0,10);
  return s.slice(0,10);
}

function columnToLetter_(column) {
  var temp, letter = '';
  while (column > 0) {
    temp = (column - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    column = (column - temp - 1) / 26;
  }
  return letter;
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
