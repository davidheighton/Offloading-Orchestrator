const { chromium } = require("playwright");
const fs = require("fs").promises;
const path = require("path");
const { getPersistentContext, getProviderPage } = require("./browser-sessions");
const composerSelector = '[data-testid="chat-input"][role="textbox"], [role="textbox"][aria-label="Write your prompt to Claude"]';

function getComposer(page) {
    return page.locator(composerSelector).first();
}

async function sendMessage(page, composer, message) {
    await composer.fill(message.trim());

    const sendButton = page.getByRole("button", { name: "Send message", exact: true });
    await sendButton.waitFor({ state: "visible", timeout: 10000 });
    try {
        await sendButton.click({ timeout: 10000 });
    } catch (error) {
        if (!await sendButton.isEnabled().catch(() => false)) {
            throw new Error("Claude send button remained disabled. Sign in to the Claude browser profile, then retry the job.");
        }
        throw error;
    }
}

async function getLastAssistantMessage(page) {
    const selectors = [
        '[data-testid="assistant-message"] [data-cds="Prose"]',
        '[data-testid="assistant-message"] .prose',
        '[data-testid="assistant-message"]',
        '[data-testid="chat-message"][data-message-author="assistant"]',
        '[data-testid="chat-message"][data-role="assistant"]',
        '[data-testid="chat-message"]',
        "main .prose"
    ];

    for (const selector of selectors) {
        const messages = await page.$$(selector);
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const text = await messages[index].innerText().catch(() => "");
            if (text.trim()) return text.trim();
        }
    }

    return null;
}

async function getAuthenticationError(page) {
    const url = new URL(page.url());
    const loginPath = /\/(login|sign-in|signup)(\/|$)/i.test(url.pathname);
    if (loginPath) {
        return "Claude is not authenticated. Sign in to the Claude browser profile, then retry the job.";
    }

    const signInControl = await page
        .getByRole("button", { name: /sign in|log in/i })
        .isVisible()
        .catch(() => false);
    return signInControl
        ? "Claude is not authenticated. Sign in to the Claude browser profile, then retry the job."
        : null;
}

async function waitForAssistantReply(page, previousReply, message, timeout = 90000) {
    const start = Date.now();
    let candidate = null;
    let stableReads = 0;

    while (Date.now() - start < timeout) {
        const reply = await getLastAssistantMessage(page);
        const generating = await page
            .locator('[data-testid="assistant-message"][data-is-streaming="true"], [aria-label*="Stop" i], [data-testid*="stop" i]')
            .count()
            .then(count => count > 0)
            .catch(() => false);

        if (reply && reply !== previousReply && reply !== message.trim() && !generating) {
            stableReads = reply === candidate ? stableReads + 1 : 1;
            candidate = reply;
            if (stableReads >= 3) return reply;
        } else {
            candidate = null;
            stableReads = 0;
        }

        await page.waitForTimeout(500);
    }

    throw new Error("Claude reply not found within timeout.");
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
        : path.join(profileRoot, "ClaudeWebProfile");
    const statePath = path.join(profilePath, "active-conversation.txt");
    const keepBrowserOpen = options.keepBrowserOpen === true;
    let browser;

    try {
        const launch = () => chromium.launchPersistentContext(profilePath, {
            headless: false,
            ...(options.channel ? { channel: options.channel } : {}),
            args: ["--disable-blink-features=AutomationControlled"]
        });
        browser = keepBrowserOpen
            ? await getPersistentContext("claude", launch)
            : await launch();

        const page = await getProviderPage(browser, ["claude.ai"]);
        const savedUrl = await fs.readFile(statePath, "utf8").catch(() => "");
        const conversationUrl = /^https:\/\/claude\.ai\/(?:chat\/|new|chat$)/.test(savedUrl)
            ? savedUrl
            : "https://claude.ai/chat/";

        if (page.url() !== conversationUrl) {
            await page.goto(conversationUrl, { waitUntil: "domcontentloaded" });
        }

        const authenticationError = await getAuthenticationError(page);
        if (authenticationError) throw new Error(authenticationError);

        const composer = getComposer(page);
        try {
            await composer.waitFor({ state: "visible", timeout: 20000 });
        } catch {
            const authError = await getAuthenticationError(page);
            if (authError) throw new Error(authError);
            throw new Error("Claude did not load the prompt box.");
        }

        const previousReply = await getLastAssistantMessage(page);
        await sendMessage(page, composer, message);

        const reply = await waitForAssistantReply(page, previousReply, message);
        await fs.writeFile(statePath, page.url(), "utf8");
        return reply;
    } finally {
        if (browser && !keepBrowserOpen) await browser.close();
    }
}

if (require.main === module) {
    const message = process.argv.slice(2).join(" ").trim();
    if (!message) {
        console.error("Usage: node claude.js <message>");
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

module.exports = { getAuthenticationError, getLastAssistantMessage, run, sendMessage };