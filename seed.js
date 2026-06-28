const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_STRAPI_URL = "http://localhost:1337";

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvFile(path.join(__dirname, ".env"));
loadEnvFile(path.join(__dirname, "..", ".env"));

function requireEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function fetchWithRetry(
  url,
  init = {},
  { retries = 3, backoffMs = 500, timeoutMs = 15000 } = {},
) {
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status} ${res.statusText}`);
    } catch (err) {
      clearTimeout(timeoutId);
      lastErr = err;
    }

    const wait = backoffMs * Math.pow(2, attempt);
    await new Promise((r) => setTimeout(r, wait));
  }

  throw lastErr;
}

function strapiUrl(path) {
  const base = process.env.STRAPI_URL || DEFAULT_STRAPI_URL;
  return new URL(path, base).toString();
}

async function requestJson(path, init = {}) {
  const token = requireEnv("STRAPI_TOKEN");
  const res = await fetch(strapiUrl(path), {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401) {
      throw new Error(
        `Authentication failed (401). Use an API Token from Strapi Admin → Settings → API Tokens (not Transfer Tokens). ` +
          `Set STRAPI_TOKEN in backend/.env and ensure STRAPI_URL points to your running Strapi instance. ` +
          `${init.method || "GET"} ${path}${text ? ` - ${text}` : ""}`,
      );
    }
    throw new Error(
      `${init.method || "GET"} ${path} failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ""}`,
    );
  }

  return res.json();
}

async function uploadImageFromUrl(imageUrl, filename) {
  const token = requireEnv("STRAPI_TOKEN");
  if (process.env.SKIP_UPLOADS === "1") return null;

  let res;
  try {
    res = await fetchWithRetry(
      imageUrl,
      {},
      { retries: 3, backoffMs: 600, timeoutMs: 20000 },
    );
  } catch (err) {
    console.warn(`Image download skipped (unavailable): ${imageUrl}`);
    return null;
  }

  const contentType = res.headers.get("content-type") || "image/jpeg";
  const buf = Buffer.from(await res.arrayBuffer());
  const blob = new Blob([buf], { type: contentType });

  const form = new FormData();
  form.append("files", blob, filename);

  const uploadRes = await fetch(strapiUrl("/api/upload"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: form,
  });

  if (!uploadRes.ok) {
    const text = await uploadRes.text().catch(() => "");
    throw new Error(
      `POST /api/upload failed: ${uploadRes.status} ${uploadRes.statusText}${text ? ` - ${text}` : ""}`,
    );
  }

  const uploaded = await uploadRes.json();
  const first = Array.isArray(uploaded) ? uploaded[0] : null;
  if (!first?.id) throw new Error(`Unexpected upload response for ${imageUrl}`);
  return first.id;
}

async function findBySlug(collection, slug) {
  const qs = new URLSearchParams();
  qs.set("filters[slug][$eq]", slug);
  qs.set("pagination[pageSize]", "1");
  const res = await requestJson(`/api/${collection}?${qs.toString()}`);
  const first = res?.data?.[0] ?? null;
  return first ? first.id : null;
}

async function createEntry(collection, data) {
  const payloadWithPublish = { ...data, publishedAt: new Date().toISOString() };

  try {
    const res = await requestJson(`/api/${collection}`, {
      method: "POST",
      body: JSON.stringify({ data: payloadWithPublish }),
    });
    return res?.data?.id;
  } catch {
    const res = await requestJson(`/api/${collection}`, {
      method: "POST",
      body: JSON.stringify({ data }),
    });
    return res?.data?.id;
  }
}

async function ensureBySlug(collection, { slug, ...data }) {
  const existingId = await findBySlug(collection, slug);
  if (existingId) return existingId;
  const id = await createEntry(collection, { ...data, slug });
  if (!id) throw new Error(`Failed to create ${collection} ${slug}`);
  return id;
}

function slugifyAscii(input) {
  const s = String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return s || null;
}

/** Strapi slugs must be ASCII: /^[A-Za-z0-9-_.~]*$/ */
function asciiSlugFromLabel(label, prefix = "item") {
  const ascii = slugifyAscii(label);
  if (ascii) return ascii.slice(0, 80);
  const hash = crypto
    .createHash("sha1")
    .update(String(label))
    .digest("hex")
    .slice(0, 12);
  return `${prefix}-${hash}`;
}

function normalizeDigits(input) {
  const s = String(input || "");
  const map = {
    "۰": "0",
    "۱": "1",
    "۲": "2",
    "۳": "3",
    "۴": "4",
    "۵": "5",
    "۶": "6",
    "۷": "7",
    "۸": "8",
    "۹": "9",
    "٠": "0",
    "١": "1",
    "٢": "2",
    "٣": "3",
    "٤": "4",
    "٥": "5",
    "٦": "6",
    "٧": "7",
    "٨": "8",
    "٩": "9",
  };
  return s.replace(/[۰-۹٠-٩]/g, (ch) => map[ch] ?? ch);
}

function decodeEntities(input) {
  return String(input || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function decodeXmlEntities(input) {
  return decodeEntities(input)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);/g, (_, num) =>
      String.fromCodePoint(parseInt(num, 10)),
    );
}

function htmlToText(html) {
  const cleaned = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const text = cleaned
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h1|h2|h3|tr|td|th)>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function extractMeta(html, key) {
  const h = String(html || "");
  const re1 = new RegExp(
    `<meta[^>]+property=["']${key}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i",
  );
  const re2 = new RegExp(
    `<meta[^>]+name=["']${key}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i",
  );
  const m = h.match(re1) || h.match(re2);
  return m ? decodeEntities(m[1]).trim() : null;
}

function extractFirstTagText(html, tagName) {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const m = String(html || "").match(re);
  if (!m) return null;
  return htmlToText(m[1]).trim() || null;
}

function extractImageUrls(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const h = String(html || "");
  const re = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(h))) {
    const raw = m[1];
    if (!raw || raw.startsWith("data:")) continue;
    const url = new URL(raw, baseUrl).toString();
    if (!/\.(png|jpe?g|webp)(\?|#|$)/i.test(url)) continue;
    if (/logo|icon|sprite/i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function parseBaziPlanetSpecs(text) {
  const normalized = normalizeDigits(text);
  const lines = normalized
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const idx = lines.findIndex((l) => l.includes("مشخصات"));
  if (idx === -1) return {};
  const tail = lines.slice(idx + 1);

  function findValue(label) {
    const i = tail.findIndex((l) => l.replace(/\s+/g, " ").includes(label));
    if (i === -1) return null;
    const v = tail[i + 1] ?? null;
    return v ? v.replace(/\s+/g, " ").trim() : null;
  }

  const players = findValue("تعداد بازیکن");
  const time = findValue("مدت زمان بازی");
  const difficulty = findValue("پيچيدگي و سختي بازی");
  const age = findValue("گروه سنی");
  const category = findValue("دسته بندی");

  function parseRange(v) {
    if (!v) return null;
    const m = v.match(/(\d+)\s*تا\s*(\d+)/);
    if (m) return { min: Number(m[1]), max: Number(m[2]) };
    const single = v.match(/(\d+)/);
    if (single) return { min: Number(single[1]), max: Number(single[1]) };
    return null;
  }

  function parseMinutes(v) {
    if (!v) return null;
    const m = v.match(/(\d+)\s*دقیقه/);
    if (m) return Number(m[1]);
    const n = v.match(/(\d+)/);
    return n ? Number(n[1]) : null;
  }

  function parseAge(v) {
    if (!v) return null;
    const m = v.match(/(\d+)\s*سال/);
    if (m) return Number(m[1]);
    const n = v.match(/(\d+)/);
    return n ? Number(n[1]) : null;
  }

  function mapDifficulty(v) {
    if (!v) return null;
    const s = v.replace(/\s+/g, " ").trim();
    if (s.includes("سبک")) return 1.6;
    if (s.includes("متوسط")) return 2.5;
    if (s.includes("سنگین")) return 3.5;
    return null;
  }

  return {
    category,
    players: parseRange(players),
    playingTime: parseMinutes(time),
    age: parseAge(age),
    complexity: mapDifficulty(difficulty),
  };
}

function extractSection(text, startLabel, endLabel) {
  const t = String(text || "");
  const startIdx = t.indexOf(startLabel);
  if (startIdx === -1) return null;
  const afterStart = t.slice(startIdx + startLabel.length);
  const endIdx = afterStart.indexOf(endLabel);
  const slice = endIdx === -1 ? afterStart : afterStart.slice(0, endIdx);
  const cleaned = slice.trim().replace(/\n{3,}/g, "\n\n");
  return cleaned || null;
}

function extractAllXmlLinkValues(xml, linkType) {
  const out = [];
  const re = new RegExp(
    `<link[^>]+type=["']${linkType}["'][^>]+value=["']([^"']+)["'][^>]*/?>`,
    "gi",
  );
  let m;
  while ((m = re.exec(String(xml || "")))) {
    out.push(decodeXmlEntities(m[1]).trim());
  }
  return out;
}

function extractXmlTagValue(xml, tagName) {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const m = String(xml || "").match(re);
  return m ? decodeXmlEntities(m[1]).trim() : null;
}

function extractXmlAttrValue(xml, tagName, attr) {
  const re = new RegExp(
    `<${tagName}[^>]+${attr}=["']([^"']+)["'][^>]*/?>`,
    "i",
  );
  const m = String(xml || "").match(re);
  return m ? decodeXmlEntities(m[1]).trim() : null;
}

function extractBggPrimaryName(xml) {
  const re = /<name[^>]+type=["']primary["'][^>]+value=["']([^"']+)["'][^>]*/i;
  const m = String(xml || "").match(re);
  return m ? decodeXmlEntities(m[1]).trim() : null;
}

async function fetchBggThing(bggId) {
  const url = new URL("https://boardgamegeek.com/xmlapi2/thing");
  url.searchParams.set("id", String(bggId));
  url.searchParams.set("stats", "1");

  let lastErr;
  let xml = null;
  for (let attempt = 0; attempt <= 6; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    try {
      const res = await fetch(url.toString(), {
        signal: controller.signal,
        headers: {
          Accept: "application/xml,text/xml;q=0.9,*/*;q=0.8",
          "User-Agent": "thinksygeek-seed/1.0 (+https://localhost)",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      clearTimeout(timeoutId);

      if (res.status === 202 || res.status === 429) {
        lastErr = new Error(`HTTP ${res.status} ${res.statusText}`);
      } else if (res.ok) {
        xml = await res.text();
        break;
      } else {
        const text = await res.text().catch(() => "");
        lastErr = new Error(
          `HTTP ${res.status} ${res.statusText}${text ? ` - ${text.slice(0, 300)}` : ""}`,
        );
      }
    } catch (err) {
      clearTimeout(timeoutId);
      lastErr = err;
    }

    const wait = Math.min(15000, 800 * Math.pow(2, attempt));
    await new Promise((r) => setTimeout(r, wait));
  }

  if (!xml) {
    throw lastErr ?? new Error("Failed to fetch BGG XML");
  }

  const name = extractBggPrimaryName(xml) || `BGG-${bggId}`;
  const yearPublishedRaw = extractXmlAttrValue(xml, "yearpublished", "value");
  const minPlayersRaw = extractXmlAttrValue(xml, "minplayers", "value");
  const maxPlayersRaw = extractXmlAttrValue(xml, "maxplayers", "value");
  const playingTimeRaw = extractXmlAttrValue(xml, "playingtime", "value");
  const minAgeRaw = extractXmlAttrValue(xml, "minage", "value");
  const weightRaw = extractXmlAttrValue(xml, "averageweight", "value");
  const descriptionEn = extractXmlTagValue(xml, "description");

  const publishers = extractAllXmlLinkValues(xml, "boardgamepublisher");
  const designers = extractAllXmlLinkValues(xml, "boardgamedesigner");
  const categories = extractAllXmlLinkValues(xml, "boardgamecategory");
  const mechanics = extractAllXmlLinkValues(xml, "boardgamemechanic");

  const imageUrl = extractXmlTagValue(xml, "image");
  const thumbnailUrl = extractXmlTagValue(xml, "thumbnail");

  function toNumber(v) {
    if (v === null || v === undefined) return null;
    const n = Number(String(v).trim());
    return Number.isFinite(n) ? n : null;
  }

  return {
    bggId: String(bggId),
    name,
    yearPublished: toNumber(yearPublishedRaw),
    minPlayers: toNumber(minPlayersRaw),
    maxPlayers: toNumber(maxPlayersRaw),
    playingTime: toNumber(playingTimeRaw),
    age: toNumber(minAgeRaw),
    complexity: toNumber(weightRaw),
    descriptionEn,
    publishers,
    designers,
    categories,
    mechanics,
    imageUrl,
    thumbnailUrl,
  };
}

function parseJsonEnv(name) {
  const raw = process.env[name];
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getBaziPlanetMap() {
  const map = parseJsonEnv("BAZIPLANET_MAP");
  if (!map || typeof map !== "object") return {};
  return map;
}

function cleanupStrapiRichtext(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  return t.replace(/\n{3,}/g, "\n\n").trim();
}

async function importBaziPlanetGame(pageUrl) {
  const res = await fetchWithRetry(
    pageUrl,
    {},
    { retries: 2, backoffMs: 800, timeoutMs: 20000 },
  );
  const html = await res.text();
  const title =
    extractMeta(html, "og:title") ||
    extractFirstTagText(html, "h1") ||
    extractFirstTagText(html, "title") ||
    "Board Game";
  const descriptionText = htmlToText(html);
  const description =
    extractSection(descriptionText, "توضیحات", "جزئیات محصول") ||
    descriptionText;

  const specs = parseBaziPlanetSpecs(descriptionText);

  const urlObj = new URL(pageUrl);
  const last = urlObj.pathname.split("/").filter(Boolean).pop() || "";
  const slugGuess =
    slugifyAscii(last.split("-").slice(-3).join("-")) ||
    `baziplanet-${Date.now()}`;

  const categorySlug = specs.category ? slugifyAscii(specs.category) : null;
  const categoryIds = [];
  if (specs.category && categorySlug) {
    const id = await ensureBySlug("categories", {
      slug: categorySlug,
      name: specs.category,
    });
    categoryIds.push(id);
  }

  const imageIds = [];
  for (const [idx, imageUrl] of images.entries()) {
    const id = await uploadImageFromUrl(
      imageUrl,
      `${slugGuess}-${idx + 1}.jpg`,
    ).catch(() => null);
    if (id) imageIds.push(id);
  }

  const data = {
    slug: slugGuess,
    title,
    description,
    minPlayers: specs.players?.min ?? undefined,
    maxPlayers: specs.players?.max ?? undefined,
    playingTime: specs.playingTime ?? undefined,
    age: specs.age ?? undefined,
    complexity: specs.complexity ?? undefined,
    categories: categoryIds.length ? categoryIds : undefined,
    images: imageIds.length ? imageIds : undefined,
  };

  await ensureBySlug("games", data);
  return { slug: slugGuess };
}

function normalizeBggPublisherName(name) {
  return String(name || "").trim();
}

function getKnownPublisherNameFa(nameEn) {
  const n = normalizeBggPublisherName(nameEn).toLowerCase();
  const map = {
    kosmos: "کاسموس (KOSMOS)",
    "z-man games": "زد-من گیمز (Z-Man Games)",
    "next move games": "نکست موو گیمز (Next Move Games)",
    fryxgames: "فریکس‌گیمز (FryxGames)",
  };
  return map[n] ?? null;
}

async function importBggGame({ bggId, preferredPublisherSlug } = {}) {
  if (!bggId) throw new Error("Missing bggId");
  const bgg = await fetchBggThing(bggId);

  const baziPlanetMap = getBaziPlanetMap();
  const baziPlanetUrl =
    (typeof baziPlanetMap[bgg.bggId] === "string"
      ? baziPlanetMap[bgg.bggId]
      : null) ?? null;

  let imagesFromBazi = [];
  let descriptionFa = null;
  let specsFa = {};
  if (baziPlanetUrl) {
    const res = await fetchWithRetry(
      baziPlanetUrl,
      {},
      { retries: 2, backoffMs: 800, timeoutMs: 20000 },
    );
    const html = await res.text();
    const text = htmlToText(html);
    descriptionFa = cleanupStrapiRichtext(
      extractSection(text, "توضیحات", "جزئیات محصول"),
    );
    specsFa = parseBaziPlanetSpecs(text);
    imagesFromBazi = extractImageUrls(html, baziPlanetUrl).slice(0, 6);
  }

  const primaryName = bgg.name;
  const slugBase = slugifyAscii(primaryName) || `bgg-${bgg.bggId}`;
  const gameSlug = `${slugBase}-${bgg.bggId}`;

  const publisherNameEn = bgg.publishers?.[0] ?? null;
  const publisherSlug =
    preferredPublisherSlug ??
    (publisherNameEn ? slugifyAscii(publisherNameEn) : null) ??
    "publisher";
  const publisherNameFa =
    (publisherNameEn ? getKnownPublisherNameFa(publisherNameEn) : null) ??
    publisherNameEn ??
    publisherSlug;
  const publisherId = await ensureBySlug("publishers", {
    slug: publisherSlug,
    name: publisherNameFa,
  });

  const firstDesignerEn = bgg.designers?.[0] ?? null;
  const designerSlug = firstDesignerEn ? slugifyAscii(firstDesignerEn) : null;
  const designerId =
    firstDesignerEn && designerSlug
      ? await ensureBySlug("designers", {
          slug: designerSlug,
          name: firstDesignerEn,
        })
      : null;

  const categoryIds = [];
  for (const c of (bgg.categories || []).slice(0, 6)) {
    const cSlug = slugifyAscii(c);
    if (!cSlug) continue;
    const id = await ensureBySlug("categories", { slug: cSlug, name: c });
    categoryIds.push(id);
  }

  const mechanicIds = [];
  for (const m of (bgg.mechanics || []).slice(0, 8)) {
    const mSlug = slugifyAscii(m);
    if (!mSlug) continue;
    const id = await ensureBySlug("mechanics", { slug: mSlug, name: m });
    mechanicIds.push(id);
  }

  const imageUrls = imagesFromBazi.length ? imagesFromBazi : [];
  const imageIds = [];
  for (const [idx, imageUrl] of imageUrls.entries()) {
    const id = await uploadImageFromUrl(
      imageUrl,
      `${gameSlug}-${idx + 1}.jpg`,
    ).catch(() => null);
    if (id) imageIds.push(id);
  }

  const minPlayers = specsFa.players?.min ?? bgg.minPlayers ?? undefined;
  const maxPlayers = specsFa.players?.max ?? bgg.maxPlayers ?? undefined;
  const playingTime = specsFa.playingTime ?? bgg.playingTime ?? undefined;
  const age = specsFa.age ?? bgg.age ?? undefined;
  const complexity = specsFa.complexity ?? bgg.complexity ?? undefined;

  const description =
    descriptionFa ?? cleanupStrapiRichtext(bgg.descriptionEn) ?? primaryName;

  const data = {
    slug: gameSlug,
    title: primaryName,
    description,
    minPlayers,
    maxPlayers,
    playingTime,
    age,
    complexity,
    publisher: publisherId,
    designer: designerId ?? undefined,
    categories: categoryIds.length ? categoryIds : undefined,
    mechanics: mechanicIds.length ? mechanicIds : undefined,
    images: imageIds.length ? imageIds : undefined,
  };

  await ensureBySlug("games", data);
  return { slug: gameSlug };
}

function getDefaultBggSeedPlan() {
  return [
    {
      publisher: { slug: "kosmos", name: "کاسموس (KOSMOS)" },
      bggIds: [13, 50, 118048],
    },
    {
      publisher: { slug: "z-man-games", name: "زد-من گیمز (Z-Man Games)" },
      bggIds: [30549, 129622, 822],
    },
    {
      publisher: {
        slug: "next-move-games",
        name: "نکست موو گیمز (Next Move Games)",
      },
      bggIds: [230802, 290100, 306040],
    },
    {
      publisher: { slug: "fryxgames", name: "فریکس‌گیمز (FryxGames)" },
      bggIds: [167791, 359609],
    },
  ];
}

function parsePlayersFa(value) {
  const n = normalizeDigits(String(value || ""));
  const range = n.match(/(\d+)\s*تا\s*(\d+)/);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const single = n.match(/(\d+)/);
  if (single) return { min: Number(single[1]), max: Number(single[1]) };
  return {};
}

function parsePlayTimeFa(value) {
  const n = normalizeDigits(String(value || ""));
  const nums = n.match(/(\d+)/g);
  if (!nums?.length) return null;
  return Math.max(...nums.map(Number));
}

function parseAgeFa(value) {
  const n = normalizeDigits(String(value || ""));
  const m = n.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

function avgRatingFromSum(ratingsSum, ratingsCount) {
  if (!ratingsSum || !ratingsCount) return null;
  const total = Object.values(ratingsSum).reduce((a, b) => a + b, 0);
  return total / (5 * ratingsCount);
}

async function seedBazigeekCatalog() {
  if (process.env.BAZIGEEK_SEED === "0") return;

  let data;
  try {
    data = require("./bazigeek-seed-data.js");
  } catch {
    console.log("bazigeek-seed-data.js not found; skipping BaziGeek seed.");
    return;
  }

  const { publishers = [], games = [], articles = [] } = data;
  console.log(`BaziGeek seed: ${publishers.length} publishers, ${games.length} games, ${articles.length} articles`);

  const publisherIdBySlug = {};
  for (const pub of publishers) {
    const slug = pub.id;
    let logoId = null;
    if (pub.logoUrl) {
      logoId = await uploadImageFromUrl(pub.logoUrl, `${slug}-logo.jpg`).catch(
        () => null,
      );
    }
    const id = await ensureBySlug("publishers", {
      slug,
      name: pub.name,
      nameEnglish: pub.nameEnglish,
      bio: pub.description,
      foundedYear: pub.foundedYear,
      country: pub.country,
      website: pub.website,
      ...(logoId ? { logo: logoId } : {}),
    });
    publisherIdBySlug[slug] = id;
  }

  const categoryIdByName = {};
  async function ensureCategory(name) {
    if (categoryIdByName[name]) return categoryIdByName[name];
    const slug = asciiSlugFromLabel(name, "cat");
    const id = await ensureBySlug("categories", { slug, name });
    categoryIdByName[name] = id;
    return id;
  }

  const designerIdByName = {};
  async function ensureDesigner(name) {
    if (!name) return null;
    if (designerIdByName[name]) return designerIdByName[name];
    const slug = asciiSlugFromLabel(name, "designer");
    const id = await ensureBySlug("designers", { slug, name });
    designerIdByName[name] = id;
    return id;
  }

  for (const g of games) {
    const slug = g.id;
    const existing = await findBySlug("games", slug);
    if (existing) {
      console.log(`Skip BaziGeek game (exists): ${slug}`);
      continue;
    }

    const players = parsePlayersFa(g.numberOfPlayers);
    const playingTime = parsePlayTimeFa(g.playTime);
    const age = parseAgeFa(g.ageRange);
    const ratingsCount = g.ratingsCount ?? 0;
    const averageRating =
      g.averageRating ?? avgRatingFromSum(g.ratingsSum, ratingsCount);

    const categoryIds = [];
    for (const cat of g.categories || []) {
      categoryIds.push(await ensureCategory(cat));
    }

    const designerId = await ensureDesigner(g.designer);
    const publisherId = publisherIdBySlug[g.publisherId] ?? null;

    let imageId = null;
    if (g.bgImageUrl) {
      imageId = await uploadImageFromUrl(
        g.bgImageUrl,
        `${slug}-cover.jpg`,
      ).catch(() => null);
    }

    const ratingFields =
      ratingsCount > 0 && g.ratingsSum
        ? {
            ratingGameplay: g.ratingsSum.gameplay / ratingsCount,
            ratingArt: g.ratingsSum.artAndComponents / ratingsCount,
            ratingRules: g.ratingsSum.rulesEase / ratingsCount,
            ratingStrategy: g.ratingsSum.strategyDepth / ratingsCount,
            ratingReplay: g.ratingsSum.replayability / ratingsCount,
          }
        : {};

    await createEntry("games", {
      slug,
      title: g.title,
      titleEnglish: g.titleEnglish,
      description: g.description,
      story: g.story,
      videoUrl: g.videoUrl,
      minPlayers: players.min,
      maxPlayers: players.max,
      bestPlayerCount: g.bestPlayerCount,
      playingTime,
      age,
      languageDependency: g.languageDependency,
      releaseYear: g.releaseYear,
      complexity: g.difficulty,
      averageRating,
      ratingsCount,
      ...ratingFields,
      publisher: publisherId ?? undefined,
      designer: designerId ?? undefined,
      categories: categoryIds.length ? categoryIds : undefined,
      images: imageId ? [imageId] : undefined,
    });

    console.log(`Created BaziGeek game: ${slug}`);
  }

  for (const art of articles) {
    const slug = art.slug || art.id;
    const existing = await findBySlug("articles", slug);
    if (existing) {
      console.log(`Skip BaziGeek article (exists): ${slug}`);
      continue;
    }

    let coverId = null;
    if (art.imageUrl) {
      coverId = await uploadImageFromUrl(art.imageUrl, `${slug}-cover.jpg`).catch(
        () => null,
      );
    }

    await createEntry("articles", {
      slug,
      title: art.title,
      brief: art.brief,
      content: art.content,
      author: art.author,
      publishedDate: art.date,
      readTime: art.readTime,
      category: art.category,
      likes: art.likes ?? 0,
      tags: art.tags ?? [],
      ...(coverId ? { coverImage: coverId } : {}),
    });

    console.log(`Created BaziGeek article: ${slug}`);
  }
}

async function main() {
  console.log("Seeding started…");

  const publishers = [
    { slug: "kosmos", name: "کاسموس (KOSMOS)" },
    { slug: "next-move-games", name: "نکست موو گیمز (Next Move Games)" },
    { slug: "fryxgames", name: "فریکس‌گیمز (FryxGames)" },
    { slug: "z-man-games", name: "زد-من گیمز (Z-Man Games)" },
    { slug: "space-cowboys", name: "اسپیس کابویس (Space Cowboys)" },
  ];

  const categories = [
    { slug: "strategy", name: "استراتژی" },
    { slug: "family", name: "خانوادگی" },
    { slug: "abstract", name: "انتزاعی" },
    { slug: "cooperative", name: "همکاری‌محور" },
    { slug: "economic", name: "اقتصادی" },
    { slug: "sci-fi", name: "علمی‌تخیلی" },
    { slug: "card-game", name: "کارت‌محور" },
  ];

  const mechanics = [
    { slug: "resource-management", name: "مدیریت منابع" },
    { slug: "trading-negotiation", name: "معامله و مذاکره" },
    { slug: "dice-rolling", name: "تاس‌ریزی" },
    { slug: "pattern-building", name: "کاشی‌چینی / ساخت الگو" },
    { slug: "engine-building", name: "ساخت موتور" },
    { slug: "hand-management", name: "مدیریت دست" },
    { slug: "area-control", name: "کنترل منطقه" },
    { slug: "token-collection", name: "جمع‌آوری توکن" },
    { slug: "set-collection", name: "ست‌سازی" },
    { slug: "cooperative-play", name: "بازی مشارکتی" },
  ];

  const publisherIdBySlug = {};
  for (const p of publishers) {
    publisherIdBySlug[p.slug] = await ensureBySlug("publishers", p);
  }

  const categoryIdBySlug = {};
  for (const c of categories) {
    categoryIdBySlug[c.slug] = await ensureBySlug("categories", c);
  }

  const mechanicIdBySlug = {};
  for (const m of mechanics) {
    mechanicIdBySlug[m.slug] = await ensureBySlug("mechanics", m);
  }

  const bggSeedPlan = parseJsonEnv("BGG_SEED_PLAN");
  const plan = Array.isArray(bggSeedPlan)
    ? bggSeedPlan
    : getDefaultBggSeedPlan();
  if (process.env.BGG_SEED === "1") {
    const baziPlanetMap = getBaziPlanetMap();
    if (Object.keys(baziPlanetMap).length === 0) {
      console.log(
        'BAZIPLANET_MAP is empty. Images will be skipped unless you provide a mapping { "<bggId>": "<baziPlanetUrl>" }',
      );
    }

    for (const group of plan) {
      const publisher = group?.publisher;
      const publisherSlug = publisher?.slug;
      const publisherName = publisher?.name;
      const bggIds = Array.isArray(group?.bggIds) ? group.bggIds : [];
      if (publisherSlug && publisherName) {
        await ensureBySlug("publishers", {
          slug: publisherSlug,
          name: publisherName,
        });
      }
      for (const id of bggIds) {
        await importBggGame({
          bggId: id,
          preferredPublisherSlug: publisherSlug || undefined,
        });
      }
    }
  }

  const baziPlanetUrls = (process.env.BAZIPLANET_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const url of baziPlanetUrls) {
    await importBaziPlanetGame(url);
  }

  const games = [
    {
      slug: "catan",
      title: "کاتان",
      description:
        "کاتان یکی از کلاسیک‌ترین بازی‌های مدرن است که در آن بازیکنان روی جزیرهٔ کاتان برای ساخت‌وساز و توسعه رقابت می‌کنند.\n\nهستهٔ بازی بر مدیریت منابع، معامله و تصمیم‌گیری‌های تاکتیکی بنا شده است؛ هر نوبت با تاس‌ریزی جریان منابع را تغییر می‌دهد و مذاکره‌ها (تجارت) به یک ابزار کلیدی تبدیل می‌شوند. تعادل میان توسعهٔ جاده‌ها/شهرها، کنترل نقاط کلیدی و مدیریت ریسک، تجربه‌ای پرکشمکش و بسیار تکرارپذیر می‌سازد.",
      minPlayers: 3,
      maxPlayers: 4,
      playingTime: 90,
      complexity: 2.29,
      publisher: "kosmos",
      categories: ["strategy", "family", "economic"],
      mechanics: [
        "resource-management",
        "trading-negotiation",
        "dice-rolling",
        "area-control",
      ],
      imageUrls: ["https://picsum.photos/seed/catan-boardgame/1600/900"],
    },
    {
      slug: "azul",
      title: "آزول",
      description:
        "آزول یک بازی انتزاعیِ شیک و بسیار خوش‌ساخت است که در آن با انتخاب هوشمندانهٔ کاشی‌ها، دیوارهای کاخ را با الگوهای زیبا تزئین می‌کنید.\n\nسادگی قوانین در کنار عمق تصمیم‌گیری باعث می‌شود هر انتخاب شما پیامد داشته باشد: زمان‌بندی در برداشتن کاشی‌ها، جلوگیری از سود بردن رقبا و مدیریت جریمه‌ها، مسیر پیروزی را مشخص می‌کند. آزول برای جمع‌های خانوادگی عالی است اما برای بازیکنان رقابتی نیز چالش‌برانگیز می‌ماند.",
      minPlayers: 2,
      maxPlayers: 4,
      playingTime: 45,
      complexity: 1.76,
      publisher: "next-move-games",
      categories: ["abstract", "family"],
      mechanics: ["pattern-building", "set-collection"],
      imageUrls: ["https://picsum.photos/seed/azul-tiles/1600/900"],
    },
    {
      slug: "terraforming-mars",
      title: "ترافرمینگ مارس",
      description:
        "ترافرمینگ مارس یک بازی استراتژی سنگین‌تر و بسیار محبوب است که در آن نقش شرکت‌های عظیم را بر عهده می‌گیرید تا با پروژه‌های مختلف، سیارهٔ مریخ را قابل سکونت کنید.\n\nطراحی بازی بر «ساخت موتور» و مدیریت اقتصاد مبتنی است: کارت‌ها موتور تولید و امتیازدهی شما را می‌سازند، اما انتخاب پروژه‌ها نیازمند زمان‌بندی دقیق، مدیریت منابع و رقابت روی نقشه است. بازی حس پیشرفت بلندمدت، برنامه‌ریزی چندمرحله‌ای و رقابت لایه‌دار را به‌شکل حرفه‌ای ارائه می‌دهد.",
      minPlayers: 1,
      maxPlayers: 5,
      playingTime: 120,
      complexity: 3.26,
      publisher: "fryxgames",
      categories: ["strategy", "economic", "sci-fi"],
      mechanics: ["engine-building", "hand-management", "resource-management"],
      imageUrls: ["https://picsum.photos/seed/terraforming-mars/1600/900"],
    },
    {
      slug: "pandemic",
      title: "پندمیک",
      description:
        "پندمیک یک بازی همکاری‌محورِ پرتنش است که در آن تیم شما باید جلوی گسترش بیماری‌های خطرناک را بگیرد و هم‌زمان درمان آن‌ها را کشف کند.\n\nهر نقش توانایی ویژه‌ای دارد و موفقیت تنها با هماهنگی واقعی، برنامه‌ریزی مشترک و مدیریت بحران ممکن می‌شود. فشار زمان، گسترش زنجیره‌ای آلودگی‌ها و تصمیم‌های دشوار (درمان فوری یا تحقیق برای درمان) تجربه‌ای سینمایی و نفس‌گیر خلق می‌کند؛ برد و باخت واقعاً تیمی است.",
      minPlayers: 2,
      maxPlayers: 4,
      playingTime: 45,
      complexity: 2.4,
      publisher: "z-man-games",
      categories: ["strategy", "cooperative", "family"],
      mechanics: ["cooperative-play", "hand-management"],
      imageUrls: ["https://picsum.photos/seed/pandemic-map/1600/900"],
    },
    {
      slug: "splendor",
      title: "اسپلندور",
      description:
        "اسپلندور یک بازی سریع و بسیار اعتیادآور است که در آن با جمع‌آوری ژتون‌های جواهر و خرید کارت‌ها، یک موتور اقتصادی می‌سازید و برای کسب پرستیژ رقابت می‌کنید.\n\nقواعد ساده‌اند اما تصمیم‌ها تیز و رقابتی‌اند: چه کارت‌هایی را اولویت دهید، چه زمانی ذخیره کنید و چگونه هزینه‌ها را با تخفیف‌های دائمی مدیریت کنید. ریتم روان، زمان بازی کوتاه و عمق تاکتیکی، اسپلندور را به یک انتخاب ممتاز برای شروع و ادامهٔ شب بازی تبدیل می‌کند.",
      minPlayers: 2,
      maxPlayers: 4,
      playingTime: 30,
      complexity: 1.78,
      publisher: "space-cowboys",
      categories: ["family", "economic", "card-game"],
      mechanics: ["engine-building", "token-collection", "set-collection"],
      imageUrls: ["https://picsum.photos/seed/splendor-gems/1600/900"],
    },
  ];

  for (const g of games) {
    const existing = await findBySlug("games", g.slug);
    if (existing) {
      console.log(`Skip (already exists): ${g.slug}`);
      continue;
    }

    const imageIds = [];
    for (let i = 0; i < g.imageUrls.length; i++) {
      const url = g.imageUrls[i];
      const id = await uploadImageFromUrl(url, `${g.slug}-${i + 1}.jpg`);
      if (id) imageIds.push(id);
    }

    const payload = {
      title: g.title,
      slug: g.slug,
      description: g.description,
      minPlayers: g.minPlayers,
      maxPlayers: g.maxPlayers,
      playingTime: g.playingTime,
      complexity: g.complexity,
      publisher: publisherIdBySlug[g.publisher],
      categories: g.categories.map((s) => categoryIdBySlug[s]),
      mechanics: g.mechanics.map((s) => mechanicIdBySlug[s]),
    };
    if (imageIds.length > 0) payload.images = imageIds;

    const gameId = await createEntry("games", payload);

    console.log(`Created game: ${g.slug} (id=${gameId})`);
  }

  await seedBazigeekCatalog();

  console.log("Seeding finished ✅");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
