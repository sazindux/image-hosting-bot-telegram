# 📸 ImgBB Telegram Uploader Bot (Cloudflare Workers Edition)

A high-performance, resilient, single-file Telegram image uploader bot built specifically for **Cloudflare Workers**. It features **Telegram Bot API 10.1+ Rich Messages**, inline styled buttons, zero external npm dependencies, and an advanced **4-tier automatic fallback upload system** to ensure your uploads never fail.

---

## ✨ Key Features

1. **Zero Dependencies & High Speed**: Built purely on Web Standard APIs (`fetch`, `FormData`, `Response`) inside a single ES Module worker file (`worker.js`). No Node.js runtime overhead, lightning-fast cold starts.
2. **Telegram Bot API 10.1+ Rich Messages**: Utilizes modern rich text formatting and embedded inline `<tg-button-row>` and `<tg-button>` tags (`success` style) for clean navigation and action buttons (Open Link, Copy Link, Share).
3. **Robust 4-Tier Fallback Upload System**:
   * **Tier 1 — ImgBB**: Key rotation across multiple API keys/accounts in random order to bypass rate limits.
   * **Tier 2 — Catbox.moe**: Fast, keyless anonymous or userhash-authenticated upload.
   * **Tier 3 — Imgur**: Keyless anonymous upload via a free Imgur Client-ID.
   * **Tier 4 — Telegram Storage (Zero External Host)**: Stores the raw, uncompressed file in your own private Telegram channel via `sendDocument` and serves it back via a secure, cached public proxy route (`/image/<file_id>.<ext>`) on your worker domain with a 1-year immutable cache header. Your bot token is never exposed to viewers.
4. **Activity Logging**: Automatically mirrors successful or failed uploads into a private log channel with user metadata and file sizing.
5. **Interactive UI**: Clean `/start` command with interactive guide and about menus powered by callback queries.

---

## 🛠️ How It Works (Architecture)

```
[ User Sends Photo ] 
        │
        ▼
[ Cloudflare Worker ] ──(Downloads via Telegram Bot API)
        │
        ├─► 1. Try ImgBB (API Key Rotation) ──► Success? Return URL
        │     └─(If failed)
        ├─► 2. Try Catbox.moe ────────────────► Success? Return URL
        │     └─(If failed)
        ├─► 3. Try Imgur API ──────────────────► Success? Return URL
        │     └─(If failed)
        └─► 4. Store in Telegram Chat (sendDocument) ──► Stream via /image proxy
```

* **Rich Messages**: Instead of legacy inline keyboard markups, buttons are embedded right inside the HTML block using `<tg-button>` elements.
* **Image Proxying**: When using Telegram Storage fallback, the worker fetches the file securely using your secret `BOT_TOKEN` and streams it to the public with correct content-types derived from the file extension (`.jpg`, `.png`, `.webp`, etc.).

---

## 🚀 Step-by-Step Setup Guide

### Prerequisites
* A [Cloudflare account](https://cloudflare.com) (Free tier is fully sufficient).
* Node.js and npm installed locally (for Wrangler CLI).
* A Telegram Bot Token from [@BotFather](https://t.me/BotFather).

---

### Step 1: Clone or Download the Project
Create a new directory for your project and save the bot script as `worker.js`:
```bash
mkdir telegram-imgbb-bot
cd telegram-imgbb-bot
# Save your worker code into worker.js
```

Create a `wrangler.toml` file in the same directory:
```toml
name = "imgbb-telegram-bot"
main = "worker.js"
compatibility_date = "2024-03-20"
```

---

### Step 2: Install Wrangler & Authenticate
Install the Cloudflare Wrangler CLI globally (or run via `npx`):
```bash
npm install -g wrangler
wrangler login
```

---

### Step 3: Configure Environment Variables & Secrets
Set your required bot token and optional backup storage/logging keys using Wrangler secrets:

```bash
# Required: Your Telegram Bot Token from @BotFather
wrangler secret put BOT_TOKEN

# Recommended: ImgBB API keys (comma-separated for key rotation)
wrangler secret put IMGBB_API_KEYS
```

#### Optional Environment Secrets/Vars:
```bash
# Optional: Catbox account userhash
wrangler secret put CATBOX_USERHASH

# Optional: Free Imgur Client-ID for anonymous Imgur fallback
wrangler secret put IMGUR_CLIENT_ID

# Optional: Private channel ID for activity logs (e.g., -1001234567890)
wrangler secret put LOG_CHANNEL_ID

# Optional: Private channel ID for Telegram storage fallback tier
wrangler secret put TG_STORAGE_CHAT_ID

# Optional: Bot and Developer usernames for message footers
wrangler secret put BOT_USERNAME
wrangler secret put DEV_USERNAME
```
*Note: To find channel IDs like `-1001234567890`, add your bot as an admin to a private channel and forward a message from that channel to `@userinfobot` or `@RawDataBot`.*

---

### Step 4: Deploy to Cloudflare Workers
Deploy your worker script to Cloudflare:
```bash
wrangler deploy
```
After deployment, Wrangler will output your worker URL (e.g., `https://imgbb-telegram-bot.<your-subdomain>.workers.dev`).

---

### Step 5: Register the Telegram Webhook
Run the following cURL command to link your Telegram bot to your new Cloudflare Worker endpoint (replace `<YOUR_WORKER_URL>` and `<BOT_TOKEN>` with your actual values):

```bash
curl -F "url=https://imgbb-telegram-bot.<your-subdomain>.workers.dev/" https://api.telegram.org/bot<BOT_TOKEN>/setWebhook
```

You should receive a JSON response confirming success: `{"ok":true,"result":true,"description":"Webhook was set"}`.

---

## 📂 Project Structure

```text
├── worker.js        # Main Cloudflare Worker script containing all bot logic & proxies
├── wrangler.toml    # Cloudflare Workers configuration file
└── README.md        # This documentation file
```

---

## 🤝 Contributing
Contributions, issues, and feature requests are welcome! Feel free to check the issues page or submit a pull request.

## 📄 License
This project is open-source and available under the [MIT License](LICENSE).