import { test } from "node:test";
import assert from "node:assert/strict";
import { hashtags, mergeContact } from "../src/util";
import { normalizeLinkedIn, parseResult, type Contact } from "../src/claude";
import { companyLabel, parseCompanyLabel } from "../src/notion";

const base: Contact = {
  name: "Jane Doe", linkedin: null, role: null, company: null, email: null, x_handle: null,
  website: null, current_city: null, city_met: null, last_contacted: null, notes: "", low_confidence: [],
};

test("normalizes LinkedIn share links", () => {
  const shared = "Check out Jane's profile https://www.linkedin.com/in/Jane-Doe-123?utm_source=share&utm_medium=ios_app";
  assert.equal(normalizeLinkedIn(shared), "https://www.linkedin.com/in/jane-doe-123/");
  assert.equal(normalizeLinkedIn("linkedin.com/in/janedoe/"), "https://www.linkedin.com/in/janedoe/");
  assert.equal(normalizeLinkedIn("Jane Doe from Acme"), null);
});

test("hashtags", () => {
  assert.deepEqual(hashtags("Met Jane #investor #SF #investor, not#this"), ["investor", "SF"]);
});

test("company label round-trips the existing row format", () => {
  const c = { ...base, company: "Rootly", role: "Events Marketing & Startup Community Manager" };
  assert.equal(companyLabel(c), "Rootly (Events Marketing & Startup Community Manager)");
  assert.deepEqual(parseCompanyLabel("36 Labs (CTO)"), { company: "36 Labs", role: "CTO" });
  assert.deepEqual(parseCompanyLabel("Acme"), { company: "Acme", role: null });
});

test("merge keeps old values and appends notes", () => {
  const old = { ...base, email: "jane@acme.com", notes: "Met at Weave, SF." };
  const next = { ...base, company: "Acme", notes: "Coffee follow-up, talked hiring." };
  const m = mergeContact(old, next);
  assert.equal(m.email, "jane@acme.com");
  assert.equal(m.company, "Acme");
  assert.equal(m.notes, "Met at Weave, SF.\n\nCoffee follow-up, talked hiring.");
  assert.equal(mergeContact(old, { ...base, notes: "Met at Weave, SF." }).notes, "Met at Weave, SF.");
});

test("parseResult drops invalid values", () => {
  const r = parseResult({
    status: "found",
    contact: { ...base, email: "not an email", x_handle: "@jane", city_met: "Paris", current_city: "NYC",
      website: "jane.dev", linkedin: "https://linkedin.com/in/jane?x=1", last_contacted: "Oct 11" },
    candidates: [], message: "",
  });
  assert.equal(r.status, "found");
  if (r.status !== "found") return;
  assert.equal(r.contact.email, null);
  assert.equal(r.contact.x_handle, "jane");
  assert.equal(r.contact.city_met, null);
  assert.equal(r.contact.current_city, "NYC");
  assert.equal(r.contact.website, null);
  assert.equal(r.contact.linkedin, "https://www.linkedin.com/in/jane/");
  assert.equal(r.contact.last_contacted, null);
  assert.equal(parseResult({ status: "ambiguous", contact: null, candidates: [], message: "" }).status, "not_found");
});

import { applyApollo } from "../src/apollo";

test("Apollo fills a missing email and replaces a guessed one only when verified", () => {
  const apollo = { email: "jane@acme.com", emailStatus: "verified", title: "CTO", company: "Acme", xHandle: "jane" };
  const filled = applyApollo({ ...base }, apollo);
  assert.equal(filled.usedEmail, true);
  assert.equal(filled.contact.email, "jane@acme.com");
  assert.equal(filled.contact.role, "CTO");

  const guessed = { ...base, email: "j@acme.com", low_confidence: ["email"] };
  assert.equal(applyApollo(guessed, apollo).contact.email, "jane@acme.com");
  assert.deepEqual(applyApollo(guessed, apollo).contact.low_confidence, []);
  assert.equal(applyApollo(guessed, { ...apollo, emailStatus: "likely" }).contact.email, "j@acme.com");

  const sure = { ...base, email: "jane@jane.dev" };
  assert.equal(applyApollo(sure, apollo).contact.email, "jane@jane.dev");

  const unverified = applyApollo({ ...base }, { ...apollo, emailStatus: "personal" });
  assert.deepEqual(unverified.contact.low_confidence, ["email"]);
});

import { apolloLookup } from "../src/apollo";

test("apolloLookup sends the key and LinkedIn URL, and skips placeholders and mismatches", async () => {
  const realFetch = globalThis.fetch;
  let seen: { url: string; headers: Record<string, string> } | null = null;
  const respond = (body: unknown) => {
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string> };
      return new Response(JSON.stringify(body));
    }) as typeof fetch;
  };
  const c = { ...base, linkedin: "https://www.linkedin.com/in/jane-doe/" };
  try {
    respond({ match_confidence: "high", person: {
      linkedin_url: "http://www.linkedin.com/in/jane-doe", email: "email_not_unlocked@domain.com",
      personal_emails: ["jane@gmail.com"], title: "CTO", twitter_url: "https://twitter.com/janedoe",
      organization: { name: "Acme" } } });
    const r = await apolloLookup("KEY", c);
    assert.equal(seen!.headers["x-api-key"], "KEY");
    assert.match(seen!.url, /people\/match\?.*linkedin_url=https%3A%2F%2Fwww.linkedin.com%2Fin%2Fjane-doe%2F/);
    assert.deepEqual(r, { email: "jane@gmail.com", emailStatus: "personal", title: "CTO", company: "Acme", xHandle: "janedoe" });

    respond({ match_confidence: "high", person: { linkedin_url: "http://www.linkedin.com/in/someone-else", email: "x@y.com" } });
    assert.equal(await apolloLookup("KEY", c), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});
