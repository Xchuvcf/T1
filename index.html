const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

module.exports = async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'Missing URL parameter' });

    let browser;
    try {
        browser = await puppeteer.launch({
            args: [...chromium.args, '--disable-blink-features=AutomationControlled'],
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });
        
        const page = await browser.newPage();
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });

        let streamUrl = null;

        // الاستماع لطلبات الشبكة للبحث عن m3u8 أو m3u
        page.on('request', request => {
            const reqUrl = request.url();
            if (reqUrl.includes('.m3u8') || reqUrl.includes('.m3u')) {
                streamUrl = reqUrl;
            }
        });

        // فتح الصفحة وانتظار تحميل الشبكة بالكامل
        await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 15000 });

        // محاكاة نقرة بالماوس داخل الصفحة لإجبار المشغل على العمل إذا كان يتطلب تفاعلاً
        try {
            await page.mouse.click(100, 100);
        } catch (e) {}

        // انتظار إضافي لمدة 4 ثوانٍ لالتقاط الرابط فور طلبه
        await new Promise(r => setTimeout(r, 4000));

        await browser.close();

        if (streamUrl) {
            res.status(200).json({ success: true, stream: streamUrl });
        } else {
            res.status(404).json({ success: false, error: 'لم يتم العثور على رابط البث' });
        }
    } catch (error) {
        if (browser) await browser.close();
        res.status(500).json({ success: false, error: error.message });
    }
};
