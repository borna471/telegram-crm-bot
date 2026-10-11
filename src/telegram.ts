export interface TgMessage {
  message_id: number;
  date: number;
  chat: { id: number };
  from?: { id: number };
  text?: string;
  caption?: string;
  reply_to_message?: { message_id: number };
}

export interface Update {
  update_id: number;
  message?: TgMessage;
}

export class Telegram {
  constructor(private token: string) {}

  async call<T = unknown>(method: string, body: unknown): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
    return json.result;
  }

  async send(chatId: number, text: string, replyTo?: number): Promise<number> {
    const msg = await this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: text.slice(0, 4096),
      link_preview_options: { is_disabled: true },
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    });
    return msg.message_id;
  }

  typing(chatId: number): Promise<unknown> {
    return this.call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => undefined);
  }
}
