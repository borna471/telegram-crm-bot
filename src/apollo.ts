import type { Contact } from "./claude";

// Docs: https://docs.apollo.io/reference/people-enrichment
const URL = "https://api.apollo.io/api/v1/people/match";

interface ApolloPerson {
  email?: string | null;
  email_status?: string | null;
  personal_emails?: string[] | null;
  title?: string | null;
  twitter_url?: string | null;
  linkedin_url?: string | null;
  organization?: { name?: string | null } | null;
}

export interface ApolloResult {
  email: string | null;
  emailStatus: string | null;
  title: string | null;
  company: string | null;
  xHandle: string | null;
}

/** Looks a person up in Apollo by LinkedIn URL, or by name + company. Returns null when Apollo has no confident match. */
export async function apolloLookup(apiKey: string, c: Contact): Promise<ApolloResult | null> {
  const params = new URLSearchParams({ reveal_personal_emails: "true", reveal_phone_number: "false" });
  if (c.linkedin) params.set("linkedin_url", c.linkedin);
  params.set("name", c.name);
  if (c.company) params.set("organization_name", c.company);

  const res = await fetch(`${URL}?${params}`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json", accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Apollo ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { person?: ApolloPerson | null; match_confidence?: string };
  const p = json.person;
  if (!p || json.match_confidence === "none" || json.match_confidence === "low") return null;
  // When we know the LinkedIn profile, make sure Apollo matched that same profile.
  if (c.linkedin && p.linkedin_url && !sameLinkedIn(c.linkedin, p.linkedin_url)) return null;

  const work = usable(p.email) && p.email_status !== "unavailable" ? p.email! : null;
  const personal = (p.personal_emails ?? []).find(usable) ?? null;
  return {
    email: work ?? personal,
    emailStatus: work ? (p.email_status ?? null) : personal ? "personal" : null,
    title: p.title ?? null,
    company: p.organization?.name ?? null,
    xHandle: p.twitter_url?.match(/(?:twitter|x)\.com\/([A-Za-z0-9_]+)/i)?.[1] ?? null,
  };
}

/**
 * Fill gaps in Claude's research with Apollo's data. Apollo's email wins when Claude had none,
 * or when Claude's was a guess and Apollo's is verified. Other fields are only filled if empty.
 */
export function applyApollo(c: Contact, a: ApolloResult): { contact: Contact; usedEmail: boolean } {
  const claudeUnsure = c.low_confidence.includes("email");
  const usedEmail = !!a.email && (!c.email || (claudeUnsure && a.emailStatus === "verified"));
  let lowConfidence = c.low_confidence;
  if (usedEmail) {
    lowConfidence = lowConfidence.filter((f) => f !== "email");
    if (a.emailStatus !== "verified") lowConfidence = [...lowConfidence, "email"];
  }
  return {
    usedEmail,
    contact: {
      ...c,
      email: usedEmail ? a.email : c.email,
      role: c.role ?? a.title,
      company: c.company ?? a.company,
      x_handle: c.x_handle ?? a.xHandle,
      low_confidence: lowConfidence,
    },
  };
}

function usable(email: string | null | undefined): email is string {
  // Apollo returns placeholder addresses for emails the plan hasn't unlocked.
  return !!email && email.includes("@") && !email.startsWith("email_not_unlocked");
}

function sameLinkedIn(a: string, b: string): boolean {
  const slug = (u: string) => u.match(/\/in\/([^/?#]+)/i)?.[1]?.toLowerCase();
  return slug(a) === slug(b);
}
