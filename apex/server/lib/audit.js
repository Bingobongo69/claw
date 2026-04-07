import { fetchActiveListings } from "./ebay.js";

const PRIORITY_ORDER = { high: 3, medium: 2, low: 1 };

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function addIssue(issues, { code, message, suggestion, priority = "medium", weight = 10 }) {
  issues.push({ code, message, suggestion, priority });
  return weight;
}

function derivePriority(issues) {
  if (!issues.length) return "low";
  return issues.reduce((current, issue) => {
    return PRIORITY_ORDER[issue.priority] > PRIORITY_ORDER[current] ? issue.priority : current;
  }, "low");
}

function keywordScore(title = "") {
  const words = title.toLowerCase().split(/[^a-z0-9äöüß]+/).filter(Boolean);
  if (!words.length) return 0;
  const unique = new Set(words);
  return unique.size / words.length;
}

function evaluateListing(listing) {
  let score = 100;
  const issues = [];
  const title = listing.title?.trim() || "";
  const description = listing.shortDescription?.trim() || "";
  const priceValue = Number(listing?.price?.value);
  const imageCount = Array.isArray(listing?.image?.imageUrls)
    ? listing.image.imageUrls.length
    : listing?.image?.imageUrl
      ? 1
      : 0;

  if (!title) {
    score -= addIssue(issues, {
      code: "title_missing",
      message: "Titel fehlt",
      suggestion: "Titel aus Produkten/SKU übernehmen",
      priority: "high",
      weight: 35
    });
  } else {
    if (title.length < 55) {
      score -= addIssue(issues, {
        code: "title_short",
        message: `Titel hat nur ${title.length} Zeichen`,
        suggestion: "Keywords, Marke und Zustand ergänzen (60-80 Zeichen)",
        priority: "medium",
        weight: 15
      });
    }
    if (title.length > 80) {
      score -= addIssue(issues, {
        code: "title_long",
        message: `Titel ist ${title.length} Zeichen lang`,
        suggestion: "Auf wichtigste Keywords kürzen (<80 Zeichen)",
        priority: "low",
        weight: 5
      });
    }
    if (keywordScore(title) < 0.65) {
      score -= addIssue(issues, {
        code: "title_repetition",
        message: "Viele doppelte Wörter im Titel",
        suggestion: "Synonyme oder Feature-Keywords einsetzen",
        priority: "low",
        weight: 5
      });
    }
    if (/([!?]{3,}|\bneu\b.{0,10}\bneu\b)/i.test(title)) {
      score -= addIssue(issues, {
        code: "title_noise",
        message: "Titel enthält Füllwörter oder zu viele Sonderzeichen",
        suggestion: "Marketing-Phrasen entfernen, klare Suchbegriffe nutzen",
        priority: "medium",
        weight: 10
      });
    }
  }

  if (!description || description.length < 120) {
    score -= addIssue(issues, {
      code: "description_short",
      message: "Beschreibung fehlt oder ist sehr kurz",
      suggestion: "Kurzbeschreibung mit Features, Zustand und Lieferumfang ergänzen",
      priority: "medium",
      weight: 15
    });
  }

  if (!Number.isFinite(priceValue) || priceValue <= 0) {
    score -= addIssue(issues, {
      code: "price_missing",
      message: "Preis fehlt oder ist ungültig",
      suggestion: "VK prüfen und setzen",
      priority: "high",
      weight: 30
    });
  } else {
    if (priceValue < 5) {
      score -= addIssue(issues, {
        code: "price_low",
        message: `VK (${priceValue.toFixed(2)}) wirkt extrem niedrig`,
        suggestion: "Margencheck durchführen oder Mindestpreis definieren",
        priority: "medium",
        weight: 10
      });
    }
    if (priceValue > 2000) {
      score -= addIssue(issues, {
        code: "price_high",
        message: `VK (${priceValue.toFixed(2)}) ist sehr hoch`,
        suggestion: "Mit Konkurrenzpreisen vergleichen und Argumente im Listing einbauen",
        priority: "medium",
        weight: 10
      });
    }
  }

  if (imageCount === 0) {
    score -= addIssue(issues, {
      code: "images_missing",
      message: "Keine Produktbilder hinterlegt",
      suggestion: "Mindestens 4 Bilder in hoher Auflösung hochladen",
      priority: "high",
      weight: 30
    });
  } else if (imageCount < 3) {
    score -= addIssue(issues, {
      code: "images_low",
      message: `${imageCount} Bild(er) sind zu wenig für Vertrauen`,
      suggestion: "Mehrere Winkel + Detailshots ergänzen",
      priority: "medium",
      weight: 15
    });
  }

  score -= addIssue(issues, {
    code: "competitor_pending",
    message: "Konkurrenz-/Preisniveau noch nicht abgeglichen",
    suggestion: "Preisvergleichsdaten anbinden (Geizhals, Idealo etc.)",
    priority: "low",
    weight: 5
  });

  const priority = derivePriority(issues);
  return {
    listingId: listing.listingId,
    sku: listing.sku,
    marketplaceId: listing.marketplaceId,
    title,
    shortDescription: description,
    price: listing.price,
    quantity: listing.quantity,
    availableQuantity: listing.availableQuantity,
    image: listing.image?.imageUrl || listing?.image?.imageUrls?.[0] || null,
    url: listing.itemWebUrl || listing.itemHref,
    score: clampScore(score),
    priority,
    issues,
    raw: listing
  };
}

export async function buildListingAudit({ limit = 50 } = {}) {
  const rawListings = await fetchActiveListings({ limit, max: limit });
  return rawListings.map(evaluateListing);
}
