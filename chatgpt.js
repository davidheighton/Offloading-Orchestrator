const { chromium } = require("playwright");
const fs = require("fs").promises;
const path = require("path");
const { getPersistentContext, getProviderPage } = require("./browser-sessions");
const composerSelector = "#prompt-textarea, #mobile-composer-prompt, textarea[placeholder='Ask ChatGPT'], [data-testid='prompt-textarea'], [contenteditable='true'][aria-label='Ask ChatGPT'], [contenteditable='true'][data-placeholder]";
const defaultReplyTimeoutMs = 90000;
const longReplyTimeoutMs = 150000;
const maxReplyTimeoutMs = 240000;

function getExpectedReplyTimeout(message) {
    const longFormRequest = /\b(?:comprehensive|compare|design|detailed|in-depth|review|report|step[- ]by[- ]step|summari[sz]e|synthesi[sz]e|thorough|analy[sz]e)\b/i.test(message);
    return longFormRequest || message.trim().length >= 1200
        ? longReplyTimeoutMs
        : defaultReplyTimeoutMs;
}

function getComposer(page) {
    return page.locator(composerSelector).first();
}

async function enableThinkMode(page) {
    const thinkButton = page.getByRole("button", { name: "Think", exact: true });
    try {
        await thinkButton.waitFor({ state: "visible", timeout: 2000 });
    } catch (error) {
        if (error.name === "TimeoutError") return;
        throw error;
    }

    if (await thinkButton.getAttribute("aria-pressed") !== "true") {
        if (typeof thinkButton.isEnabled === "function" && !await thinkButton.isEnabled()) return;
        try {
            await thinkButton.click({ timeout: 2000 });
        } catch (error) {
            if (error.name === "TimeoutError") return;
            throw error;
        }
    }

    if (await thinkButton.getAttribute("aria-pressed") !== "true") {
        throw new Error("Could not enable ChatGPT Think mode.");
    }
}

async function sendMessage(page, composer, message) {
    await composer.fill(message.trim());

    const sendButton = page.getByRole("button", { name: /^(send message|send)$/i });
    await sendButton.waitFor({ state: "visible", timeout: 10000 });
    try {
        await sendButton.click({ timeout: 10000 });
    } catch (error) {
        if (!await sendButton.isEnabled().catch(() => false)) {
            throw new Error("ChatGPT send button remained disabled. Sign in to the ChatGPT browser profile, then retry the job.");
        }
        throw error;
    }
}

async function queryAllDuringNavigation(page, selector) {
    try {
        return await page.$$(selector);
    } catch (error) {
        if (error.message.includes("Execution context was destroyed")) return [];
        throw error;
    }
}

async function getLastAssistantMessage(page) {
    const selectors = [
        '[data-message-author-role="assistant"]',
        '[data-chatgpt-search-unit-key*="assistant"] [data-markdown-text-style="assistant-message"]'
    ];

    for (const selector of selectors) {
        const messages = await queryAllDuringNavigation(page, selector);
        if (messages.length === 0) continue;

        const text = await messages[messages.length - 1].innerText().catch(() => "");
        if (text.trim()) return text.trim();
    }

    return null;
}

async function getLastUserTurn(page) {
    const selectors = [
        '[data-chatgpt-search-unit-key*="user"]',
        '[data-message-author-role="user"]'
    ];

    for (const selector of selectors) {
        const messages = await queryAllDuringNavigation(page, selector);
        if (messages.length === 0) continue;

        const message = messages[messages.length - 1];
        const key = await message.getAttribute("data-chatgpt-search-unit-key") ||
            await message.getAttribute("data-message-id") ||
            `user-${messages.length}`;
        const turnId = key.replace(/:\d+:user$/, "");
        return { key, text: await message.innerText().catch(() => ""), turnId };
    }

    return null;
}

async function getLastAssistantTurn(page) {
    const selectors = [
        '[data-chatgpt-search-unit-key*="assistant"]',
        '[data-message-author-role="assistant"]'
    ];

    for (const selector of selectors) {
        const messages = await queryAllDuringNavigation(page, selector);
        if (messages.length === 0) continue;

        const message = messages[messages.length - 1];
        const key = await message.getAttribute("data-chatgpt-search-unit-key") ||
            await message.getAttribute("data-message-id") ||
            `assistant-${messages.length}`;
        const turnId = key.replace(/:\d+:assistant$/, "");
        return { key, turnId };
    }

    return null;
}

async function getAuthenticationError(page) {
    const url = new URL(page.url());
    const hostname = url.hostname.toLowerCase();
    const loginHost = /(^|\.)(auth\.openai\.com|login\.openai\.com)$/.test(hostname);
    const loginPath = /\/(auth\/login|login|signup)(\/|$)/i.test(url.pathname);

    if (loginHost || loginPath) {
        return "ChatGPT is not authenticated. Sign in to the ChatGPT browser profile, then retry the job.";
    }

    const signInHeading = await page
        .getByRole("heading", { name: /log in|sign up/i })
        .isVisible()
        .catch(() => false);
    const signInButton = await page
        .getByRole("button", { name: /log in|sign up|create account/i })
        .isVisible()
        .catch(() => false);

    if (signInHeading || signInButton) {
        return "ChatGPT is not authenticated. Sign in to the ChatGPT browser profile, then retry the job.";
    }

    const composerVisible = await getComposer(page)
        .isVisible()
        .catch(() => false);
    return composerVisible ? null : "ChatGPT chat did not load a message box.";
}

async function waitForAssistantReply(
    page,
    message,
    previousUserKey,
    previousAssistantKey,
    timeout = defaultReplyTimeoutMs,
    previousReply,
    maxTimeout = Math.min(timeout * 2, maxReplyTimeoutMs)
) {
    const start = Date.now();
    const hardDeadline = start + Math.max(timeout, maxTimeout);
    let deadline = Math.min(start + timeout, hardDeadline);
    let candidate = null;
    let stableReads = 0;
    let lastProgressReply = previousReply;
    let replyProgressCount = 0;
    let lastState = {};

    while (Date.now() < deadline && Date.now() < hardDeadline) {
        const userTurn = await getLastUserTurn(page);
        const assistantTurn = await getLastAssistantTurn(page);
        const reply = await getLastAssistantMessage(page);
        const stopIndicators = page.locator('[data-testid="stop-button"], button[aria-label*="Stop generating" i]');
        const stopIndicatorCount = await stopIndicators.count().catch(() => 0);
        let generating = false;
        for (let index = 0; index < stopIndicatorCount; index += 1) {
            if (await stopIndicators.nth(index).isVisible().catch(() => false)) {
                generating = true;
                break;
            }
        }
        const expectedUserTurn = userTurn &&
            userTurn.key !== previousUserKey &&
            userTurn.text.includes(message.trim());
        const newAssistantTurn = assistantTurn && assistantTurn.key !== previousAssistantKey;
        const matchingTurn = userTurn?.turnId && assistantTurn?.turnId
            ? userTurn.turnId === assistantTurn.turnId
            : newAssistantTurn;
        const userHasRealKey = userTurn && !/^user-\d+$/.test(userTurn.key);
        const assistantHasRealKey = assistantTurn && !/^assistant-\d+$/.test(assistantTurn.key);
        const conflictingTurnIds = userHasRealKey && assistantHasRealKey && userTurn?.turnId && assistantTurn?.turnId &&
            userTurn.turnId !== assistantTurn.turnId;
        const correlatedReply = newAssistantTurn && matchingTurn;
        const textDeltaReply = previousReply !== undefined && !assistantHasRealKey && !conflictingTurnIds &&
            reply && reply !== previousReply;
        const validReply = expectedUserTurn && (correlatedReply || textDeltaReply) && reply;
        if (validReply && reply !== lastProgressReply) {
            lastProgressReply = reply;
            replyProgressCount += 1;
            deadline = Math.min(hardDeadline, Date.now() + timeout);
        }
        lastState = {
            userTurnSeen: Boolean(userTurn && userTurn.key !== previousUserKey),
            submittedMessageMatched: Boolean(userTurn && userTurn.text.includes(message.trim())),
            assistantTurnSeen: Boolean(newAssistantTurn),
            matchingTurn: Boolean(matchingTurn),
            replyLength: reply?.length || 0,
            generating
        };

        if (expectedUserTurn && (correlatedReply || textDeltaReply) && reply && !generating) {
            stableReads = reply === candidate ? stableReads + 1 : 1;
            candidate = reply;
            if (stableReads >= (correlatedReply ? 3 : 5)) return reply;
        } else {
            candidate = null;
            stableReads = 0;
        }

        await page.waitForTimeout(500);
    }

    const visibleDialogCount = await page
        .locator('[role="dialog"]:visible, [role="alertdialog"]:visible')
        .count()
        .catch(() => null);
    const composer = getComposer(page);
    const composerVisible = typeof composer.isVisible === "function"
        ? await composer.isVisible().catch(() => null)
        : null;

    throw new Error(`ChatGPT reply not found within timeout. Diagnostics: ${JSON.stringify({
        ...lastState,
        timeoutMs: timeout,
        maxTimeoutMs: Math.max(timeout, maxTimeout),
        replyProgressCount,
        visibleDialogCount,
        composerVisible
    })}`);
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
        : path.join(profileRoot, "ChatGPTWebProfile");
    const statePath = path.join(profilePath, "active-conversation.txt");
    const keepBrowserOpen = options.keepBrowserOpen === true;
    let browser;

    try {
        const launch = () => chromium.launchPersistentContext(profilePath, {
            headless: false,
            args: [
                "--disable-blink-features=AutomationControlled",
                "--disable-features=IsolateOrigins,site-per-process"
            ]
        });
        browser = keepBrowserOpen
            ? await getPersistentContext("chatgpt", launch)
            : await launch();

        const page = await getProviderPage(browser, ["chatgpt.com", "chat.openai.com"]);
        const savedUrl = await fs.readFile(statePath, "utf8").catch(() => "");
        const conversationUrl = /^https:\/\/chatgpt\.com\/(?:c\/|$)/.test(savedUrl)
            ? savedUrl
            : "https://chatgpt.com";

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
            throw new Error("ChatGPT did not load the message box.");
        }

        await enableThinkMode(page);
        const previousUserTurn = await getLastUserTurn(page);
        const previousAssistantTurn = await getLastAssistantTurn(page);
        const previousReply = await getLastAssistantMessage(page);
        await sendMessage(page, composer, message);

        const replyTimeout = getExpectedReplyTimeout(message);
        const reply = await waitForAssistantReply(
            page,
            message,
            previousUserTurn?.key,
            previousAssistantTurn?.key,
            replyTimeout,
            previousReply ?? "",
            Math.min(replyTimeout * 2, maxReplyTimeoutMs)
        );
        await fs.writeFile(statePath, page.url(), "utf8");
        return reply;
    } finally {
        if (browser && !keepBrowserOpen) await browser.close();
    }
}

if (require.main === module) {
    const message = process.argv.slice(2).join(" ").trim();
    if (!message) {
        console.error("Usage: node chatgpt.js <message>");
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
    enableThinkMode,
    getAuthenticationError,
    getExpectedReplyTimeout,
    getLastAssistantMessage,
    getLastAssistantTurn,
    getLastUserTurn,
    run,
    sendMessage,
    waitForAssistantReply
};