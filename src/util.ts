import type { Contact } from "./claude";

export function hashtags(text: string): string[] {
  return [...new Set([...text.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu)].map((m) => m[1]))];
}

export function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

/** New research fills gaps and refreshes facts; Borna's earlier notes are kept and the new ones appended. */
export function mergeContact(old: Contact, next: Contact): Contact {
  const pick = <K extends keyof Contact>(k: K) => (next[k] ?? old[k]) as Contact[K];
  const notes = !old.notes ? next.notes : !next.notes || old.notes.includes(next.notes) ? old.notes : `${old.notes}\n\n${next.notes}`;
  return {
    name: next.name || old.name,
    linkedin: pick("linkedin"),
    role: pick("role"),
    company: pick("company"),
    email: pick("email"),
    x_handle: pick("x_handle"),
    website: pick("website"),
    current_city: pick("current_city"),
    city_met: pick("city_met"),
    last_contacted: pick("last_contacted"),
    notes,
    low_confidence: next.low_confidence,
  };
}
