# DoraHacks Submission — TeleGifts G2

- **Hackathon:** [Heads Up: Even Realities Hackathon](https://dorahacks.io/hackathon/even-realities/detail)
- **Primary Track:** `Track 01 — Messaging & News` (`Telegram`: accounts, bots, channels, Mini Apps)
- **Bonus / Cross-Track Category:** `Best Telegram Integration`
- **Target Hardware & SDK:** Even Realities G2 (`576 × 288`, 4-bit optical waveguide) + Even R1 Ring · `@evenrealities/even_hub_sdk@0.0.16`

---

## 1. One-Line Pitch
**TeleGifts G2** turns Even Realities G2 glasses and the R1 Ring into a heads-up Telegram Gift collectibles terminal and real-time moderator copilot — combining 4-bit optical floor & 5-venue spread charts, instant SSE `/ask` interrupts, IMU head-nod alert triage, and 1-tap visual Telegram replies.

---

## 2. Inspiration & Why Smart Glasses?
Telegram Collectible Gifts trade 24/7 across five fragmented TON marketplaces (**Portals, Tonnel, MRKT, Getgems, and Fragment**), while collector alpha and price discovery happen inside fast-moving Telegram forum topics (`#floor-watch`, `#deals-radar`, `#model-checks`) and breakout channels.

Collectors and community moderators face constant phone pullout fatigue:
1. Checking whether a gift floor or net-of-fee arbitrage spread moved across five venues.
2. Answering repetitive `/ask` floor and spread questions in Telegram supergroups.
3. Looking up gift floors mid-conversation at IRL TON/Telegram meetups.

**Even Realities G2** solves this natively in the wearer's line of sight:
- **Glanceable 4-bit Optical Visuals:** `256 × 144` 16-shade UTC floor plots, 5-venue horizontal spread bar charts, and tilted 3D gift relief projections sit cleanly beside a brightness-graded (`textColor` `2 / 4 / 3`) 3-region waveguide HUD.
- **Hands-Free Action:** Hold the **R1 Ring** to voice-pick a Telegram reply draft via offline WASM speech recognition (`soundswallower`), **nod** to open a `LIVE /ASK` smart reply via G2 IMU (`imuControl`), or launch directly from the **G2 OS Menu (`glassesMenu`)** into a 60-second Morning Market Brief.

---

## 3. System Architecture

```mermaid
flowchart LR
  subgraph Glasses["Even Realities G2 + R1 Ring (SDK 0.0.16)"]
    HUD["576×288 4-Bit Spatial HUD\n(3 Text Regions + 256×144 PNG Plane)"]
    MIC["G2 Mic + Speaker Role\n(self PTT / other IRL Lookup)"]
    IMU["G2 IMU (imuControl)\nNod: Reply · Shake: Dismiss"]
    RING["R1 Ring & Temple Touch\nSwipe · Tap · Hold · 2×Tap"]
  end

  subgraph Companion["TeleGifts Companion WebView (.ehpk)"]
    UI["@telegifts/phone UI\nExplore · Insights · Heatmap · Sheets"]
    COPILOT["9-Tool Collector Copilot\nBrief · Gifti · Watchlist · Research · Note"]
    ASR["Offline SoundSwallower WASM\nFinite-State JSGF Grammar"]
    TICKER["Live CoinGecko TON/USDT\n+ Deterministic Offline Fallback"]
  end

  subgraph Relay["Self-Hosted Telegram Bot Relay (server/telegramRelay.mjs)"]
    SSE["GET /g2/telegram/events\nSub-Second Authenticated SSE"]
    BOT["Telegram Bot API\n/ask · sendPhoto · Inline Callbacks"]
  end

  RING --> Companion
  MIC --> ASR --> Companion
  IMU --> Companion
  Companion --> HUD
  TICKER --> Companion
  Companion <-->|"Bearer Auth + Idempotent Receipts"| Relay
  SSE -->|"LIVE /ASK Interrupt"| Companion
  BOT <-->|"Forum Topics, Channels & DMs"| TG["Telegram Supergroups & Saved Messages"]
```

---

## 4. Even G2 SDK `0.0.16` Hardware Capabilities Used

| Even Hub SDK Primitive | How TeleGifts G2 Uses It |
| --- | --- |
| `createStartUpPageContainer` / `rebuildPageContainer` / `textContainerUpgrade` | 3-region spatial HUD with brightness hierarchy (`header: 2`, `body: 4` w/ single `isEventCapture: 1`, `footer: 3`) and fenced container IDs |
| `updateImageRawData` (`120 × 120` & `256 × 144`) | Streams 16-level grayscale gift artwork, tilted 3D relief models, `24h/7d/30d` UTC floor charts, and 5-venue horizontal spread bar charts |
| `EventSourceType` (`RING`, `GLASSES_R`, `GLASSES_L`) + `LONG_PRESS` | R1 Ring push-to-talk draft selection in Smart Reply composer + live input-source badge on HUD mirror |
| `audioControl` + `AudioSpeakerRole` (`self` vs `other`) | Offline JSGF voice commands & `Ask Gifti` for wearer (`self`), plus bounded 12s **IRL Meetup Overheard Lookup** (`other`) that beams mentioned gift spreads without interfering with wearer speech |
| `imuControl` + `IMU_DATA_REPORT` (`x, y, z`) | Power-gated **Head-Nod / Head-Shake Alert Triage** active strictly during transient `LIVE /ASK` and Watch-Hit (`digest-watch-*`) overlays |
| `onLaunchSource` (`glassesMenu` vs `appMenu`) | Early-captured G2 OS menu launch opens straight into the **60s Morning Market Brief (`summary`)** |
| `getLocalStorage` / `setLocalStorage` + `pickImageFromAlbum` | Hydrates & writes through Favorites, Watchlist baselines, Relay config, and G2 hardware preferences into Even App native storage, plus album gift-image scanning |

---

## 5. 60-Second Judge Evaluation Guide (Zero API Keys Required)

```bash
npm install
npm test
npm run dev
```

1. **Interactive Browser & GitHub Pages Judge Studio (`http://localhost:3000`):**
   - Opens a side-by-side **TeleGifts Phone Bezel + Even Realities G2 `576 × 288` 4-Bit Optical Waveguide** with ambient backdrop switching (`Dark Lab / TON Meetup / City Walk`), keyboard-mapped R1 Ring & Temple controls (`↑/↓/Enter/Esc/Space`), and **real `16 kHz` microphone voice input** (`🎤 Speak G2 Command` → offline `soundswallower` WASM, plus `🤖 Speak to Gifti AI` with **20 free demo messages** or an optional one-time RAM-only `OpenAI / Gemini / Groq` key that is never saved anywhere).
   - Browse **Explore** (Grid & List sparklines), **Insights → Heatmap** (`12h / 24h / 7d / 30d`), or **Tools → User portfolio & Wallet Card** (enter `@collector` or any public TON wallet `EQ...` / `UQ...` / `.ton`).
   - Tap **Copilot** in the `Explore` header to test all **9 Collector Copilot tools**: `60s Morning market brief`, `Ask Gifti copilot`, `Watchlist & USDT valuation`, `Net arbitrage & rarity research` (net of `2.5%–5%` venue seller fees + 5-venue spread bar toggle), `Draft Telegram alpha note`, `Spread radar`, and `Watch asking price`.
   - Tap **Telegram Setup** (or `⚡ + Live /ask Alert` in the Studio) to test **`+ Live /ask Heads-Up`**, **IMU Head-Nod Triage**, paste a **`t.me/nft/PlushPepe-412`** link to beam its 5-venue spread to G2, or trigger **12s IRL Counterparty Mic**.
2. **Official Even Hub Simulator (`576 × 288` Waveguide):**
   - In a second terminal, run `npm run simulate` (`evenhub-simulator http://localhost:3000/?raw=1`).
3. **Optional Live Telegram Bot Relay:**
   - Copy `.env.example` to `.env`, set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME` (kept strictly server-side), run `npm run relay`, and connect in **Telegram Setup** for real `/ask` SSE interrupts, `venue-spread.png` / `floor-chart.png` `sendPhoto` replies, and inline `🔄 Ask Live Floor` / `📌 Pin to Digest` callback buttons.

---

## 6. Security, Live-Data Honesty & Public Repo Hygiene
- **Zero Client-Side Secrets:** `TELEGRAM_BOT_TOKEN` lives exclusively in `server/telegramRelay.mjs`. Relay endpoints enforce DNS-rebinding Host checks, Fetch Metadata (`Sec-Fetch-Site`), CORS allowlists, and `timingSafeEqual` Bearer tokens.
- **Strict Live vs. Snapshot Honesty:** When connected to a live Telegram relay without a live market/history feed, synthetic 7d curves and spread charts are never attached or presented as live quotes — outgoing cards explicitly carry `(snapshot)` markers.
- **Automated Public Audit (`npm run audit:public`):** Scans all repository files (`>330` files including bundled assets and `app.json`) to guarantee zero leaked tokens, keystores, or private endpoints.
