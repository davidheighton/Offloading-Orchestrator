const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const { Readable } = require("node:stream");
const test = require("node:test");
const { createBrowserSessionManager } = require("./browser-sessions");
const {
    enableThinkMode,
    getAuthenticationError,
    getLastAssistantMessage,
    sendMessage,
    getExpectedReplyTimeout,
    waitForAssistantReply
} = require("./chatgpt");
const copilot = require("./copilot-free");
const gemini = require("./gemini");
const claude = require("./claude");
const meta = require("./meta-ai");
const ollama = require("./ollama");
const {
    clarifyTask,
    createImprovementWorkflowPayload,
    getServiceBaseUrl,
    maxClarificationQuestions,
    parseClarificationResponse,
    requestJson,
    runImprovementAdvice
} = require("./improvement-advisor");
const {
    buildDashboardSnapshot,
    buildLocalRepositorySummary,
    buildCodingJobPrompt,
    buildRepositorySummaryPrompt,
    buildWorkflowSynthesisPrompt,
    calculateVendorRankings,
    collectRepositoryFiles,
    createServiceProviderRunner,
    createQueueProcessor,
    gradeVendorJob,
    makeVendorGrade,
    getKnowledgeKey,
    getServiceBrowserProfilePath,
    hasJobCapacity,
    isJsonContentType,
    normalizeProvider,
    parseRepositorySummary,
    persistKnowledgeSummary,
    publicJob,
    publicWorkflow,
    pruneFinishedJobs,
    readVendorGrades,
    recordVendorGrade,
    readJson,
    redactSensitiveText,
    resolveWorkspacePath,
    setProviderOffline,
    selectAutoProvider,
    providerRunners,
    server
} = require("./offloading-agent");

test("repository summary paths stay inside the workspace", () => {
    assert.equal(resolveWorkspacePath("copilot-free.js"), path.resolve("copilot-free.js"));
    assert.throws(() => resolveWorkspacePath("../outside"), /inside the workspace/);
    assert.throws(() => resolveWorkspacePath(path.resolve("outside")), /relative path/);
});

test("repository context redacts common secret assignments and bearer tokens", () => {
    const content = 'api_key = "abc123"\nrefresh_token = "long-lived-token"\nrefresh-token: alternate-token\nGITHUB_TOKEN = "ghp_example-secret"\napi-token: another-token\ntokenizer = "bpe"\ntokenCount = 42\nrefresh_count = 5\nAuthorization: Bearer abc.def.ghi';
    const redacted = redactSensitiveText(content);
    assert.doesNotMatch(redacted, /abc123|long-lived-token|alternate-token|ghp_example-secret|another-token|abc\.def\.ghi/);
    assert.match(redacted, /tokenizer = "bpe"/);
    assert.match(redacted, /tokenCount = 42/);
    assert.match(redacted, /refresh_count = 5/);
    assert.match(redacted, /\[REDACTED\]/);
});

test("repository context redacts quoted JSON secret keys without changing ordinary values", () => {
    const input = JSON.stringify({
        api_key: "plain-secret",
        password: 'prefix"tail-secret',
        name: "plain-secret"
    });

    const redacted = redactSensitiveText(input);
    const parsed = JSON.parse(redacted);
    assert.equal(parsed.api_key, "[REDACTED]");
    assert.equal(parsed.password, "[REDACTED]");
    assert.equal(parsed.name, "plain-secret");
    assert.doesNotMatch(redacted, /prefix|tail-secret/);
});

test("repository collection includes eligible workspace source without dependency folders", async () => {
    const files = await collectRepositoryFiles(".");
    const paths = files.map(file => file.path);
    assert.ok(paths.includes("offloading-agent.js"));
    assert.ok(paths.includes("copilot-free.js"));
    assert.ok(paths.every(filePath => !filePath.startsWith("node_modules/")));
});

test("repository collection bounds reads when a file grows after its size check", async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(process.cwd(), ".collector-test-"));
    const limit = 64 * 1024;
    const exactLimitFile = path.join(temporaryRoot, "exact-limit.js");
    const growingFile = path.join(temporaryRoot, "growing.js");
    const originalOpen = fs.open;
    const originalAppendFile = fs.appendFile;
    let requestedReadBytes = 0;
    let growingFileHandleClosed = false;

    try {
        await fs.writeFile(exactLimitFile, Buffer.alloc(limit, 0x61));
        const exactLimitPath = path.relative(process.cwd(), exactLimitFile).split(path.sep).join("/");
        const exactLimitFiles = await collectRepositoryFiles(exactLimitPath);
        assert.equal(Buffer.byteLength(exactLimitFiles[0].content), limit);

        await fs.writeFile(growingFile, "initial content");
        fs.open = async (...args) => {
            const fileHandle = await originalOpen(...args);
            if (path.resolve(args[0]) !== path.resolve(growingFile)) return fileHandle;

            return {
                stat: () => fileHandle.stat(),
                read: async (...readArgs) => {
                    await originalAppendFile(growingFile, Buffer.alloc(25 * 1024, 0x61));
                    const result = await fileHandle.read(...readArgs);
                    requestedReadBytes += result.bytesRead;
                    return result;
                },
                close: async () => {
                    growingFileHandleClosed = true;
                    await fileHandle.close();
                }
            };
        };

        const growingPath = path.relative(process.cwd(), growingFile).split(path.sep).join("/");
        await assert.rejects(collectRepositoryFiles(growingPath), /No eligible text files/);
        assert.equal(requestedReadBytes, limit + 1);
        assert.equal(growingFileHandleClosed, true);
    } finally {
        fs.open = originalOpen;
        await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
});

test("repository collection scans past early ineligible files within its bounded budget", async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(process.cwd(), ".collector-test-"));
    try {
        for (let index = 0; index < 401; index += 1) {
            const fileName = `image-${String(index).padStart(2, "0")}.png`;
            await fs.writeFile(path.join(temporaryRoot, fileName), "image");
        }
        const sourceDirectory = path.join(temporaryRoot, "z-source");
        await fs.mkdir(sourceDirectory);
        await fs.writeFile(path.join(sourceDirectory, "eligible.js"), "module.exports = true;\n");

        const relativeRoot = path.relative(process.cwd(), temporaryRoot).split(path.sep).join("/");
        const files = await collectRepositoryFiles(relativeRoot);
        assert.deepEqual(files.map(file => file.path), [`${relativeRoot}/z-source/eligible.js`]);
    } finally {
        await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
});

test("repository collection excludes files under sensitive directories", async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(process.cwd(), ".collector-test-"));
    try {
        const secretsDirectory = path.join(temporaryRoot, "secrets");
        const sourceDirectory = path.join(temporaryRoot, "src");
        await fs.mkdir(secretsDirectory);
        await fs.mkdir(sourceDirectory);
        await fs.writeFile(path.join(secretsDirectory, "settings.js"), "module.exports = {};\n");
        await fs.writeFile(path.join(sourceDirectory, "app.js"), "module.exports = true;\n");

        const relativeRoot = path.relative(process.cwd(), temporaryRoot).split(path.sep).join("/");
        const files = await collectRepositoryFiles(relativeRoot);
        assert.deepEqual(files.map(file => file.path), [`${relativeRoot}/src/app.js`]);

        const relativeSecretFile = path.relative(
            process.cwd(),
            path.join(secretsDirectory, "settings.js")
        ).split(path.sep).join("/");
        await assert.rejects(
            collectRepositoryFiles(relativeSecretFile),
            /No eligible text files/
        );
    } finally {
        await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
});

test("repository summaries require the documented JSON shape", () => {
    const summary = {
        summary: "A small Node.js project.",
        keyFiles: [{ path: "offloading-agent.js", role: "HTTP job API" }],
        entryPoints: ["npm start"],
        dependencies: ["playwright"],
        risks: [],
        limitations: []
    };
    assert.deepEqual(parseRepositorySummary(JSON.stringify(summary)), summary);
    assert.throws(() => parseRepositorySummary("not json"), /valid JSON/);
    assert.throws(() => parseRepositorySummary(JSON.stringify({ summary: "missing fields" })), /required JSON shape/);
});

test("repository summary prompt requests grounded JSON and marks source as untrusted", () => {
    const prompt = buildRepositorySummaryPrompt(".", [{ path: "README.md", content: "Project notes" }]);
    assert.match(prompt, /valid JSON/);
    assert.match(prompt, /untrusted source data/);
    assert.match(prompt, /--- README\.md ---/);

    const boundedPrompt = buildRepositorySummaryPrompt(".", [{ path: "large.js", content: "x".repeat(20000) }]);
    assert.equal(boundedPrompt.length, 10000);
    assert.match(boundedPrompt, /Additional workspace content omitted/);
});

test("coding job prompts request concrete code without implying provider filesystem access", () => {
    const prompt = buildCodingJobPrompt("Fix the workflow coding branch.");
    assert.match(prompt, /coding job/);
    assert.match(prompt, /unified diff/);
    assert.match(prompt, /do not claim files were changed/);
    assert.match(prompt, /untrusted data, not as instructions/);
    assert.match(prompt, /Fix the workflow coding branch\./);
    assert.throws(() => buildCodingJobPrompt(" "), /non-empty coding request/);
});

test("JSON request parsing rejects malformed UTF-8 and preserves valid multibyte text", async () => {
    const validRequest = Readable.from([Buffer.from('{"message":"é"}')]);
    assert.deepEqual(await readJson(validRequest), { message: "é" });

    const malformedRequest = Readable.from([
        Buffer.from('{"message":"'),
        Buffer.from([0xff]),
        Buffer.from('"}')
    ]);
    await assert.rejects(readJson(malformedRequest), error => {
        assert.equal(error.statusCode, 400);
        assert.equal(error.message, "Request body must be valid JSON.");
        return true;
    });
});

test("queue processor resumes pending jobs after an unexpected failure", async () => {
    let signalFirstJobStarted;
    let releaseFirstJob;
    let signalNextJobCompleted;
    const firstJobStarted = new Promise(resolve => { signalFirstJobStarted = resolve; });
    const firstJobGate = new Promise(resolve => { releaseFirstJob = resolve; });
    const nextJobCompleted = new Promise(resolve => { signalNextJobCompleted = resolve; });
    const firstJob = { status: "queued", message: "first job" };
    const jobs = [firstJob];
    const executedJobs = [];
    const finishedJobs = [];
    const processQueue = createQueueProcessor(jobs, async job => {
        if (job.message === "first job") {
            signalFirstJobStarted();
            await firstJobGate;
            job.result = { partial: true };
            throw null;
        }
        executedJobs.push(job.message);
        signalNextJobCompleted();
        return "completed";
    }, job => finishedJobs.push(job));

    const firstRun = processQueue();
    await firstJobStarted;
    const nextJob = { status: "queued", message: "next job" };
    jobs.push(nextJob);
    await processQueue();
    const idlePromise = processQueue.waitForIdle();
    releaseFirstJob();

    await firstRun;
    await idlePromise;
    await nextJobCompleted;
    assert.deepEqual(executedJobs, ["next job"]);
    assert.equal(jobs.length, 0);
    assert.equal(firstJob.status, "failed");
    assert.equal(firstJob.error, "null");
    assert.equal("message" in firstJob, false);
    assert.equal("result" in firstJob, false);
    assert.equal("knowledgeKey" in firstJob, false);
    assert.equal(finishedJobs.filter(job => job === firstJob).length, 1);
    assert.equal(nextJob.status, "completed");
});

test("queue processor runs different providers concurrently but serializes each provider", async () => {
    let releaseCopilot;
    let releaseChatGPT;
    let signalCopilotStarted;
    let signalChatGPTStarted;
    let signalSecondCopilotStarted;
    const copilotGate = new Promise(resolve => { releaseCopilot = resolve; });
    const chatGPTGate = new Promise(resolve => { releaseChatGPT = resolve; });
    const copilotStarted = new Promise(resolve => { signalCopilotStarted = resolve; });
    const chatGPTStarted = new Promise(resolve => { signalChatGPTStarted = resolve; });
    const secondCopilotStarted = new Promise(resolve => { signalSecondCopilotStarted = resolve; });
    const firstCopilotJob = { provider: "copilot", message: "copilot first", status: "queued" };
    const secondCopilotJob = { provider: "copilot", message: "copilot second", status: "queued" };
    const chatGPTJob = { provider: "chatgpt", message: "chatgpt first", status: "queued" };
    const jobs = [firstCopilotJob, secondCopilotJob, chatGPTJob];
    const processQueue = createQueueProcessor(jobs, async job => {
        if (job.message === "copilot first") {
            signalCopilotStarted();
            await copilotGate;
        } else if (job.message === "chatgpt first") {
            signalChatGPTStarted();
            await chatGPTGate;
        } else {
            signalSecondCopilotStarted();
        }
        return job.message;
    });

    const processing = processQueue();
    await Promise.all([copilotStarted, chatGPTStarted]);
    assert.equal(secondCopilotJob.status, "queued");

    releaseCopilot();
    await secondCopilotStarted;
    assert.equal(firstCopilotJob.status, "completed");
    assert.equal(secondCopilotJob.status, "running");

    releaseChatGPT();
    await processing;
    assert.equal(secondCopilotJob.status, "completed");
    assert.equal(chatGPTJob.status, "completed");
});

test("queue processor wakes for a newly submitted provider while another job is active", async () => {
    let releaseCopilot;
    let signalCopilotStarted;
    let signalGeminiStarted;
    const copilotGate = new Promise(resolve => { releaseCopilot = resolve; });
    const copilotStarted = new Promise(resolve => { signalCopilotStarted = resolve; });
    const geminiStarted = new Promise(resolve => { signalGeminiStarted = resolve; });
    const copilotJob = { provider: "copilot", status: "queued" };
    const jobs = [copilotJob];
    const processQueue = createQueueProcessor(jobs, async job => {
        if (job.provider === "copilot") {
            signalCopilotStarted();
            await copilotGate;
        } else {
            signalGeminiStarted();
        }
        return job.provider;
    });

    const processing = processQueue();
    await copilotStarted;
    const geminiJob = { provider: "gemini", status: "queued" };
    jobs.push(geminiJob);
    await processQueue();

    let timeout;
    try {
        await Promise.race([
            geminiStarted,
            new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error("Gemini job was not woken")), 1000);
            })
        ]);
        assert.equal(copilotJob.status, "running");
        assert.equal(geminiJob.status, "completed");
    } finally {
        clearTimeout(timeout);
        releaseCopilot();
    }

    await processing;
    assert.equal(copilotJob.status, "completed");
});

test("queue processor isolates completion callback failures and resolves idle waiters", async () => {
    const firstJob = { provider: "copilot", status: "queued" };
    const nextJob = { provider: "copilot", status: "queued" };
    const jobs = [firstJob, nextJob];
    const processQueue = createQueueProcessor(jobs, async job => job.provider, job => {
        if (job === firstJob) throw new Error("callback failed");
    });
    const originalConsoleError = console.error;
    const loggedErrors = [];
    console.error = (...args) => loggedErrors.push(args);

    try {
        await processQueue();
        await processQueue.waitForIdle();
    } finally {
        console.error = originalConsoleError;
    }

    assert.equal(firstJob.status, "completed");
    assert.equal(nextJob.status, "completed");
    assert.equal(loggedErrors.length, 1);
    assert.match(loggedErrors[0][0], /completion callback failed/);
});

test("queue processor fails jobs whose thrown errors cannot be stringified", async () => {
    const failingJob = { status: "queued", message: "failing job" };
    const nextJob = { status: "queued", message: "next job" };
    const finishedJobs = [];
    const jobs = [failingJob, nextJob];
    const processQueue = createQueueProcessor(jobs, async job => {
        if (job === failingJob) {
            throw { toString() { throw new Error("coercion failed"); } };
        }
        return "completed";
    }, job => finishedJobs.push(job));

    await processQueue();

    assert.equal(failingJob.status, "failed");
    assert.equal(failingJob.error, "Job failed with an unprintable error.");
    assert.equal("message" in failingJob, false);
    assert.equal(nextJob.status, "completed");
    assert.deepEqual(finishedJobs, [failingJob, nextJob]);
});

test("public job responses preserve empty failure messages", () => {
    const response = publicJob({
        id: "job-1",
        status: "failed",
        createdAt: "2026-10-19T00:00:00.000Z",
        updatedAt: "2026-10-19T00:00:01.000Z",
        error: ""
    });

    assert.equal("error" in response, true);
    assert.equal(response.error, "");
});

test("oversized synthesis input preserves full branch results and reports partial workflow status", () => {
    const workflow = {
        id: "workflow-oversized",
        goal: "Design",
        createdAt: "2026-10-20T00:00:00.000Z",
        updatedAt: "2026-10-20T00:00:01.000Z",
        synthesisError: "Workflow synthesis input exceeds the provider limit.",
        threads: [{ id: "thread-1", name: "Architecture", required: true, jobId: "job-1" }]
    };
    const branchResult = "x".repeat(12000);
    const jobStore = new Map([
        ["job-1", { id: "job-1", status: "completed", provider: "copilot", type: "thinking", result: branchResult }]
    ]);

    assert.throws(
        () => buildWorkflowSynthesisPrompt(workflow, jobStore),
        /exceeds the 10000-character provider limit/
    );
    const result = publicWorkflow(workflow, jobStore);
    assert.equal(result.status, "partial");
    assert.equal(result.threads[0].job.result.length, branchResult.length);
    assert.equal(result.threads[0].job.result, branchResult);
});

test("knowledge keys are stable and do not expose workspace paths", () => {
    const key = getKnowledgeKey(".");
    assert.match(key, /^[a-f0-9]{64}$/);
    assert.equal(getKnowledgeKey("."), key);
});

test("failed knowledge persistence removes its temporary file and preserves the original error", async () => {
    const knowledgeDirectory = path.resolve(".copilot-knowledge");
    let directoryExisted = true;
    try {
        await fs.access(knowledgeDirectory);
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
        directoryExisted = false;
    }

    const originalRename = fs.rename;
    const renameError = new Error("rename failed");
    const job = {
        path: `persist-failure-${Date.now()}-${Math.random()}`,
        result: { summary: "test" }
    };
    let temporaryPath;
    fs.rename = async source => {
        temporaryPath = source;
        throw renameError;
    };

    try {
        await assert.rejects(persistKnowledgeSummary(job), error => error === renameError);
        assert.equal(job.knowledgeKey, undefined);
        assert.ok(temporaryPath);
        await assert.rejects(fs.access(temporaryPath), { code: "ENOENT" });
    } finally {
        fs.rename = originalRename;
        if (temporaryPath) await fs.rm(temporaryPath, { force: true });
        if (!directoryExisted) await fs.rmdir(knowledgeDirectory);
    }
});

test("finished job retention enforces age and count limits without evicting active jobs", () => {
    const now = Date.now();
    const jobs = new Map();

    jobs.set("expired", {
        status: "completed",
        updatedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString()
    });
    for (let index = 0; index < 300; index += 1) {
        jobs.set(`finished-${index}`, {
            status: index % 2 === 0 ? "completed" : "failed",
            updatedAt: new Date(now - (300 - index) * 1000).toISOString()
        });
    }
    jobs.set("running", { status: "running", updatedAt: new Date(now).toISOString() });
    jobs.set("queued", { status: "queued", updatedAt: new Date(now).toISOString() });

    pruneFinishedJobs(jobs, now);

    assert.equal(jobs.size, 202);
    assert.equal(jobs.has("expired"), false);
    assert.equal(jobs.has("finished-99"), false);
    assert.equal(jobs.has("finished-100"), true);
    assert.equal(jobs.has("running"), true);
    assert.equal(jobs.has("queued"), true);
});

test("provider selection defaults to Copilot and accepts all supported providers", () => {
    assert.equal(normalizeProvider(), "copilot");
    assert.equal(normalizeProvider("copilot"), "copilot");
    assert.equal(normalizeProvider("chatgpt"), "chatgpt");
    assert.equal(normalizeProvider("gemini"), "gemini");
    assert.equal(normalizeProvider("claude"), "claude");
    assert.equal(normalizeProvider("meta"), "meta");
    assert.equal(normalizeProvider("ollama"), "ollama");
    assert.equal(normalizeProvider("auto"), "auto");
    assert.throws(() => normalizeProvider("unknown"), /auto.*copilot.*chatgpt.*gemini.*claude.*meta.*ollama/);
});

test("Ollama uses the configured local model and returns its response text", async () => {
    let requestUrl;
    let requestBody;
    const result = await ollama.run("Summarize the change", {
        model: "qwen3.5:9b",
        fetchImpl: async (url, options) => {
            requestUrl = url;
            requestBody = JSON.parse(options.body);
            return Response.json({ message: { content: "  Local summary  " } });
        }
    });

    assert.equal(requestUrl, "http://127.0.0.1:11434/api/chat");
    assert.deepEqual(requestBody, {
        model: "qwen3.5:9b",
        messages: [{ role: "user", content: "Summarize the change" }],
        stream: false
    });
    assert.equal(result, "Local summary");
});

test("Ollama rejects non-loopback endpoints", async () => {
    await assert.rejects(
        ollama.run("Local only", { baseUrl: "http://example.com:11434" }),
        /loopback Ollama URL/
    );
});

test("Ollama rejects base URLs that would be silently normalized", () => {
    for (const baseUrl of [
        "http://127.0.0.1:11434/api",
        "http://user:pass@127.0.0.1:11434",
        "http://127.0.0.1:11434?proxy=true",
        "http://127.0.0.1:11434#chat"
    ]) {
        assert.throws(() => ollama.getOllamaBaseUrl(baseUrl), /loopback origin without a path/);
    }
});

test("Ollama timeout is configurable within a bounded range", () => {
    assert.equal(ollama.getOllamaTimeoutMs(""), 600000);
    assert.equal(ollama.getOllamaTimeoutMs("300000"), 300000);
    assert.throws(() => ollama.getOllamaTimeoutMs("999"), /between 1000 and 900000/);
    assert.throws(() => ollama.getOllamaTimeoutMs("900001"), /between 1000 and 900000/);
    assert.throws(() => ollama.getOllamaTimeoutMs("not-a-number"), /between 1000 and 900000/);
});

test("Ollama model configuration defaults safely and rejects invalid tags", () => {
    assert.equal(ollama.getOllamaModel(""), "qwen3.5:9b");
    assert.equal(ollama.getOllamaModel("  qwen2.5-coder:7b  "), "qwen2.5-coder:7b");
    assert.throws(() => ollama.getOllamaModel("   "), /non-empty model tag/);
    assert.throws(() => ollama.getOllamaModel("x".repeat(257)), /at most 256 characters/);
    assert.throws(() => ollama.getOllamaModel("qwen\n3.5"), /non-empty model tag/);
});

test("Ollama reports request timeouts with the configured duration", async () => {
    const timeoutError = new Error("The operation was aborted due to timeout");
    timeoutError.name = "TimeoutError";

    await assert.rejects(
        ollama.run("Slow local request", {
            timeoutMs: 120000,
            fetchImpl: async () => { throw timeoutError; }
        }),
        /Ollama request timed out after 120000 milliseconds/
    );
});

test("Ollama explains local connection failures and preserves the cause", async () => {
    const connectionError = new TypeError("fetch failed");

    await assert.rejects(
        ollama.run("Local request", { fetchImpl: async () => { throw connectionError; } }),
        error => {
            assert.match(error.message, /Could not connect to local Ollama at http:\/\/127\.0\.0\.1:11434/);
            assert.match(error.message, /Confirm the Ollama service is running/);
            assert.equal(error.cause, connectionError);
            return true;
        }
    );
});

test("Ollama reports HTTP status even when an error body is not JSON", async () => {
    await assert.rejects(
        ollama.run("Local request", {
            fetchImpl: async () => ({ ok: false, status: 503, json: async () => { throw new Error("not JSON"); } })
        }),
        /Ollama returned HTTP 503/
    );
});

test("Ollama preserves structured HTTP error details", async () => {
    await assert.rejects(
        ollama.run("Local request", {
            fetchImpl: async () => Response.json({ error: "model qwen3.5:9b not found" }, { status: 404 })
        }),
        /Ollama returned HTTP 404: model qwen3\.5:9b not found/
    );
});

test("Ollama rejects malformed JSON and empty successful responses", async () => {
    await assert.rejects(
        ollama.run("Local request", {
            fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("invalid"); } })
        }),
        /Ollama returned invalid JSON/
    );
    await assert.rejects(
        ollama.run("Local request", {
            fetchImpl: async () => Response.json({ message: { content: "  " } })
        }),
        /Ollama returned an empty response/
    );
});

test("vendor rankings combine skill-specific grades with a neutral prior", () => {
    const grades = [
        { provider: "claude", skill: "coding", score: 5 },
        { provider: "claude", skill: "coding", score: 4 },
        { provider: "gemini", skill: "coding", score: 1 },
        { provider: "meta", skill: "thinking", score: 5 }
    ];
    const codingRankings = calculateVendorRankings("coding", grades);
    const thinkingRankings = calculateVendorRankings("thinking", grades);

    assert.equal(codingRankings[0].provider, "claude");
    assert.equal(codingRankings[0].score, 3.6);
    assert.equal(codingRankings[0].averageScore, 4.5);
    assert.equal(codingRankings[0].sampleCount, 2);
    assert.equal(codingRankings.find(vendor => vendor.provider === "meta").sampleCount, 0);
    assert.equal(thinkingRankings[0].provider, "meta");
    assert.equal(thinkingRankings[0].score, 3.5);
    assert.throws(() => calculateVendorRankings("copilot", grades), /coding.*thinking/);
});

test("automatic vendor selection favors grades and balances ties by active load", () => {
    const grades = [
        { provider: "claude", skill: "coding", score: 5 },
        { provider: "claude", skill: "coding", score: 5 }
    ];
    const activeJobs = new Map([
        ["job-1", { provider: "claude", status: "running" }],
        ["job-2", { provider: "chatgpt", status: "queued" }]
    ]);
    assert.equal(selectAutoProvider("coding", grades, activeJobs).provider, "claude");

    const first = selectAutoProvider("thinking", [], activeJobs, 0);
    const second = selectAutoProvider("thinking", [], activeJobs, first.nextCursor);
    assert.notEqual(first.provider, "chatgpt");
    assert.notEqual(first.provider, "claude");
    assert.notEqual(first.provider, second.provider);
});

test("automatic provider selection excludes vendors marked offline", () => {
    const offline = new Set(["claude"]);
    const grades = [{ provider: "claude", skill: "coding", score: 5 }];
    const rankings = calculateVendorRankings("coding", grades, new Map(), offline);

    assert.equal(rankings.find(vendor => vendor.provider === "claude").offline, true);
    assert.notEqual(selectAutoProvider("coding", grades, new Map(), 0, offline).provider, "claude");
    assert.throws(() => selectAutoProvider("coding", grades, new Map(), 0,
        new Set(providerRunners.keys())), /No providers are online/);
});

test("vendor grades validate, persist across reads, and cannot be duplicated", async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(process.cwd(), ".vendor-grade-test-"));
    const filePath = path.join(temporaryRoot, "grades.json");
    const jobs = new Map([[
        "job-1",
        { id: "job-1", provider: "claude", type: "coding", status: "completed" }
    ]]);

    try {
        const result = await gradeVendorJob(jobs, "job-1", { score: 5, note: "  Clear fix  " }, filePath);
        assert.deepEqual(result.grade, {
            jobId: "job-1",
            provider: "claude",
            skill: "coding",
            score: 5,
            note: "Clear fix",
            gradedAt: result.grade.gradedAt
        });
        assert.equal(result.vendors[0].provider, "claude");
        assert.deepEqual(await readVendorGrades(filePath), [result.grade]);
        await assert.rejects(gradeVendorJob(jobs, "job-1", { score: 4 }, filePath), error => {
            assert.equal(error.statusCode, 409);
            assert.match(error.message, /already been graded/);
            return true;
        });
        assert.throws(() => makeVendorGrade(jobs.get("job-1"), { score: 6 }), error => {
            assert.equal(error.statusCode, 400);
            assert.match(error.message, /integer from 1 to 5/);
            return true;
        });
    } finally {
        await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
});

test("job API accepts only application/json media types", () => {
    assert.equal(isJsonContentType("application/json"), true);
    assert.equal(isJsonContentType(" Application/JSON; charset=utf-8 "), true);
    assert.equal(isJsonContentType("text/plain"), false);
    assert.equal(isJsonContentType("application/problem+json"), false);
    assert.equal(isJsonContentType(undefined), false);
});

test("job API validates content types, object bodies, and job types", async () => {
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });

    try {
        for (const body of ["not valid JSON", "x".repeat(65 * 1024)]) {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/jobs`, {
                method: "POST",
                headers: { "content-type": "text/plain" },
                body
            });

            assert.equal(response.status, 415);
        }

        const malformedJsonResponse = await fetch(`http://127.0.0.1:${server.address().port}/jobs`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{"
        });
        assert.equal(malformedJsonResponse.status, 400);
        assert.deepEqual(await malformedJsonResponse.json(), { error: "Request body must be valid JSON." });

        for (const body of [null, [], "hello", 5]) {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/jobs`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body)
            });

            assert.equal(response.status, 400);
            assert.deepEqual(await response.json(), { error: "Request body must be a JSON object." });
        }

        for (const [body, expectedError] of [
            [{ confirmedProviderSharing: true }, "A non-empty message is required for copilot jobs."],
            [{ confirmedProviderSharing: true, type: "" }, "Job type must be 'copilot', 'coding', 'thinking', or 'repo-summary'."]
        ]) {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/jobs`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body)
            });

            assert.equal(response.status, 400);
            assert.deepEqual(await response.json(), { error: expectedError });
        }
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test("Meta authentication detection distinguishes login and chat pages", async () => {
    const makePage = url => ({
        url: () => url,
        getByRole: () => ({ isVisible: async () => false })
    });

    assert.match(
        await meta.getAuthenticationError(makePage("https://www.meta.ai/login")),
        /Meta AI is not authenticated/
    );
    assert.equal(await meta.getAuthenticationError(makePage("https://www.meta.ai/")), null);
});

test("Meta reply extraction returns prose without thinking controls", async () => {
    const page = {
        $$: async selector => selector === '[data-testid="assistant-message"] > .mt-4 .prose'
            ? [{ innerText: async () => "  META_PROVIDER_OK  " }]
            : selector === '[role="article"][aria-label="Meta AI response"]'
                ? [{ innerText: async () => "Show thinking\nMETA_PROVIDER_OK\nLike this response" }]
                : []
    };

    assert.equal(await meta.getLastAssistantMessage(page), "META_PROVIDER_OK");
});

test("Meta submits by clicking its send button rather than pressing Enter", async () => {
    const steps = [];
    const composer = { fill: async message => steps.push(`fill:${message}`) };
    const sendButton = {
        waitFor: async options => steps.push(`wait:${options.state}`),
        isEnabled: async () => true,
        click: async () => steps.push("click")
    };
    const page = {
        getByRole: (role, options) => {
            assert.equal(role, "button");
            assert.deepEqual(options, { name: "Send", exact: true });
            return sendButton;
        }
    };

    await meta.sendMessage(page, composer, "  test prompt  ");
    assert.deepEqual(steps, ["fill:test prompt", "wait:visible", "click"]);
});

test("Claude authentication detection distinguishes login and chat pages", async () => {
    const makePage = url => ({
        url: () => url,
        getByRole: () => ({ isVisible: async () => false })
    });

    assert.match(
        await claude.getAuthenticationError(makePage("https://claude.ai/login")),
        /Claude is not authenticated/
    );
    assert.equal(await claude.getAuthenticationError(makePage("https://claude.ai/new")), null);
});

test("Claude reply extraction returns the latest chat message", async () => {
    const page = {
        $$: async selector => selector === '[data-testid="assistant-message"] [data-cds="Prose"]'
            ? [{ innerText: async () => "  CLAUDE_PROVIDER_OK  " }]
            : selector === '[data-testid="assistant-message"]'
                ? [{ innerText: async () => "Claude responded: CLAUDEPROVIDEROK\nCLAUDE_PROVIDER_OK\nMessage actions" }]
                : []
    };

    assert.equal(await claude.getLastAssistantMessage(page), "CLAUDE_PROVIDER_OK");
});

test("Claude submits by clicking its send button rather than pressing Enter", async () => {
    const steps = [];
    const composer = { fill: async message => steps.push(`fill:${message}`) };
    const sendButton = {
        waitFor: async options => steps.push(`wait:${options.state}`),
        isEnabled: async () => true,
        click: async () => steps.push("click")
    };
    const page = {
        getByRole: (role, options) => {
            assert.equal(role, "button");
            assert.deepEqual(options, { name: "Send message", exact: true });
            return sendButton;
        }
    };

    await claude.sendMessage(page, composer, "  test prompt  ");
    assert.deepEqual(steps, ["fill:test prompt", "wait:visible", "click"]);
});

test("Gemini authentication detection distinguishes login and chat pages", async () => {
    const makePage = url => ({
        url: () => url,
        locator: () => ({ first: () => ({ isVisible: async () => true }) }),
        getByRole: () => ({ isVisible: async () => false })
    });

    assert.match(
        await gemini.getAuthenticationError(makePage("https://accounts.google.com/signin")),
        /Gemini is not authenticated/
    );
    assert.equal(await gemini.getAuthenticationError(makePage("https://gemini.google.com/app")), null);
});

test("Gemini reply extraction returns the latest model response", async () => {
    const page = {
        $$: async selector => selector === "model-response"
            ? [{ innerText: async () => "Earlier reply" }, { innerText: async () => "  GEMINI_PROVIDER_OK  " }]
            : []
    };

    assert.equal(await gemini.getLastAssistantMessage(page), "GEMINI_PROVIDER_OK");
});

test("Gemini reuses an existing conversation page instead of opening another page", async () => {
    const existingPage = { url: () => "https://gemini.google.com/app/existing" };
    let createdPage = false;
    const context = {
        pages: () => [existingPage],
        newPage: async () => {
            createdPage = true;
            return {};
        }
    };

    assert.equal(await gemini.getGeminiPage(context), existingPage);
    assert.equal(createdPage, false);
});

test("Gemini waits for the submitted prompt to appear as a user turn", async () => {
    const prompt = "Review the queue\nwith the supplied facts";
    const page = {
        $$: async selector => selector === "user-query"
            ? [
                { innerText: async () => "Earlier prompt" },
                { innerText: async () => `You said ${prompt}\n${prompt}` }
            ]
            : [],
        waitForTimeout: async () => {}
    };

    await gemini.waitForUserTurn(page, 1, prompt, 100);
});

test("Gemini waits for a saved conversation to hydrate before taking its baseline", async () => {
    const waits = [];
    const page = {
        locator: selector => {
            assert.equal(selector, "user-query");
            return {
                first: () => ({ waitFor: async options => waits.push(options) })
            };
        }
    };

    assert.equal(await gemini.waitForConversationReady(page, "https://gemini.google.com/app/existing", 1234), true);

    assert.deepEqual(waits, [{ state: "attached", timeout: 1234 }]);
});

test("Gemini falls back to a fresh chat when the saved conversation does not hydrate", async () => {
    const navigations = [];
    const page = {
        locator: () => ({
            first: () => ({ waitFor: async () => { throw new Error("Conversation was removed"); } })
        }),
        goto: async (url, options) => navigations.push({ url, options })
    };

    const loadedSavedConversation = await gemini.ensureConversationReady(
        page,
        "https://gemini.google.com/app/stale-conversation",
        10
    );

    assert.equal(loadedSavedConversation, false);
    assert.deepEqual(navigations, [{
        url: "https://gemini.google.com/app",
        options: { waitUntil: "domcontentloaded" }
    }]);
});

test("Gemini does not wait for history on a new conversation route", async () => {
    let locatedHistory = false;
    const page = {
        locator: () => {
            locatedHistory = true;
            throw new Error("No history expected");
        }
    };

    assert.equal(await gemini.waitForConversationReady(page, "https://gemini.google.com/app"), true);

    assert.equal(locatedHistory, false);
});

test("Gemini fails fast when the submitted prompt does not become a user turn", async () => {
    const page = {
        $$: async () => [{ innerText: async () => "An unrelated earlier prompt" }],
        waitForTimeout: async () => new Promise(resolve => setTimeout(resolve, 1))
    };

    await assert.rejects(
        gemini.waitForUserTurn(page, 0, "expected new prompt", 10),
        /did not submit the prompt/
    );
});

test("Gemini submits by clicking its send button rather than pressing Enter", async () => {
    const steps = [];
    const composer = { fill: async message => steps.push(`fill:${message}`) };
    const sendButton = {
        waitFor: async options => steps.push(`wait:${options.state}`),
        isEnabled: async () => true,
        click: async () => steps.push("click")
    };
    const page = {
        getByRole: (role, options) => {
            assert.equal(role, "button");
            assert.ok(options.name.test("Send message"));
            return sendButton;
        }
    };

    await gemini.sendMessage(page, composer, "  test prompt  ");
    assert.deepEqual(steps, ["fill:test prompt", "wait:visible", "click"]);
});

test("ChatGPT authentication detection distinguishes login and chat pages", async () => {
    const makePage = url => ({
        url: () => url,
        locator: () => ({ first: () => ({ isVisible: async () => true }) }),
        getByRole: () => ({ isVisible: async () => false })
    });

    assert.match(
        await getAuthenticationError(makePage("https://auth.openai.com/auth/login")),
        /ChatGPT is not authenticated/
    );
    assert.equal(await getAuthenticationError(makePage("https://chatgpt.com/c/example")), null);
});

test("ChatGPT login overlay is detected even when the composer is visible", async () => {
    const page = {
        url: () => "https://chatgpt.com/",
        locator: () => ({ first: () => ({ isVisible: async () => true }) }),
        getByRole: (role, options) => {
            assert.ok(options.name.test("Log in or create account"));
            return { isVisible: async () => true };
        }
    };

    assert.match(await getAuthenticationError(page), /ChatGPT is not authenticated/);
});

test("ChatGPT composer works when the page has no sign-in overlay", async () => {
    const page = {
        url: () => "https://chatgpt.com/",
        locator: () => ({ first: () => ({ isVisible: async () => true }) }),
        getByRole: () => ({ isVisible: async () => false })
    };

    assert.equal(await getAuthenticationError(page), null);
});

test("ChatGPT enables Think mode when it is off", async () => {
    let pressed = "false";
    let clicks = 0;
    const thinkButton = {
        waitFor: async options => assert.deepEqual(options, { state: "visible", timeout: 2000 }),
        getAttribute: async name => name === "aria-pressed" ? pressed : null,
        click: async () => {
            clicks += 1;
            pressed = "true";
        }
    };
    const page = {
        getByRole: (role, options) => {
            assert.equal(role, "button");
            assert.deepEqual(options, { name: "Think", exact: true });
            return thinkButton;
        }
    };

    await enableThinkMode(page);
    assert.equal(pressed, "true");
    assert.equal(clicks, 1);
});

test("ChatGPT can use its default mode when the Think control is unavailable", async () => {
    const page = {
        getByRole: () => ({
            waitFor: async () => {
                const error = new Error("Think control did not appear");
                error.name = "TimeoutError";
                throw error;
            }
        })
    };

    await assert.doesNotReject(enableThinkMode(page));
});

test("ChatGPT can use its default mode when Think is disabled", async () => {
    let clicks = 0;
    const page = {
        getByRole: () => ({
            waitFor: async () => {},
            getAttribute: async () => "false",
            isEnabled: async () => false,
            click: async () => { clicks += 1; }
        })
    };

    await enableThinkMode(page);
    assert.equal(clicks, 0);
});

test("ChatGPT does not toggle Think mode off when it is already enabled", async () => {
    let clicks = 0;
    const thinkButton = {
        waitFor: async () => {},
        getAttribute: async () => "true",
        click: async () => { clicks += 1; }
    };
    const page = { getByRole: () => thinkButton };

    await enableThinkMode(page);
    assert.equal(clicks, 0);
});

test("ChatGPT reply extraction returns the latest assistant message", async () => {
    const page = {
        $$: async () => [
            { innerText: async () => "Earlier reply" },
            { innerText: async () => "Latest reply" }
        ]
    };

    assert.equal(await getLastAssistantMessage(page), "Latest reply");
});

test("ChatGPT reply extraction tolerates a transient navigation during DOM queries", async () => {
    const page = {
        $$: async () => {
            throw new Error("Execution context was destroyed, most likely because of a navigation");
        }
    };

    assert.equal(await getLastAssistantMessage(page), null);
});

test("ChatGPT reply extraction supports the current assistant-message DOM", async () => {
    const page = {
        $$: async selector => selector.includes("data-chatgpt-search-unit-key")
            ? [{ innerText: async () => "  CHATGPT_THINK_MODE_OK  " }]
            : []
    };

    assert.equal(await getLastAssistantMessage(page), "CHATGPT_THINK_MODE_OK");
});

test("ChatGPT timeout diagnostics distinguish a stale assistant turn", async () => {
    const makeTurn = (key, text) => ({
        getAttribute: async name => name === "data-chatgpt-search-unit-key" ? key : null,
        innerText: async () => text
    });
    const page = {
        $$: async selector => {
            if (selector.includes("assistant") && selector.includes("data-chatgpt-search-unit-key")) {
                return [makeTurn("fallback-turn-8:2:assistant", "ChatGPT said: stale reply")];
            }
            if (selector.includes("user") && selector.includes("data-chatgpt-search-unit-key")) {
                return [makeTurn("fallback-turn-9:0:user", "Reply with exactly: CURRENT_TURN_OK")];
            }
            if (selector.includes("data-chatgpt-search-unit-key")) return [];
            if (selector.includes("data-markdown-text-style")) {
                return [{ innerText: async () => "STALE_REPLY" }];
            }
            return [];
        },
        locator: () => ({
            count: async () => 0,
            first: () => ({ isVisible: async () => false })
        }),
        waitForTimeout: async () => {}
    };

    await assert.rejects(
        waitForAssistantReply(
            page,
            "Reply with exactly: CURRENT_TURN_OK",
            "fallback-turn-8:0:user",
            "fallback-turn-8:2:assistant",
            20
        ),
        error => {
            assert.match(error.message, /ChatGPT reply not found within timeout/);
            const diagnostics = JSON.parse(error.message.match(/Diagnostics: (.+)$/)[1]);
            assert.deepEqual(diagnostics, {
                userTurnSeen: true,
                submittedMessageMatched: true,
                assistantTurnSeen: false,
                matchingTurn: false,
                replyLength: "ChatGPT said: stale reply".length,
                generating: false,
                timeoutMs: 20,
                maxTimeoutMs: 40,
                replyProgressCount: 0,
                visibleDialogCount: 0,
                composerVisible: false
            });
            return true;
        }
    );
});

test("ChatGPT accepts a completed reply when the stop button remains hidden in the DOM", async () => {
    const makeTurn = (key, text) => ({
        getAttribute: async name => name === "data-chatgpt-search-unit-key" ? key : null,
        innerText: async () => text
    });
    const userTurn = makeTurn("turn-1:0:user", "Reply with exactly: COMPLETED_TURN_OK");
    const assistantTurn = makeTurn("turn-1:1:assistant", "COMPLETED_TURN_OK");
    const page = {
        $$: async selector => {
            if (selector === '[data-message-author-role="assistant"]') return [assistantTurn];
            if (selector.includes("data-chatgpt-search-unit-key") && selector.includes("user")) return [userTurn];
            if (selector.includes("data-chatgpt-search-unit-key") && selector.includes("assistant")) return [assistantTurn];
            return [];
        },
        locator: selector => {
            assert.match(selector, /stop-button/);
            return {
                count: async () => 1,
                nth: () => ({ isVisible: async () => false })
            };
        },
        waitForTimeout: async () => {}
    };

    assert.equal(
        await waitForAssistantReply(page, "Reply with exactly: COMPLETED_TURN_OK", null, null, 100),
        "COMPLETED_TURN_OK"
    );
});

test("ChatGPT extends the reply deadline when a matched long answer is still growing", async () => {
    const message = "Provide a detailed design for a reliable workflow.";
    const makeTurn = (key, text) => ({
        getAttribute: async name => name === "data-chatgpt-search-unit-key" ? key : null,
        innerText: async () => text
    });
    const userTurn = makeTurn("turn-long:0:user", message);
    let reply = "Generating answer";
    let generating = true;
    let pollCount = 0;
    const assistantTurn = makeTurn("turn-long:1:assistant", reply);
    const page = {
        $$: async selector => {
            if (selector === '[data-message-author-role="assistant"]') {
                return [{
                    getAttribute: assistantTurn.getAttribute,
                    innerText: async () => reply
                }];
            }
            if (selector.includes("data-chatgpt-search-unit-key") && selector.includes("user")) return [userTurn];
            if (selector.includes("data-chatgpt-search-unit-key") && selector.includes("assistant")) return [assistantTurn];
            return [];
        },
        locator: () => ({
            count: async () => 1,
            nth: () => ({ isVisible: async () => generating })
        }),
        waitForTimeout: async () => new Promise(resolve => setTimeout(() => {
            pollCount += 1;
            if (pollCount === 4) reply = "A detailed answer that finished after the original wait window.";
            if (pollCount === 5) generating = false;
            resolve();
        }, 200))
    };

    assert.equal(getExpectedReplyTimeout(message), 150000);
    assert.equal(
        await waitForAssistantReply(page, message, null, null, 1000, "", 3000),
        "A detailed answer that finished after the original wait window."
    );
    assert.equal(getExpectedReplyTimeout("Reply with exactly: OK"), 90000);
});

test("ChatGPT reply progress cannot extend the wait beyond its hard timeout", async () => {
    const message = "Write a detailed report.";
    const makeTurn = (key, text) => ({
        getAttribute: async name => name === "data-chatgpt-search-unit-key" ? key : null,
        innerText: async () => text
    });
    const userTurn = makeTurn("turn-capped:0:user", message);
    let reply = "Growing";
    const assistantTurn = makeTurn("turn-capped:1:assistant", reply);
    const page = {
        $$: async selector => {
            if (selector === '[data-message-author-role="assistant"]') {
                return [{ getAttribute: assistantTurn.getAttribute, innerText: async () => reply }];
            }
            if (selector.includes("data-chatgpt-search-unit-key") && selector.includes("user")) return [userTurn];
            if (selector.includes("data-chatgpt-search-unit-key") && selector.includes("assistant")) return [assistantTurn];
            return [];
        },
        locator: () => ({
            count: async () => 1,
            nth: () => ({ isVisible: async () => true }),
            first: () => ({ isVisible: async () => false })
        }),
        waitForTimeout: async () => new Promise(resolve => setTimeout(() => {
            reply += ".";
            resolve();
        }, 50))
    };

    await assert.rejects(
        waitForAssistantReply(page, message, null, null, 100, "", 350),
        error => {
            assert.match(error.message, /ChatGPT reply not found within timeout/);
            const diagnosticsText = error.message.slice(error.message.indexOf("Diagnostics: ") + "Diagnostics: ".length);
            const diagnostics = JSON.parse(diagnosticsText);
            assert.equal(diagnostics.maxTimeoutMs, 350);
            assert.ok(diagnostics.replyProgressCount > 0);
            return true;
        }
    );
});

test("ChatGPT accepts stable new reply text when the assistant turn has no key", async () => {
    const message = "Reply with exactly: KEYLESS_TURN_OK";
    const makeTurn = (key, text) => ({
        getAttribute: async name => name === "data-chatgpt-search-unit-key" ? key : null,
        innerText: async () => text
    });
    const userTurn = makeTurn("turn-2:0:user", message);
    const page = {
        $$: async selector => {
            if (selector.includes("user")) return [userTurn];
            if (selector === '[data-message-author-role="assistant"]') {
                return [{ getAttribute: async () => null, innerText: async () => "NEW_REPLY" }];
            }
            return [];
        },
        locator: () => ({
            count: async () => 0,
            nth: () => ({ isVisible: async () => false }),
            first: () => ({ isVisible: async () => false })
        }),
        waitForTimeout: async () => {}
    };

    assert.equal(
        await waitForAssistantReply(page, message, "turn-1:0:user", "assistant-1", 100, "OLD_REPLY"),
        "NEW_REPLY"
    );
});

test("ChatGPT text-delta fallback rejects stale replies and conflicting real turn IDs", async () => {
    const message = "Reply with exactly: CURRENT_TURN_OK";
    const makeTurn = (key, text) => ({
        getAttribute: async name => name === "data-chatgpt-search-unit-key" ? key : null,
        innerText: async () => text
    });
    const userTurn = makeTurn("turn-2:0:user", message);
    const makePage = assistantTurn => ({
        $$: async selector => {
            if (selector.includes("user")) return [userTurn];
            if (selector.includes("assistant") && selector.includes("data-chatgpt-search-unit-key")) {
                return assistantTurn ? [assistantTurn] : [];
            }
            if (selector === '[data-message-author-role="assistant"]') {
                return [{ getAttribute: async () => null, innerText: async () => "NEW_REPLY" }];
            }
            return [];
        },
        locator: () => ({
            count: async () => 0,
            nth: () => ({ isVisible: async () => false }),
            first: () => ({ isVisible: async () => false })
        }),
        waitForTimeout: async () => {}
    });

    await assert.rejects(
        waitForAssistantReply(makePage(null), message, "turn-1:0:user", "assistant-1", 5, "NEW_REPLY"),
        /ChatGPT reply not found within timeout/
    );
    await assert.rejects(
        waitForAssistantReply(
            makePage(makeTurn("turn-1:1:assistant", "OLD_REPLY")),
            message,
            "turn-1:0:user",
            "turn-1:1:assistant",
            5,
            "OLD_REPLY"
        ),
        /ChatGPT reply not found within timeout/
    );
});

test("ChatGPT submits by clicking its send button rather than pressing Enter", async () => {
    const steps = [];
    const composer = {
        fill: async message => steps.push(`fill:${message}`),
        press: async () => steps.push("press")
    };
    const sendButton = {
        waitFor: async options => steps.push(`wait:${options.state}`),
        isEnabled: async () => true,
        click: async () => steps.push("click")
    };
    const page = {
        getByRole: (role, options) => {
            assert.equal(role, "button");
            assert.ok(options.name.test("Send message"));
            assert.ok(options.name.test("Send"));
            return sendButton;
        }
    };

    await sendMessage(page, composer, "  test prompt  ");
    assert.deepEqual(steps, ["fill:test prompt", "wait:visible", "click"]);
});

test("ChatGPT waits for a temporarily disabled send button to become enabled", async () => {
    const composer = { fill: async () => {} };
    let enabled = false;
    let clicked = false;
    const sendButton = {
        waitFor: async () => {},
        isEnabled: async () => enabled,
        click: async () => {
            enabled = true;
            clicked = true;
        }
    };
    const page = { getByRole: () => sendButton };

    await sendMessage(page, composer, "test prompt");
    assert.equal(clicked, true);
});

test("ChatGPT gives sign-in guidance when the send button remains disabled", async () => {
    const composer = { fill: async () => {} };
    const sendButton = {
        waitFor: async () => {},
        isEnabled: async () => false,
        click: async () => { throw new Error("click timed out"); }
    };
    const page = { getByRole: () => sendButton };

    await assert.rejects(
        sendMessage(page, composer, "test prompt"),
        /send button remained disabled.*sign in/i
    );
});

test("Copilot reuses its existing page, then falls back to an available or new page", async () => {
    const unrelatedPage = { url: () => "https://example.com/" };
    const copilotPage = { url: () => "https://copilot.microsoft.com/chat/conversation/123" };
    let createdPage = false;
    const context = {
        pages: () => [unrelatedPage, copilotPage],
        newPage: async () => {
            createdPage = true;
            return {};
        }
    };

    assert.equal(await copilot.getCopilotPage(context), copilotPage);
    assert.equal(createdPage, false);

    const fallbackPage = {};
    assert.equal(await copilot.getCopilotPage({
        pages: () => [fallbackPage],
        newPage: async () => assert.fail("Expected the existing page fallback")
    }), fallbackPage);

    let emptyContextPage;
    const emptyContext = {
        pages: () => [],
        newPage: async () => {
            emptyContextPage = {};
            return emptyContextPage;
        }
    };
    const selectedPage = await copilot.getCopilotPage(emptyContext);
    assert.equal(selectedPage, emptyContextPage);
});

test("Copilot waits for a changed assistant reply to stabilize", async () => {
    const replies = ["previous", "partial", "complete", "complete", "complete"];
    const page = {
        $$: async selector => selector === "[data-testid='lastChatMessage']"
            ? [{ innerText: async () => replies.shift() }]
            : [],
        locator: () => ({ count: async () => 0 }),
        waitForTimeout: async () => {}
    };

    assert.equal(await copilot.waitForAssistantReply(page, "previous"), "complete");
    assert.equal(replies.length, 0);
});

test("Copilot waits for generation to finish before accepting stable reply text", async () => {
    const replies = ["previous", "partial", "partial", "partial", "partial complete", "partial complete", "partial complete"];
    let reads = 0;
    const page = {
        $$: async selector => {
            if (selector !== "[data-testid='lastChatMessage']") return [];
            reads++;
            return [{ innerText: async () => replies.shift() }];
        },
        locator: selector => {
            assert.match(selector, /stop-button/);
            return {
                count: async () => 1,
                nth: () => ({ isVisible: async () => reads <= 4 })
            };
        },
        waitForTimeout: async () => {}
    };

    assert.equal(await copilot.waitForAssistantReply(page, "previous"), "partial complete");
    assert.equal(replies.length, 0);
});

test("browser session manager reuses contexts and closes each retained context", async () => {
    const manager = createBrowserSessionManager();
    const launches = new Map();
    const closes = new Map();
    const launch = provider => async () => {
        launches.set(provider, (launches.get(provider) || 0) + 1);
        return {
            on: () => {},
            close: async () => closes.set(provider, (closes.get(provider) || 0) + 1)
        };
    };

    const [firstGeminiContext, secondGeminiContext, metaContext] = await Promise.all([
        manager.getPersistentContext("gemini", launch("gemini")),
        manager.getPersistentContext("gemini", launch("gemini")),
        manager.getPersistentContext("meta", launch("meta"))
    ]);

    assert.equal(firstGeminiContext, secondGeminiContext);
    assert.notEqual(firstGeminiContext, metaContext);
    assert.equal(launches.get("gemini"), 1);
    assert.equal(launches.get("meta"), 1);

    await manager.closeAllPersistentContexts();
    assert.equal(closes.get("gemini"), 1);
    assert.equal(closes.get("meta"), 1);
});

test("job admission caps queued and running jobs but ignores terminal jobs", () => {
    const jobs = new Map([
        ["finished", { status: "completed" }],
        ["failed", { status: "failed" }],
        ["running", { status: "running" }],
        ["queued", { status: "queued" }]
    ]);

    assert.equal(hasJobCapacity(jobs, 3), true);
    jobs.set("queued-2", { status: "queued" });
    assert.equal(hasJobCapacity(jobs, 3), false);
    assert.equal(jobs.size, 5);
});

test("dashboard snapshot summarizes recent jobs, providers, and workflow progress", () => {
    const now = Date.parse("2026-06-18T12:00:00.000Z");
    const jobs = new Map([
        ["done", { id: "done", status: "completed", provider: "alpha", type: "coding", updatedAt: new Date(now - 1000).toISOString() }],
        ["failed", { id: "failed", status: "failed", provider: "alpha", type: "thinking", updatedAt: new Date(now - 2000).toISOString() }],
        ["running", { id: "running", status: "running", provider: "beta", type: "thinking", updatedAt: new Date(now - 3000).toISOString() }],
        ["old", { id: "old", status: "completed", provider: "alpha", type: "coding", updatedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString() }]
    ]);
    const workflows = new Map([[
        "workflow-1",
        {
            id: "workflow-1",
            goal: "Add a dashboard",
            updatedAt: new Date(now - 500).toISOString(),
            threads: [{ name: "Implementation", jobId: "running" }]
        }
    ]]);

    const snapshot = buildDashboardSnapshot(jobs, workflows, ["alpha", "beta"], now);

    assert.equal(snapshot.summary.jobsTracked, 4);
    assert.equal(snapshot.summary.activeJobs, 1);
    assert.equal(snapshot.summary.completedLast24Hours, 1);
    assert.equal(snapshot.summary.failedLast24Hours, 1);
    assert.equal(snapshot.summary.successRateLast24Hours, 50);
    assert.equal(snapshot.summary.codingJobsLast24Hours, 1);
    assert.equal(snapshot.summary.thinkingJobsLast24Hours, 2);
    assert.equal(snapshot.summary.activeWorkflows, 1);
    assert.equal(snapshot.providers[0].completedLast24Hours, 1);
    assert.equal(snapshot.providers[1].running, 1);
    assert.equal(snapshot.recentWorkflows[0].status, "running");
    assert.equal(snapshot.recentJobs.some(job => job.id === "old"), true);
});

test("local dashboard repository context is bounded and does not require a provider", () => {
    const summary = buildLocalRepositorySummary([
        { path: "package.json", content: JSON.stringify({ scripts: { test: "node --test" }, dependencies: { playwright: "^1.0.0" } }) },
        { path: "offloading-agent.js", content: "const token = 'sensitive-value';\n" + "x".repeat(1000) },
        { path: "offloading-agent.test.js", content: "test('workflow', () => {});" }
    ]);

    assert.match(summary.summary, /no provider was called/);
    assert.match(summary.summary, /offloading-agent\.js/);
    assert.match(summary.summary, /\[REDACTED\]/);
    assert.equal(summary.entryPoints[0], "test: node --test");
    assert.deepEqual(summary.dependencies, ["playwright"]);
    assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 5000);
});

test("dashboard is served locally with a stats endpoint", async () => {
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });

    try {
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        const page = await fetch(`${baseUrl}/`);
        assert.equal(page.status, 200);
        assert.match(page.headers.get("content-type"), /text\/html/);
        assert.match(await page.text(), /Offloading Orchestrator/);

        const script = await fetch(`${baseUrl}/dashboard.js`);
        assert.equal(script.status, 200);
        assert.match(await script.text(), /buildFeatureAdvicePayload/);

        const stats = await fetch(`${baseUrl}/api/dashboard`);
        const snapshot = await stats.json();
        assert.equal(stats.status, 200);
        assert.ok(Array.isArray(snapshot.providers));
        assert.ok(Array.isArray(snapshot.recentJobs));
        assert.ok(Array.isArray(snapshot.recentWorkflows));

        const unconfirmedContext = await fetch(`${baseUrl}/api/dashboard/repository-context`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: "Add usage statistics" })
        });
        assert.equal(unconfirmedContext.status, 400);

        const confirmedContext = await fetch(`${baseUrl}/api/dashboard/repository-context`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: "Add usage statistics", confirmedProviderSharing: true })
        });
        const contextBody = await confirmedContext.json();
        assert.equal(confirmedContext.status, 200);
        assert.match(contextBody.summary.summary, /no provider was called/);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test("vendor ranking endpoint validates skill and returns all vendors", async () => {
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });

    try {
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        const invalidResponse = await fetch(`${baseUrl}/vendors/rankings?skill=repo-summary`);
        assert.equal(invalidResponse.status, 400);

        const response = await fetch(`${baseUrl}/vendors/rankings?skill=coding`);
        const body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.skill, "coding");
        assert.equal(body.vendors.length, providerRunners.size);
        assert.equal(body.vendors[0].rank, 1);
        assert.ok(body.vendors.every(vendor => Number.isInteger(vendor.sampleCount) && vendor.sampleCount >= 0));
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test("offline providers are skipped while optional workflow synthesis continues", async () => {
    const originalRunners = new Map(providerRunners);
    const invokedProviders = [];
    for (const provider of providerRunners.keys()) {
        providerRunners.set(provider, async message => {
            invokedProviders.push(provider);
            return message.startsWith("Synthesize the independent design threads")
                ? "Synthesis from online providers"
                : `Completed by ${provider}`;
        });
    }
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });

    try {
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        const offlineResponse = await fetch(`${baseUrl}/providers/claude/availability`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ offline: true })
        });
        assert.equal(offlineResponse.status, 200);
        assert.equal((await offlineResponse.json()).offline, true);

        const snapshot = await (await fetch(`${baseUrl}/api/dashboard`)).json();
        assert.equal(snapshot.providers.find(provider => provider.name === "claude").offline, true);

        const ranking = await (await fetch(`${baseUrl}/vendors/rankings?skill=coding`)).json();
        assert.equal(ranking.vendors.find(provider => provider.provider === "claude").offline, true);

        const directResponse = await fetch(`${baseUrl}/jobs`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ confirmedProviderSharing: true, type: "thinking", provider: "claude", message: "Do not run." })
        });
        assert.equal(directResponse.status, 503);

        const createResponse = await fetch(`${baseUrl}/workflows`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                confirmedProviderSharing: true,
                goal: "Continue without Claude",
                synthesisProvider: "auto",
                threads: [
                    { name: "Claude perspective", prompt: "Optional Claude work", provider: "claude", required: false },
                    { name: "Gemini perspective", prompt: "Available vendor work", provider: "gemini", required: true }
                ]
            })
        });
        const created = await createResponse.json();
        assert.equal(createResponse.status, 202);

        const deadline = Date.now() + 5000;
        let workflow;
        do {
            workflow = await (await fetch(`${baseUrl}/workflows/${created.id}`)).json();
            if (["partial", "completed", "failed"].includes(workflow.status)) break;
            await new Promise(resolve => setTimeout(resolve, 10));
        } while (Date.now() < deadline);

        assert.equal(workflow.status, "partial");
        assert.deepEqual(workflow.threads.map(thread => thread.status), ["failed", "completed"]);
        assert.match(workflow.threads[0].job.error, /temporarily offline/);
        assert.equal(workflow.synthesis.status, "completed");
        assert.notEqual(workflow.synthesis.provider, "claude");
        assert.equal(invokedProviders.includes("claude"), false);

        const onlineResponse = await fetch(`${baseUrl}/providers/claude/availability`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ offline: false })
        });
        assert.equal(onlineResponse.status, 200);
        assert.equal((await onlineResponse.json()).offline, false);
    } finally {
        setProviderOffline("claude", false);
        await new Promise(resolve => server.close(resolve));
        for (const [provider, runner] of originalRunners) providerRunners.set(provider, runner);
    }
});

test("workflow API fans out branches, synthesizes results, and reports partial success", async () => {
    const originalRunners = new Map(providerRunners);
    const invokedMessages = [];
    for (const provider of providerRunners.keys()) {
        providerRunners.set(provider, async message => {
            invokedMessages.push(message);
            if (message.startsWith("Synthesize the independent design threads")) return "Unified design recommendation";
            if (message.includes("FAIL_BRANCH")) throw new Error("Optional branch failed");
            return `Completed: ${message.includes("REQUIRED_BRANCH") ? "required" : "optional"}`;
        });
    }

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });

    try {
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        const beforeConsentChecks = await (await fetch(`${baseUrl}/api/dashboard`)).json();
        for (const consent of [undefined, false, "true"]) {
            const body = {
                goal: "No unconfirmed workflow",
                threads: [{ name: "Perspective", provider: "copilot", prompt: "Should never run" }]
            };
            if (consent !== undefined) body.confirmedProviderSharing = consent;
            const response = await fetch(`${baseUrl}/workflows`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body)
            });
            assert.equal(response.status, 400);
            assert.match((await response.json()).error, /Confirm provider sharing/);
        }
        for (const consent of [undefined, false, "true"]) {
            const body = { type: "thinking", provider: "copilot", message: "Should never run" };
            if (consent !== undefined) body.confirmedProviderSharing = consent;
            const response = await fetch(`${baseUrl}/jobs`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body)
            });
            assert.equal(response.status, 400);
            assert.match((await response.json()).error, /Confirm provider sharing/);
        }
        const afterConsentChecks = await (await fetch(`${baseUrl}/api/dashboard`)).json();
        assert.equal(afterConsentChecks.summary.workflowsTracked, beforeConsentChecks.summary.workflowsTracked);
        assert.equal(afterConsentChecks.summary.jobsTracked, beforeConsentChecks.summary.jobsTracked);
        assert.deepEqual(invokedMessages, []);

        const invalidResponse = await fetch(`${baseUrl}/workflows`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                confirmedProviderSharing: true,
                goal: "Invalid workflow",
                threads: [
                    { prompt: "VALID" },
                    { prompt: "x".repeat(8001) }
                ]
            })
        });
        assert.equal(invalidResponse.status, 400);
        assert.deepEqual(invokedMessages, []);

        const oversizedDirectJob = await fetch(`${baseUrl}/jobs`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ confirmedProviderSharing: true, type: "coding", provider: "copilot", message: "x".repeat(9800) })
        });
        assert.equal(oversizedDirectJob.status, 400);

        const oversizedWorkflow = await fetch(`${baseUrl}/workflows`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                confirmedProviderSharing: true,
                goal: "g".repeat(4000),
                synthesisProvider: "copilot",
                threads: [{ name: "Long context", provider: "copilot", prompt: "x".repeat(8000) }]
            })
        });
        assert.equal(oversizedWorkflow.status, 400);
        assert.match((await oversizedWorkflow.json()).error, /10000 characters/);
        assert.deepEqual(invokedMessages, []);

        const createResponse = await fetch(`${baseUrl}/workflows`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                confirmedProviderSharing: true,
                goal: "Design a focused orchestration engine",
                synthesisProvider: "copilot",
                threads: [
                    { name: "Architecture", prompt: "REQUIRED_BRANCH", provider: "copilot" },
                    { name: "Risk review", prompt: "FAIL_BRANCH", provider: "gemini", required: false },
                    { name: "Implementation proposal", prompt: "CODING_BRANCH", type: "coding", provider: "chatgpt", required: false }
                ]
            })
        });
        const created = await createResponse.json();
        assert.equal(createResponse.status, 202);
        assert.equal(created.threads.length, 3);
        assert.equal(created.status, "queued");
        assert.equal(created.threads[0].job.provider, "copilot");
        assert.equal(created.threads[1].job.provider, "gemini");
        assert.equal(created.threads[2].job.provider, "chatgpt");
        assert.equal(created.threads[2].job.type, "coding");

        const deadline = Date.now() + 5000;
        let workflow;
        do {
            const response = await fetch(`${baseUrl}/workflows/${created.id}`);
            workflow = await response.json();
            if (workflow.status === "partial" || workflow.status === "completed" || workflow.status === "failed") break;
            await new Promise(resolve => setTimeout(resolve, 10));
        } while (Date.now() < deadline);

        assert.equal(workflow.status, "partial");
        assert.deepEqual(workflow.threads.map(thread => thread.status), ["completed", "failed", "completed"]);
        assert.equal(workflow.synthesis.status, "completed");
        assert.equal(workflow.synthesis.result, "Unified design recommendation");
        assert.equal(workflow.threads[1].required, false);
        assert.ok(invokedMessages.some(message => message.includes("CODING_BRANCH") && message.includes("coding job")));

        const requiredFailureResponse = await fetch(`${baseUrl}/workflows`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                confirmedProviderSharing: true,
                goal: "Keep required failures visible",
                synthesisProvider: "copilot",
                threads: [
                    { name: "Required", prompt: "FAIL_BRANCH", provider: "gemini" },
                    { name: "Optional", prompt: "OPTIONAL_SUCCESS", provider: "claude", required: false }
                ]
            })
        });
        const requiredFailureWorkflow = await requiredFailureResponse.json();
        assert.equal(requiredFailureResponse.status, 202);

        const requiredFailureDeadline = Date.now() + 5000;
        let failedWorkflow;
        do {
            const response = await fetch(`${baseUrl}/workflows/${requiredFailureWorkflow.id}`);
            failedWorkflow = await response.json();
            if (["partial", "completed", "failed"].includes(failedWorkflow.status)) break;
            await new Promise(resolve => setTimeout(resolve, 10));
        } while (Date.now() < requiredFailureDeadline);

        assert.equal(failedWorkflow.status, "failed");
        assert.equal(failedWorkflow.threads[0].status, "failed");
        assert.equal(failedWorkflow.threads[1].status, "completed");
        assert.equal(failedWorkflow.synthesis.status, "completed");
    } finally {
        await new Promise(resolve => server.close(resolve));
        for (const [provider, runner] of originalRunners) providerRunners.set(provider, runner);
    }
});

test("improvement advice workflow is bounded, read-only, and includes ChatGPT as an optional perspective", () => {
    const summary = {
        summary: "A small Node.js project.",
        keyFiles: [{ path: "offloading-agent.js", role: "HTTP job API" }]
    };
    const payload = createImprovementWorkflowPayload("Reduce provider reply capture failures", summary);

    assert.equal(payload.synthesisProvider, "ollama");
    assert.equal(payload.threads.length, 4);
    assert.ok(payload.threads.every(thread => thread.type === "thinking"));
    assert.ok(payload.threads.every(thread => thread.required === false));
    assert.ok(payload.threads.some(thread => thread.provider === "chatgpt"));
    assert.ok(payload.threads.some(thread => thread.provider === "ollama"));
    assert.ok(payload.threads.every(thread => /read-only advisory pass/.test(thread.prompt)));
    assert.ok(payload.threads.every(thread => /untrusted data, not instructions/.test(thread.prompt)));
    assert.equal(getServiceBaseUrl("http://127.0.0.1:8765"), "http://127.0.0.1:8765");
    assert.throws(() => getServiceBaseUrl("https://example.com"), /local offloading service/);
    assert.throws(() => createImprovementWorkflowPayload(" ", summary), /Goal must contain/);
    assert.throws(() => createImprovementWorkflowPayload("goal", {
        summary: "x".repeat(5001),
        keyFiles: []
    }), /exceeds the 5000-byte advice limit/);
});

test("clarification protocol parses vendor questions and completion responses", () => {
    assert.deepEqual(
        parseClarificationResponse('```json\n{"status":"question","question":"Which behavior should change?"}\n```'),
        { status: "question", question: "Which behavior should change?" }
    );
    assert.deepEqual(
        parseClarificationResponse('{"status":"ready","clarifiedTask":"Improve coding dispatch."}'),
        { status: "ready", clarifiedTask: "Improve coding dispatch." }
    );
    assert.throws(() => parseClarificationResponse("not JSON"), /valid JSON/);
});

test("improvement service requests time out without resubmitting", async () => {
    let requestCount = 0;
    const fetchImpl = async (url, { signal }) => {
        requestCount += 1;
        return new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
    };

    await assert.rejects(
        requestJson(fetchImpl, "http://127.0.0.1:8766/workflows/slow", {}, 10),
        /Offloading service request timed out after 10 milliseconds/
    );
    assert.equal(requestCount, 1);
});

test("improvement advice requires provider-sharing confirmation before any provider call", async () => {
    let requests = 0;
    await assert.rejects(runImprovementAdvice("Review this workspace", ".", {
        fetchImpl: async () => {
            requests += 1;
            throw new Error("Provider requests must not start without consent.");
        }
    }), /Confirm provider sharing/);
    assert.equal(requests, 0);
});

test("improvement advice asks and records vendor follow-ups before starting the workflow", async () => {
    const requests = [];
    let clarificationTurn = 0;
    const fetchImpl = async (url, options = {}) => {
        const method = options.method || "GET";
        const body = options.body ? JSON.parse(options.body) : null;
        requests.push({ url, method, body });

        if (method === "POST" && url.endsWith("/jobs")) {
            const id = `clarification-${++clarificationTurn}`;
            return Response.json({ id, status: "queued" });
        }
        if (method === "POST" && url.endsWith("/api/dashboard/repository-context")) {
            return Response.json({ summary: { summary: "Service summary", keyFiles: [] } });
        }
        if (method === "GET" && url.endsWith("/jobs/clarification-1")) {
            return Response.json({
                id: "clarification-1",
                status: "completed",
                result: JSON.stringify({ status: "question", question: "Should this cover direct jobs too?" })
            });
        }
        if (method === "GET" && url.endsWith("/jobs/clarification-2")) {
            return Response.json({
                id: "clarification-2",
                status: "completed",
                result: JSON.stringify({ status: "ready", clarifiedTask: "Preserve coding type through workflow and direct-job dispatch." })
            });
        }
        if (method === "POST" && url.endsWith("/workflows")) {
            return Response.json({ id: "workflow", status: "queued" });
        }
        if (method === "GET" && url.endsWith("/workflows/workflow")) {
            return Response.json({ id: "workflow", status: "completed", threads: [], synthesis: { status: "completed" } });
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
    };
    const asked = [];
    const workflow = await runImprovementAdvice("Improve coding job routing", ".", {
        fetchImpl,
        serviceUrl: "http://127.0.0.1:8765",
        confirmedProviderSharing: true,
        clarificationProvider: "chatgpt",
        askQuestion: async (question, number) => {
            asked.push({ question, number });
            return "Yes, cover direct jobs as well.";
        }
    });

    assert.equal(workflow.status, "completed");
    assert.deepEqual(asked, [{ question: "Should this cover direct jobs too?", number: 1 }]);
    assert.equal(requests[0].body.provider, "chatgpt");
    assert.equal(requests[0].body.confirmedProviderSharing, true);
    assert.match(requests.find(request => request.url.endsWith("/workflows")).body.goal, /Yes, cover direct jobs as well/);
    assert.equal(requests.find(request => request.url.endsWith("/workflows")).body.confirmedProviderSharing, true);
    const contextRequest = requests.find(request => request.url.endsWith("/api/dashboard/repository-context"));
    assert.equal(contextRequest.body.confirmedProviderSharing, true);
    assert.equal(contextRequest.body.path, ".");
    assert.match(contextRequest.body.goal, /Yes, cover direct jobs as well/);
    assert.equal(requests.some(request => request.body?.type === "repo-summary"), false);
    assert.ok(requests.findIndex(request => request.url.endsWith("/workflows")) >
        requests.findIndex(request => request.url.endsWith("/api/dashboard/repository-context")));
});

test("clarification stops after ten questions even if the provider asks for another", async () => {
    let createdJobs = 0;
    const fetchImpl = async (url, options = {}) => {
        if (options.method === "POST" && url.endsWith("/jobs")) {
            createdJobs += 1;
            return Response.json({ id: `clarification-${createdJobs}`, status: "queued" });
        }
        if (url.includes("/jobs/clarification-")) {
            return Response.json({
                id: url.split("/").pop(),
                status: "completed",
                result: JSON.stringify({ status: "question", question: `Question ${createdJobs}?` })
            });
        }
        throw new Error(`Unexpected request: ${url}`);
    };
    let asked = 0;
    const clarified = await clarifyTask("Clarify coding dispatch", {
        fetchImpl,
        serviceUrl: "http://127.0.0.1:8765",
        confirmedProviderSharing: true,
        askQuestion: async () => {
            asked += 1;
            return `Answer ${asked}`;
        }
    });

    assert.equal(asked, maxClarificationQuestions);
    assert.equal(createdJobs, maxClarificationQuestions + 1);
    assert.match(clarified, /Answer 10/);
});

test("service provider profiles are isolated from interactive browser profiles", () => {
    const profileRoot = path.resolve(process.env.OFFLOADING_AGENT_BROWSER_PROFILE_ROOT ||
        path.join(process.env.LOCALAPPDATA || process.env.HOME || process.cwd(), "OffloadingAgentProfiles"));
    const expectedNames = {
        copilot: "CopilotFreeChatProfile",
        chatgpt: "ChatGPTWebProfile",
        gemini: "GeminiWebProfile",
        claude: "ClaudeWebProfile",
        meta: "MetaAIWebProfile"
    };

    for (const [provider, profileName] of Object.entries(expectedNames)) {
        assert.equal(getServiceBrowserProfilePath(provider), path.join(profileRoot, profileName));
    }
});

test("service provider runners pass their dedicated profiles to browser providers", async () => {
    for (const provider of ["copilot", "chatgpt", "gemini", "claude", "meta"]) {
        let invocation;
        const runner = createServiceProviderRunner(provider, async (...args) => {
            invocation = args;
            return "ok";
        });

        assert.equal(await runner("health check"), "ok");
        assert.equal(invocation[0], "health check");
        assert.equal(invocation[1].keepBrowserOpen, true);
        assert.equal(invocation[1].profilePath, getServiceBrowserProfilePath(provider));
        assert.equal(invocation[1].channel, provider === "claude" ? "chrome" : undefined);
    }
});

test("dashboard follows advice workflow progress and renders completed results", async () => {
    const elements = new Map();
    const createFakeElement = () => ({
        children: [],
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; },
        addEventListener() {},
        setAttribute() {},
        scrollIntoView() {},
        reset() {},
        get lastElementChild() { return this.children.at(-1); }
    });
    const document = {
        querySelector(selector) {
            if (!elements.has(selector)) {
                const element = createFakeElement();
                if (selector === "#connection-state") element.children.push(createFakeElement(), createFakeElement());
                elements.set(selector, element);
            }
            return elements.get(selector);
        },
        createElement: createFakeElement,
        createDocumentFragment: createFakeElement
    };
    let workflowPolls = 0;
    const fetch = async url => {
        if (url === "/api/dashboard") {
            return {
                ok: true,
                json: async () => ({
                    generatedAt: new Date().toISOString(),
                    summary: {
                        activeJobs: 0,
                        activeWorkflows: 0,
                        completedLast24Hours: 0,
                        successRateLast24Hours: null,
                        failedLast24Hours: 0,
                        codingJobsLast24Hours: 0,
                        thinkingJobsLast24Hours: 0,
                        jobsTracked: 0
                    },
                    providers: [],
                    recentJobs: [],
                    recentWorkflows: []
                })
            };
        }
        if (url === "/workflows/workflow-1") {
            workflowPolls += 1;
            const status = workflowPolls === 1 ? "running" : "completed";
            return {
                ok: true,
                json: async () => ({
                    id: "workflow-1",
                    status,
                    threads: [{
                        name: "Implementation proposal",
                        status: "completed",
                        job: { result: "A practical first release." }
                    }],
                    synthesis: { status: "completed", result: "Ship the smallest useful version." }
                })
            };
        }
        throw new Error(`Unexpected dashboard request: ${url}`);
    };
    const context = {
        document,
        fetch,
        setInterval() {},
        setTimeout(callback) { queueMicrotask(callback); }
    };
    const dashboardSource = await fs.readFile(path.join(__dirname, "dashboard.js"), "utf8");
    vm.runInNewContext(dashboardSource, context);

    await context.waitForWorkflow("workflow-1");

    const collectText = element => [element.textContent || "", ...element.children.map(collectText)].join(" ");
    assert.equal(workflowPolls, 2);
    assert.match(collectText(elements.get("#workflow-detail")), /A practical first release/);
    assert.match(collectText(elements.get("#workflow-detail")), /Ship the smallest useful version/);
    assert.match(elements.get("#advice-status").textContent, /workflow completed/);

    const partialWorkflow = {
        id: "workflow-2",
        goal: "Improve provider outcomes",
        status: "partial",
        updatedAt: new Date().toISOString(),
        threads: [
            { name: "Architecture", status: "completed", job: { provider: "claude", result: "Keep the change small." } },
            { name: "Testing", status: "failed", job: { provider: "gemini", error: "Provider unavailable." } }
        ],
        synthesis: { status: "completed", result: "Show branch outcomes." }
    };
    context.renderWorkflows([partialWorkflow]);
    assert.match(collectText(elements.get("#workflow-list")), /1\/2 perspectives completed · 1 failed/);
    context.renderWorkflowDetail(partialWorkflow);
    const detailText = collectText(elements.get("#workflow-detail"));
    assert.match(detailText, /1 of 2 perspectives completed · partial results · 1 failed/);
    assert.match(detailText, /claude · Architecture · completed/);
    assert.match(detailText, /gemini · Testing · failed/);
    assert.match(detailText, /Provider failed to complete this perspective/);
    assert.doesNotMatch(detailText, /Provider unavailable/);
});