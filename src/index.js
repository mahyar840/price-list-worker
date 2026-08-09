/**
 * Price List Worker -- the "brain"
 * =================================
 * Overlays real OCR'd price data onto a FIXED, hand-approved graphic
 * template (assets/template-empty.png) instead of generating graphics
 * on every request. This is deliberate:
 *   - Image-generation models cannot be trusted to render exact numbers
 *     (they hallucinate digits). So the template's graphics (logos, bars,
 *     colors, banner) are generated ONCE, approved by a human, and then
 *     NEVER regenerated again.
 *   - Every subsequent price list just draws real, OCR'd text on top of
 *     that same fixed image. The graphics can never drift from what was
 *     approved; only the data changes.
 *
 * Multi-bot pattern: this one Worker can be the brain for many Telegram
 * bots. Each bot's webhook points at /webhook/<botId>. Bot config lives in
 * the BOT_CONFIG KV namespace. See README.md.
 */

import satori from "satori";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";

let resvgReady = false;
async function ensureResvgInit() {
  if (resvgReady) return;
  await initWasm(resvgWasm);
  resvgReady = true;
}

// ---------------------------------------------------------------------------
// Jalali date
// ---------------------------------------------------------------------------

const MONTHS_FA = [
  "فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
  "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند",
];

function gregorianToJalali(gy, gm, gd) {
  const gDays = [31,28,31,30,31,30,31,31,30,31,30,31];
  const jDays = [31,31,31,31,31,31,30,30,30,30,30,29];
  let gy2 = gy - 1600, gm2 = gm - 1, gd2 = gd - 1;
  let gDayNo = 365*gy2 + Math.floor((gy2+3)/4) - Math.floor((gy2+99)/100) + Math.floor((gy2+399)/400);
  for (let i = 0; i < gm2; i++) gDayNo += gDays[i];
  if (gm2 > 1 && ((gy%4===0 && gy%100!==0) || gy%400===0)) gDayNo += 1;
  gDayNo += gd2;
  let jDayNo = gDayNo - 79;
  const jNp = Math.floor(jDayNo / 12053);
  jDayNo %= 12053;
  let jy = 979 + 33*jNp + 4*Math.floor(jDayNo/1461);
  jDayNo %= 1461;
  if (jDayNo >= 366) {
    jy += Math.floor((jDayNo-1)/365);
    jDayNo = (jDayNo-1) % 365;
  }
  let jm = 0;
  while (jm < 11 && jDayNo >= jDays[jm]) { jDayNo -= jDays[jm]; jm++; }
  return { jy, jm: jm+1, jd: jDayNo+1 };
}

function todayJalaliStr() {
  const now = new Date();
  const { jy, jm, jd } = gregorianToJalali(now.getUTCFullYear(), now.getUTCMonth()+1, now.getUTCDate());
  return `${jd} ${MONTHS_FA[jm-1]} ${jy}`;
}

// ---------------------------------------------------------------------------
// TEMPLATE COORDINATE MAP
// ---------------------------------------------------------------------------
// Pixel-measured (by scanning bar colors) against assets/template-empty.png
// at its native 1536x1024 resolution. Each category can have MORE THAN ONE
// box (e.g. Samsung watches has two separate regions in the template) --
// items fill the first box, then overflow into the next box in the list,
// in order. If still more items than total box capacity, extras are
// DROPPED (never shrink the font -- per explicit instruction).

const TEMPLATE_W = 1536;
const TEMPLATE_H = 1024;
const ROW_H = 20;       // fixed row height -- never changes
const FONT_SIZE = 13;    // fixed font size -- never changes
const BOX_PAD = 10;      // inner padding from each box's own edges

const CATEGORY_BOXES = {
  "هدفون بلوتوث شیائومی": [{ x0: 20, x1: 322, y0: 171, y1: 255 }],
  "ساعت هوشمند شیائومی": [{ x0: 20, x1: 322, y0: 292, y1: 397 }],
  "پاور بانک شیائومی": [{ x0: 20, x1: 322, y0: 434, y1: 540 }],
  "کابل و شارژر شیائومی": [{ x0: 20, x1: 322, y0: 577, y1: 908 }],

  "هندزفری بلوتوث سامسونگ": [{ x0: 350, x1: 672, y0: 251, y1: 309 }],
  // shared category -- two non-contiguous boxes (see note above)
  "ساعت هوشمند سامسونگ": [
    { x0: 350, x1: 672, y0: 344, y1: 420 },
    { x0: 350, x1: 672, y0: 856, y1: 908 },
  ],
  "شارژر و پاور بانک سامسونگ": [{ x0: 350, x1: 672, y0: 456, y1: 530 }],
  "لوازم جانبی سامسونگ": [{ x0: 350, x1: 672, y0: 565, y1: 639 }],
  "کیف های حمل سامسونگ": [{ x0: 350, x1: 672, y0: 675, y1: 739 }],
  "هدفون و هندزفری بی سیم سامسونگ": [{ x0: 350, x1: 672, y0: 776, y1: 820 }],

  "اسپیکر انکر": [{ x0: 696, x1: 988, y0: 170, y1: 293 }],
  "هدفون و هندزفری بلوتوث انکر": [{ x0: 696, x1: 988, y0: 328, y1: 434 }],
  "پاور بانک انکر": [{ x0: 696, x1: 988, y0: 470, y1: 561 }],
  "شارژر و کابل انکر": [{ x0: 696, x1: 988, y0: 596, y1: 671 }],
  "هارمن کاردون": [{ x0: 696, x1: 988, y0: 709, y1: 786 }],
  "سایر برندهای انکر": [{ x0: 696, x1: 988, y0: 821, y1: 908 }],
};

const KNOWN_CATEGORIES = Object.keys(CATEGORY_BOXES);

// ---------------------------------------------------------------------------
// Bot config + session helpers (KV)
// ---------------------------------------------------------------------------

async function getBotConfig(env, botId) {
  const raw = await env.BOT_CONFIG.get(`bot:${botId}`);
  if (!raw) return null;
  return JSON.parse(raw);
  // Expected shape:
  // { "telegramToken": "...", "defaultMargin": 20 }
  // (shopName/phone/banner are now baked into the template image itself,
  // so they're no longer needed in config.)
}

async function getSession(env, botId, chatId) {
  const raw = await env.SESSIONS.get(`sess:${botId}:${chatId}`);
  return raw ? JSON.parse(raw) : { photos: [], margin: null };
}

async function setSession(env, botId, chatId, session) {
  await env.SESSIONS.put(`sess:${botId}:${chatId}`, JSON.stringify(session), {
    expirationTtl: 3600,
  });
}

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------

async function tg(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function tgSendMessage(token, chatId, text) {
  return tg(token, "sendMessage", { chat_id: chatId, text });
}

async function tgSendPhoto(token, chatId, pngBytes, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption || "");
  form.append("photo", new Blob([pngBytes], { type: "image/png" }), "price-list.png");
  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: "POST",
    body: form,
  });
  return res.json();
}

async function tgDownloadFile(token, fileId) {
  const info = await tg(token, "getFile", { file_id: fileId });
  const path = info.result.file_path;
  const fileRes = await fetch(`https://api.telegram.org/file/bot${token}/${path}`);
  const buf = await fileRes.arrayBuffer();
  return new Uint8Array(buf);
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// OCR step -- Claude vision reads one price-list image
// ---------------------------------------------------------------------------

const OCR_SYSTEM_PROMPT = `You read Persian supplier price-list table images and extract
ONLY currently available products with a real numeric price.

Rules:
- Skip any row whose price is a placeholder like "***", "تماس بگیرید", or is
  otherwise not a real number.
- Skip any row that is a section header, brand banner, or supplier contact
  info (phone numbers, telegram handles, "@..." usernames) rather than an
  actual product row.
- Use the LOWER of two prices when a row shows both cash and installment
  prices -- use the cash ("نقدی") price.
- For "category", you MUST pick the closest match from this exact list
  (copy one string exactly as written, do not invent new ones):
  ${JSON.stringify(KNOWN_CATEGORIES)}
  If a row's brand/type doesn't reasonably match ANY of these, set
  "category" to null -- do not force a bad match.
- Return ONLY a JSON array, nothing else, no markdown fences, no commentary.
  Each element: {"category": "<one of the list above, or null>",
  "name": "<product model, no brand repeated if it's obvious from category>",
  "color": "<color/variant if shown, else empty string>",
  "price": <integer, no separators>}`;

async function ocrImageToItems(apiKey, imageBytes) {
  const b64 = bytesToBase64(imageBytes);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      system: OCR_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } },
            { type: "text", text: "Extract the available products, categorized, from this price list image as JSON." },
          ],
        },
      ],
    }),
  });
  const data = await res.json();
  let text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```[a-z]*\n?/, "").replace(/```$/, "").trim();
  }
  try {
    const items = JSON.parse(text);
    return items
      .filter(it => it && it.name && typeof it.price === "number" && it.price > 0)
      .map(it => ({
        category: it.category && KNOWN_CATEGORIES.includes(it.category) ? it.category : null,
        name: String(it.name).trim(),
        color: it.color ? String(it.color).trim() : "",
        price: Math.round(it.price),
      }));
  } catch {
    return [];
  }
}

function dedupeItems(items) {
  const map = new Map();
  for (const it of items) map.set(`${it.category}|${it.name}|${it.color}`, it);
  return [...map.values()];
}

function applyMargin(items, marginPercent) {
  return items.map(it => ({
    ...it,
    price: Math.round((it.price * (1 + marginPercent / 100)) / 1000) * 1000,
  }));
}

// ---------------------------------------------------------------------------
// Render step -- overlay text on the fixed template image via satori+resvg
// ---------------------------------------------------------------------------

const fontBytesCache = {};
async function loadFont(env, bold) {
  const key = bold ? "bold" : "regular";
  if (fontBytesCache[key]) return fontBytesCache[key];
  const kvKey = `font:vazirmatn:${key}`;
  const cached = await env.BOT_CONFIG.get(kvKey, "arrayBuffer");
  if (cached) { fontBytesCache[key] = cached; return cached; }
  const url = bold ? env.FONT_URL_BOLD : env.FONT_URL_REGULAR;
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  await env.BOT_CONFIG.put(kvKey, buf);
  fontBytesCache[key] = buf;
  return buf;
}

let templateB64Cache = null;
async function loadTemplateDataUri(env) {
  if (templateB64Cache) return templateB64Cache;
  const cached = await env.BOT_CONFIG.get("template:main", "arrayBuffer");
  let buf;
  if (cached) {
    buf = cached;
  } else {
    const res = await fetch(env.TEMPLATE_URL);
    buf = await res.arrayBuffer();
    await env.BOT_CONFIG.put("template:main", buf);
  }
  const b64 = bytesToBase64(new Uint8Array(buf));
  templateB64Cache = `data:image/png;base64,${b64}`;
  return templateB64Cache;
}

/** Group items by category, split into their pre-defined boxes, and drop
 *  any item that doesn't fit (font/row size never changes). Returns an
 *  array of { x0,y0,x1,y1, rows: [{name,color,price}] } ready to draw,
 *  plus counts of what got skipped so the caller can report back. */
function layoutItemsIntoBoxes(items) {
  const byCategory = new Map();
  let uncategorized = 0;
  for (const it of items) {
    if (!it.category) { uncategorized++; continue; }
    if (!byCategory.has(it.category)) byCategory.set(it.category, []);
    byCategory.get(it.category).push(it);
  }

  const placedBoxes = [];
  let dropped = 0;

  for (const [category, catItems] of byCategory) {
    const boxes = CATEGORY_BOXES[category];
    let idx = 0;
    for (const box of boxes) {
      const capacity = Math.floor((box.y1 - box.y0 - BOX_PAD) / ROW_H);
      const rows = catItems.slice(idx, idx + capacity);
      idx += capacity;
      if (rows.length > 0) placedBoxes.push({ ...box, rows });
    }
    if (idx < catItems.length) dropped += (catItems.length - idx);
  }

  return { placedBoxes, dropped, uncategorized };
}

async function renderPriceListPng(env, items) {
  const [fontRegular, fontBold, templateUri] = await Promise.all([
    loadFont(env, false), loadFont(env, true), loadTemplateDataUri(env),
  ]);

  const { placedBoxes, dropped, uncategorized } = layoutItemsIntoBoxes(items);

  const rowChildren = [];
  for (const box of placedBoxes) {
    box.rows.forEach((it, i) => {
      const top = box.y0 + BOX_PAD / 2 + i * ROW_H;
      rowChildren.push({
        type: "div",
        props: {
          style: {
            position: "absolute", top, left: box.x0 + 6, right: TEMPLATE_W - box.x1 + 6,
            display: "flex", justifyContent: "space-between", height: ROW_H,
            fontSize: FONT_SIZE, color: "#1B1F2A",
          },
          children: [
            { type: "div", props: { children: `${it.price.toLocaleString("en-US")}`, style: { fontWeight: 700 } } },
            { type: "div", props: { children: it.color ? `${it.color}` : "", style: { color: "#6B6F7A" } } },
            { type: "div", props: { children: it.name } },
          ],
        },
      });
    });
  }

  const tree = {
    type: "div",
    props: {
      style: { position: "relative", width: TEMPLATE_W, height: TEMPLATE_H, fontFamily: "Vazirmatn" },
      children: [
        { type: "img", props: { src: templateUri, width: TEMPLATE_W, height: TEMPLATE_H, style: { position: "absolute", top: 0, left: 0 } } },
        ...rowChildren,
      ],
    },
  };

  const svg = await satori(tree, {
    width: TEMPLATE_W,
    height: TEMPLATE_H,
    fonts: [
      { name: "Vazirmatn", data: fontRegular, weight: 400, style: "normal" },
      { name: "Vazirmatn", data: fontBold, weight: 700, style: "normal" },
    ],
  });

  await ensureResvgInit();
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: TEMPLATE_W * 2 } });
  const pngData = resvg.render();
  return { png: pngData.asPng(), dropped, uncategorized };
}

// ---------------------------------------------------------------------------
// Webhook handler
// ---------------------------------------------------------------------------

async function handleUpdate(env, botId, config, update) {
  const token = config.telegramToken;
  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;

  if (msg.text === "/start") {
    await tgSendMessage(token, chatId,
      "سلام! عکس لیست قیمت تامین‌کننده رو بفرست (چند تا هم می‌تونی پشت سر هم بفرستی)، بعد /generate رو بزن.\n" +
      `درصد سود پیش‌فرض: ${config.defaultMargin}% -- برای تغییرش: /setmargin 25`);
    return;
  }

  if (msg.text && msg.text.startsWith("/setmargin")) {
    const parts = msg.text.split(" ");
    const val = parseFloat(parts[1]);
    if (isNaN(val)) {
      await tgSendMessage(token, chatId, "مثال درست: /setmargin 25");
      return;
    }
    const session = await getSession(env, botId, chatId);
    session.margin = val;
    await setSession(env, botId, chatId, session);
    await tgSendMessage(token, chatId, `درصد سود روی ${val}% تنظیم شد.`);
    return;
  }

  if (msg.text === "/generate") {
    const session = await getSession(env, botId, chatId);
    if (!session.photos.length) {
      await tgSendMessage(token, chatId, "هنوز عکسی نفرستادی.");
      return;
    }
    await tgSendMessage(token, chatId, `در حال خوندن ${session.photos.length} عکس... ⏳`);

    let allItems = [];
    for (const fileId of session.photos) {
      const bytes = await tgDownloadFile(token, fileId);
      const items = await ocrImageToItems(env.ANTHROPIC_API_KEY, bytes);
      allItems = allItems.concat(items);
    }
    allItems = dedupeItems(allItems);

    if (!allItems.length) {
      await tgSendMessage(token, chatId, "هیچ کالای موجودی استخراج نشد.");
      session.photos = [];
      await setSession(env, botId, chatId, session);
      return;
    }

    const margin = session.margin ?? config.defaultMargin;
    const priced = applyMargin(allItems, margin);
    const { png, dropped, uncategorized } = await renderPriceListPng(env, priced);

    let caption = `لیست آماده شد (سود ${margin}%)`;
    if (uncategorized) caption += `\n⚠️ ${uncategorized} مورد به هیچ دسته‌ی قالب نخورد و رد شد.`;
    if (dropped) caption += `\n⚠️ ${dropped} مورد به‌خاطر کمبود جا تو باکس‌های قالب حذف شد.`;

    await tgSendPhoto(token, chatId, png, caption);
    session.photos = [];
    await setSession(env, botId, chatId, session);
    return;
  }

  if (msg.photo && msg.photo.length) {
    const best = msg.photo[msg.photo.length - 1];
    const session = await getSession(env, botId, chatId);
    session.photos.push(best.file_id);
    await setSession(env, botId, chatId, session);
    await tgSendMessage(token, chatId, `عکس دریافت شد (${session.photos.length} عکس تو صف). وقتی تموم شد /generate رو بزن.`);
    return;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/webhook\/([a-zA-Z0-9_-]+)$/);
    if (!match || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    const botId = match[1];
    const config = await getBotConfig(env, botId);
    if (!config) return new Response("unknown bot", { status: 404 });

    const update = await request.json();
    ctx.waitUntil(handleUpdate(env, botId, config, update));
    return new Response("ok");
  },
};
