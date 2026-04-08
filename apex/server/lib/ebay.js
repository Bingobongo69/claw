import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";

const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID;
const EBAY_CERT_ID = process.env.EBAY_CERT_ID;
const EBAY_REFRESH_TOKEN = process.env.EBAY_REFRESH_TOKEN;
const EBAY_SCOPE = process.env.EBAY_SCOPE;
const EBAY_MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || "EBAY_DE";
const EBAY_SITE_ID = process.env.EBAY_SITE_ID || "77";
const EBAY_TRADING_LEVEL = process.env.EBAY_TRADING_LEVEL || "1231";
const EBAY_TRADING_ENDPOINT = process.env.EBAY_TRADING_ENDPOINT || "https://api.ebay.com/ws/api.dll";

const tradingParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", parseTagValue: true });

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

let tokenCache = { accessToken: null, expiresAt: 0 };

function requireEbayCreds() {
  if (!EBAY_CLIENT_ID || !EBAY_CERT_ID || !EBAY_REFRESH_TOKEN) {
    throw new Error("Missing EBAY_CLIENT_ID/EBAY_CERT_ID/EBAY_REFRESH_TOKEN env vars");
  }
}

export async function getEbayAccessToken(force = false) {
  requireEbayCreds();
  const now = Date.now();
  if (!force && tokenCache.accessToken && tokenCache.expiresAt - 60_000 > now) {
    return tokenCache.accessToken;
  }

  const credentials = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CERT_ID}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: EBAY_REFRESH_TOKEN
  });
  if (EBAY_SCOPE) body.set("scope", EBAY_SCOPE);

  const res = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`
    },
    body: body.toString()
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`eBay token fetch failed (${res.status}): ${text}`);
  }

  const json = await res.json();
  tokenCache = {
    accessToken: json.access_token,
    expiresAt: now + (json.expires_in || 0) * 1000
  };
  return tokenCache.accessToken;
}

export function resetEbayTokenCache() {
  tokenCache = { accessToken: null, expiresAt: 0 };
}

export async function fetchActiveListings({ limit = 50, max = 200 } = {}) {
  const accessToken = await getEbayAccessToken();
  const normalizedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const normalizedMax = Math.max(Number(max) || normalizedLimit, normalizedLimit);
  const listings = [];
  let next = `https://api.ebay.com/sell/listing/v1/item_summary/search?listingStatus=ACTIVE&limit=${normalizedLimit}`;

  while (next && listings.length < normalizedMax) {
    const res = await fetch(next, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "X-EBAY-C-MARKETPLACE-ID": EBAY_MARKETPLACE_ID
      }
    });

    if (res.status === 204) break;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`eBay listings fetch failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    if (Array.isArray(data?.itemSummaries)) {
      listings.push(...data.itemSummaries);
    }
    if (!data?.next) break;
    next = data.next;
  }

  return listings.slice(0, normalizedMax);
}

async function callTradingApi(callName, xmlBody, { useTokenInBody = false } = {}) {
  const token = await getEbayAccessToken();
  const headers = {
    "Content-Type": "text/xml",
    "X-EBAY-API-CALL-NAME": callName,
    "X-EBAY-API-COMPATIBILITY-LEVEL": EBAY_TRADING_LEVEL,
    "X-EBAY-API-SITEID": EBAY_SITE_ID,
    "X-EBAY-API-IAF-TOKEN": token
  };
  const finalXml = useTokenInBody
    ? xmlBody.replace("{{TOKEN}}", token)
    : xmlBody;
  const res = await fetch(EBAY_TRADING_ENDPOINT, { method: "POST", headers, body: finalXml });
  const text = await res.text();
  if (!res.ok) throw new Error(`Trading API ${callName} failed (${res.status}): ${text.slice(0, 400)}`);
  return tradingParser.parse(text);
}

function normalizeTradingItem(item) {
  if (!item) return null;
  const quantity = Number(item.Quantity ?? 0);
  const quantitySold = Number(item.SellingStatus?.QuantitySold ?? 0);
  const priceNode = item.StartPrice || item.BuyItNowPrice || item.SellingStatus?.CurrentPrice;
  const price = typeof priceNode === "object" ? Number(priceNode?.["#text"] ?? priceNode) : Number(priceNode ?? 0);
  const currency = typeof priceNode === "object" ? priceNode?.["@_currencyID"] : undefined;
  const pictureSource = item.PictureDetails?.PictureURL || item.PictureDetails?.GalleryURL;
  const pictureList = Array.isArray(pictureSource) ? pictureSource : pictureSource ? [pictureSource] : [];
  const available = Number(item.QuantityAvailable ?? quantity - quantitySold);
  return {
    listingId: item.ItemID,
    sku: item.SKU || null,
    title: item.Title || "",
    shortDescription: item.Description || "",
    price: { value: price || 0, currency: currency || "EUR" },
    quantity,
    availableQuantity: Number.isFinite(available) ? Math.max(available, 0) : Math.max(quantity - quantitySold, 0),
    marketplaceId: item.Site ?? EBAY_MARKETPLACE_ID,
    image: pictureList[0] || null,
    url: item.ListingDetails?.ViewItemURL || null,
    listingStatus: item.SellingStatus?.ListingStatus,
    category: item.PrimaryCategory?.CategoryName,
    startTime: item.ListingDetails?.StartTime,
    endTime: item.ListingDetails?.EndTime,
    raw: item
  };
}

export async function fetchSellerListings({ entriesPerPage = 100, maxPages = 10 } = {}) {
  const items = [];
  let page = 1;

  while (page <= maxPages) {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
        <ActiveList>
          <Include>true</Include>
          <Pagination>
            <EntriesPerPage>${entriesPerPage}</EntriesPerPage>
            <PageNumber>${page}</PageNumber>
          </Pagination>
        </ActiveList>
        <GranularityLevel>Fine</GranularityLevel>
      </GetMyeBaySellingRequest>`;
    const data = await callTradingApi("GetMyeBaySelling", xml);
    const response = data?.GetMyeBaySellingResponse;
    if (!response) break;
    const activeList = response.ActiveList;
    const array = activeList?.ItemArray?.Item;
    const list = Array.isArray(array) ? array : array ? [array] : [];
    for (const item of list) {
      const normalized = normalizeTradingItem(item);
      if (normalized) items.push(normalized);
    }
    const totalPages = Number(activeList?.PaginationResult?.TotalNumberOfPages ?? page);
    if (page >= totalPages) break;
    page += 1;
  }
  return items;
}

export async function reviseEbayItem({ itemId, title, description, price }) {
  if (!itemId) throw new Error("ItemID required for revise");
  const fields = ["<ItemID>" + xmlEscape(itemId) + "</ItemID>"];
  if (title) fields.push(`<Title>${xmlEscape(title)}</Title>`);
  if (description) fields.push(`<Description>${xmlEscape(description)}</Description>`);
  if (price) fields.push(`<StartPrice currencyID="EUR">${Number(price).toFixed(2)}</StartPrice>`);
  const xml = `<?xml version="1.0" encoding="utf-8"?>
    <ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
      <Item>
        ${fields.join("\n")}
      </Item>
    </ReviseFixedPriceItemRequest>`;
  await callTradingApi("ReviseFixedPriceItem", xml);
}

export async function findCompletedItems({ keywords, limit = 15 }) {
  if (!keywords) return [];
  const params = new URLSearchParams({
    "OPERATION-NAME": "findCompletedItems",
    "SERVICE-VERSION": "1.13.0",
    "SECURITY-APPNAME": EBAY_CLIENT_ID,
    "RESPONSE-DATA-FORMAT": "JSON",
    "REST-PAYLOAD": "true",
    keywords,
    "paginationInput.entriesPerPage": String(limit)
  });
  params.append("itemFilter(0).name", "Condition");
  params.append("itemFilter(0).value", "Used");
  params.append("itemFilter(1).name", "ListingType");
  params.append("itemFilter(1).value", "FixedPrice");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  let res;
  try {
    res = await fetch(`https://svcs.ebay.com/services/search/FindingService/v1?${params.toString()}`, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`eBay finding API ${res.status}`);
  const data = await res.json();
  const items = data?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];
  return items.map((item) => ({
    title: item.title?.[0],
    price: Number(item.sellingStatus?.[0]?.currentPrice?.[0]?.__value__ || 0),
    endTime: item.listingInfo?.[0]?.endTime?.[0]
  }));
}
