const DEFAULT_STRAPI_URL = "http://localhost:1337";

function requireEnv(name) {
  const v = process.env[name];
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

  console.log("Seeding finished ✅");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
