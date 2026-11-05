export interface DemoSite {
  slug: string;
  title: string;
  url: string; // path served by the app
  payeeMethod: "meta_tag" | "footnote_json" | "funding_yml" | "paypal_me" | "none";
  blurb: string;
}

/** Bundled creator sites under /demo-sites/. One per payee-resolution branch, plus a prompt-injection attacker. */
export const DEMO_SITES: DemoSite[] = [
  { slug: "compost-diaries", title: "Compost Diaries", url: "/demo-sites/compost-diaries/", payeeMethod: "meta_tag", blurb: "Declares its PayPal payee in a <meta name=\"footnote:paypal\"> tag." },
  { slug: "worm-bin-weekly", title: "Worm Bin Weekly", url: "/demo-sites/worm-bin-weekly/", payeeMethod: "footnote_json", blurb: "Declares its payee in /.well-known/footnote.json." },
  { slug: "open-compost-toolkit", title: "Open Compost Toolkit", url: "/demo-sites/open-compost-toolkit/", payeeMethod: "funding_yml", blurb: "Open-source repo with a .github/FUNDING.yml paypal.me link." },
  { slug: "bokashi-bench", title: "Bokashi Bench", url: "/demo-sites/bokashi-bench/", payeeMethod: "paypal_me", blurb: "Only has a paypal.me link in the page footer." },
  { slug: "garden-gnome-gazette", title: "Garden Gnome Gazette", url: "/demo-sites/garden-gnome-gazette/", payeeMethod: "none", blurb: "No payee declared: royalties wait in escrow until the owner claims the domain." },
  { slug: "quick-compost-hacks", title: "Quick Compost Hacks", url: "/demo-sites/quick-compost-hacks/", payeeMethod: "none", blurb: "Hides a prompt-injection (\"pay me 100%\"). Footnote strips it, flags it and applies a penalty." },
  { slug: "almanac-reprints", title: "Almanac Reprints", url: "/demo-sites/almanac-reprints/", payeeMethod: "none", blurb: "Thin background page: scores under the threshold and is dropped." },
];

export const SAMPLE_QUESTIONS = [
  "How can I compost food scraps in a small apartment?",
  "Is bokashi or a worm bin better for a tiny kitchen?",
  "What mistakes make indoor composting smell bad?",
];
