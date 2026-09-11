import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

const CONFIG = {
    navigationTimeout: 15000,
    discoveryTime: 7000,
    validationTimeout: 3500,
    maxCandidates: 60,
    maxValidation: 6
};

/* -------------------------------------------------------
   Response helper
------------------------------------------------------- */

function response(res, status, data) {
    res.status(status);

    res.setHeader(
        "Content-Type",
        "application/json; charset=utf-8"
    );

    res.setHeader(
        "Cache-Control",
        "no-store"
    );

    res.setHeader(
        "X-Content-Type-Options",
        "nosniff"
    );

    return res.json(data);
}

/* -------------------------------------------------------
   URL utilities
------------------------------------------------------- */

function normalizeUrl(value, base = undefined) {
    if (
        !value ||
        typeof value !== "string"
    ) {
        return null;
    }

    try {
        value = value.trim();

        if (
            value.startsWith("blob:") ||
            value.startsWith("data:") ||
            value.startsWith("javascript:")
        ) {
            return null;
        }

        const url = new URL(
            value,
            base
        );

        if (
            url.protocol !== "http:" &&
            url.protocol !== "https:"
        ) {
            return null;
        }

        url.hash = "";

        return url.toString();

    } catch {
        return null;
    }
}

function isPrivateHost(hostname) {

    const host =
        hostname.toLowerCase();

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

    const ipv4 =
        host.match(
            /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
        );

    if (!ipv4) {
        return false;
    }

    const p =
        ipv4.slice(1).map(Number);

    if (
        p.some(
            n => n < 0 || n > 255
        )
    ) {
        return true;
    }

    const [
        a,
        b
    ] = p;

    return (
        a === 10 ||
        a === 127 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168)
    );
}

function validateTarget(value) {

    const url =
        normalizeUrl(value);

    if (!url) {
        return {
            ok: false,
            error: "الرابط غير صالح."
        };
    }

    const parsed =
        new URL(url);

    if (
        isPrivateHost(
            parsed.hostname
        )
    ) {
        return {
            ok: false,
            error:
                "هذا العنوان غير مسموح."
        };
    }

    return {
        ok: true,
        url
    };
}

/* -------------------------------------------------------
   HLS detection
------------------------------------------------------- */

function isHlsUrl(url) {

    if (!url) {
        return false;
    }

    const value =
        url.toLowerCase();

    return (
        value.includes(".m3u8") ||
        value.includes(".m3u?")
    );
}

function isHlsText(text) {

    if (!text) {
        return false;
    }

    return (
        text.includes("#EXTM3U") ||
        text.includes("#EXT-X-")
    );
}

/* -------------------------------------------------------
   Candidate scoring
------------------------------------------------------- */

function score(url, meta = {}) {

    const value =
        url.toLowerCase();

    let points = 0;

    if (
        value.includes(".m3u8")
    ) {
        points += 100;
    }

    if (
        value.includes("master")
    ) {
        points += 35;
    }

    if (
        value.includes("playlist")
    ) {
        points += 15;
    }

    if (
        value.includes("index")
    ) {
        points += 10;
    }

    if (
        value.includes("live")
    ) {
        points += 10;
    }

    if (
        value.includes("stream")
    ) {
        points += 8;
    }

    if (
        meta.resourceType === "media"
    ) {
        points += 30;
    }

    if (
        meta.resourceType === "xhr"
    ) {
        points += 20;
    }

    if (
        meta.resourceType === "fetch"
    ) {
        points += 20;
    }

    if (
        value.startsWith("https://")
    ) {
        points += 5;
    }

    const badWords = [
        "analytics",
        "tracking",
        "telemetry",
        "doubleclick",
        "googletagmanager",
        "/ads/",
        "/advert",
        "facebook.com/tr"
    ];

    for (
        const word of badWords
    ) {
        if (
            value.includes(word)
        ) {
            points -= 50;
        }
    }

    return points;
}

/* -------------------------------------------------------
   Browser
------------------------------------------------------- */

async function createBrowser() {

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

            "--disable-features=Translate,BackForwardCache"
        ],

        executablePath:
            await chromium.executablePath(),

        defaultViewport: {
            width: 1280,
            height: 720,
            deviceScaleFactor: 1
        },

        headless:
            chromium.headless
    });
}

/* -------------------------------------------------------
   Text URL extraction
------------------------------------------------------- */

function extractHlsUrls(
    text,
    baseUrl
) {

    const found =
        new Set();

    if (!text) {
        return [];
    }

    const absolute =
        /https?:\/\/[^\s"'<>\\]+/gi;

    for (
        const match of
        text.matchAll(absolute)
    ) {

        const value =
            match[0]
                .replace(
                    /[),;]+$/g,
                    ""
                );

        const url =
            normalizeUrl(value);

        if (
            url &&
            isHlsUrl(url)
        ) {
            found.add(url);
        }
    }

    const relative =
        /["'`]([^"'`]+\.m3u8(?:\?[^"'`]*)?)["'`]/gi;

    for (
        const match of
        text.matchAll(relative)
    ) {

        const url =
            normalizeUrl(
                match[1],
                baseUrl
            );

        if (url) {
            found.add(url);
        }
    }

    return [
        ...found
    ];
}

/* -------------------------------------------------------
   HLS validation
------------------------------------------------------- */

async function validateHls(
    page,
    url
) {

    try {

        return await page.evaluate(
            async ({
                url,
                timeout
            }) => {

                const controller =
                    new AbortController();

                const timer =
                    setTimeout(
                        () =>
                            controller.abort(),
                        timeout
                    );

                try {

                    const res =
                        await fetch(
                            url,
                            {
                                method: "GET",
                                cache: "no-store",
                                signal:
                                    controller.signal
                            }
                        );

                    const type =
                        res.headers.get(
                            "content-type"
                        ) || "";

                    const text =
                        await res.text();

                    const hls =
                        type
                            .toLowerCase()
                            .includes(
                                "mpegurl"
                            ) ||
                        text.includes(
                            "#EXTM3U"
                        ) ||
                        text.includes(
                            "#EXT-X-"
                        );

                    return {
                        ok: res.ok,
                        status:
                            res.status,
                        hls,
                        type,
                        length:
                            text.length
                    };

                } catch (error) {

                    return {
                        ok: false,
                        hls: false,
                        error:
                            error.message
                    };

                } finally {

                    clearTimeout(
                        timer
                    );
                }

            },
            {
                url,
                timeout:
                    CONFIG.validationTimeout
            }
        );

    } catch {

        return {
            ok: false,
            hls: false
        };
    }
}

/* -------------------------------------------------------
   Main extraction
------------------------------------------------------- */

async function extract(
    targetUrl
) {

    let browser = null;

    try {

        console.log(
            "[extract] starting"
        );

        browser =
            await createBrowser();

        console.log(
            "[extract] browser started"
        );

        const page =
            await browser.newPage();

        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 " +
            "(KHTML, like Gecko) " +
            "Chrome/149.0.0.0 Safari/537.36"
        );

        const candidates =
            new Map();

        function addCandidate(
            url,
            meta = {}
        ) {

            const normalized =
                normalizeUrl(url);

            if (!normalized) {
                return;
            }

            if (
                !isHlsUrl(normalized)
            ) {
                return;
            }

            if (
                candidates.size >=
                CONFIG.maxCandidates
            ) {
                return;
            }

            const points =
                score(
                    normalized,
                    meta
                );

            const existing =
                candidates.get(
                    normalized
                );

            if (
                !existing ||
                points > existing.score
            ) {

                candidates.set(
                    normalized,
                    {
                        url:
                            normalized,
                        score:
                            points,
                        resourceType:
                            meta.resourceType ||
                            "unknown"
                    }
                );
            }
        }

        /* Network requests */

        page.on(
            "request",
            request => {

                try {

                    addCandidate(
                        request.url(),
                        {
                            resourceType:
                                request.resourceType()
                        }
                    );

                } catch {}
            }
        );

        /* Network responses */

        page.on(
            "response",
            response => {

                try {

                    const url =
                        response.url();

                    const type =
                        response.headers()
                            ["content-type"] ||
                        "";

                    const resourceType =
                        response
                            .request()
                            .resourceType();

                    if (
                        isHlsUrl(url) ||
                        type
                            .toLowerCase()
                            .includes(
                                "mpegurl"
                            )
                    ) {

                        addCandidate(
                            url,
                            {
                                resourceType
                            }
                        );
                    }

                } catch {}
            }
        );

        console.log(
            "[extract] opening target"
        );

        await page.goto(
            targetUrl,
            {
                waitUntil:
                    "domcontentloaded",
                timeout:
                    CONFIG.navigationTimeout
            }
        ).catch(
            error => {

                console.log(
                    "[extract] navigation:",
                    error.message
                );
            }
        );

        /*
         * Short wait only.
         * We deliberately do NOT use networkidle0.
         */

        await new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    1200
                )
        );

        /* Try to activate normal players */

        await page.evaluate(
            () => {

                const selectors = [
                    "video",
                    "button",
                    "[role='button']",
                    ".play",
                    ".vjs-big-play-button",
                    ".jw-icon-display",
                    ".plyr__control--overlaid"
                ];

                for (
                    const selector of
                    selectors
                ) {

                    for (
                        const element of
                        document.querySelectorAll(
                            selector
                        )
                    ) {

                        try {
                            element.click();
                        } catch {}
                    }
                }

                for (
                    const video of
                    document.querySelectorAll(
                        "video"
                    )
                ) {

                    try {

                        video.muted =
                            true;

                        const result =
                            video.play();

                        if (
                            result &&
                            typeof result.catch ===
                            "function"
                        ) {
                            result.catch(
                                () => {}
                            );
                        }

                    } catch {}
                }

            }
        ).catch(
            () => {}
        );

        const deadline =
            Date.now() +
            CONFIG.discoveryTime;

        while (
            Date.now() < deadline
        ) {

            /* Inspect HTML and scripts */

            try {

                const pageData =
                    await page.evaluate(
                        () => {

                            return {
                                html:
                                    document
                                        .documentElement
                                        ?.outerHTML ||
                                    "",

                                scripts:
                                    [
                                        ...document
                                            .scripts
                                    ].map(
                                        s =>
                                            s.textContent ||
                                            ""
                                    ),

                                videos:
                                    [
                                        ...document
                                            .querySelectorAll(
                                                "video"
                                            )
                                    ].map(
                                        video => ({
                                            src:
                                                video
                                                    .currentSrc ||
                                                video.src ||
                                                ""
                                        })
                                    )
                            };
                        }
                    );

                for (
                    const video of
                    pageData.videos
                ) {

                    addCandidate(
                        video.src,
                        {
                            resourceType:
                                "media"
                        }
                    );
                }

                const text =
                    [
                        pageData.html,
                        ...pageData.scripts
                    ].join("\n");

                for (
                    const url of
                    extractHlsUrls(
                        text,
                        page.url()
                    )
                ) {

                    addCandidate(
                        url,
                        {
                            resourceType:
                                "script"
                        }
                    );
                }

            } catch {}

            const sorted =
                [
                    ...candidates.values()
                ].sort(
                    (a, b) =>
                        b.score -
                        a.score
                );

            if (
                sorted.length > 0 &&
                sorted[0].score >= 130
            ) {
                break;
            }

            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        300
                    )
            );
        }

        const sorted =
            [
                ...candidates.values()
            ]
                .sort(
                    (a, b) =>
                        b.score -
                        a.score
                )
                .slice(
                    0,
                    CONFIG.maxValidation
                );

        console.log(
            "[extract] candidates:",
            sorted.length
        );

        if (
            sorted.length === 0
        ) {

            return {
                success: false,
                error:
                    "لم يتم العثور على مصدر HLS."
            };
        }

        /* Validate strongest candidates */

        for (
            const candidate of
            sorted
        ) {

            console.log(
                "[extract] validating:",
                candidate.url
            );

            const check =
                await validateHls(
                    page,
                    candidate.url
                );

            if (
                check.ok &&
                check.hls
            ) {

                console.log(
                    "[extract] verified"
                );

                return {
                    success: true,
                    stream:
                        candidate.url,
                    type:
                        "hls",
                    verified:
                        true,
                    score:
                        candidate.score
                };
            }
        }

        /*
         * Some streaming servers reject
         * validation requests while allowing
         * the browser/player to use the URL.
         */

        return {
            success: true,
            stream:
                sorted[0].url,
            type:
                "hls",
            verified:
                false,
            score:
                sorted[0].score
        };

    } finally {

        if (browser) {

            console.log(
                "[extract] closing browser"
            );

            await browser
                .close()
                .catch(
                    () => {}
                );
        }
    }
}

/* -------------------------------------------------------
   Vercel handler
------------------------------------------------------- */

export default async function handler(
    req,
    res
) {

    if (
        req.method !== "GET"
    ) {

        return response(
            res,
            405,
            {
                success: false,
                error:
                    "Method Not Allowed"
            }
        );
    }

    const rawUrl =
        typeof req.query?.url ===
        "string"
            ? req.query.url
            : "";

    if (!rawUrl) {

        return response(
            res,
            400,
            {
                success: false,
                error:
                    "Missing URL parameter."
            }
        );
    }

    const target =
        validateTarget(
            rawUrl
        );

    if (!target.ok) {

        return response(
            res,
            400,
            {
                success: false,
                error:
                    target.error
            }
        );
    }

    try {

        const result =
            await extract(
                target.url
            );

        return response(
            res,
            result.success
                ? 200
                : 404,
            result
        );

    } catch (error) {

        console.error(
            "[extract] fatal:",
            error
        );

        return response(
            res,
            500,
            {
                success: false,
                error:
                    "حدث خطأ أثناء تحليل المصدر."
            }
        );
    }
}
