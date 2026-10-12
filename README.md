# telegram-crm-bot

A private Telegram bot that saves people you meet to the Notion **People** database in your Personal CRM.

- Share a LinkedIn profile to the bot (Share → Telegram) and add a line of notes, or just send a name and notes.
- Claude (Opus 5.5 with web search) identifies the person and fills in LinkedIn, company and role, a public email, X handle, website and city. It never signs in to LinkedIn; it works from public search results.
- If a name matches several people, the bot lists them and you reply with a number.
- The bot replies with a card of what it saved. Reply to that card to correct it ("company is Stripe", "wrong person, she's in NYC"), or reply `/delete` to remove it.
- If the person is already in the database (same LinkedIn or name), the row is updated and your new notes are appended.
- `#tags` in your message become Tags. Only your Telegram user ID can use the bot.

## Setup

You need Node 20+ and a free Cloudflare account.

```sh
npm install
npx wrangler login
```

### 1. Get the three tokens

1. **Telegram bot token.** In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token. To find your own user ID, message [@userinfobot](https://t.me/userinfobot).
2. **Anthropic API key.** Create one at [console.anthropic.com](https://console.anthropic.com/settings/keys). Usage is billed per request.
3. **Notion token.** Create an internal integration at [notion.so/profile/integrations](https://www.notion.so/profile/integrations) and copy its secret. Then open the **Personal CRM** page in Notion, click `•••` → **Connections**, and add the integration so it can read and write the People database.

**Optional: Apollo for emails.** If you add an Apollo API key, the bot looks the person up in Apollo whenever Claude didn't find an email (or only guessed one), using their LinkedIn URL. In Apollo, go to **Settings → Integrations → API Keys → Create new key** and give it access to `people/match` (People Enrichment). Each match uses 1 Apollo credit, and nothing is charged when Apollo finds no data. The card says when an email came from Apollo. Without the key, the bot works as before.

The People database ID is already set in `wrangler.toml` (`NOTION_DATABASE_ID`). `TIMEZONE` there sets the date used for "Last contacted".

### 2. Store the secrets

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put ALLOWED_TELEGRAM_USER_ID     # your numeric Telegram user ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET      # any random string, e.g. `openssl rand -hex 16`
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put NOTION_TOKEN
npx wrangler secret put APOLLO_API_KEY               # optional
```

### 3. Deploy and connect Telegram

```sh
npm run deploy
```

Wrangler prints the Worker URL. Open this once in a browser to register the webhook:

```
https://telegram-crm-bot.<your-subdomain>.workers.dev/setup?key=<TELEGRAM_WEBHOOK_SECRET>
```

Then send `/start` to your bot.

## How it works

`src/index.ts` receives Telegram's webhook, checks the secret header and your user ID, and hands the message to a Durable Object, which answers Telegram immediately and does the slow work (a web-searching Claude call can take a minute) in an alarm. The Durable Object also remembers which card maps to which Notion row and any "which one?" question that's waiting for your answer.

- `src/claude.ts`: the research prompt and Claude call (web search + web fetch, result returned through a strict `report_result` tool).
- `src/notion.ts`: reads and writes People rows. "Current company" is stored as `Company (Role)` to match the existing rows.
- `src/apollo.ts`: optional Apollo People Enrichment lookup for emails.
- `src/telegram.ts`: the few Telegram Bot API calls used.

## Development

```sh
npm run typecheck
npm test
npx wrangler tail   # live logs from the deployed Worker
```
