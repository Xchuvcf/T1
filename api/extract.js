const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");

const CACHE = new Map();

const CONFIG = {
    navigationTimeout: 20000,
    extractionTimeout: 16000,
    cacheTtl: 30 * 1000,
    maxCandidates: 80,
    maxResponseBytes: 2 * 1024 * 1024,
};

function json(res, status, body) {
    res.status(status);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.json(body);
}

function normalizeUrl(value) {
    try {
        const u = new URL(value);

        if (!["http:", "https:"].includes(u.protocol)) {
            return null;
        }

        u.hash = "";

        return u.toString();
    } catch {
        return null;
    }
}

function isPrivateHostname(hostname) {
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

    // IPv4 private / loopback / link-local ranges
    const ipv4 = host.match(
        /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
    );

    if (ipv4) {
        const p = ipv4.slice(1).map(Number);

        if (p.some(x => x > 255)) return true;

        const [a, b] = p;

        if (a === 10) return true;
        if (a === 127) return true;
        if (a === 169 && b === 254) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
    }

    return false;
}

function validateTarget(value) {
    const url = normalizeUrl(value);

    if (!url) {
        return {
            ok: false,
            error: "الرابط غير صالح.",
        };
    }

    const parsed = new URL(url);

    if (isPrivateHostname(parsed.hostname)) {
        return {
            ok: false,
            error: "هذا النوع من العناوين غير مسموح.",
        };
    }

    return {
        ok: true,
        url,
    };
}

function scoreCandidate(url, meta = {}) {
    const value = url.toLowerCase();

    let score = 0;

    if (value.includes(".m3u8")) score += 100;
    if (value.includes("master")) score += 30;
    if (value.includes("playlist")) score += 15;
    if (value.includes("live")) score += 10;
    if (value.includes("stream")) score += 10;

    if (meta.resourceType === "media") score += 25;
    if (meta.resourceType === "xhr") score += 20;
    if (meta.resourceType === "fetch") score += 20;

    if (value.includes(".m3u?")) score -= 20;
    if (value.includes("ads")) score -= 15;
    if (value.includes("advert")) score -= 15;
    if (value.includes("tracking")) score -= 30;
    if (value.includes("analytics")) score -= 30;
    if (value.includes("doubleclick")) score -= 40;

    return score;
}

function isPossibleStream(url) {
    if (!url) return false;

    const value = url.toLowerCase();

    return (
        value.includes(".m3u8") ||
        value.includes(".m3u") ||
        value.includes("application/vnd.apple.mpegurl")
    );
}

async function validateStream(page, candidate) {
    try {
        const result = await page.evaluate(async (url) => {
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 5000);

                const response = await fetch(url, {
                    method: "GET",
                    cache: "no-store",
                    signal: controller.signal,
                });

                clearTimeout(timer);

                const type =
                    response.headers.get("content-type") || "";

                const text = await response.text();

                const looksLikeHls =
                    type.toLowerCase().includes("mpegurl") ||
                    text.includes("#EXTM3U") ||
                    text.includes("#EXT-X-");

                return {
                    ok: response.ok,
                    status: response.status,
                    type,
                    looksLikeHls,
                    length: text.length,
                };
            } catch (error) {
                return {
                    ok: false,
                    error: error.message,
                };
            }
        }, candidate.url);

        return result;
    } catch {
        return {
            ok: false,
        };
    }
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
        defaultViewport: {
            width: 1280,
            height: 720,
            deviceScaleFactor: 1,
        },
        executablePath: await chromium.executablePath(),
        headless: true,
    });
}

async function extract(targetUrl) {
    const browser = await launchBrowser();

    try {
        const page = await browser.newPage();

        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/149.0.0.0 Safari/537.36"
        );

        await page.setExtraHTTPHeaders({
            "Accept-Language": "en-US,en;q=0.9,ar;q=0.8",
        });

        await page.setRequestInterception(true);

        const candidates = new Map();

        const addCandidate = (url, meta = {}) => {
            const normalized = normalizeUrl(url);

            if (!normalized) return;
            if (!isPossibleStream(normalized)) return;

            if (candidates.size >= CONFIG.maxCandidates) return;

            const current = candidates.get(normalized);

            const score = scoreCandidate(normalized, meta);

            if (!current || score > current.score) {
                candidates.set(normalized, {
                    url: normalized,
                    score,
                    resourceType: meta.resourceType || "unknown",
                });
            }
        };

        page.on("request", request => {
            const url = request.url();

            addCandidate(url, {
                resourceType: request.resourceType(),
            });

            request.continue().catch(() => {});
        });

        page.on("response", async response => {
            try {
                const url = response.url();

                const type =
                    response.headers()["content-type"] || "";

                const resourceType =
                    response.request().resourceType();

                if (
                    isPossibleStream(url) ||
                    type.toLowerCase().includes("mpegurl") ||
                    resourceType === "media"
                ) {
                    addCandidate(url, {
                        resourceType,
                    });
                }
            } catch {}
        });

        page.on("requestfailed", request => {
            // الفشل لا يعني أن الرابط غير صالح بالضرورة.
            // بعض الخوادم ترسل redirect أو تمنع HEAD/GET المباشر.
            addCandidate(request.url(), {
                resourceType: request.resourceType(),
            });
        });

        await page.goto(targetUrl, {
            waitUntil: "domcontentloaded",
            timeout: CONFIG.navigationTimeout,
        }).catch(() => {});

        // إعطاء الصفحة فرصة لتشغيل JavaScript والمشغل.
        await new Promise(resolve => setTimeout(resolve, 2500));

        // محاولة تشغيل عناصر الفيديو/الأزرار القابلة للنقر.
        await page.evaluate(() => {
            const selectors = [
                "video",
                "button",
                "[role='button']",
                ".play",
                ".vjs-big-play-button",
                ".jw-icon-display",
                ".plyr__control--overlaid",
            ];

            for (const selector of selectors) {
                const elements = document.querySelectorAll(selector);

                for (const element of elements) {
                    try {
                        element.click();
                    } catch {}
                }
            }

            for (const video of document.querySelectorAll("video")) {
                try {
                    video.muted = true;
                    const promise = video.play();

                    if (promise && promise.catch) {
                        promise.catch(() => {});
                    }
                } catch {}
            }
        }).catch(() => {});

        const started = Date.now();

        // انتظار ذكي: نتوقف بمجرد العثور على مرشح قوي.
        while (Date.now() - started < CONFIG.extractionTimeout) {
            const sorted = [...candidates.values()]
                .sort((a, b) => b.score - a.score);

            if (sorted.length > 0 && sorted[0].score >= 100) {
                break;
            }

            await new Promise(resolve => setTimeout(resolve, 500));
        }

        const sorted = [...candidates.values()]
            .sort((a, b) => b.score - a.score)
            .slice(0, 12);

        if (!sorted.length) {
            return {
                success: false,
                error: "لم يتم العثور على رابط HLS.",
            };
        }

        // التحقق من أفضل المرشحين.
        for (const candidate of sorted) {
            const validation = await validateStream(
                page,
                candidate
            );

            if (
                validation.ok &&
                validation.looksLikeHls
            ) {
                return {
                    success: true,
                    stream: candidate.url,
                    type: "hls",
                    score: candidate.score,
                    verified: true,
                };
            }
        }

        // إذا منع الخادم الفحص المباشر، نعيد أفضل مرشح
        // تم التقاطه من شبكة الصفحة.
        return {
            success: true,
            stream: sorted[0].url,
            type: "hls",
            score: sorted[0].score,
            verified: false,
        };
    } finally {
        await browser.close().catch(() => {});
    }
}

module.exports = async (req, res) => {
    if (req.method !== "GET") {
        return json(res, 405, {
            success: false,
            error: "Method Not Allowed",
        });
    }

    const rawUrl = req.query?.url;

    if (!rawUrl || typeof rawUrl !== "string") {
        return json(res, 400, {
            success: false,
            error: "Missing URL parameter.",
        });
    }

    const validation = validateTarget(rawUrl);

    if (!validation.ok) {
        return json(res, 400, {
            success: false,
            error: validation.error,
        });
    }

    const targetUrl = validation.url;

    // Cache قصير لتقليل تشغيل Chromium.
    const cached = CACHE.get(targetUrl);

    if (
        cached &&
        Date.now() - cached.timestamp < CONFIG.cacheTtl
    ) {
        return json(res, 200, {
            ...cached.data,
            cached: true,
        });
    }

    try {
        const data = await extract(targetUrl);

        if (data.success) {
            CACHE.set(targetUrl, {
                timestamp: Date.now(),
                data,
            });
        }

        return json(
            res,
            data.success ? 200 : 404,
            data
        );
    } catch (error) {
        console.error("EXTRACTOR_ERROR:", error);

        return json(res, 500, {
            success: false,
            error: "حدث خطأ أثناء معالجة المصدر.",
        });
    }
};
