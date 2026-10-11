import Anthropic from "@anthropic-ai/sdk";

export const CITIES = [
  "San Francisco",
  "London",
  "NYC",
  "Vancouver",
  "Toronto",
  "Montreal",
  "Other USA",
  "Other Canada",
] as const;

export interface Contact {
  name: string;
  linkedin: string | null;
  role: string | null;
  company: string | null;
  email: string | null;
  x_handle: string | null;
  website: string | null;
  current_city: string | null;
  city_met: string | null;
  last_contacted: string | null;
  notes: string;
  low_confidence: string[];
}

export interface Candidate {
  name: string;
  headline: string;
  linkedin: string | null;
}

export type Result =
  | { status: "found"; contact: Contact }
  | { status: "ambiguous"; candidates: Candidate[] }
  | { status: "not_found"; message: string };

const MODEL = "claude-opus-5-5";

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
const nullableCity = { anyOf: [{ type: "string", enum: [...CITIES] }, { type: "null" }] };

const REPORT_TOOL = {
  name: "report_result",
  description: "Report the final result. Call exactly once, after research is done.",
  strict: true,
  input_schema: {
    type: "object" as const,
    additionalProperties: false,
    required: ["status", "contact", "candidates", "message"],
    properties: {
      status: { type: "string", enum: ["found", "ambiguous", "not_found"] },
      contact: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: [
              "name", "linkedin", "role", "company", "email", "x_handle", "website",
              "current_city", "city_met", "last_contacted", "notes", "low_confidence",
            ],
            properties: {
              name: { type: "string" },
              linkedin: nullableString,
              role: nullableString,
              company: nullableString,
              email: nullableString,
              x_handle: nullableString,
              website: nullableString,
              current_city: nullableCity,
              city_met: nullableCity,
              last_contacted: { ...nullableString, description: "YYYY-MM-DD" },
              notes: { type: "string" },
              low_confidence: { type: "array", items: { type: "string" } },
            },
          },
          { type: "null" },
        ],
      },
      candidates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "headline", "linkedin"],
          properties: { name: { type: "string" }, headline: { type: "string" }, linkedin: nullableString },
        },
      },
      message: { type: "string", description: "Short explanation when status is not_found; otherwise empty." },
    },
  },
};

function systemPrompt(today: string): string {
  return `You fill in rows of Borna's personal CRM (a Notion "People" database) for people Borna met, mostly professional connections from LinkedIn. Today is ${today}.

Borna sends either a LinkedIn profile URL plus notes, or a name plus notes. Use web search to identify the person and find their LinkedIn URL, current role, current company, a publicly listed email, X handle, personal website, and current city.

How to research:
- LinkedIn pages usually show a sign-in wall. Work from search result snippets and other public sources (company sites, personal sites, X, GitHub, press). Never try to sign in anywhere.
- A LinkedIn URL from Borna settles who the person is. The slug is often their name.
- With only a name, use Borna's hints (company, event, city) to pick the right person. If more than one real person plausibly fits and the hints don't decide it, return status "ambiguous" with up to 5 candidates (name, one-line headline, LinkedIn URL if known). Don't guess.
- Never invent values. Use null when you can't find something. Only use an email that is publicly listed; never construct one from a naming pattern.
- List the field names you are unsure about in low_confidence (for example "email", "current_city").

Field rules:
- name: the person's full name as they present it.
- linkedin: canonical https://www.linkedin.com/in/<slug>/ form, no query string.
- x_handle: handle without the @.
- current_city: where they live or work now, mapped to one of the options. Use "Other USA" or "Other Canada" for other cities in those countries, null elsewhere or if unknown.
- city_met: where Borna met them, from Borna's message, mapped the same way. Null if not stated.
- last_contacted: the date Borna met or talked to them, from the message. Default to today.
- notes: Borna's own context (where you met, what you talked about, follow-ups), lightly cleaned up, in Borna's voice. Start with "Met at <place>, <city> (<Mon D, YYYY>)." when the place is known. Don't add web research to notes. If the identity match is not certain, add one short sentence saying so and why.

When you are done, call report_result exactly once.`;
}

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

export async function research(apiKey: string, input: string, today: string): Promise<Result> {
  const client = new Anthropic({ apiKey });
  const messages: Params["messages"] = [{ role: "user", content: input }];

  for (let i = 0; i < 10; i++) {
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: systemPrompt(today),
      tools: [
        { type: "web_search_20260209", name: "web_search", max_uses: 8 },
        { type: "web_fetch_20260209", name: "web_fetch", max_uses: 4, blocked_domains: ["linkedin.com"] },
        REPORT_TOOL,
      ],
      messages,
    });

    if (res.stop_reason === "refusal") throw new Error("Claude declined this request.");

    const call = res.content.find((b) => b.type === "tool_use" && b.name === "report_result");
    if (call && call.type === "tool_use") return parseResult(call.input);

    messages.push({ role: "assistant", content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
    if (res.stop_reason === "pause_turn") continue;
    messages.push({ role: "user", content: "Call report_result now with what you have." });
  }
  throw new Error("Research didn't finish. Try again with more detail.");
}

// Strict tool use guarantees the schema, but keep a light check so a bad value never reaches Notion.
export function parseResult(raw: unknown): Result {
  const r = raw as { status: string; contact: Contact | null; candidates: Candidate[]; message: string };
  if (r.status === "found" && r.contact) {
    const c = r.contact;
    const city = (v: string | null) => (v && (CITIES as readonly string[]).includes(v) ? v : null);
    return {
      status: "found",
      contact: {
        ...c,
        linkedin: normalizeLinkedIn(c.linkedin),
        x_handle: c.x_handle ? c.x_handle.replace(/^@/, "").trim() : null,
        email: c.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email) ? c.email : null,
        website: c.website && /^https?:\/\//.test(c.website) ? c.website : null,
        current_city: city(c.current_city),
        city_met: city(c.city_met),
        last_contacted: c.last_contacted && /^\d{4}-\d{2}-\d{2}$/.test(c.last_contacted) ? c.last_contacted : null,
        low_confidence: c.low_confidence ?? [],
      },
    };
  }
  if (r.status === "ambiguous" && r.candidates?.length) {
    return { status: "ambiguous", candidates: r.candidates.slice(0, 5) };
  }
  return { status: "not_found", message: r.message || "Couldn't identify this person." };
}

export function normalizeLinkedIn(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  return m ? `https://www.linkedin.com/in/${decodeURIComponent(m[1]).toLowerCase()}/` : null;
}
