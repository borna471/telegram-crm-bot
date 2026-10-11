import type { Contact } from "./claude";

const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

export interface Row {
  id: string;
  url: string;
  contact: Contact;
  tags: string[];
  metCities: string[];
}

export class Notion {
  constructor(private token: string, private databaseId: string) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Notion-Version": VERSION,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Notion ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json() as Promise<T>;
  }

  /** Existing row with the same LinkedIn URL, or else the same name. */
  async findExisting(c: Contact): Promise<Row | null> {
    const or: unknown[] = [{ property: "Name", title: { equals: c.name } }];
    if (c.linkedin) {
      const slug = c.linkedin.match(/\/in\/([^/]+)/)?.[1];
      if (slug) or.push({ property: "LinkedIn", url: { contains: `/in/${slug}` } });
    }
    const res = await this.call<{ results: NotionPage[] }>("POST", `/databases/${this.databaseId}/query`, {
      filter: { or },
      page_size: 5,
    });
    const pages = res.results.map(toRow);
    return pages.find((p) => c.linkedin && p.contact.linkedin === c.linkedin) ?? pages[0] ?? null;
  }

  async get(pageId: string): Promise<Row> {
    return toRow(await this.call<NotionPage>("GET", `/pages/${pageId}`));
  }

  async create(c: Contact, tags: string[]): Promise<Row> {
    const page = await this.call<NotionPage>("POST", "/pages", {
      parent: { database_id: this.databaseId },
      properties: toProperties(c, tags, c.city_met ? [c.city_met] : []),
    });
    return toRow(page);
  }

  async archive(pageId: string): Promise<void> {
    await this.call("PATCH", `/pages/${pageId}`, { archived: true });
  }

  async update(pageId: string, c: Contact, tags: string[], metCities: string[]): Promise<Row> {
    const properties = toProperties(c, tags, metCities);
    return toRow(await this.call<NotionPage>("PATCH", `/pages/${pageId}`, { properties }));
  }
}

/** "Rootly (Events Manager)" — matches the rows already in the database. */
export function companyLabel(c: Contact): string {
  if (c.company && c.role) return `${c.company} (${c.role})`;
  return c.company ?? c.role ?? "";
}

export function parseCompanyLabel(s: string): { company: string | null; role: string | null } {
  const m = s.match(/^(.*?)\s*\((.+)\)\s*$/);
  if (m) return { company: m[1] || null, role: m[2] };
  return { company: s || null, role: null };
}

function text(s: string | null) {
  if (!s) return [];
  const chunks = s.match(/[\s\S]{1,2000}/g) ?? [];
  return chunks.map((content) => ({ type: "text", text: { content } }));
}

function toProperties(c: Contact, tags: string[], metCities: string[]) {
  return {
    Name: { title: text(c.name) },
    LinkedIn: { url: c.linkedin },
    "Current company": { rich_text: text(companyLabel(c)) },
    Email: { email: c.email },
    "X.com handle": { rich_text: text(c.x_handle) },
    Website: { url: c.website },
    "Current city": { multi_select: c.current_city ? [{ name: c.current_city }] : [] },
    "City last met in": { multi_select: metCities.map((name) => ({ name })) },
    "Last contacted": { date: c.last_contacted ? { start: c.last_contacted } : null },
    Notes: { rich_text: text(c.notes) },
    Tags: { multi_select: tags.map((name) => ({ name })) },
  };
}

interface NotionPage {
  id: string;
  url: string;
  properties: Record<string, any>;
}

function plain(rich: { plain_text: string }[] | undefined): string {
  return (rich ?? []).map((r) => r.plain_text).join("");
}

function toRow(p: NotionPage): Row {
  const props = p.properties;
  const ms = (k: string): string[] => (props[k]?.multi_select ?? []).map((o: { name: string }) => o.name);
  const { company, role } = parseCompanyLabel(plain(props["Current company"]?.rich_text));
  return {
    id: p.id,
    url: p.url,
    tags: ms("Tags"),
    metCities: ms("City last met in"),
    contact: {
      name: plain(props.Name?.title),
      linkedin: props.LinkedIn?.url ?? null,
      company,
      role,
      email: props.Email?.email ?? null,
      x_handle: plain(props["X.com handle"]?.rich_text) || null,
      website: props.Website?.url ?? null,
      current_city: ms("Current city")[0] ?? null,
      city_met: ms("City last met in")[0] ?? null,
      last_contacted: props["Last contacted"]?.date?.start ?? null,
      notes: plain(props.Notes?.rich_text),
      low_confidence: [],
    },
  };
}
