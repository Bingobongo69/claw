/**
 * Apex Apps Script API
 *
 * Deploy:
 * 1) Extensions -> Apps Script
 * 2) Paste this file as Code.gs
 * 3) Deploy -> New deployment -> Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 4) Copy Web app URL and set it as APEX_SHEETS_WEBAPP_URL in the server.
 *
 * Endpoints:
 *   GET  ?action=ping
 *   POST (JSON) {action:"getSales"}
 *   POST (JSON) {action:"appendSale", row:{...}}
 *   POST (JSON) {action:"getRange", sheet:"Verkäufe", a1:"A1:J"}
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

    if (action === "getRange") {
      var sheetName = body.sheet;
      var a1 = body.a1;
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
      if (!sheet) return _json({ ok: false, error: "sheet_not_found", sheet: sheetName });
      var values = sheet.getRange(a1).getValues();
      return _json({ ok: true, values: values });
    }

    if (action === "getSales") {
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Verkäufe");
      if (!sheet) return _json({ ok: false, error: "sheet_not_found", sheet: "Verkäufe" });
      var lastRow = sheet.getLastRow();
      if (lastRow < 2) return _json({ ok: true, header: sheet.getRange(1,1,1,10).getValues()[0], rows: [] });
      var header = sheet.getRange(1,1,1,10).getValues()[0];
      var rows = sheet.getRange(2,1,lastRow-1,10).getValues();
      return _json({ ok: true, header: header, rows: rows });
    }

    if (action === "appendSale") {
      var row = body.row || {};
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Verkäufe");
      if (!sheet) return _json({ ok: false, error: "sheet_not_found", sheet: "Verkäufe" });

      // expected columns: Datum, Titel, SKU, Menge, EK-Gesamt, Versand, Gebühr, VK, Gewinn, Order-ID
      var values = [
        row.datum || "",
        row.titel || "",
        row.sku || "",
        row.menge || "",
        row.ek_gesamt || "",
        row.versand || "",
        row.gebuehr || "",
        row.vk || "",
        row.gewinn || "",
        row.order_id || ""
      ];
      sheet.appendRow(values);
      return _json({ ok: true });
    }

    return _json({ ok: false, error: "unknown_action", action: action });
  } catch (err) {
    return _json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
