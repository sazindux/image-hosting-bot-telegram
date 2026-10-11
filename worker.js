/**
 * ImgBB Telegram Uploader Bot — Cloudflare Workers Edition (Rich Messages)
 * -----------------------------------------------------------------------
 * Single-file ES Module worker. No npm packages, no Node APIs — only
 * Web Standard fetch/FormData/Response.
 *
 * v5 — added on top of v4:
 *   1. ADDED a fourth-tier fallback that needs no external image host at
 *      all: the photo is stored in your own Telegram chat/channel via
 *      sendDocument (unmodified — no re-compression, unlike sendPhoto),
 *      and served back through a new GET /image/<file_id>.<ext> route on
 *      this same Worker, which streams the file straight from Telegram's
 *      servers with a 1-year immutable cache header. No bot token or
 *      third-party host is ever exposed to the viewer.
 *      (Ported from a small Astro reference project the user shared,
 *      TG-IHOST — this version fixes its two bugs: it derives the
 *      correct Content-Type from the file's actual extension instead of
 *      hardcoding "image/jpeg", and there's no public web upload form to
 *      abuse — uploads only ever come from this bot's own photo handler.)
 *
 * v4 — fixes on top of v3:
 *   1. REMOVED the Telegra.ph fallback. Telegram permanently disabled new
 *      media uploads to telegra.ph in September 2024 (Durov cited abuse by
 *      anonymous actors), and it has never been re-enabled. The old
 *      uploadToTelegraph() call was silently failing 100% of the time —
 *      this was not a bug in the request code, the upstream endpoint is
 *      just dead for this purpose.
 *   2. ADDED Imgur's anonymous upload API as the new third-tier fallback,
 *      in its place. It needs only a free, keyless-login "Client-ID"
 *      (env.IMGUR_CLIENT_ID) and is actively maintained.
 *
 * Carried over from v3:
 *   1. Buttons are real Rich Message buttons (<tg-button> /
 *      <tg-button-row> tags embedded directly in the HTML content),
 *      instead of a classic `reply_markup` inline keyboard.
 *   2. All bot-generated text is formatted with clear paragraph spacing,
 *      headings, and lists for the rich message renderer.
 *
 * Carried over from v2:
 *   - A standard browser User-Agent on every outbound fetch, to avoid
 *     generic bot/IP flagging from hosts that block default Cloudflare
 *     / fetch UAs.
 *   - ImgBB API key rotation across multiple keys/accounts, so a single
 *     rate-limited or flagged key doesn't take the whole bot down.
 *   - Automatic fallback to Catbox.moe (and now Imgur) if ImgBB fails on
 *     every key, so uploads keep working even during an ImgBB outage
 *     or a hard IP ban.
 *
 * Uses Telegram Bot API 10.1+ Rich Messages (sendRichMessage /
 * editMessageText with a `rich_message` field, HTML style), including
 * Bot API 10.1+ inline `<tg-button>` / `<tg-button-row>` tags for
 * buttons (colored via the `style` attribute: "success" = green).
 *
 * Required environment variables (Worker secrets / vars):
 *   BOT_TOKEN         -> Telegram bot token from @BotFather
 *
 * ImgBB keys (at least one of these two is required for ImgBB to be tried;
 * if neither is set, the bot skips straight to Catbox/Imgur):
 *   IMGBB_API_KEY     -> a single ImgBB API key (legacy / simple setup)
 *   IMGBB_API_KEYS    -> comma-separated list of multiple ImgBB API keys,
 *                        ideally generated from different ImgBB accounts,
 *                        e.g. "key1,key2,key3". Takes priority over
 *                        IMGBB_API_KEY if both are set.
 *
 * Optional environment variables:
 *   BOT_USERNAME      -> shown in the footer (defaults to "image_hostingrobot")
 *   DEV_USERNAME      -> shown in the footer (defaults to "ezybots")
 *   CATBOX_USERHASH   -> your Catbox account userhash, so fallback uploads
 *                        land in your Catbox account instead of anonymous
 *                        (optional — anonymous uploads work fine too)
 *   IMGUR_CLIENT_ID   -> a free Imgur application Client-ID, used for
 *                        anonymous (no user login) uploads as the final
 *                        fallback host. Get one in ~1 minute:
 *                          1. Go to https://api.imgur.com/oauth2/addclient
 *                          2. Application name: anything
 *                          3. Authorization type: "Anonymous usage without
 *                             user authorization"
 *                          4. Email + description: anything
 *                          5. Submit — you'll get a "Client ID" immediately,
 *                             no approval wait. Use that value here.
 *                        If unset, the bot just skips this fallback tier.
 *   LOG_CHANNEL_ID    -> a private channel/chat ID (e.g. "-1001234567890").
 *                        If set, every photo the bot processes is echoed
 *                        there with the uploaded image, the uploader's
 *                        @username (or numeric ID if no username), and
 *                        whether the upload succeeded or failed. The bot
 *                        must be added to that channel as an admin.
 *   TG_STORAGE_CHAT_ID -> a private channel/chat ID (e.g. "-1009876543210")
 *                        used as the final upload fallback: the bot posts
 *                        the original photo there as a document, and
 *                        GET /image/<file_id>.<ext> on this same Worker
 *                        serves it back publicly. The bot must be an
 *                        admin of that chat with permission to post. Can
 *                        be the same chat as LOG_CHANNEL_ID, or a
 *                        separate one — either works. If unset, this
 *                        fallback tier is skipped.
 *
 * Deploy, then set the webhook (see cURL command at the bottom of this file).
 * -----------------------------------------------------------------------
 */

const TELEGRAM_API = "https://api.telegram.org";

// A realistic, current desktop-Chrome User-Agent. Sent on every outbound
// request (ImgBB, Catbox, Imgur, and the Telegram file download) so
// none of those hosts see the generic Cloudflare Workers fetch signature.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Public image-serving route for the Telegram-storage fallback tier
    // (see uploadToTelegramStorage below). Anyone with a link can view
    // the image; the bot token itself is never exposed to them.
    // Supports /image/<file_id>.<ext> (current, has a real extension so
    // clients/apps that sniff URLs by extension work correctly) and the
    // older /image?id=<file_id> query form, for links already handed out.
    if (request.method === "GET" && (url.pathname === "/image" || url.pathname.startsWith("/image/"))) {
      return handleImageProxy(url, env);
    }

    if (request.method !== "POST") {
      return new Response("OK - Telegram webhook endpoint is alive", { status: 200 });
    }

    if (!env.BOT_TOKEN) {
      return new Response("Missing BOT_TOKEN environment variable", { status: 500 });
    }

    let update;
    try {
      update = await request.json();
    } catch (err) {
      return new Response("Invalid JSON payload", { status: 400 });
    }

    // url.origin is this same Worker's own public URL — used to build
    // /image/... links for the Telegram-storage fallback tier.
    ctx.waitUntil(handleUpdate(update, env, url.origin));

    // Telegram just needs a fast 200 OK acknowledgment.
    return new Response("OK", { status: 200 });
  },
};

// =========================================================================
// Update routing
// =========================================================================

async function handleUpdate(update, env, origin) {
  try {
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, env);
      return;
    }

    const message = update.message;
    if (!message) return;

    const chatId = message.chat.id;

    if (message.text && message.text.startsWith("/start")) {
      await sendRichMessage(env.BOT_TOKEN, chatId, homeHtml(message.from, env));
      return;
    }

    if (message.photo && message.photo.length > 0) {
      await handlePhoto(message, env, origin);
      return;
    }

    await sendRichMessage(
      env.BOT_TOKEN,
      chatId,
      "<p>📷 Please send me a <b>photo</b> and I'll upload it for you.</p><p>Send /start for the main menu.</p>"
    );
  } catch (err) {
    console.error("handleUpdate error:", err);
  }
}

// =========================================================================
// Callback query (menu navigation) handling
// =========================================================================

async function handleCallbackQuery(query, env) {
  const botToken = env.BOT_TOKEN;
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const data = query.data || "";

  // Always ack the callback so Telegram stops showing the loading spinner.
  await answerCallbackQuery(botToken, query.id);

  if (!chatId || !messageId) return;

  if (data === "menu:home") {
    await editRichMessage(botToken, chatId, messageId, homeHtml(query.from, env));
  } else if (data === "menu:guide") {
    await editRichMessage(botToken, chatId, messageId, guideHtml());
  } else if (data === "menu:about") {
    await editRichMessage(botToken, chatId, messageId, aboutHtml());
  }
}

// =========================================================================
// Rich message content (HTML style — see Bot API "Rich messages")
//
// Buttons live inline inside the HTML itself, as <tg-button-row>
// blocks containing one or more <tg-button> tags, instead of a separate
// reply_markup keyboard. Text is broken into short paragraphs with blank
// lines between them so the rendered message stays easy to scan.
// =========================================================================

function footerHtml(env) {
  const bot = (env && env.BOT_USERNAME) || "image_hostingrobot";
  const dev = (env && env.DEV_USERNAME) || "sazindu";
  return `<footer>&lt;/&gt; @${bot} — built by @${dev} </footer>`;
}

function homeHtml(user, env) {
  const name = escapeHtml(user?.first_name || "there");
  return [
    `<p><b>👋 Welcome, ${name}!</b></p>`,
    `<p>This bot uploads your photos to a free image host and hands you back a direct link — ready to copy or share instantly.</p>`,
    `<p>Just send a <b>photo</b> to get started, or use the buttons below.</p>`,
    `<tg-button-row align="left">`,
    ` <tg-button type="callback_data" style="success" data="menu:guide">📖 Guide</tg-button>`,
    ` <tg-button type="callback_data" style="success" data="menu:about">👾 About</tg-button>`,
    `</tg-button-row>`,
    footerHtml(env),
  ].join("\n");
}

function guideHtml() {
  return [
    `<h3>📖 Guide</h3>`,
    `<ol>`,
    `<li>Send any photo (as a photo, not a file)</li>`,
    `<li>Wait a few seconds while it uploads</li>`,
    `<li>Get a direct link back, with buttons to open, copy, or share it</li>`,
    `</ol>`,
    `<p>No accounts, no storage on our side — just fast image hosting. 🚀</p>`,
    `<tg-button-row align="left">`,
    ` <tg-button type="callback_data" style="success" data="menu:home">🔙 Back</tg-button>`,
    `</tg-button-row>`,
  ].join("\n");
}

function aboutHtml() {
  return [
    `<h3>👾 About This Bot</h3>`,
    `<p>A simple, fast, and lightweight tool designed to help you upload images and generate shareable direct links effortlessly.</p>`,
    `<p>Free to use, anytime, anywhere. ⚡</p>`,
    `<tg-button-row align="left">`,
    ` <tg-button type="callback_data" style="success" data="menu:home">🔙 Back</tg-button>`,
    `</tg-button-row>`,
  ].join("\n");
}

/**
 * Builds the HTML block appended after a successful upload — one row
 * with all three buttons:
 *   - Open Link (url button)
 *   - Copy Link (copy_text button — copies with a single tap)
 *   - Share (opens Telegram's native share sheet pre-filled with the link)
 *
 * All three are Rich Message buttons embedded directly in the message
 * HTML via a single <tg-button-row>, rather than a separate reply_markup
 * keyboard.
 */
function resultButtonsHtml(directUrl) {
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(directUrl)}&text=${encodeURIComponent(
    "📸 Uploaded image"
  )}`;
  const safeUrl = escapeAttr(directUrl);
  const safeShareUrl = escapeAttr(shareUrl);

  return [
    `<tg-button-row align="left">`,
    ` <tg-button type="url" style="success" url="${safeUrl}">🔗 Open Link</tg-button>`,
    ` <tg-button type="copy_text" style="success" text="${safeUrl}">📋 Copy Link</tg-button>`,
    ` <tg-button type="url" style="success" url="${safeShareUrl}">📤 Share</tg-button>`,
    `</tg-button-row>`,
  ].join("\n");
}

// =========================================================================
// Photo upload flow
// =========================================================================

async function handlePhoto(message, env, origin) {
  const chatId = message.chat.id;
  const botToken = env.BOT_TOKEN;

  await sendChatAction(botToken, chatId, "upload_photo");

  try {
    const largestPhoto = message.photo[message.photo.length - 1];
    const fileId = largestPhoto.file_id;

    const filePath = await getTelegramFilePath(botToken, fileId);
    if (!filePath) {
      await sendRichMessage(botToken, chatId, "<p>⚠️ Couldn't retrieve the file from Telegram.</p><p>Please try again.</p>");
      await sendLogToChannel(botToken, env.LOG_CHANNEL_ID, {
        fileId,
        user: message.from,
        status: "error",
        errorMsg: "getFile failed (couldn't retrieve file path from Telegram)",
      });
      return;
    }

    const fileUrl = `${TELEGRAM_API}/file/bot${botToken}/${filePath}`;
    const fileResponse = await fetch(fileUrl, { headers: { "User-Agent": BROWSER_UA } });
    if (!fileResponse.ok) {
      await sendRichMessage(botToken, chatId, "⚠️ Failed to download the photo from Telegram.");
      await sendLogToChannel(botToken, env.LOG_CHANNEL_ID, {
        fileId,
        user: message.from,
        status: "error",
        errorMsg: "Failed to download the photo from Telegram",
      });
      return;
    }
    const fileBlob = await fileResponse.blob();
    const fileName = filePath.split("/").pop() || `telegram-photo-${Date.now()}.jpg`;
    const sizeKb = `${Math.round(fileBlob.size / 1024)} KB`;

    const result = await uploadImageWithFallback(fileBlob, fileName, env, origin);

    if (!result) {
      await sendRichMessage(
        botToken,
        chatId,
        "<p>⚠️ Upload failed on every available host (ImgBB, Catbox, Imgur, Telegram Storage).</p><p>Please try again in a bit.</p>"
      );
      await sendLogToChannel(botToken, env.LOG_CHANNEL_ID, {
        fileId,
        user: message.from,
        status: "error",
        errorMsg: "All hosts failed (ImgBB, Catbox, Imgur, Telegram Storage)",
      });
      return;
    }

    // The URL is left as plain auto-detected text (not wrapped in <a> or
    // <code>) so Telegram treats it as a normal link entity and renders
    // the link preview under the message. It's wrapped in its own <p>
    // (with a <br> after the intro line) so it lands on its own line
    // instead of running together with the surrounding text.
    const resultHtml = [
      `<p><b>✅ Upload successful!</b> Here's your direct link:<br>${result.url}</p>`,
      `<p>💾 Size: ${sizeKb} &nbsp;&nbsp;•&nbsp;&nbsp; 🌐 Host: ${result.source}</p>`,
      resultButtonsHtml(result.url),
    ].join("\n");

    await sendRichMessage(botToken, chatId, resultHtml, {
      replyToMessageId: message.message_id,
    });

    await sendLogToChannel(botToken, env.LOG_CHANNEL_ID, {
      fileId,
      user: message.from,
      status: "success",
      url: result.url,
      source: result.source,
      sizeKb,
    });
  } catch (err) {
    console.error("handlePhoto error:", err);
    await sendRichMessage(botToken, chatId, "<p>⚠️ Something went wrong while processing your photo.</p><p>Please try again.</p>");
    await sendLogToChannel(botToken, env.LOG_CHANNEL_ID, {
      user: message.from,
      status: "error",
      errorMsg: `Unexpected error: ${err && err.message ? err.message : String(err)}`,
    });
  }
}

// =========================================================================
// Upload orchestration: ImgBB (key rotation) -> Catbox -> Imgur -> Telegram
//                        Storage
//
// NOTE: Telegra.ph was removed as a fallback here. Telegram permanently
// disabled new media uploads to telegra.ph in September 2024 due to abuse
// by anonymous actors, and the /upload endpoint has never been reinstated
// since — every call to it fails, regardless of how it's called. Imgur's
// anonymous upload API (needs only a free Client-ID, no user login) took
// its place as the third tier. The final tier, Telegram Storage, needs no
// external host at all: it re-uses Telegram itself, via this bot's own
// storage chat and the /image proxy route defined below.
// =========================================================================

async function uploadImageWithFallback(fileBlob, fileName, env, origin) {
  // 1) Try every configured ImgBB key, in random order, so repeated
  //    requests don't hammer the same key/account first every time.
  const imgbbKeys = getImgbbKeys(env);
  for (const key of shuffle(imgbbKeys)) {
    const url = await uploadToImgbb(fileBlob, fileName, key);
    if (url) return { url, source: "ImgBB" };
  }

  // 2) Fall back to Catbox.moe (no API key required).
  const catboxUrl = await uploadToCatbox(fileBlob, fileName, env.CATBOX_USERHASH);
  if (catboxUrl) return { url: catboxUrl, source: "Catbox" };

  // 3) Fall back to Imgur (anonymous upload, needs env.IMGUR_CLIENT_ID).
  if (env.IMGUR_CLIENT_ID) {
    const imgurUrl = await uploadToImgur(fileBlob, fileName, env.IMGUR_CLIENT_ID);
    if (imgurUrl) return { url: imgurUrl, source: "Imgur" };
  }

  // 4) Fall back to storing the file in our own Telegram chat, served back
  //    through this Worker's /image route (needs env.TG_STORAGE_CHAT_ID).
  if (env.TG_STORAGE_CHAT_ID) {
    const storageUrl = await uploadToTelegramStorage(fileBlob, fileName, env.BOT_TOKEN, env.TG_STORAGE_CHAT_ID, origin);
    if (storageUrl) return { url: storageUrl, source: "Telegram Storage" };
  }

  return null;
}

function getImgbbKeys(env) {
  if (env.IMGBB_API_KEYS) {
    return env.IMGBB_API_KEYS.split(",")
      .map((k) => k.trim())
      .filter(Boolean);
  }
  if (env.IMGBB_API_KEY) return [env.IMGBB_API_KEY];
  return [];
}

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function uploadToImgbb(fileBlob, fileName, apiKey) {
  try {
    const form = new FormData();
    form.append("image", fileBlob, fileName);

    const res = await fetch(`https://api.imgbb.com/1/upload?key=${apiKey}`, {
      method: "POST",
      headers: { "User-Agent": BROWSER_UA },
      body: form,
    });

    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.success) {
      console.error("ImgBB upload failed:", res.status, data && data.error);
      return null;
    }
    return data.data.url || data.data.display_url || null;
  } catch (err) {
    console.error("ImgBB upload error:", err);
    return null;
  }
}

async function uploadToCatbox(fileBlob, fileName, userhash) {
  try {
    const form = new FormData();
    form.append("reqtype", "fileupload");
    if (userhash) form.append("userhash", userhash);
    form.append("fileToUpload", fileBlob, fileName);

    const res = await fetch("https://catbox.moe/user/api.php", {
      method: "POST",
      headers: { "User-Agent": BROWSER_UA },
      body: form,
    });

    const text = (await res.text()).trim();
    if (!res.ok || !text.startsWith("https://")) {
      console.error("Catbox upload failed:", res.status, text);
      return null;
    }
    return text;
  } catch (err) {
    console.error("Catbox upload error:", err);
    return null;
  }
}

/**
 * Uploads to Imgur's anonymous image endpoint. Requires only a
 * Client-ID (no OAuth / no user login) — see the IMGUR_CLIENT_ID docs
 * at the top of this file for how to get one. Returns the direct image
 * link on success, or null on any failure.
 */
async function uploadToImgur(fileBlob, fileName, clientId) {
  try {
    const form = new FormData();
    form.append("image", fileBlob, fileName);
    form.append("type", "file");

    const res = await fetch("https://api.imgur.com/3/image", {
      method: "POST",
      headers: {
        Authorization: `Client-ID ${clientId}`,
        "User-Agent": BROWSER_UA,
      },
      body: form,
    });

    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.success || !data.data || !data.data.link) {
      console.error("Imgur upload failed:", res.status, data && data.data && data.data.error);
      return null;
    }
    return data.data.link;
  } catch (err) {
    console.error("Imgur upload error:", err);
    return null;
  }
}

/**
 * Uploads to our own Telegram chat/channel (env.TG_STORAGE_CHAT_ID) via
 * sendDocument, then hands back a link to this same Worker's own
 * /image/<file_id>.<ext> route (see handleImageProxy below), which
 * streams the file back on demand. The extension is taken from the
 * original filename so the link itself looks and behaves like a normal
 * image URL (xxxx.jpg / xxxx.png), which matters for any client, embed,
 * or app that infers file type from the URL rather than the response
 * headers.
 *
 * sendDocument (not sendPhoto) is used deliberately — sendPhoto makes
 * Telegram re-compress and re-encode the image, degrading quality;
 * sendDocument stores the original bytes untouched.
 *
 * This never exposes the bot token or a raw api.telegram.org URL to the
 * end viewer — only our own domain and an opaque file_id.
 */
async function uploadToTelegramStorage(fileBlob, fileName, botToken, storageChatId, origin) {
  try {
    if (!storageChatId || !origin) return null;

    const form = new FormData();
    form.append("chat_id", storageChatId);
    form.append("document", fileBlob, fileName);

    const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendDocument`, {
      method: "POST",
      headers: { "User-Agent": BROWSER_UA },
      body: form,
    });

    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok || !data.result || !data.result.document) {
      console.error("Telegram storage upload failed:", res.status, data && data.description);
      return null;
    }

    const fileId = data.result.document.file_id;
    // Telegram photos are always re-encoded to JPEG when sent as a
    // "photo" (which is how this bot receives them), so fall back to
    // .jpg if the original filename had no recognizable extension.
    const ext = extensionFromFileName(fileName) || "jpg";
    return `${origin}/image/${encodeURIComponent(fileId)}.${ext}`;
  } catch (err) {
    console.error("Telegram storage upload error:", err);
    return null;
  }
}

// =========================================================================
// Public image proxy (Telegram-storage fallback tier)
//
// Serves GET /image/<file_id>.<ext> (or the legacy GET /image?id=<file_id>)
// by resolving the file's current path via getFile and streaming its
// bytes back from api.telegram.org, with a long-lived cache header. The
// bot token never reaches the viewer — only this Worker's own fetch
// calls know it.
//
// Content-Type is derived from a real file extension — the one in the
// URL itself when present, otherwise the one in the path getFile
// resolves to (see mimeTypeFromExtension) — rather than being
// hardcoded, a common bug in similar Telegram-as-CDN scripts that
// mislabels every non-JPEG image.
// =========================================================================

async function handleImageProxy(url, env) {
  const { fileId, ext: extFromUrl } = parseImageRequest(url);
  if (!fileId) {
    return new Response("Missing file id", { status: 400 });
  }
  if (!env.BOT_TOKEN) {
    return new Response("Server misconfigured", { status: 500 });
  }

  const filePath = await getTelegramFilePath(env.BOT_TOKEN, fileId);
  if (!filePath) {
    return new Response("File not found", { status: 404 });
  }

  const fileUrl = `${TELEGRAM_API}/file/bot${env.BOT_TOKEN}/${filePath}`;
  const fileResponse = await fetch(fileUrl, { headers: { "User-Agent": BROWSER_UA } });
  if (!fileResponse.ok || !fileResponse.body) {
    return new Response("Failed to fetch file from Telegram", { status: 502 });
  }

  const ext = extFromUrl || extensionFromFileName(filePath);
  return new Response(fileResponse.body, {
    headers: {
      "Content-Type": mimeTypeFromExtension(ext),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

/**
 * Extracts { fileId, ext } from either URL shape this route accepts:
 *   /image/<file_id>.<ext>   -> current links (real extension in the URL)
 *   /image?id=<file_id>      -> legacy links handed out before this
 *                                extension support was added
 * `ext` is "" when there isn't one to go on (legacy form).
 */
function parseImageRequest(url) {
  if (url.pathname === "/image") {
    return { fileId: url.searchParams.get("id") || "", ext: "" };
  }
  const segment = decodeURIComponent(url.pathname.slice("/image/".length));
  const lastDot = segment.lastIndexOf(".");
  if (lastDot <= 0) return { fileId: segment, ext: "" };
  return { fileId: segment.slice(0, lastDot), ext: segment.slice(lastDot + 1).toLowerCase() };
}

const EXTENSION_MIME_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  heic: "image/heic",
  tif: "image/tiff",
  tiff: "image/tiff",
};

function extensionFromFileName(name) {
  if (!name) return "";
  const ext = name.split(".").pop();
  return ext && ext !== name ? ext.toLowerCase() : "";
}

function mimeTypeFromExtension(ext) {
  return EXTENSION_MIME_TYPES[ext] || "application/octet-stream";
}

// =========================================================================
// Telegram API helpers
// =========================================================================

async function getTelegramFilePath(botToken, fileId) {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/getFile?file_id=${fileId}`, {
    headers: { "User-Agent": BROWSER_UA },
  });
  const data = await res.json();
  if (!data.ok) return null;
  return data.result.file_path;
}

/**
 * Sends a rich (HTML-style) message via Bot API 10.1's sendRichMessage.
 * Buttons, when needed, should already be embedded in `html` as
 * <tg-button-row>/<tg-button> tags — see resultButtonsHtml / homeHtml /
 * guideHtml / aboutHtml above. `options.replyMarkup` is still supported
 * as a fallback/extra classic keyboard, but is no longer used by the
 * built-in flows in this file.
 */
async function sendRichMessage(botToken, chatId, html, options = {}) {
  const payload = {
    chat_id: chatId,
    rich_message: { html },
  };
  if (options.replyMarkup) payload.reply_markup = options.replyMarkup;
  if (options.replyToMessageId) {
    payload.reply_parameters = { message_id: options.replyToMessageId };
  }

  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendRichMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": BROWSER_UA },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error("sendRichMessage failed:", await res.text());
  }
  return res;
}

/**
 * Edits an existing message's rich content via editMessageText's
 * rich_message parameter (Bot API 10.1+). Buttons live inline in `html`,
 * same as sendRichMessage above.
 */
async function editRichMessage(botToken, chatId, messageId, html, replyMarkup) {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    rich_message: { html },
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;

  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": BROWSER_UA },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error("editRichMessage failed:", await res.text());
  }
  return res;
}

/**
 * Echoes every processed photo into a private log channel, if
 * env.LOG_CHANNEL_ID is configured. Reuses the original Telegram file_id
 * (when available) so the image is forwarded without re-uploading it.
 * Never throws — logging must not break the main upload flow.
 *
 * @param {string} botToken
 * @param {string|undefined} logChannelId
 * @param {{
 *   fileId?: string,
 *   user?: { id?: number, username?: string, first_name?: string },
 *   status: "success" | "error",
 *   url?: string,
 *   source?: string,
 *   sizeKb?: string,
 *   errorMsg?: string,
 * }} info
 */
async function sendLogToChannel(botToken, logChannelId, info) {
  if (!logChannelId) return;

  try {
    const who = info.user?.username
      ? `@${escapeHtml(info.user.username)}`
      : `ID: <code>${info.user?.id ?? "unknown"}</code>`;

    const lines = [
      info.status === "success" ? "✅ <b>Upload succeeded</b>" : "❌ <b>Upload failed</b>",
      `👤 User: ${who}`,
    ];
    if (info.status === "success") {
      lines.push(`🌐 Host: ${escapeHtml(info.source || "unknown")}`);
      if (info.sizeKb) lines.push(`💾 Size: ${escapeHtml(info.sizeKb)}`);
      if (info.url) lines.push(`🔗 ${info.url}`);
    } else {
      lines.push(`⚠️ Reason: ${escapeHtml(info.errorMsg || "unknown error")}`);
    }
    const caption = lines.join("\n");

    if (info.fileId) {
      // Reuse the Telegram file_id directly — no re-download/re-upload needed.
      const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": BROWSER_UA },
        body: JSON.stringify({
          chat_id: logChannelId,
          photo: info.fileId,
          caption,
          parse_mode: "HTML",
        }),
      });
      if (!res.ok) console.error("sendLogToChannel (photo) failed:", await res.text());
    } else {
      // No file_id available (e.g. failed before we had one) — send text only.
      const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": BROWSER_UA },
        body: JSON.stringify({ chat_id: logChannelId, text: caption, parse_mode: "HTML" }),
      });
      if (!res.ok) console.error("sendLogToChannel (text) failed:", await res.text());
    }
  } catch (err) {
    // Logging must never break the main flow.
    console.error("sendLogToChannel error:", err);
  }
}

async function answerCallbackQuery(botToken, callbackQueryId, text) {
  try {
    await fetch(`${TELEGRAM_API}/bot${botToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": BROWSER_UA },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch (err) {
    // Non-critical.
  }
}

async function sendChatAction(botToken, chatId, action) {
  try {
    await fetch(`${TELEGRAM_API}/bot${botToken}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": BROWSER_UA },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  } catch (err) {
    // Non-critical.
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Like escapeHtml, but also escapes double quotes so a value is safe to
// drop inside an HTML attribute (e.g. url="..." or text="..." on a
// <tg-button> tag).
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}

/**
 * -----------------------------------------------------------------------
 * DEPLOYMENT NOTES
 * -----------------------------------------------------------------------
 * 1. Deploy this worker (e.g. `wrangler deploy`) and note its URL, e.g.:
 *      https://imgbb-bot.<your-subdomain>.workers.dev
 *
 * 2. Set secrets:
 *      wrangler secret put BOT_TOKEN
 *      wrangler secret put IMGBB_API_KEYS      # comma-separated, e.g. "key1,key2,key3"
 *      # (or, for a single key: wrangler secret put IMGBB_API_KEY)
 *      wrangler secret put CATBOX_USERHASH     # optional
 *      wrangler secret put IMGUR_CLIENT_ID     # optional — see docs above for how to get one
 *      wrangler secret put TG_STORAGE_CHAT_ID  # optional — see docs above; can reuse LOG_CHANNEL_ID's chat
 *      wrangler secret put BOT_USERNAME        # optional
 *      wrangler secret put DEV_USERNAME        # optional
 *      wrangler secret put LOG_CHANNEL_ID      # optional, e.g. "-1001234567890"
 *
 * 3. If using LOG_CHANNEL_ID and/or TG_STORAGE_CHAT_ID: create a private
 *    channel, add your bot to it as an admin (needs "Post Messages"
 *    permission), then get the channel's numeric ID — easiest way is to
 *    forward any message from the channel to @userinfobot or
 *    @RawDataBot, which will show you an ID like -1001234567890. Use
 *    that full value (including the minus sign). A single channel can
 *    serve both purposes if you'd rather not set up two.
 *
 * 4. Register the Telegram webhook with a single cURL command:
 *
 *      curl -F "url=https://imgbb-bot.<your-subdomain>.workers.dev/" https://api.telegram.org/bot<BOT_TOKEN>/setWebhook
 *
 * NOTES:
 * - sendRichMessage / rich_message and <tg-button> styles require Bot
 *   API 10.1+ and a recent Telegram client. Older clients fall back to
 *   plain text / default gray buttons, nothing breaks.
 * - Buttons are Rich Message buttons embedded directly in the HTML
 *   (<tg-button-row> / <tg-button>) rather than a classic reply_markup
 *   inline keyboard. The upload-result buttons (Open Link, Copy Link,
 *   Share) sit together in a single <tg-button-row>. callback_data
 *   buttons still arrive as ordinary callback_query updates, so
 *   handleCallbackQuery needs no changes.
 * - Message text is built from <p> (and occasional <br>) blocks rather
 *   than bare "\n\n" — in HTML rich-message mode, plain whitespace/
 *   newlines are not rendered as line breaks, only actual block tags are.
 * - The uploaded link is sent as plain auto-detected text (not inside
 *   <code> or <a> tags) so Telegram renders its normal link preview
 *   under the result message.
 * - Upload order is ImgBB (all configured keys, random order) -> Catbox
 *   -> Imgur (only if IMGUR_CLIENT_ID is set) -> Telegram Storage (only
 *   if TG_STORAGE_CHAT_ID is set). Telegra.ph was removed — Telegram
 *   itself disabled new media uploads to it in Sept 2024 and it has
 *   stayed disabled since, so it could never have worked here.
 *   If all configured hosts fail, the user gets a clear error message.
 * - Telegram Storage needs no external account at all: it posts the
 *   original file into your own TG_STORAGE_CHAT_ID chat via sendDocument
 *   (not sendPhoto, so it isn't re-compressed), and this Worker's own
 *   GET /image/<file_id>.<ext> route streams it back with a 1-year
 *   immutable cache header. The bot token is never exposed to viewers.
 * -----------------------------------------------------------------------
 */ 
