import YAML from "yaml";
import { htmlToCleanText } from "./sanitize.js";
import type { Fetcher } from "./fetcher.js";
import { normalizeDomain } from "./attribution.js";

export type PayeeMethod = "meta_tag" | "footnote_json" | "funding_yml" | "paypal_me" | "none";

export interface Payee {
  method: PayeeMethod;
  label: string; // human description of how it was found
  email: string | null;
  paypalMe: string | null;
  evidenceUrl: string | null;
}

export interface Site {
  key: string; // creator id shown in the UI, e.g. "example.com" or "compost-diaries.demo"
  root: string; // URL prefix ending with "/", where /.well-known/footnote.json lives
  label?: string;
}

const EMAIL_RE = /^[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,255}\.[A-Za-z]{2,}$/;
export const isEmail = (s: unknown): s is string => typeof s === "string" && EMAIL_RE.test(s.trim()) && s.length <= 254;
const PAYPALME_RE = /paypal\.me\/([A-Za-z0-9]{1,20})(?:[/?#]|$)/i;

export const NONE: Payee = { method: "none", label: "no payee declaration found (escrow)", email: null, paypalMe: null, evidenceUrl: null };

/** Map a page URL to the creator "site" (domain key + root URL). Demo sites live under /demo-sites/<slug>/. */
export function siteOf(pageUrl: string, localOrigin: string): Site {
  const u = new URL(pageUrl, localOrigin);
  const local = new URL(localOrigin);
  if (u.origin === local.origin) {
    const m = u.pathname.match(/^\/demo-sites\/([a-z0-9-]+)\//);
    if (m) return { key: `${m[1]}.demo`, root: `${u.origin}/demo-sites/${m[1]}/` };
  }
  return { key: normalizeDomain(u.host), root: `${u.origin}/` };
}

async function tryFetch(f: Fetcher, url: string) {
  try {
    const r = await f(url);
    return r.status >= 200 && r.status < 300 ? r : null;
  } catch {
    return null;
  }
}

/** Parse /.well-known/footnote.json (see docs/footnote-spec.md). */
export function parseFootnoteJson(body: string): { email: string | null; paypalMe: string | null; name?: string } | null {
  try {
    const j = JSON.parse(body);
    if (!j || typeof j !== "object" || ![1, "1"].includes(j.version)) return null;
    const email = isEmail(j?.paypal?.email) ? j.paypal.email.trim().toLowerCase() : null;
    const me = typeof j?.paypal?.me === "string" ? j.paypal.me.match(/([A-Za-z0-9]{1,20})\/?$/)?.[1] ?? null : null;
    if (!email && !me) return null;
    return { email, paypalMe: me, name: typeof j.name === "string" ? j.name.slice(0, 80) : undefined };
  } catch {
    return null;
  }
}

/** Parse GitHub FUNDING.yml: only `custom:` entries that are paypal.me links or emails matter to us. */
export function parseFundingYml(body: string): { email: string | null; paypalMe: string | null } | null {
  try {
    const y = YAML.parse(body) as Record<string, unknown> | null;
    if (!y || typeof y !== "object") return null;
    const raw = y.custom;
    const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String);
    let email: string | null = null;
    let paypalMe: string | null = null;
    for (const c of list) {
      const addr = c.replace(/^mailto:/i, "").trim();
      if (!email && isEmail(addr)) email = addr.toLowerCase();
      const m = c.match(PAYPALME_RE);
      if (!paypalMe && m) paypalMe = m[1];
    }
    if (typeof y.paypal === "string" && isEmail(y.paypal)) email = y.paypal.toLowerCase();
    return email || paypalMe ? { email, paypalMe } : null;
  } catch {
    return null;
  }
}

function githubFundingUrls(pageUrl: string): string[] {
  const u = new URL(pageUrl);
  if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return [];
  const [owner, repo] = u.pathname.split("/").filter(Boolean);
  if (!owner) return [];
  const urls: string[] = [];
  if (repo) urls.push(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/.github/FUNDING.yml`);
  urls.push(`https://raw.githubusercontent.com/${owner}/.github/HEAD/FUNDING.yml`);
  return urls;
}

/**
 * Resolve how to pay the creator of `pageUrl`.
 * Precedence (strongest proof of domain control first):
 *   1. <meta name="footnote:paypal">  2. /.well-known/footnote.json  3. GitHub FUNDING.yml
 *   4. paypal.me link on the page    5. none -> escrow
 */
export async function resolvePayee(pageUrl: string, site: Site, fetcher: Fetcher, html?: string): Promise<Payee> {
  let page = html;
  if (page === undefined) page = (await tryFetch(fetcher, pageUrl))?.body;
  const parsed = page ? htmlToCleanText(page) : null;

  const metaEmail = parsed?.metaTags["footnote:paypal"];
  if (isEmail(metaEmail)) {
    return { method: "meta_tag", label: '<meta name="footnote:paypal">', email: metaEmail.trim().toLowerCase(), paypalMe: null, evidenceUrl: pageUrl };
  }

  const wk = await tryFetch(fetcher, new URL(".well-known/footnote.json", site.root).toString());
  if (wk) {
    const j = parseFootnoteJson(wk.body);
    if (j) return { method: "footnote_json", label: "/.well-known/footnote.json", email: j.email, paypalMe: j.paypalMe, evidenceUrl: wk.url };
  }

  for (const url of [...githubFundingUrls(pageUrl), new URL(".github/FUNDING.yml", site.root).toString()]) {
    const r = await tryFetch(fetcher, url);
    const f = r && parseFundingYml(r.body);
    if (f) return { method: "funding_yml", label: "GitHub FUNDING.yml", email: f.email, paypalMe: f.paypalMe, evidenceUrl: r!.url };
  }

  for (const href of parsed?.links ?? []) {
    const m = href.match(PAYPALME_RE);
    if (m) return { method: "paypal_me", label: "paypal.me link on page", email: null, paypalMe: m[1], evidenceUrl: pageUrl };
  }
  return NONE;
}

/** Whether a payee is auto-payable through the Payouts API (needs an email). */
export const isPayable = (p: Payee) => !!p.email;
