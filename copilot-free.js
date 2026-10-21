const { chromium } = require('playwright');
const fs = require('fs').promises;
const path = require('path');
const { getPersistentContext, getProviderPage } = require('./browser-sessions');

async function getCopilotPage(context) {
    return getProviderPage(context, ['copilot.microsoft.com', 'copilot.com']);
}

// --- Helper: extract last assistant message from any DOM variant ---
async function getLastAssistantMessage(page) {
    const selectors = [
        "[data-testid='lastChatMessage']",
        "div[data-message-author='assistant']",
        "div[class*='assistant-message']",
        "div[data-testid='message-content']"
    ];

    for (const selector of selectors) {
        const elements = await page.$$(selector);
        if (elements.length > 0) {
            const last = elements[elements.length - 1];
            const text = await last.innerText();
            if (text && text.trim().length > 0) {
                return text;
            }
        }
    }

    return null;
}

async function isGenerating(page) {
    const indicators = page.locator('[data-testid="stop-button"], button[aria-label*="Stop generating" i]');
    const count = await indicators.count().catch(() => 0);

    for (let index = 0; index < count; index++) {
        if (await indicators.nth(index).isVisible().catch(() => false)) return true;
    }

    return false;
}

// --- Helper: detect an expired or missing Copilot sign-in ---
async function getAuthenticationError(page) {
    const url = new URL(page.url());
    const hostname = url.hostname.toLowerCase();
    const loginHost = /(^|\.)(login\.live\.com|login\.microsoftonline\.com)$/.test(hostname);
    const loginPath = /\/(login|signin|sign-in)(\/|$)/i.test(url.pathname);

    if (loginHost || loginPath) {
        return "Copilot is not authenticated. Sign in to the browser profile, then retry the job.";
    }

    const signInHeading = await page
        .getByRole("heading", { name: /sign in/i })
        .isVisible()
        .catch(() => false);
    const signInButton = await page
        .getByRole("button", { name: /^sign in(?: with microsoft)?$/i })
        .isVisible()
        .catch(() => false);

    if (signInHeading || signInButton) {
        return "Copilot is not authenticated. Sign in to the browser profile, then retry the job.";
    }

    return null;
}

// --- Helper: wait for assistant reply ---
async function waitForAssistantReply(page, previousReply, timeout = 60000) {
    const start = Date.now();
    let candidate = null;
    let stableReads = 0;

    while (Date.now() - start < timeout) {
        const reply = await getLastAssistantMessage(page);
        const generating = await isGenerating(page);
        if (reply && reply.trim().length > 0 && reply !== previousReply && !generating) {
            stableReads = reply === candidate ? stableReads + 1 : 1;
            candidate = reply;
            if (stableReads >= 3) return reply;
        } else {
            candidate = null;
            stableReads = 0;
        }
        await page.waitForTimeout(250);
    }

    throw new Error("Assistant reply not found within timeout.");
}

// --- Main ---
async function run(message, options = {}) {
    if (typeof message !== "string" || !message.trim()) {
        throw new Error("A non-empty message is required.");
    }

    const profileRoot = process.env.LOCALAPPDATA || process.env.HOME;
    if (!profileRoot) {
        throw new Error("Could not determine the local profile directory.");
    }

    const profilePath = options.profilePath
        ? path.resolve(options.profilePath)
        : path.join(profileRoot, "CopilotFreeChatProfile");
    const statePath = path.join(profilePath, "active-conversation.txt");
    const keepBrowserOpen = options.keepBrowserOpen === true;
    let browser;

    try {
        const launch = () => chromium.launchPersistentContext(
            profilePath,
            {
                headless: false,
                args: [
                    "--disable-blink-features=AutomationControlled",
                    "--disable-features=IsolateOrigins,site-per-process"
                ]
            }
        );
        browser = keepBrowserOpen
            ? await getPersistentContext('copilot', launch)
            : await launch();

        const page = await getCopilotPage(browser);
        const savedUrl = await fs.readFile(statePath, "utf8").catch(() => "");
        const conversationUrl = /^https:\/\/copilot(?:\.microsoft)?\.com\/chat\/conversation\//.test(savedUrl)
            ? savedUrl
            : "https://copilot.microsoft.com";

        if (page.url() !== conversationUrl) {
            await page.goto(conversationUrl, { waitUntil: "networkidle" });
        }

        const authenticationError = await getAuthenticationError(page);
        if (authenticationError) {
            throw new Error(authenticationError);
        }

        const composer = page.getByRole("textbox", { name: "Message Copilot" });
        try {
            await composer.waitFor({ state: "visible", timeout: 15000 });
        } catch {
            const authenticationError = await getAuthenticationError(page);
            if (authenticationError) {
                throw new Error(authenticationError);
            }
            throw new Error("Copilot chat did not load the message box.");
        }
        const previousReply = await getLastAssistantMessage(page);

        await composer.fill(message);
        await composer.press("Enter");

        const reply = await waitForAssistantReply(page, previousReply);
        await fs.writeFile(statePath, page.url(), "utf8");
        return reply;
    } finally {
        if (browser && !keepBrowserOpen) {
            await browser.close();
        }
    }
}

if (require.main === module) {
    const message = process.argv.slice(2).join(" ").trim();
    if (!message) {
        console.error("Usage: node copilot-free.js <message>");
        process.exitCode = 1;
    } else {
        run(message)
            .then(reply => console.log(reply))
            .catch(error => {
                console.error(error.message);
                process.exitCode = 1;
            });
    }
}

module.exports = { getAuthenticationError, getCopilotPage, run, waitForAssistantReply };
