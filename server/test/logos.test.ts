import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { LOCAL_USER_ID } from "../src/auth/users.ts";
import { DEMO_LOGOS } from "../src/mail/demo-logos.ts";
import { bimiLocation, findIconLinks, logoDomain, mailFromDomain, SenderLogos, sniffImage } from "../src/mail/logos.ts";
import { FetchError, guardedLookup, httpsTransport, isBlockedAddress, makeSafeFetch, type SafeFetch, type Transport, type TransportResponse } from "../src/mail/safe-fetch.ts";
import { sanitizeSvg } from "../src/mail/svg.ts";
import type { AccountRow } from "../src/mail/store.ts";
import { addAccount, makeEnv, msg, type TestEnv } from "./helpers.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const GOOD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#336699"/></svg>`;
const PUBLIC_V4 = "9.9.9.9";

describe("logoDomain", () => {
  const cases: [string, string | null][] = [
    ["news@mail.brightfield.com", "brightfield.com"],
    ["a@email.brightfield.com", "brightfield.com"],
    ["a@e.em.send.news.brightfield.com", "brightfield.com"],
    ["a@BrightField.COM", "brightfield.com"],
    ["a@mail.brightfield.co.uk", "brightfield.co.uk"],
    ["a@brightfield.com.au", "brightfield.com.au"],
    ["a@news.brightfield.co.jp", "brightfield.co.jp"],
    ["a@shop.brightfield.com.br", "brightfield.com.br"],
    ["a@brightfield.co.nz", "brightfield.co.nz"],
    ["a@mail.brightfield.co.in", "brightfield.co.in"],
    ["a@brightfield.org.uk", "brightfield.org.uk"],
    ["a@tidewrack.news", "tidewrack.news"],
    ["a@tallyho.cloud", "tallyho.cloud"],
    ["a@bücher-beispiel.de", "xn--bcher-beispiel-gsb.de"],
    // personal providers
    ["a@gmail.com", null],
    ["a@googlemail.com", null],
    ["a@outlook.com", null],
    ["a@outlook.fr", null],
    ["a@hotmail.com", null],
    ["a@hotmail.co.uk", null],
    ["a@live.com", null],
    ["a@msn.com", null],
    ["a@yahoo.com", null],
    ["a@mail.yahoo.co.jp", null],
    ["a@icloud.com", null],
    ["a@me.com", null],
    ["a@mac.com", null],
    ["a@aol.com", null],
    ["a@proton.me", null],
    ["a@protonmail.com", null],
    ["a@pm.me", null],
    ["a@gmx.de", null],
    ["a@gmx.net", null],
    ["a@mail.com", null],
    ["a@fastmail.com", null],
    ["a@hey.com", null],
    ["a@yandex.ru", null],
    ["a@zoho.com", null],
    ["a@qq.com", null],
    ["a@163.com", null],
    ["a@tutanota.com", null],
    ["a@tuta.io", null],
    ["a@mail.gmail.com", null],
    // not fetchable
    ["a@192.0.2.1", null],
    ["a@[::1]", null],
    ["a@localhost", null],
    ["a@intranet", null],
    ["a@printer.local", null],
    ["a@box.internal", null],
    ["a@app.localhost", null],
    ["a@brightfield.example", null],
    ["a@brightfield.test", null],
    ["a@brightfield.invalid", null],
    ["a@co.uk", null],
    ["a@-bad-.com", null],
    ["a@bad_host.com", null],
    ["a@exa mple.com", null],
    ["a@", null],
    ["no-at-sign", null],
    ["@brightfield.com", null],
  ];
  for (const [email, expected] of cases) {
    test(`${email} -> ${expected}`, () => assert.equal(logoDomain(email), expected));
  }
});

describe("address blocklist", () => {
  const blocked = [
    "0.0.0.0", "0.255.255.255", "127.0.0.1", "127.255.255.254", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255",
    "192.168.0.1", "192.168.255.255", "169.254.0.1", "169.254.169.254", "100.64.0.1", "100.127.255.255", "192.0.0.1",
    "192.0.2.5", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.255", "240.0.0.1",
    "255.255.255.255", "192.88.99.1",
    "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "ff02::1", "ff00::", "::ffff:127.0.0.1", "::ffff:10.1.2.3",
    "::ffff:169.254.169.254", "::ffff:7f00:1", "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::808:808", "2002:7f00:1::1",
    "2002:0a00:0001::", "2002:c0a8:0101::1", "2001:db8::1", "2001:db8:abcd::", "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "2001:10::1", "3fff::1", "100::1", "5f00::1",
    // junk fails closed
    "", "not-an-ip", "256.1.1.1", "1.2.3", "1.2.3.4.5", "fe80::1%eth0", "1::2::3", "01.2.3.4",
  ];
  for (const ip of blocked) test(`blocks ${ip || "(empty)"}`, () => assert.equal(isBlockedAddress(ip), true));

  const allowed = [PUBLIC_V4, "1.0.0.1", "172.32.0.1", "172.15.255.255", "100.63.255.255", "100.128.0.1", "169.253.1.1", "198.17.0.1", "198.20.0.1", "223.255.255.254",
    "2606:4700:4700::1111", "2a00:1450:4001::1", "::ffff:9.9.9.9", "2002:0909:0909::1"];
  for (const ip of allowed) test(`allows ${ip}`, () => assert.equal(isBlockedAddress(ip), false));
});

describe("guarded lookup", () => {
  const ask = (resolve: Parameters<typeof guardedLookup>[0], options: object = {}) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }>((done) =>
      guardedLookup(resolve)("brightfield.com", options as never, (err, address, family) => done({ err, address, family })),
    );

  test("refuses a name that resolves to a private address, including when answers are mixed", async () => {
    const priv = await ask(async () => [{ address: "10.0.0.5", family: 4 }]);
    assert.equal(priv.err?.code, "EBLOCKED");
    const mixed = await ask(async () => [{ address: PUBLIC_V4, family: 4 }, { address: "169.254.169.254", family: 4 }], { all: true });
    assert.equal(mixed.err?.code, "EBLOCKED");
    const v6 = await ask(async () => [{ address: "::1", family: 6 }]);
    assert.equal(v6.err?.code, "EBLOCKED");
  });

  test("passes public answers in both callback shapes", async () => {
    const one = await ask(async () => [{ address: PUBLIC_V4, family: 4 }]);
    assert.equal(one.err, null);
    assert.equal(one.address, PUBLIC_V4);
    const all = await ask(async () => [{ address: PUBLIC_V4, family: 4 }], { all: true });
    assert.deepEqual(all.address, [{ address: PUBLIC_V4, family: 4 }]);
  });

  test("the real transport never connects to a rebinding name", async () => {
    const fetcher = makeSafeFetch(httpsTransport(async () => [{ address: "127.0.0.1", family: 4 }]));
    await assert.rejects(
      fetcher("https://rebind.brightfield.com/", { signal: AbortSignal.timeout(2000), maxBytes: 1000, accept: "image/*" }),
      (e: FetchError) => e.kind === "blocked",
    );
  });
});

// --- The fetcher, against a pretend network ----------------------------------------------------

function reply(status: number, body: Buffer | string = "", headers: Record<string, string> = {}): TransportResponse {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return {
    status,
    headers: { location: headers.location, "content-length": headers["content-length"] ?? String(buf.length) },
    body: (async function* () {
      yield buf;
    })(),
    close() {},
  };
}

function fakeTransport(routes: Record<string, () => TransportResponse | Promise<TransportResponse>>) {
  const seen: string[] = [];
  const transport: Transport = async (url) => {
    seen.push(url.href);
    const route = routes[url.href];
    if (!route) throw new Error(`no route for ${url.href}`);
    return route();
  };
  return { transport, seen };
}

const opts = (over: object = {}) => ({ signal: AbortSignal.timeout(5000), maxBytes: 1000, accept: "image/*", ...over });

describe("safe fetch", () => {
  test("fetches a plain https url", async () => {
    const { transport } = fakeTransport({ "https://brightfield.com/a.png": () => reply(200, PNG) });
    const res = await makeSafeFetch(transport)("https://brightfield.com/a.png", opts());
    assert.deepEqual(res.body, PNG);
  });

  test("refuses urls that are not plain https on 443 without credentials", async () => {
    const { transport, seen } = fakeTransport({});
    const get = makeSafeFetch(transport);
    for (const url of [
      "http://brightfield.com/a.png",
      "https://brightfield.com:8443/a.png",
      "https://brightfield.com:80/a.png",
      "https://user:pw@brightfield.com/a.png",
      "https://127.0.0.1/a.png",
      "https://[::1]/a.png",
      "https://2130706433/a.png",
      "https://0x7f.1/a.png",
      "https://printer.local/a.png",
      "https://localhost/a.png",
      "ftp://brightfield.com/a.png",
      "not a url",
    ]) {
      await assert.rejects(get(url, opts()), FetchError, url);
    }
    assert.deepEqual(seen, [], "nothing was requested");
  });

  test("follows up to three redirects and re-validates each", async () => {
    const hop = (to: string) => () => reply(302, "", { location: to });
    const { transport } = fakeTransport({
      "https://brightfield.com/1": hop("/2"),
      "https://brightfield.com/2": hop("https://cdn.brightfield.com/3"),
      "https://cdn.brightfield.com/3": hop("https://static.example-cdn.net/4"),
      "https://static.example-cdn.net/4": () => reply(200, PNG),
      "https://brightfield.com/loop": hop("/loop"),
    });
    const get = makeSafeFetch(transport);
    assert.deepEqual((await get("https://brightfield.com/1", opts())).body, PNG);
    await assert.rejects(get("https://brightfield.com/loop", opts()), (e: FetchError) => e.kind === "redirect" && /Too many/.test(e.message));
  });

  test("a redirect to a private or non-https target is refused before any request", async () => {
    for (const target of ["https://127.0.0.1/x", "https://169.254.169.254/latest/meta-data", "http://brightfield.com/x", "https://brightfield.com:9443/x", "https://metadata.internal/x", "https://[fd00::1]/x"]) {
      const { transport, seen } = fakeTransport({ "https://brightfield.com/start": () => reply(301, "", { location: target }) });
      await assert.rejects(makeSafeFetch(transport)("https://brightfield.com/start", opts()), FetchError, target);
      assert.deepEqual(seen, ["https://brightfield.com/start"], target);
    }
  });

  test("a redirect that leaves the allowed domain is refused", async () => {
    const { transport, seen } = fakeTransport({ "https://brightfield.com/": () => reply(302, "", { location: "https://elsewhere-example.net/" }) });
    const scoped = { allowHost: (h: string) => h === "brightfield.com" || h.endsWith(".brightfield.com") };
    await assert.rejects(makeSafeFetch(transport)("https://brightfield.com/", opts(scoped)), (e: FetchError) => e.kind === "redirect");
    assert.deepEqual(seen, ["https://brightfield.com/"]);
    // and a look-alike suffix is not a subdomain
    const lookalike = fakeTransport({ "https://brightfield.com/": () => reply(302, "", { location: "https://evilbrightfield.com/" }) });
    await assert.rejects(makeSafeFetch(lookalike.transport)("https://brightfield.com/", opts(scoped)), (e: FetchError) => e.kind === "redirect");
  });

  test("oversize responses are refused, by declared length and by actual bytes", async () => {
    const big = Buffer.alloc(5000, 7);
    const lying = (): TransportResponse => ({ status: 200, headers: { "content-length": "10" }, body: (async function* () { yield big; })(), close() {} });
    const { transport } = fakeTransport({ "https://brightfield.com/declared": () => reply(200, big), "https://brightfield.com/lying": lying });
    const get = makeSafeFetch(transport);
    await assert.rejects(get("https://brightfield.com/declared", opts()), (e: FetchError) => e.kind === "size");
    await assert.rejects(get("https://brightfield.com/lying", opts()), (e: FetchError) => e.kind === "size");
  });

  test("truncate keeps the first bytes and stops reading", async () => {
    let pulled = 0;
    const endless = (): TransportResponse => ({
      status: 200,
      headers: {},
      body: (async function* () {
        for (;;) {
          pulled += 1;
          yield Buffer.alloc(400, 65);
        }
      })(),
      close() {},
    });
    const { transport } = fakeTransport({ "https://brightfield.com/": endless });
    const res = await makeSafeFetch(transport)("https://brightfield.com/", opts({ truncate: true }));
    assert.equal(res.body.length, 1000);
    assert.equal(res.truncated, true);
    assert.equal(pulled, 3);
  });

  test("non-200 answers and an expired deadline fail", async () => {
    const { transport } = fakeTransport({ "https://brightfield.com/gone": () => reply(404) });
    const get = makeSafeFetch(transport);
    await assert.rejects(get("https://brightfield.com/gone", opts()), (e: FetchError) => e.kind === "status");
    const hang: Transport = (_url, { signal }) => new Promise((_ok, fail) => signal.addEventListener("abort", () => fail(new Error("aborted"))));
    await assert.rejects(makeSafeFetch(hang)("https://brightfield.com/", opts({ signal: AbortSignal.timeout(30) })), (e: FetchError) => e.kind === "timeout");
  });
});

describe("image sniffing", () => {
  const pad = (head: number[], to = 32) => Buffer.concat([Buffer.from(head), Buffer.alloc(to, 0x20)]);
  test("accepts PNG, JPEG, GIF, WebP and ICO by their magic numbers", () => {
    assert.equal(sniffImage(PNG)?.contentType, "image/png");
    assert.equal(sniffImage(pad([0xff, 0xd8, 0xff, 0xe0]))?.contentType, "image/jpeg");
    assert.equal(sniffImage(Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(20)]))?.contentType, "image/gif");
    assert.equal(sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(20)]))?.contentType, "image/webp");
    const ico = Buffer.alloc(6 + 16 + 10);
    ico.writeUInt16LE(1, 2);
    ico.writeUInt16LE(1, 4);
    assert.equal(sniffImage(ico)?.contentType, "image/x-icon");
  });

  test("rejects HTML, text, scripts and truncated headers whatever the server called them", () => {
    assert.equal(sniffImage(Buffer.from("<!doctype html><html><body>Not an image at all</body></html>")), null);
    assert.equal(sniffImage(Buffer.from("alert('hi'); // pretend this is a png ".repeat(3))), null);
    assert.equal(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47])), null);
    assert.equal(sniffImage(Buffer.alloc(64)), null, "ico header with zero entries");
    assert.equal(sniffImage(Buffer.concat([Buffer.from("<svg>"), Buffer.alloc(30)])), null, "binary junk in an svg");
  });

  test("svg is accepted only after sanitizing", () => {
    const out = sniffImage(Buffer.from(`<svg viewBox="0 0 1 1" onload="alert(1)"><script>alert(1)</script><rect width="1" height="1"/></svg>`));
    assert.equal(out?.contentType, "image/svg+xml");
    assert.ok(!/script|onload/.test(out!.bytes.toString()));
    assert.equal(sniffImage(Buffer.from(`<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>`)), null, "nothing drawable is left");
  });
});

describe("svg sanitizer", () => {
  const hostile: [string, string][] = [
    ["script element", `<svg><script>alert(1)</script><rect width="5" height="5"/></svg>`],
    ["script with entities", `<svg><script>alert&#40;1&#41;</script><rect width="5" height="5"/></svg>`],
    ["onload handler", `<svg onload="alert(1)"><rect width="5" height="5"/></svg>`],
    ["onclick and onmouseover on shapes", `<svg><rect width="5" height="5" onclick="alert(1)" onmouseover="alert(2)" OnFocus="x"/></svg>`],
    ["foreignObject with html", `<svg><foreignObject><iframe src="https://track.invalid/x"></iframe><img src="x" onerror="alert(1)"></foreignObject><rect width="5" height="5"/></svg>`],
    ["external href on use", `<svg><use href="https://track.invalid/x.svg#a"/><rect width="5" height="5"/></svg>`],
    ["external xlink:href", `<svg><use xlink:href="https://track.invalid/x.svg#a"/><rect width="5" height="5"/></svg>`],
    ["javascript href", `<svg><a href="javascript:alert(1)"><rect width="5" height="5"/></a></svg>`],
    ["data href", `<svg><use href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="/><rect width="5" height="5"/></svg>`],
    ["image element", `<svg><image href="https://track.invalid/p.png"/><rect width="5" height="5"/></svg>`],
    ["style @import", `<svg><style>@import url(https://track.invalid/a.css);</style><rect width="5" height="5"/></svg>`],
    ["style with url()", `<svg><style>rect{fill:url(https://track.invalid/a)}</style><rect width="5" height="5"/></svg>`],
    ["style attribute with url()", `<svg><rect width="5" height="5" style="fill:url(https://track.invalid/a)"/></svg>`],
    ["style attribute with import", `<svg><rect width="5" height="5" style="@import 'https://track.invalid/a.css'"/></svg>`],
    ["fill with external url", `<svg><rect width="5" height="5" fill="url(https://track.invalid/a#g)"/></svg>`],
    ["animate setting an href", `<svg><a><animate attributeName="href" values="javascript:alert(1)"/></a><set attributeName="href" to="javascript:alert(1)"/><rect width="5" height="5"/></svg>`],
    ["doctype with entities", `<!DOCTYPE svg [<!ENTITY a "&#60;script&#62;alert(1)&#60;/script&#62;">]><svg><rect width="5" height="5"/></svg>`],
    ["cdata script", `<svg><![CDATA[<script>alert(1)</script>]]><rect width="5" height="5"/></svg>`],
    ["text elements", `<svg><text>tracking words</text><rect width="5" height="5"/></svg>`],
  ];
  for (const [name, input] of hostile) {
    test(`strips ${name}`, () => {
      const out = sanitizeSvg(input);
      assert.ok(out === null || out.startsWith("<svg"));
      const text = out ?? "";
      assert.ok(!/<script|<foreignObject|<style|<image|<iframe|<animate|<set|<a[\s>]|<text|on\w+=|javascript:|data:|@import|track\.invalid|alert\(|CDATA|tracking words/i.test(text), text);
      // every href that survives is a same-document reference
      for (const m of text.matchAll(/href="([^"]*)"/g)) assert.match(m[1]!, /^#/);
      assert.ok(text.includes("<rect"), "the drawing survives");
    });
  }

  test("keeps ordinary logo drawing, same-document references and plain presentation styles", () => {
    const out = sanitizeSvg(
      `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient><path id="p" d="M0 0h4v4z"/></defs><rect width="10" height="10" fill="url(#g)"/><use href="#p" x="2" style="fill:#fff;stroke:none"/><circle cx="5" cy="5" r="2" fill="#ffffff" opacity=".5"/></svg>`,
    )!;
    for (const part of ["viewBox=\"0 0 10 10\"", "<linearGradient", "<stop", "fill=\"url(#g)\"", "href=\"#p\"", "<circle", "fill:#fff"]) assert.ok(out.includes(part), `${part} in ${out}`);
    assert.ok(out.includes('xmlns="http://www.w3.org/2000/svg"'));
  });

  test("returns null for non-svg input", () => {
    assert.equal(sanitizeSvg("<html><body>hi</body></html>"), null);
    assert.equal(sanitizeSvg(""), null);
  });
});

describe("icon discovery", () => {
  const base = new URL("https://www.brightfield.com/shop/");
  test("prefers apple-touch-icon, then the largest declared size, and resolves relative links", () => {
    const html = `<head>
      <link rel="icon" href="/favicon-16.png" sizes="16x16">
      <link rel="shortcut icon" href="favicon.ico">
      <link rel="icon" type="image/png" sizes="96x96" href="https://cdn.brightfield-assets.net/96.png">
      <link rel='apple-touch-icon' sizes='180x180' href='/apple.png'>
      <link rel="mask-icon" href="/mask.svg">
      <link rel="icon" href="http://brightfield.com/insecure.png">
      <link rel="stylesheet" href="/site.css">
    </head>`;
    assert.deepEqual(
      findIconLinks(html, base).map((l) => l.url.href),
      ["https://www.brightfield.com/apple.png", "https://cdn.brightfield-assets.net/96.png", "https://www.brightfield.com/favicon-16.png", "https://www.brightfield.com/shop/favicon.ico"],
    );
  });

  test("BIMI records need an https logo location", () => {
    assert.equal(bimiLocation([["v=BIMI1; l=https://brightfield.com/logo.svg; a=https://brightfield.com/vmc.pem"]]), "https://brightfield.com/logo.svg");
    assert.equal(bimiLocation([["v=BIMI1;", " l=https://brightfield.com/logo.svg"]]), "https://brightfield.com/logo.svg");
    assert.equal(bimiLocation([["v=BIMI1; l=http://brightfield.com/logo.svg"]]), null);
    assert.equal(bimiLocation([["v=BIMI1; l="]]), null);
    assert.equal(bimiLocation([["v=spf1 -all"]]), null);
  });
});

// --- The service and the route -----------------------------------------------------------------

interface Web {
  safeFetch: SafeFetch;
  calls: string[];
  /** Pages and images by URL; an Error value answers like that failure. */
  routes: Record<string, Buffer | string | FetchError>;
}
function fakeWeb(routes: Web["routes"] = {}): Web {
  const web: Web = {
    calls: [],
    routes,
    safeFetch: async (url) => {
      const href = String(url);
      web.calls.push(href);
      const hit = web.routes[href];
      if (hit === undefined) throw new FetchError("status", "Answered 404");
      if (hit instanceof FetchError) throw hit;
      return { url: new URL(href), body: Buffer.from(hit), truncated: false };
    },
  };
  return web;
}
const noBimi = async () => {
  throw Object.assign(new Error("no record"), { code: "ENODATA" });
};

function makeService(env: TestEnv, web: Web, over: { resolveTxt?: (n: string) => Promise<string[][]>; now?: () => number } = {}) {
  const scheduled: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const logos = new SenderLogos(env.ctx, {
    safeFetch: web.safeFetch,
    resolveTxt: over.resolveTxt ?? noBimi,
    delayMs: () => 2 * 3_600_000,
    schedule: (fn, ms) => {
      const entry = { fn, ms, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    now: over.now,
  });
  return { logos, scheduled };
}

describe("sender logo service", () => {
  let env: TestEnv;
  before(() => {
    env = makeEnv();
  });
  after(() => env.cleanup());

  test("BIMI first, then the page icon, then favicon.ico", async () => {
    const web = fakeWeb({
      "https://bimi.brightfield.com/logo.svg": GOOD_SVG,
      "https://page.brightfield.com/": `<link rel="icon" href="/i.png"><link rel="apple-touch-icon" href="/a.png">`,
      "https://page.brightfield.com/a.png": PNG,
      "https://fav.brightfield.com/": "<html>no icons</html>",
      "https://fav.brightfield.com/favicon.ico": Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.alloc(40)]),
    });
    const { logos } = makeService(env, web, {
      resolveTxt: async (name) => {
        if (name === "default._bimi.bimi.brightfield.com") return [["v=BIMI1; l=https://bimi.brightfield.com/logo.svg"]];
        throw Object.assign(new Error("no record"), { code: "ENODATA" });
      },
    });
    await logos.fetchNow("bimi.brightfield.com");
    await logos.fetchNow("page.brightfield.com");
    await logos.fetchNow("fav.brightfield.com");
    const rows = env.ctx.db.all<{ domain: string; status: string; source: string; content_type: string }>("SELECT domain, status, source, content_type FROM sender_logos ORDER BY domain");
    assert.deepEqual(
      rows.map((r) => [r.domain, r.status, r.source, r.content_type]),
      [
        ["bimi.brightfield.com", "found", "bimi", "image/svg+xml"],
        ["fav.brightfield.com", "found", "favicon", "image/x-icon"],
        ["page.brightfield.com", "found", "icon", "image/png"],
      ],
    );
    assert.ok(!web.calls.includes("https://page.brightfield.com/i.png"), "the apple-touch-icon was enough");
  });

  test("a BIMI answer that is not an svg is ignored", async () => {
    const web = fakeWeb({ "https://bimi2.brightfield.com/logo.png": PNG });
    const { logos } = makeService(env, web, { resolveTxt: async () => [["v=BIMI1; l=https://bimi2.brightfield.com/logo.png"]] });
    await logos.fetchNow("bimi2.brightfield.com");
    assert.equal(env.ctx.db.get<{ status: string }>("SELECT status FROM sender_logos WHERE domain = 'bimi2.brightfield.com'")!.status, "none");
  });

  test("falls back to www when the bare domain does not answer, and tells the fetcher to stay on the domain", async () => {
    const scopes: boolean[] = [];
    const web = fakeWeb({ "https://www.wwwonly.com/": `<link rel="icon" href="/x.png">`, "https://www.wwwonly.com/x.png": PNG });
    const inner = web.safeFetch;
    web.safeFetch = (url, o) => {
      if (String(url).endsWith("/")) scopes.push(Boolean(o.allowHost?.("evil.net")));
      return inner(url, o);
    };
    const { logos } = makeService(env, web);
    await logos.fetchNow("wwwonly.com");
    assert.equal(env.ctx.db.get<{ status: string }>("SELECT status FROM sender_logos WHERE domain = 'wwwonly.com'")!.status, "found");
    assert.deepEqual(scopes, [false, false], "pages may only redirect within the domain");
  });

  test("a hostile svg icon is stored sanitized", async () => {
    const web = fakeWeb({
      "https://evilsvg.com/": `<link rel="icon" href="/i.svg">`,
      "https://evilsvg.com/i.svg": `<svg viewBox="0 0 1 1" onload="alert(1)"><script>alert(1)</script><rect width="1" height="1"/></svg>`,
    });
    const { logos } = makeService(env, web);
    await logos.fetchNow("evilsvg.com");
    const row = env.ctx.db.get<{ blob_sha256: string }>("SELECT blob_sha256 FROM sender_logos WHERE domain = 'evilsvg.com'")!;
    const stored = env.ctx.store.readBlob(row.blob_sha256)!.toString();
    assert.ok(stored.includes("<rect") && !/script|onload/.test(stored));
  });

  test("concurrent requests for one domain share a single fetch", async () => {
    const web = fakeWeb({ "https://shared.com/": `<link rel="icon" href="/i.png">`, "https://shared.com/i.png": PNG });
    const { logos } = makeService(env, web);
    await Promise.all([logos.fetchNow("shared.com"), logos.fetchNow("shared.com"), logos.fetchNow("shared.com")]);
    assert.equal(web.calls.filter((c) => c === "https://shared.com/").length, 1);
  });

  test("at most four domains are fetched at once", async () => {
    let active = 0;
    let peak = 0;
    const web = fakeWeb();
    web.safeFetch = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active -= 1;
      throw new FetchError("status", "Answered 404");
    };
    const { logos } = makeService(env, web);
    await Promise.all(Array.from({ length: 12 }, (_, i) => logos.fetchNow(`crowd${i}.com`)));
    assert.equal(peak, 4);
  });

  test("a miss is remembered for a week; an unreachable network is retried within the hour", async () => {
    let now = 1_000_000_000_000;
    const web = fakeWeb();
    const { logos } = makeService(env, web, { now: () => now });
    await logos.fetchNow("quiet.com");
    const scheduleBefore = web.calls.length;
    // fresh 'none' within a week: no new fetch is queued
    now += 6 * 24 * 3_600_000;
    assert.equal(logos.cached("quiet.com", LOCAL_USER_ID), null);
    // after a week it is queued again
    const second = makeService(env, web, { now: () => now + 2 * 24 * 3_600_000 });
    assert.equal(second.logos.cached("quiet.com", LOCAL_USER_ID), null);
    assert.equal(second.scheduled.length, 1);
    assert.ok(web.calls.length === scheduleBefore, "cached() itself never fetches");

    const offline = fakeWeb();
    offline.safeFetch = async () => {
      throw new FetchError("network", "offline");
    };
    const t = makeService(env, offline, { now: () => now, resolveTxt: async () => { throw Object.assign(new Error("x"), { code: "ECONNREFUSED" }); } });
    await t.logos.fetchNow("offline.com");
    const later = makeService(env, offline, { now: () => now + 2 * 3_600_000 });
    later.logos.cached("offline.com", LOCAL_USER_ID);
    assert.equal(later.scheduled.length, 1, "retried after about an hour, not a week");
    const soon = makeService(env, offline, { now: () => now + 600_000 });
    soon.logos.cached("offline.com", LOCAL_USER_ID);
    assert.equal(soon.scheduled.length, 0, "not hammered in the meantime");
  });

  test("a found logo is reused for 30 days and kept when the refresh finds nothing", async () => {
    let now = 2_000_000_000_000;
    const web = fakeWeb({ "https://keeper.com/": `<link rel="icon" href="/i.png">`, "https://keeper.com/i.png": PNG });
    const { logos } = makeService(env, web, { now: () => now });
    await logos.fetchNow("keeper.com");
    now += 29 * 24 * 3_600_000;
    const fresh = makeService(env, web, { now: () => now });
    assert.ok(fresh.logos.cached("keeper.com", LOCAL_USER_ID));
    assert.equal(fresh.scheduled.length, 0);
    now += 2 * 24 * 3_600_000;
    const stale = makeService(env, fakeWeb(), { now: () => now });
    assert.ok(stale.logos.cached("keeper.com", LOCAL_USER_ID), "a stale logo is still served while it refreshes");
    assert.equal(stale.scheduled.length, 1);
    await stale.logos.fetchNow("keeper.com");
    assert.ok(stale.logos.cached("keeper.com", LOCAL_USER_ID), "the old logo survives a refresh that finds nothing");
  });
});

describe("GET /api/logos/:domain", () => {
  let env: TestEnv;
  let web: Web;
  let scheduled: { fn: () => void; ms: number }[];
  let realAccount: AccountRow;
  const setLogos = (value: boolean | null) => {
    env.ctx.db.run("DELETE FROM settings WHERE user_id = ? AND key = 'senderLogos'", LOCAL_USER_ID);
    if (value !== null) env.ctx.db.run("INSERT INTO settings (user_id, key, value) VALUES (?, 'senderLogos', ?)", LOCAL_USER_ID, JSON.stringify(value));
  };
  const get = (domain: string, headers: Record<string, string> = {}) => env.api(`/api/logos/${domain}`, { headers });

  before(() => {
    env = makeEnv();
    web = fakeWeb({
      "https://brightfield.com/": `<link rel="icon" href="/i.png">`,
      "https://brightfield.com/i.png": PNG,
      "https://svgco.com/": `<link rel="icon" href="/i.svg">`,
      "https://svgco.com/i.svg": `<svg viewBox="0 0 1 1" onload="x()"><script>x()</script><rect width="1" height="1"/></svg>`,
    });
    const made = makeService(env, web);
    env.ctx.logos = made.logos;
    scheduled = made.scheduled;
    realAccount = env.ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", addAccount(env.ctx, LOCAL_USER_ID, "me@work.test", "imap"))!;
    const demoAccount = env.ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", addAccount(env.ctx, LOCAL_USER_ID, "me@demo.test", "demo"))!;
    env.ctx.store.ingest(realAccount, {
      messages: [
        msg({ from: { name: "Bright", email: "news@mail.brightfield.com" }, remoteThreadId: "r1" }),
        msg({ from: { name: "Mixed", email: "hello@mixed-sender.com" }, remoteThreadId: "r2" }),
        msg({ from: { name: "Vector", email: "hi@svgco.com" }, remoteThreadId: "r3" }),
      ],
      cursor: null,
      done: true,
    });
    env.ctx.store.ingest(demoAccount, {
      messages: [
        msg({ from: { name: "Salt", email: "hello@saltmarrow.com" }, remoteThreadId: "d1" }),
        msg({ from: { name: "Mixed", email: "hello@mixed-sender.com" }, remoteThreadId: "d2" }),
        msg({ from: { name: "Nobody", email: "hello@uninvented-demo.com" }, remoteThreadId: "d3" }),
        msg({ from: { name: "Mail", email: "friend@gmail.com" }, remoteThreadId: "d4" }),
      ],
      cursor: null,
      done: true,
    });
  });
  after(() => env.cleanup());

  test("mailFromDomain separates real from demo mail", () => {
    const db = env.ctx.db;
    assert.deepEqual(mailFromDomain(db, LOCAL_USER_ID, "brightfield.com"), { any: true, allDemo: false });
    assert.deepEqual(mailFromDomain(db, LOCAL_USER_ID, "saltmarrow.com"), { any: true, allDemo: true });
    assert.deepEqual(mailFromDomain(db, LOCAL_USER_ID, "mixed-sender.com"), { any: true, allDemo: false });
    assert.deepEqual(mailFromDomain(db, LOCAL_USER_ID, "never-heard.com"), { any: false, allDemo: false });
    assert.deepEqual(mailFromDomain(db, LOCAL_USER_ID, "field.com"), { any: false, allDemo: false }, "a suffix of the name is not a subdomain");
  });

  test("a domain nobody wrote to you from is a 404 and nothing is fetched or scheduled", async () => {
    setLogos(true);
    for (const domain of ["never-heard.com", "field.com", "gmail.com", "127.0.0.1", "localhost", "a.b.brightfield.com", "co.uk"]) {
      assert.equal((await get(domain)).status, 404, domain);
    }
    assert.deepEqual(web.calls, []);
    assert.deepEqual(scheduled, []);
  });

  test("logos are off until the person turns them on: no fetch and nothing scheduled", async () => {
    setLogos(null);
    assert.equal((await get("brightfield.com")).status, 404);
    setLogos(false);
    assert.equal((await get("brightfield.com")).status, 404);
    assert.deepEqual(web.calls, []);
    assert.deepEqual(scheduled, []);
  });

  test("the server switch overrides the person", async () => {
    setLogos(true);
    env.ctx.config.senderLogos = false;
    try {
      assert.equal((await get("brightfield.com")).status, 404);
      assert.equal((await get("saltmarrow.com")).status, 404);
    } finally {
      env.ctx.config.senderLogos = true;
    }
    assert.deepEqual(web.calls, []);
    assert.deepEqual(scheduled, []);
  });

  test("cross-site loads are refused", async () => {
    setLogos(true);
    assert.equal((await get("saltmarrow.com", { "sec-fetch-site": "cross-site" })).status, 404);
    assert.equal((await get("saltmarrow.com", { "sec-fetch-site": "same-site" })).status, 404);
    assert.equal((await get("saltmarrow.com", { "sec-fetch-site": "same-origin" })).status, 200);
  });

  test("an agent token cannot use it, like the other browser-only read routes", async () => {
    const { token } = env.ctx.agents.create(LOCAL_USER_ID, "Reader", ["read"]);
    const res = await env.api("/api/logos/saltmarrow.com", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 403);
  });

  test("demo domains are served from the bundle with no network, even when the setting is unset", async () => {
    for (const setting of [null, true]) {
      setLogos(setting);
      const res = await get("saltmarrow.com");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "image/svg+xml");
      assert.equal(await res.text(), DEMO_LOGOS["saltmarrow.com"]);
    }
    setLogos(false);
    assert.equal((await get("saltmarrow.com")).status, 404, "an explicit off is honored");
    assert.deepEqual(web.calls, []);
    assert.deepEqual(scheduled, []);
  });

  test("a demo-only domain without a bundled mark is a 404 and is never fetched", async () => {
    setLogos(true);
    assert.equal((await get("uninvented-demo.com")).status, 404);
    assert.deepEqual(scheduled, []);
  });

  test("all five invented demo marks are plain, safe svg", () => {
    assert.deepEqual(Object.keys(DEMO_LOGOS).sort(), ["pinecrestair.com", "quarrystonebank.com", "saltmarrow.com", "tallyho.cloud", "tidewrack.news"]);
    for (const [domain, svg] of Object.entries(DEMO_LOGOS)) {
      assert.ok(sanitizeSvg(svg), domain);
      assert.ok(!/<text|<script|href=|url\(/i.test(svg), domain);
    }
  });

  test("an uncached domain answers 404 now, is fetched hours later, and then is served from the cache", async () => {
    setLogos(true);
    const first = await get("brightfield.com");
    assert.equal(first.status, 404);
    assert.deepEqual(web.calls, [], "nothing fetched while the request waits");
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0]!.ms, 2 * 3_600_000, "the delay comes from the injected source");

    assert.equal((await get("brightfield.com")).status, 404);
    assert.equal(scheduled.length, 1, "asking again does not queue a second fetch");

    scheduled[0]!.fn();
    await env.ctx.logos.fetchNow("brightfield.com"); // joins the fetch the timer started
    assert.equal(web.calls.filter((c) => c === "https://brightfield.com/").length, 1);

    const res = await get("brightfield.com");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("content-security-policy"), "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    assert.equal(res.headers.get("cache-control"), "private, max-age=604800");
    assert.equal(res.headers.get("content-disposition"), "inline");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
    assert.equal(scheduled.length, 1);
  });

  test("a scheduled fetch is dropped if the person switched logos off meanwhile", async () => {
    setLogos(true);
    const before = web.calls.length;
    assert.equal((await get("mixed-sender.com")).status, 404);
    const job = scheduled[scheduled.length - 1]!;
    setLogos(false);
    job.fn();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(web.calls.length, before);
  });

  test("a stored svg is served sanitized, as svg, with the locked-down headers", async () => {
    setLogos(true);
    assert.equal((await get("svgco.com")).status, 404);
    await env.ctx.logos.fetchNow("svgco.com");
    const res = await get("svgco.com");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/svg+xml");
    assert.equal(res.headers.get("content-security-policy"), "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    const body = await res.text();
    assert.ok(body.includes("<rect") && !/script|onload/.test(body));
  });
});
