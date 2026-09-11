const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");

const CONFIG = {
    navigationTimeout: 18000,
    discoveryTimeout: 12000,
    validationTimeout: 5000,
    maxCandidates: 100,
    maxCandidateChecks: 8,
};

function send(res, status, data) {
    res.status(status);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.json(data);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeUrl(value, base = null) {
    try {
        if (!value || typeof value !== "string") {
            return null;
        }

        value = value.trim();

        if (
            value.startsWith("blob:") ||
            value.startsWith("data:") ||
            value.startsWith("javascript:")
        ) {
            return null;
        }

        const url = new URL(value, base || undefined);

        if (!["http:", "https:"].includes(url.protocol)) {
            return null;
        }

        url.hash = "";

        return url.toString();
    } catch {
        return null;
    }
}

function isPrivateHost(hostname) {
    const host = hostname.toLowerCase();

    if (
        host === "localhost" ||
        host === "localhost.localdomain" ||
        host.endsWith(".localhost") ||
        host === "0.0.0.0" ||
        host === "::1" ||
        host === "[::1]"
    ) {
        return true;
    }

    const ipv4 = host.match(
        /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
    );

    if (!ipv4) {
        return false;
    }

    const parts = ipv4.slice(1).map(Number);

    if (parts.some(n => n > 255)) {
        return true;
    }

    const [a, b] = parts;

    return (
        a === 10 ||
        a === 127 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168)
    );
}

function validateTarget(value) {
    const url = normalizeUrl(value);

    if (!url) {
        return {
            ok: false,
            error: "الرابط غير صالح."
        };
    }

    const parsed = new URL(url);

    if (isPrivateHost(parsed.hostname)) {
        return {
            ok: false,
            error: "هذا العنوان غير مسموح."
        };
    }

    return {
        ok: true,
        url
    };
}

function looksLikeHls(value) {
    if (!value) {
        return false;
    }

    const v = value.toLowerCase();

    return (
        v.includes(".m3u8") ||
        v.includes(".m3u?")
    );
}

function looksLikePlaylistText(text) {
    if (!text || typeof text !== "string") {
        return false;
    }

    return (
        text.includes("#EXTM3U") ||
        text.includes("#EXT-X-")
    );
}

function scoreCandidate(url, meta = {}) {
    const value = url.toLowerCase();

    let score = 0;

    // HLS
    if (value.includes(".m3u8")) score += 100;
    if (value.includes("master")) score += 35;
    if (value.includes("index")) score += 15;
    if (value.includes("playlist")) score += 15;
    if (value.includes("live")) score += 10;
    if (value.includes("stream")) score += 8;

    // Network source
    if (meta.resourceType === "media") score += 30;
    if (meta.resourceType === "xhr") score += 20;
    if (meta.resourceType === "fetch") score += 20;

    // Prefer HTTPS
    if (value.startsWith("https://")) score += 5;

    // Avoid obvious non-stream endpoints
    const negative = [
        "analytics",
        "tracking",
        "telemetry",
        "doubleclick",
        "googletagmanager",
        "facebook.com/tr",
        "pixel",
        "/ads/",
        "/advert",
    ];

    for (const item of negative) {
        if (value.includes(item)) {
            score -= 50;
        }
    }

    return score;
}

async function launchBrowser() {
    return puppeteer.launch({
        args: [
            ...chromium.args,

            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",

            "--disable-background-networking",
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",

            "--disable-features=Translate,BackForwardCache",
        ],

        executablePath: await chromium.executablePath(),

        headless: true,

        defaultViewport: {
            width: 1280,
            height: 720,
            deviceScaleFactor: 1
        }
    });
}

async function validateHls(page, url) {
    try {
        return await page.evaluate(
            async ({ url, timeout }) => {
                const controller = new AbortController();

                const timer = setTimeout(
                    () => controller.abort(),
                    timeout
                );

                try {
                    const response = await fetch(url, {
                        method: "GET",
                        cache: "no-store",
                        signal: controller.signal
                    });

                    const contentType =
                        response.headers.get("content-type") || "";

                    const text =
                        await response.text();

                    const hls =
                        contentType
                            .toLowerCase()
                            .includes("mpegurl") ||
                        text.includes("#EXTM3U") ||
                        text.includes("#EXT-X-");

                    return {
                        ok: response.ok,
                        status: response.status,
                        contentType,
                        hls,
                        length: text.length
                    };
                } catch (error) {
                    return {
                        ok: false,
                        error: error.message
                    };
                } finally {
                    clearTimeout(timer);
                }
            },
            {
                url,
                timeout: CONFIG.validationTimeout
            }
        );
    } catch {
        return {
            ok: false
        };
    }
}

function extractUrlsFromText(text, baseUrl) {
    if (!text) {
        return [];
    }

    const results = new Set();

    const absolute =
        /https?:\/\/[^\s"'<>\\]+/gi;

    for (const match of text.matchAll(absolute)) {
        const clean = match[0]
            .replace(/[),;]+$/g, "");

        const normalized =
            normalizeUrl(clean);

        if (normalized && looksLikeHls(normalized)) {
            results.add(normalized);
        }
    }

    // Relative playlist references
    const relative =
        /["'`]([^"'`]+\.m3u8(?:\?[^"'`]*)?)["'`]/gi;

    for (const match of text.matchAll(relative)) {
        const normalized =
            normalizeUrl(match[1], baseUrl);

        if (normalized) {
            results.add(normalized);
        }
    }

    return [...results];
}

async function extractFromPage(page, addCandidate) {
    try {
        const data = await page.evaluate(() => {
            return {
                html: document.documentElement?.outerHTML || "",
                scripts: [
                    ...document.scripts
                ].map(script => script.textContent || ""),
                videos: [
                    ...document.querySelectorAll("video")
                ].map(video => ({
                    src: video.currentSrc || video.src || "",
                    poster: video.poster || ""
                }))
            };
        });

        for (const video of data.videos || []) {
            if (looksLikeHls(video.src)) {
                addCandidate(video.src, {
                    resourceType: "media"
                });
            }
        }

        const combined = [
            data.html,
            ...(data.scripts || [])
        ].join("\n");

        for (const url of extractUrlsFromText(
            combined,
            page.url()
        )) {
            addCandidate(url, {
                resourceType: "script"
            });
        }
    } catch {}
}

async function extract(targetUrl) {
    let browser = null;

    try {
        browser = await launchBrowser();

        const page = await browser.newPage();

        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/140.0.0.0 Safari/537.36"
        );

        await page.setExtraHTTPHeaders({
            "Accept-Language":
                "en-US,en;q=0.9,ar;q=0.8"
        });

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(
                navigator,
                "webdriver",
                {
                    get: () => false
                }
            );
        });

        const candidates = new Map();

        function addCandidate(url, meta = {}) {
            const normalized =
                normalizeUrl(url);

            if (!normalized) {
                return;
            }

            if (!looksLikeHls(normalized)) {
                return;
            }

            if (candidates.size >= CONFIG.maxCandidates) {
                return;
            }

            const score =
                scoreCandidate(
                    normalized,
                    meta
                );

            const previous =
                candidates.get(normalized);

            if (
                !previous ||
                score > previous.score
            ) {
                candidates.set(
                    normalized,
                    {
                        url: normalized,
                        score,
                        resourceType:
                            meta.resourceType ||
                            "unknown"
                    }
                );
            }
        }

        // Network requests
        page.on("request", request => {
            try {
                addCandidate(
                    request.url(),
                    {
                        resourceType:
                            request.resourceType()
                    }
                );
            } catch {}
        });

        // Network responses
        page.on("response", response => {
            try {
                const url =
                    response.url();

                const type =
                    response.headers()
                        ["content-type"] || "";

                const resourceType =
                    response.request()
                        .resourceType();

                if (
                    looksLikeHls(url) ||
                    type
                        .toLowerCase()
                        .includes("mpegurl")
                ) {
                    addCandidate(url, {
                        resourceType
                    });
                }
            } catch {}
        });

        await page.goto(targetUrl, {
            waitUntil: "domcontentloaded",
            timeout: CONFIG.navigationTimeout
        }).catch(() => {});

        // Give JavaScript/player time to initialize.
        await sleep(1800);

        // Try normal video/player interaction.
        await page.evaluate(() => {
            const selectors = [
                "video",
                "button",
                "[role='button']",
                ".play",
                ".vjs-big-play-button",
                ".jw-icon-display",
                ".plyr__control--overlaid"
            ];

            for (const selector of selectors) {
                for (const element of
                    document.querySelectorAll(selector)) {
                    try {
                        element.click();
                    } catch {}
                }
            }

            for (const video of
                document.querySelectorAll("video")) {
                try {
                    video.muted = true;

                    const result =
                        video.play();

                    if (
                        result &&
                        typeof result.catch ===
                        "function"
                    ) {
                        result.catch(() => {});
                    }
                } catch {}
            }
        }).catch(() => {});

        const start = Date.now();

        while (
            Date.now() - start <
            CONFIG.discoveryTimeout
        ) {
            await extractFromPage(
                page,
                addCandidate
            );

            const sorted =
                [...candidates.values()]
                    .sort(
                        (a, b) =>
                            b.score - a.score
                    );

            // Strong candidate found.
            if (
                sorted.length &&
                sorted[0].score >= 125
            ) {
                break;
            }

            await sleep(500);
        }

        const sorted =
            [...candidates.values()]
                .sort(
                    (a, b) =>
                        b.score - a.score
                )
                .slice(
                    0,
                    CONFIG.maxCandidateChecks
                );

        if (!sorted.length) {
            return {
                success: false,
                error:
                    "لم يتم العثور على رابط HLS."
            };
        }

        // Validate best candidates.
        for (const candidate of sorted) {
            const validation =
                await validateHls(
                    page,
                    candidate.url
                );

            if (
                validation.ok &&
                validation.hls
            ) {
                return {
                    success: true,
                    stream: candidate.url,
                    type: "hls",
                    verified: true,
                    score: candidate.score
                };
            }
        }

        // Some providers block direct validation.
        // Return the strongest network candidate.
        return {
            success: true,
            stream: sorted[0].url,
            type: "hls",
            verified: false,
            score: sorted[0].score
        };

    } finally {
        if (browser) {
            await browser.close()
                .catch(() => {});
        }
    }
}

module.exports = async (req, res) => {
    if (req.method !== "GET") {
        return send(res, 405, {
            success: false,
            error: "Method Not Allowed"
        });
    }

    const rawUrl =
        typeof req.query?.url === "string"
            ? req.query.url
            : "";

    if (!rawUrl) {
        return send(res, 400, {
            success: false,
            error:
                "Missing URL parameter."
        });
    }

    const target =
        validateTarget(rawUrl);

    if (!target.ok) {
        return send(res, 400, {
            success: false,
            error: target.error
        });
    }

    try {
        const result =
            await extract(target.url);

        return send(
            res,
            result.success ? 200 : 404,
            result
        );
    } catch (error) {
        console.error(
            "HLS_EXTRACTOR_ERROR",
            error
        );

        return send(res, 500, {
            success: false,
            error:
                "حدث خطأ أثناء تحليل المصدر."
        });
    }
};
