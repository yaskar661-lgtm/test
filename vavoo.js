const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const VER = "3.1.4";

const SUPPORTED_HOSTS = ["vavoo.to", "geil.to", "kool.to"];

let _sig = null;
let _exp = 0;
const _dns = new Map();

function getSourceOrigin(targetUrl) {
  try {
    const u = new URL(targetUrl);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    for (const h of SUPPORTED_HOSTS) {
      if (host === h || host.endsWith("." + h)) {
        return `https://${h}`;
      }
    }
    return `${u.protocol}//${u.hostname}`;
  } catch (_) {
    return "https://vavoo.to";
  }
}

function normalizeTargetUrl(rawTarget) {
  let url = rawTarget.trim();
  const match = url.match(/\/play\/([^/?#]+)/);

  if (match && !/\/live\/play\//i.test(url)) {
    const origin = getSourceOrigin(url);
    if (origin.includes("vavoo.to")) {
      url = `https://vavoo.to/vavoo-iptv/play/${match[1]}`;
    } else if (!/^https?:\/\//i.test(url)) {
      url = `${origin}/vavoo-iptv/play/${match[1]}`;
    }
  }

  return url;
}

async function resolveIp(host) {
  if (!host || /^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return host;
  if (_dns.has(host)) return _dns.get(host);

  try {
    const res = await fetch(`https://1.1.1.1/dns-query?name=${encodeURIComponent(host)}&type=A`, {
      headers: { "Accept": "application/dns-json" }
    });
    if (res.ok) {
      const json = await res.json();
      const a = json?.Answer?.find(x => x.type === 1);
      if (a?.data) {
        _dns.set(host, a.data);
        return a.data;
      }
    }
  } catch (_) {}
  return host;
}

async function transformUrl(rawUrl, useDnsIp = false) {
  if (!useDnsIp) return rawUrl;

  try {
    const u = new URL(rawUrl);
    if (u.protocol === "https:") {
      // HTTPS + CDN/SNI ortamlarda IP ile yönlendirme sertifika hatası verebilir
      return rawUrl;
    }
    const ip = await resolveIp(u.hostname);
    if (ip && ip !== u.hostname) {
      u.hostname = ip;
      return u.toString();
    }
  } catch (_) {}
  return rawUrl;
}

async function getSig(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _sig && now < _exp) return _sig;

  const endpoints = [
    "https://www.vypn.net/api/app/ping",
    "https://cache.vypn.net/api/app/ping",
    "https://www.vavoo.tv/api/app/ping"
  ];

  const payload = {
    reason: "app-focus",
    locale: "en",
    theme: "dark",
    metadata: {
      device: { type: "desktop", uniqueId: crypto.randomUUID() },
      os: { name: "win32", version: "Windows 10 Pro", abis: ["x64"], host: "Lenovo" },
      app: { platform: "electron" },
      version: { package: "net.vypn.app", binary: "3.1.0", js: "3.1.0" }
    },
    appFocusTime: 0,
    playerActive: false,
    playDuration: 0,
    devMode: false,
    hasAddon: true,
    castConnected: false,
    package: "net.vypn.app",
    version: "3.1.0",
    process: "app",
    firstAppStart: now,
    lastAppStart: now,
    ipLocation: null,
    adblockEnabled: true,
    proxy: { supported: ["ss"], engine: "Mu", enabled: false, autoServer: true },
    iap: { supported: false }
  };

  for (const ep of endpoints) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(ep, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Content-Type": "application/json; charset=utf-8",
          "Accept": "*/*"
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (res.ok) {
        const d = await res.json();
        const s = d?.sig || d?.addonSig || d?.signature || d?.token;
        if (s) {
          _sig = s;
          _exp = now + 900000;
          return s;
        }
      }
    } catch (_) {}
  }

  return _sig;
}

function extractUrlFromResponse(data) {
  if (!data) return null;
  if (typeof data === "string") {
    return data.startsWith("http") ? data : null;
  }
  if (Array.isArray(data) && data.length > 0) {
    return extractUrlFromResponse(data[0]);
  }
  return data.url || data.streamUrl || data.m3u8 || data.data?.url || data.js?.url || null;
}

async function isLikelyM3u8(candidateUrl, headers) {
  if (!candidateUrl || typeof candidateUrl !== "string") return false;
  if (/\.m3u8(\?|$)/i.test(candidateUrl)) return true;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(candidateUrl, {
      method: "GET",
      headers: {
        "User-Agent": headers["User-Agent"] || UA,
        "Referer": headers["Referer"] || "https://vavoo.to/",
        "Range": "bytes=0-256"
      },
      signal: controller.signal
    });
    clearTimeout(timer);

    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("mpegurl") || ct.includes("m3u8")) return true;

    const text = await res.text();
    if (text.trimStart().startsWith("#EXTM3U")) return true;
  } catch (_) {}

  return false;
}

async function resolveStream(rawTarget, sig, clientIp, region = "AT", language = "de") {
  const sourceOrigin = getSourceOrigin(rawTarget);
  const normalizedUrl = normalizeTargetUrl(rawTarget);

  const baseHeaders = {
    "User-Agent": UA,
    "Accept": "*/*",
    "Accept-Language": language,
    "Referer": `${sourceOrigin}/`,
    "Origin": sourceOrigin,
    "Content-Type": "application/json; charset=utf-8"
  };

  if (sig) baseHeaders["mediahubmx-signature"] = sig;
  if (clientIp) {
    baseHeaders["X-Forwarded-For"] = clientIp;
    baseHeaders["X-Real-IP"] = clientIp;
    baseHeaders["CF-Connecting-IP"] = clientIp;
  }

  // 1) /live/play/ akışı için v2 resolve uç noktaları
  if (/\/live\/play\//i.test(normalizedUrl)) {
    const v2Bases = [
      sourceOrigin,
      "https://geil.to",
      "https://kool.to",
      "https://kool.ws",
      "https://vavoo.net",
      "https://voltop.net"
    ];
    const uniqueV2 = [...new Set(v2Bases)];

    for (const base of uniqueV2) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(`${base}/live/resolve?url=${encodeURIComponent(normalizedUrl)}`, {
          headers: {
            "User-Agent": UA,
            "Accept": "application/json",
            "Referer": `${base}/`,
            "Origin": base
          },
          signal: controller.signal
        });
        clearTimeout(timer);

        if (res.ok) {
          const d = await res.json();
          const candidate = extractUrlFromResponse(d);
          if (candidate && await isLikelyM3u8(candidate, baseHeaders)) {
            return candidate;
          }
        }
      } catch (_) {}
    }
  }

  // 2) mediahubmx-resolve.json akışı (vavoo.to, geil.to, kool.to)
  const v1Bases = [
    sourceOrigin,
    "https://vavoo.to",
    "https://geil.to",
    "https://kool.to",
    "https://kool.ws",
    "https://vavoo.net",
    "https://voltop.net"
  ];
  const uniqueV1 = [...new Set(v1Bases)];

  const body = JSON.stringify({
    language,
    region,
    url: normalizedUrl,
    clientVersion: VER
  });

  for (const base of uniqueV1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(`${base}/mediahubmx-resolve.json`, {
        method: "POST",
        headers: {
          ...baseHeaders,
          "Referer": `${base}/`,
          "Origin": base
        },
        body,
        signal: controller.signal
      });
      clearTimeout(timer);

      if (res.ok) {
        const d = await res.json();
        const candidate = extractUrlFromResponse(d);
        if (candidate && await isLikelyM3u8(candidate, baseHeaders)) {
          return candidate;
        }
      }
    } catch (_) {}
  }

  return null;
}

export default {
  async fetch(req) {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "*"
        }
      });
    }

    const u = new URL(req.url);
    let target = u.searchParams.get("url");
    const region = (u.searchParams.get("region") || "AT").toUpperCase();
    const language = (u.searchParams.get("lang") || "de").toLowerCase();
    const useDnsIp = u.searchParams.get("dnsip") === "1";

    if (!target && u.pathname.startsWith("/play/")) {
      const part = u.pathname.replace("/play/", "").trim();
      if (part) {
        target = part.startsWith("http") ? part : `https://vavoo.to/vavoo-iptv/play/${part}`;
      }
    }

    if (!target) {
      return new Response("Bad Request: missing 'url' parameter", { status: 400 });
    }

    const clientIp =
      req.headers.get("CF-Connecting-IP") ||
      req.headers.get("x-real-ip") ||
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();

    let sig = await getSig(false);
    let resolved = await resolveStream(target, sig, clientIp, region, language);

    // İlk denemede sonuç gelmezse imzayı tazeleyip bir kez daha dene
    if (!resolved) {
      sig = await getSig(true);
      resolved = await resolveStream(target, sig, clientIp, region, language);
    }

    if (!resolved) {
      return new Response("Service Unavailable: stream not resolved", { status: 502 });
    }

    const dest = await transformUrl(resolved, useDnsIp);

    return new Response(null, {
      status: 302,
      headers: {
        "Location": dest,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache, no-store, must-revalidate"
      }
    });
  }
};
