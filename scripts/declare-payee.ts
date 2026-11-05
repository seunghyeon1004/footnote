/* Demo helper: act as the owner of a demo site and publish (or remove) a footnote:paypal declaration.
 *   npx tsx scripts/declare-payee.ts garden-gnome-gazette owner@example.com
 *   npx tsx scripts/declare-payee.ts garden-gnome-gazette --undo
 */
import fs from "node:fs";
import path from "node:path";
const [slug, arg] = process.argv.slice(2);
if (!slug || !arg) { console.error("usage: declare-payee <slug> <email|--undo>"); process.exit(1); }
const file = path.resolve("demo-sites", slug, "index.html");
let html = fs.readFileSync(file, "utf8");
html = html.replace(/<meta name="footnote:paypal"[^>]*>\n?/g, "");
if (arg !== "--undo") {
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(arg)) { console.error("not an email"); process.exit(1); }
  html = html.replace("<title>", `<meta name="footnote:paypal" content="${arg}">\n<title>`);
}
fs.writeFileSync(file, html);
console.log(arg === "--undo" ? `removed payee declaration from ${slug}` : `${slug} now declares ${arg}`);
