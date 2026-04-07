import fetch from "node-fetch";

const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID;
const EBAY_CERT_ID = process.env.EBAY_CERT_ID;
const EBAY_REFRESH_TOKEN = process.env.EBAY_REFRESH_TOKEN;
const EBAY_SCOPE = process.env.EBAY_SCOPE || [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.account.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.inventory.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment"
].join(" ");

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
    refresh_token: EBAY_REFRESH_TOKEN,
    scope: EBAY_SCOPE
  });

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
        Accept: "application/json"
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
