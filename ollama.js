const defaultBaseUrl = "http://127.0.0.1:11434";
const defaultModel = "qwen3.5:9b";
const defaultTimeoutMs = 600000;
const maxTimeoutMs = 900000;

function getOllamaModel(value = process.env.OLLAMA_MODEL) {
    if (value === undefined || value === "") return defaultModel;
    if (typeof value !== "string") throw new Error("Ollama model must be a non-empty model tag.");

    const model = value.trim();
    if (!model || model.length > 256 || /[\u0000-\u001f]/.test(model)) {
        throw new Error("Ollama model must be a non-empty model tag of at most 256 characters.");
    }
    return model;
}

function getOllamaTimeoutMs(value = process.env.OLLAMA_TIMEOUT_MS) {
    if (value === undefined || value === "") return defaultTimeoutMs;

    const timeoutMs = Number(value);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > maxTimeoutMs) {
        throw new Error(`Ollama timeout must be between 1000 and ${maxTimeoutMs} milliseconds.`);
    }
    return timeoutMs;
}

function getOllamaBaseUrl(value = process.env.OLLAMA_HOST || defaultBaseUrl) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error("Ollama URL must be a valid loopback HTTP URL.");
    }

    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
        throw new Error("Ollama URL must use a loopback Ollama URL.");
    }
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
        throw new Error("Ollama URL must be a loopback origin without a path, query, or credentials.");
    }

    return url.origin;
}

async function run(message, options = {}) {
    if (typeof message !== "string" || !message.trim()) {
        throw new Error("A non-empty message is required.");
    }

    const baseUrl = getOllamaBaseUrl(options.baseUrl);
    const model = getOllamaModel(options.model ?? process.env.OLLAMA_MODEL);
    const fetchImpl = options.fetchImpl || fetch;
    const timeoutMs = getOllamaTimeoutMs(options.timeoutMs);
    let response;
    try {
        response = await fetchImpl(`${baseUrl}/api/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                model,
                messages: [{ role: "user", content: message.trim() }],
                stream: false
            }),
            signal: AbortSignal.timeout(timeoutMs)
        });
    } catch (error) {
        if (error?.name === "TimeoutError") {
            throw new Error(`Ollama request timed out after ${timeoutMs} milliseconds.`);
        }
        throw new Error(`Could not connect to local Ollama at ${baseUrl}. Confirm the Ollama service is running.`, {
            cause: error
        });
    }

    if (!response.ok) {
        let errorDetail;
        try {
            const errorResponse = await response.json();
            if (typeof errorResponse?.error === "string" && errorResponse.error.trim()) {
                errorDetail = errorResponse.error.trim();
            }
        } catch {
            errorDetail = undefined;
        }
        throw new Error(`Ollama returned HTTP ${response.status}${errorDetail ? `: ${errorDetail}` : "."}`);
    }

    let result;
    try {
        result = await response.json();
    } catch {
        throw new Error("Ollama returned invalid JSON.");
    }
    if (typeof result?.message?.content !== "string" || !result.message.content.trim()) {
        throw new Error("Ollama returned an empty response.");
    }

    return result.message.content.trim();
}

module.exports = { getOllamaBaseUrl, getOllamaModel, getOllamaTimeoutMs, run };
