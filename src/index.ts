import { DurableObject } from "cloudflare:workers";
import { research, normalizeLinkedIn, type Candidate, type Result } from "./claude";
import { Notion, companyLabel, type Row } from "./notion";
import { Telegram, type TgMessage, type Update } from "./telegram";
import { hashtags, mergeContact, union } from "./util";

export interface Env {
  BOT: DurableObjectNamespace<Bot>;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ALLOWED_TELEGRAM_USER_ID: string;
  ANTHROPIC_API_KEY: string;
  NOTION_TOKEN: string;
  NOTION_DATABASE_ID: string;
  TIMEZONE: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // One-time: GET /setup?key=<TELEGRAM_WEBHOOK_SECRET> points Telegram at this Worker.
    if (req.method === "GET" && url.pathname === "/setup") {
      if (url.searchParams.get("key") !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("Forbidden", { status: 403 });
      const result = await new Telegram(env.TELEGRAM_BOT_TOKEN).call("setWebhook", {
        url: `${url.origin}/webhook`,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["message"],
      });
      return Response.json({ ok: true, result });
    }

    if (req.method === "POST" && url.pathname === "/webhook") {
      if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const update = (await req.json()) as Update;
      if (update.message && String(update.message.from?.id) === env.ALLOWED_TELEGRAM_USER_ID) {
        await env.BOT.get(env.BOT.idFromName("bot")).enqueue(update);
      }
      // Answer Telegram right away; the Durable Object alarm does the slow work.
      return new Response("ok");
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

const HELP = `Send me someone you met:
- Share their LinkedIn profile here, plus a line of notes ("Weave afterparty SF, talked about her seed round").
- Or just a name and notes ("Jane Doe from Acme, met at Dreamforce, into dev tools").

Add #tags to tag them.
Reply to a saved card to correct it ("company is Stripe", "wrong person, she's in NYC").
Reply /delete to a saved card to remove it.`;

interface Pending {
  text: string;
  date: number;
  askedAt: number;
  candidates: Candidate[];
}

export class Bot extends DurableObject<Env> {
  private tg = new Telegram(this.env.TELEGRAM_BOT_TOKEN);
  private notion = new Notion(this.env.NOTION_TOKEN, this.env.NOTION_DATABASE_ID);

  async enqueue(update: Update): Promise<void> {
    const s = this.ctx.storage;
    // Telegram retries webhooks; update_id only goes up, so skip anything already seen.
    if (update.update_id <= ((await s.get<number>("lastUpdateId")) ?? 0)) return;
    const queue = (await s.get<Update[]>("queue")) ?? [];
    queue.push(update);
    await s.put({ lastUpdateId: update.update_id, queue });
    if ((await s.getAlarm()) === null) await s.setAlarm(Date.now());
  }

  // One message per alarm keeps each run well inside the alarm time limit.
  async alarm(): Promise<void> {
    const s = this.ctx.storage;
    const queue = (await s.get<Update[]>("queue")) ?? [];
    const update = queue.shift();
    await s.put("queue", queue);
    if (queue.length) await s.setAlarm(Date.now());
    const msg = update?.message;
    if (!msg) return;
    try {
      await this.handle(msg);
    } catch (err) {
      console.error(err);
      await this.tg
        .send(msg.chat.id, `Something went wrong: ${(err as Error).message}`, msg.message_id)
        .catch(console.error);
    }
  }

  private async handle(msg: TgMessage): Promise<void> {
    const chat = msg.chat.id;
    const text = (msg.text ?? msg.caption ?? "").trim();
    if (!text) return;

    if (text === "/start" || text === "/help") {
      await this.tg.send(chat, HELP);
      return;
    }

    const repliedPage = msg.reply_to_message
      ? await this.ctx.storage.get<string>(`card:${msg.reply_to_message.message_id}`)
      : undefined;

    if (text === "/delete") {
      if (!repliedPage) return void (await this.tg.send(chat, "Reply /delete to the saved card you want removed."));
      await this.notion.archive(repliedPage);
      await this.tg.send(chat, "Deleted.", msg.message_id);
      return;
    }

    if (repliedPage) return this.correct(msg, repliedPage, text);

    const pending = await this.ctx.storage.get<Pending>("pending");
    const pick = text.match(/^(\d)\.?$/);
    if (pending && pick) {
      const c = pending.candidates[Number(pick[1]) - 1];
      if (!c) return void (await this.tg.send(chat, `Pick 1 to ${pending.candidates.length}, or send more detail.`));
      await this.ctx.storage.delete("pending");
      const picked = `${pending.text}\n\nBorna confirmed it's this person: ${c.name}, ${c.headline}${c.linkedin ? `, ${c.linkedin}` : ""}`;
      return this.addContact(msg, picked, pending.date);
    }

    await this.ctx.storage.delete("pending");
    // A non-number reply soon after "Which one?" is extra detail for that same person.
    if (pending && msg.date - pending.askedAt < 30 * 60) {
      return this.addContact(msg, `${pending.text}\n\nMore detail from Borna: ${text}`, pending.date);
    }
    return this.addContact(msg, text, msg.date);
  }

  private async addContact(msg: TgMessage, text: string, date: number): Promise<void> {
    const chat = msg.chat.id;
    await this.tg.typing(chat);
    const linkedin = normalizeLinkedIn(text);
    const input =
      `Borna's message:\n${text}` + (linkedin ? `\n\nLinkedIn profile from the message: ${linkedin}` : "");
    const result = await research(this.env.ANTHROPIC_API_KEY, input, this.today(date));

    if (result.status === "ambiguous") {
      await this.ctx.storage.put<Pending>("pending", { text, date, askedAt: msg.date, candidates: result.candidates });
      const list = result.candidates
        .map((c, i) => `${i + 1}. ${c.name}, ${c.headline}${c.linkedin ? `\n   ${c.linkedin}` : ""}`)
        .join("\n");
      await this.tg.send(chat, `Which one?\n${list}\n\nReply with the number, or send more detail.`, msg.message_id);
      return;
    }
    if (result.status === "not_found") {
      await this.tg.send(chat, `${result.message}\nSend a LinkedIn link or more detail and I'll try again.`, msg.message_id);
      return;
    }

    const contact = result.contact;
    const tags = hashtags(text);
    const existing = await this.notion.findExisting(contact);
    let row: Row;
    if (existing) {
      const merged = mergeContact(existing.contact, contact);
      const metCities = union(existing.metCities, contact.city_met ? [contact.city_met] : []);
      row = await this.notion.update(existing.id, merged, union(existing.tags, tags), metCities);
    } else {
      row = await this.notion.create(contact, tags);
    }
    await this.sendCard(chat, row, existing ? "Updated existing row" : "Saved", contact.low_confidence, msg.message_id);
  }

  private async correct(msg: TgMessage, pageId: string, text: string): Promise<void> {
    await this.tg.typing(msg.chat.id);
    const row = await this.notion.get(pageId);
    const input = `Here is a row already in Borna's CRM:\n${JSON.stringify(row.contact, null, 2)}

Borna's correction:\n${text}

Apply the correction and return the full updated contact with status "found". Research again only if the correction says it's the wrong person or asks you to look something up. Keep the existing notes unless the correction is about them; add any new context Borna gives to the notes.`;
    const result: Result = await research(this.env.ANTHROPIC_API_KEY, input, this.today(msg.date));
    if (result.status !== "found") {
      const why = result.status === "not_found" ? result.message : "That matches more than one person.";
      await this.tg.send(msg.chat.id, `${why} Nothing changed.`, msg.message_id);
      return;
    }
    const c = result.contact;
    // Swap the corrected meeting city in place; keep the other cities already on the row.
    const metCities = union(
      row.metCities.filter((x) => x !== row.contact.city_met),
      c.city_met ? [c.city_met] : [],
    );
    const updated = await this.notion.update(pageId, c, union(row.tags, hashtags(text)), metCities);
    await this.sendCard(msg.chat.id, updated, "Updated", c.low_confidence, msg.message_id);
  }

  private async sendCard(chat: number, row: Row, verb: string, unsure: string[], replyTo: number) {
    const c = row.contact;
    const lines = [
      `${verb}: ${c.name}`,
      companyLabel(c) || null,
      `LinkedIn: ${c.linkedin ?? "-"}`,
      `Email: ${c.email ?? "-"}`,
      `X: ${c.x_handle ? `@${c.x_handle}` : "-"}`,
      `Website: ${c.website ?? "-"}`,
      `Lives in: ${c.current_city ?? "-"} · Met in: ${row.metCities.join(", ") || "-"} · Last contacted: ${c.last_contacted ?? "-"}`,
      row.tags.length ? `Tags: ${row.tags.join(", ")}` : null,
      c.notes ? `Notes: ${c.notes.length > 600 ? `${c.notes.slice(0, 600)}…` : c.notes}` : null,
      unsure.length ? `Unsure about: ${unsure.join(", ")}` : null,
      "",
      `Reply to this message to correct it. ${row.url}`,
    ].filter((l) => l !== null);
    const id = await this.tg.send(chat, lines.join("\n"), replyTo);
    await this.ctx.storage.put(`card:${id}`, row.id);
  }

  private today(unixSeconds: number): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: this.env.TIMEZONE }).format(new Date(unixSeconds * 1000));
  }
}
