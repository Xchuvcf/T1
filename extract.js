const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

module.exports = async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'Missing URL parameter' });

    let browser;
    try {
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });
        
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

        let streamUrl = null;

        await page.setRequestInterception(true);
        page.on('request', request => {
            if (request.url().includes('.m3u8')) {
                streamUrl = request.url();
                request.abort(); 
            } else {
                request.continue();
            }
        });

        // تم تقليل وقت الانتظار ليتناسب مع حدود Vercel المجانية
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
        await new Promise(r => setTimeout(r, 1000));
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
