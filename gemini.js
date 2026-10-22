const { chromium } = require("playwright");
const fs = require("fs").promises;
const path = require("path");
const { getPersistentContext, getProviderPage } = require("./browser-sessions");
const composerSelector = '[role="textbox"][aria-label="Enter a prompt for Gemini"]';

function getComposer(page) {
    return page.locator(composerSelector).first();
}

async function getGeminiPage(context) {
    return getProviderPage(context, ["gemini.google.com"]);
}

async function sendMessage(page, composer, message) {
    await composer.fill(message.trim());

    const sendButton = page.getByRole("button", { name: /^(send message|send)$/i });
    await sendButton.waitFor({ state: "visible", timeout: 10000 });
    try {
        await sendButton.click({ timeout: 10000 });
    } catch (error) {
        if (!await sendButton.isEnabled().catch(() => false)) {
            throw new Error("Gemini send button remained disabled. Sign in to the Gemini browser profile, then retry the job.");
        }
        throw error;
    }
}

async function getLastAssistantMessage(page) {
    const selectors = [
        "model-response",
        "message-content",
        ".model-response-text",
        '[data-test-id="model-response"]'
    ];

    for (const selector of selectors) {
        const messages = await page.$$(selector);
        if (messages.length === 0) continue;

        const text = await messages[messages.length - 1].innerText().catch(() => "");
        if (text.trim()) return text.trim();
    }

    return null;
}

async function waitForUserTurn(page, previousCount, message, timeout = 15000) {
    const start = Date.now();
    const expectedMessage = message.trim().replace(/\s+/g, " ");

    while (Date.now() - start < timeout) {
        const userTurns = await page.$$("user-query");
        if (userTurns.length > previousCount) {
            const latestTurn = await userTurns[userTurns.length - 1].innerText().catch(() => "");
            if (latestTurn.replace(/\s+/g, " ").includes(expectedMessage)) return;
        }

        await page.waitForTimeout(250);
    }

    throw new Error("Gemini did not submit the prompt; the new conversation turn was not found.");
}

async function waitForConversationReady(page, conversationUrl, timeout = 20000) {
    if (!/^https:\/\/gemini\.google\.com\/app\/[^/?#]+/.test(conversationUrl)) return true;

    try {
        await page.locator("user-query").first().waitFor({ state: "attached", timeout });
        return true;
    } catch {
        return false;
    }
}

async function ensureConversationReady(page, conversationUrl, timeout) {
    const conversationReady = await waitForConversationReady(page, conversationUrl, timeout);
    if (!conversationReady) {
        await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded" });
    }
    return conversationReady;
}

async function saveActiveConversationUrl(page, statePath) {
    const url = page.url();
    if (/^https:\/\/gemini\.google\.com\/app\/[^/?#]+/.test(url)) {
        await fs.writeFile(statePath, url, "utf8");
    }
}

async function getAuthenticationError(page) {
    const url = new URL(page.url());
    const hostname = url.hostname.toLowerCase();
    const loginHost = /(^|\.)accounts\.google\.com$/.test(hostname);
    const loginPath = /\/signin|\/ServiceLogin/i.test(url.pathname);

    if (loginHost || loginPath) {
        return "Gemini is not authenticated. Sign in to the Gemini browser profile, then retry the job.";
    }

    const signInButton = await page
        .getByRole("button", { name: /sign in|log in/i })
        .isVisible()
        .catch(() => false);
    return signInButton
        ? "Gemini is not authenticated. Sign in to the Gemini browser profile, then retry the job."
        : null;
}

async function waitForAssistantReply(page, previousReply, timeout = 90000) {
    const start = Date.now();
    let candidate = null;
    let stableReads = 0;

    while (Date.now() - start < timeout) {
        const reply = await getLastAssistantMessage(page);
        const stopIndicators = page.locator('[aria-label*="Stop" i], [data-test-id*="stop" i]');
        const stopIndicatorCount = await stopIndicators.count().catch(() => 0);
        let generating = false;
        for (let index = 0; index < stopIndicatorCount; index += 1) {
            if (await stopIndicators.nth(index).isVisible().catch(() => false)) {
                generating = true;
                break;
            }
        }

        if (reply && reply !== previousReply && !generating) {
            stableReads = reply === candidate ? stableReads + 1 : 1;
            candidate = reply;
            if (stableReads >= 3) return reply;
        } else {
            candidate = null;
            stableReads = 0;
        }

        await page.waitForTimeout(500);
    }

    throw new Error("Gemini reply not found within timeout.");
}

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
        : path.join(profileRoot, "GeminiWebProfile");
    const statePath = path.join(profilePath, "active-conversation.txt");
    const keepBrowserOpen = options.keepBrowserOpen === true;
    let browser;

    try {
        const launch = () => chromium.launchPersistentContext(profilePath, {
            headless: false,
            args: ["--disable-blink-features=AutomationControlled"]
        });
        browser = keepBrowserOpen
            ? await getPersistentContext("gemini", launch)
            : await launch();

        const page = await getGeminiPage(browser);
        const savedUrl = await fs.readFile(statePath, "utf8").catch(() => "");
        const conversationUrl = /^https:\/\/gemini\.google\.com\/app(?:\/|$)/.test(savedUrl)
            ? savedUrl
            : "https://gemini.google.com/app";

        if (page.url() !== conversationUrl) {
            await page.goto(conversationUrl, { waitUntil: "domcontentloaded" });
        }

        const authenticationError = await getAuthenticationError(page);
        if (authenticationError) throw new Error(authenticationError);

        await ensureConversationReady(page, conversationUrl);

        const composer = getComposer(page);
        try {
            await composer.waitFor({ state: "visible", timeout: 20000 });
        } catch {
            const authError = await getAuthenticationError(page);
            if (authError) throw new Error(authError);
            throw new Error("Gemini did not load the prompt box.");
        }

        const previousReply = await getLastAssistantMessage(page);
        const previousUserCount = (await page.$$("user-query")).length;
        await sendMessage(page, composer, message);
        await waitForUserTurn(page, previousUserCount, message);
        await saveActiveConversationUrl(page, statePath);

        const reply = await waitForAssistantReply(page, previousReply);
        await saveActiveConversationUrl(page, statePath);
        return reply;
    } finally {
        if (browser && !keepBrowserOpen) await browser.close();
    }
}

if (require.main === module) {
    const message = process.argv.slice(2).join(" ").trim();
    if (!message) {
        console.error("Usage: node gemini.js <message>");
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

module.exports = {
    getAuthenticationError,
    ensureConversationReady,
    getGeminiPage,
    getLastAssistantMessage,
    run,
    saveActiveConversationUrl,
    sendMessage,
    waitForAssistantReply,
    waitForConversationReady,
    waitForUserTurn
};