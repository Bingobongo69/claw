export function normalizeSettingValue(raw, type = "string") {
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

export function normalizeDateString(input) {
  if (!input) return "";
  const d = new Date(input);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  const s = String(input).trim();
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) {
    return new Date(`${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T00:00:00Z`).toISOString().slice(0, 10);
  }
  return s.slice(0, 10);
}

export function cleanKeywords(input = "") {
  return String(input)
    .replace(/[_-]/g, " ")
    .replace(/\b(?:EK|VK)[^\s]*\b/gi, "")
    .replace(/\b\d{2}_\d{2}_\d{2}_[^\s]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
