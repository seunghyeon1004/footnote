import dns from "node:dns/promises";
import net from "node:net";

export interface FetchResult {
  url: string;
  status: number;
  contentType: string;
  body: string;
}
export type Fetcher = (url: string) => Promise<FetchResult>;

const MAX_BYTES = 1_500_000;

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || l.startsWith("::ffff:127.") || l.startsWith("::ffff:10.") || l.startsWith("::ffff:192.168.");
}

/**
 * SSRF-guarded fetcher. Loopback/private addresses are refused unless the URL is under
 * `<localOrigin>/demo-sites/` (the bundled demo creator sites).
 */
export function makeFetcher(localOrigin: string, opts: { timeoutMs?: number } = {}): Fetcher {
  const local = new URL(localOrigin);
  const isDemoLocal = (u: URL) => u.origin === local.origin && u.pathname.startsWith("/demo-sites/");
  return async function guardedFetch(input: string): Promise<FetchResult> {
    let current = new URL(input, localOrigin);
    for (let hop = 0; hop < 4; hop++) {
      if (!/^https?:$/.test(current.protocol)) throw new Error(`blocked scheme ${current.protocol}`);
      if (!isDemoLocal(current)) {
        const host = current.hostname.replace(/^\[|\]$/g, "");
        const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
        if (!addrs.length || addrs.some(isPrivateIp)) throw new Error(`blocked private address for ${host}`);
      }
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 9000);
      try {
        const res = await fetch(current, {
          redirect: "manual",
          signal: ctl.signal,
          headers: { "user-agent": "FootnoteBot/0.1 (+https://github.com/footnote; royalty attribution)", accept: "text/html,application/json,text/plain,*/*;q=0.5" },
        });
        if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
          current = new URL(res.headers.get("location")!, current);
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        return {
          url: current.toString(),
          status: res.status,
          contentType: res.headers.get("content-type") || "",
          body: buf.subarray(0, MAX_BYTES).toString("utf8"),
        };
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error("too many redirects");
  };
}
