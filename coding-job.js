const { open, realpath } = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { getServiceBaseUrl, requestJson } = require("./improvement-advisor");
const { isSensitiveFile, maxCodingContextBytes, normalizeProvider } = require("./offloading-agent");
const { getOllamaModel } = require("./ollama");

const jobTimeoutMs = 15 * 60 * 1000;
const minJobTimeoutMs = 1000;
const maxJobTimeoutMs = 15 * 60 * 1000;
const pollIntervalMs = 2000;
const serviceRequestTimeoutMs = 30000;

function parseCodingJobArgs(args) {
    let confirmedProviderSharing = false;
    let provider = "auto";
    let model;
    let timeoutMs = jobTimeoutMs;
    const contextFiles = [];
    const messageParts = [];

    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--confirm-provider-sharing") {
            confirmedProviderSharing = true;
        } else if (args[index] === "--provider") {
            if (!args[index + 1]) throw new Error("--provider requires a provider name.");
            provider = normalizeProvider(args[++index]);
            if (provider === "auto") continue;
        } else if (args[index] === "--model") {
            if (!args[index + 1]) throw new Error("--model requires an installed Ollama model tag or 'auto'.");
            const selectedModel = args[++index];
            model = selectedModel === "auto" ? "auto" : getOllamaModel(selectedModel);
        } else if (args[index] === "--context-file") {
            if (!args[index + 1]) throw new Error("--context-file requires a workspace-relative file path.");
            const contextFile = args[++index];
            if (contextFiles.includes(contextFile)) throw new Error(`Context file was supplied more than once: ${contextFile}`);
            contextFiles.push(contextFile);
        } else if (args[index] === "--timeout-ms") {
            if (!args[index + 1]) throw new Error("--timeout-ms requires a duration in milliseconds.");
            const parsedTimeoutMs = Number(args[++index]);
            if (!Number.isInteger(parsedTimeoutMs) || parsedTimeoutMs < minJobTimeoutMs || parsedTimeoutMs > maxJobTimeoutMs) {
                throw new Error(`--timeout-ms must be an integer from ${minJobTimeoutMs} to ${maxJobTimeoutMs}.`);
            }
            timeoutMs = parsedTimeoutMs;
        } else if (args[index].startsWith("--")) {
            throw new Error(`Unknown option: ${args[index]}`);
        } else {
            messageParts.push(args[index]);
        }
    }

    const message = messageParts.join(" ").trim();
    if (!message) {
        throw new Error('Usage: npm run code -- "<coding task>" --confirm-provider-sharing [--provider <name>] [--context-file <workspace-relative-path>] [--timeout-ms <milliseconds>]');
    }
    if (!confirmedProviderSharing) {
        throw new Error("Pass --confirm-provider-sharing before sending a coding job to a provider.");
    }
    if (model !== undefined && provider !== "ollama") {
        throw new Error("--model is available only with --provider ollama.");
    }

    return { message, provider, ...(model !== undefined ? { model } : {}), contextFiles, timeoutMs, confirmedProviderSharing };
}

async function readCodingContextFile(filePath, workspacePath = process.cwd()) {
    if (filePath === undefined) return undefined;
    if (typeof filePath !== "string" || !filePath.trim() || path.isAbsolute(filePath)) {
        throw new Error("Coding context file must be a workspace-relative path.");
    }

    const workspace = await realpath(workspacePath);
    const sourcePath = await realpath(path.resolve(workspace, filePath));
    const relativePath = path.relative(workspace, sourcePath);
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
        throw new Error("Coding context file must resolve inside the workspace.");
    }
    if (isSensitiveFile(relativePath)) {
        throw new Error("Sensitive files cannot be used as coding context.");
    }

    const handle = await open(sourcePath, "r");
    try {
        const before = await handle.stat();
        if (!before.isFile()) throw new Error("Coding context path must be a file.");
        if (before.size > maxCodingContextBytes) {
            throw new Error(`Coding context file must not exceed ${maxCodingContextBytes} bytes.`);
        }

        const buffer = Buffer.alloc(maxCodingContextBytes + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const after = await handle.stat();
        if (bytesRead > maxCodingContextBytes || after.size > maxCodingContextBytes) {
            throw new Error(`Coding context file must not exceed ${maxCodingContextBytes} bytes.`);
        }

        try {
            return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
        } catch {
            throw new Error("Coding context file must contain valid UTF-8 text.");
        }
    } finally {
        await handle.close();
    }
}

async function readCodingContextFiles(filePaths = [], workspacePath = process.cwd()) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) return undefined;
    const sections = [];
    for (const filePath of filePaths) {
        const context = await readCodingContextFile(filePath, workspacePath);
        sections.push(`--- ${filePath.replace(/\\/g, "/")} ---\n${context}`);
    }
    const combinedContext = sections.join("\n\n");
    if (Buffer.byteLength(combinedContext, "utf8") > maxCodingContextBytes) {
        throw new Error(`Combined coding context must not exceed ${maxCodingContextBytes} UTF-8 bytes.`);
    }
    return combinedContext;
}

async function runCodingJob(message, options = {}) {
    if (options.confirmedProviderSharing !== true) {
        throw new Error("Confirm provider sharing before starting a coding job.");
    }
    if (typeof message !== "string" || !message.trim()) {
        throw new Error("A non-empty coding request is required.");
    }

    const fetchImpl = options.fetchImpl || fetch;
    const baseUrl = getServiceBaseUrl(options.serviceUrl);
    const context = options.context !== undefined
        ? options.context
        : options.contextFiles
            ? await readCodingContextFiles(options.contextFiles, options.workspacePath)
            : await readCodingContextFile(options.contextFile, options.workspacePath);
    const job = await requestJson(fetchImpl, `${baseUrl}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            confirmedProviderSharing: true,
            type: "coding",
            provider: options.provider || "auto",
            ...(options.model !== undefined ? { model: options.model } : {}),
            message: message.trim(),
            ...(context !== undefined ? { context } : {})
        })
    }, options.requestTimeoutMs || serviceRequestTimeoutMs);
    if (!job || typeof job.id !== "string" || !job.id) {
        throw new Error("Offloading service accepted the coding job without returning a job ID.");
    }
    options.onStatus?.(job.status, job);

    const deadline = Date.now() + (options.timeoutMs ?? options.jobTimeoutMs ?? jobTimeoutMs);
    let lastStatus = job.status;
    while (Date.now() < deadline) {
        const result = await requestJson(fetchImpl, `${baseUrl}/jobs/${job.id}`, {}, options.requestTimeoutMs || serviceRequestTimeoutMs);
        if (result.status !== lastStatus) {
            options.onStatus?.(result.status, result);
            lastStatus = result.status;
        }
        if (result.status === "completed" || result.status === "failed") return result;
        await delay(options.pollIntervalMs ?? pollIntervalMs);
    }
    throw new Error(`Timed out waiting for coding job ${job.id}. The job was not resubmitted.`);
}

async function main(args) {
    const parsed = parseCodingJobArgs(args);
    const context = await readCodingContextFiles(parsed.contextFiles);
    if (parsed.contextFiles.length > 0) {
        console.log(`Reading bounded coding context from ${parsed.contextFiles.join(", ")}.`);
    }
    const job = await runCodingJob(parsed.message, {
        ...parsed,
        context,
        serviceUrl: process.env.OFFLOADING_AGENT_URL,
        onStatus: status => console.log(`Coding job status: ${status}`)
    });
    console.log(`\nCoding job ${job.id} via ${job.provider}${job.model ? ` (${job.model})` : ""}: ${job.status}`);
    if (job.status === "completed") {
        console.log("Proposed result only; no workspace files were modified.");
        console.log(typeof job.result === "string" ? job.result : JSON.stringify(job.result, null, 2));
    } else {
        console.error(job.error || "The coding job failed.");
        process.exitCode = 1;
    }
}

if (require.main === module) {
    main(process.argv.slice(2)).catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { main, parseCodingJobArgs, readCodingContextFile, readCodingContextFiles, runCodingJob };