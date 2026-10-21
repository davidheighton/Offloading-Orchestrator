const defaultBaseUrl = "http://127.0.0.1:11434";
const defaultModel = "qwen3.5:9b";
const defaultTimeoutMs = 180000;

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

    return url.origin;
}

async function run(message, options = {}) {
    if (typeof message !== "string" || !message.trim()) {
        throw new Error("A non-empty message is required.");
    }

    const baseUrl = getOllamaBaseUrl(options.baseUrl);
    const model = options.model || process.env.OLLAMA_MODEL || defaultModel;
    const fetchImpl = options.fetchImpl || fetch;
    const response = await fetchImpl(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            model,
            messages: [{ role: "user", content: message.trim() }],
            stream: false
        }),
        signal: AbortSignal.timeout(options.timeoutMs || defaultTimeoutMs)
    });

    let result;
    try {
        result = await response.json();
    } catch {
        throw new Error("Ollama returned invalid JSON.");
    }
    if (!response.ok) {
        throw new Error(`Ollama returned HTTP ${response.status}.`);
    }
    if (typeof result?.message?.content !== "string" || !result.message.content.trim()) {
        throw new Error("Ollama returned an empty response.");
    }

    return result.message.content.trim();
}

module.exports = { getOllamaBaseUrl, run };
