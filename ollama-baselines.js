const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const assessmentValues = new Set(["pass", "partial", "fail", "incomplete"]);
const runStatusValues = new Set(["completed", "failed", "timeout"]);
let writeQueue = Promise.resolve();

function validateOllamaBaselineRun(run) {
    if (!run || typeof run !== "object" || Array.isArray(run) ||
        typeof run.runId !== "string" || !/^[a-zA-Z0-9._:-]{1,100}$/.test(run.runId) ||
        typeof run.task !== "string" || !run.task.trim() || run.task.length > 300 ||
        !new Set(["coding", "thinking"]).has(run.skill) ||
        !new Set(["small", "medium", "large"]).has(run.size) ||
        typeof run.testedAt !== "string" || !Number.isFinite(Date.parse(run.testedAt))) {
        throw new Error("Ollama baseline run metadata did not match the required format.");
    }
    const settings = run.settings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings) ||
        typeof settings.temperature !== "number" || !Number.isFinite(settings.temperature) ||
        !Number.isInteger(settings.contextTokens) || settings.contextTokens < 1 ||
        !Number.isInteger(settings.outputTokens) || settings.outputTokens < 1 ||
        typeof settings.think !== "boolean") {
        throw new Error("Ollama baseline settings did not match the required format.");
    }
    if (!Array.isArray(run.results) || run.results.length === 0 || run.results.length > 100) {
        throw new Error("Ollama baseline run must contain between 1 and 100 model results.");
    }

    const models = new Set();
    const results = run.results.map(result => {
        if (!result || typeof result !== "object" || Array.isArray(result) ||
            typeof result.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(result.model) ||
            models.has(result.model) || !runStatusValues.has(result.runStatus) ||
            !assessmentValues.has(result.assessment) ||
            (result.note !== undefined && (typeof result.note !== "string" || result.note.length > 500))) {
            throw new Error("Ollama baseline model result did not match the required format.");
        }
        models.add(result.model);
        for (const field of ["elapsedSeconds", "loadSeconds", "generationTokensPerSecond"]) {
            if (result[field] !== undefined && result[field] !== null &&
                (typeof result[field] !== "number" || !Number.isFinite(result[field]) || result[field] < 0)) {
                throw new Error(`Ollama baseline '${field}' must be a non-negative number.`);
            }
        }
        for (const field of ["promptTokens", "outputTokens"]) {
            if (result[field] !== undefined && result[field] !== null &&
                (!Number.isInteger(result[field]) || result[field] < 0)) {
                throw new Error(`Ollama baseline '${field}' must be a non-negative integer.`);
            }
        }
        if (result.doneReason !== undefined && result.doneReason !== null &&
            (typeof result.doneReason !== "string" || result.doneReason.length > 100)) {
            throw new Error("Ollama baseline doneReason must be a string of at most 100 characters.");
        }
        return {
            model: result.model,
            runStatus: result.runStatus,
            assessment: result.assessment,
            ...(result.elapsedSeconds !== undefined ? { elapsedSeconds: result.elapsedSeconds } : {}),
            ...(result.loadSeconds !== undefined ? { loadSeconds: result.loadSeconds } : {}),
            ...(result.promptTokens !== undefined ? { promptTokens: result.promptTokens } : {}),
            ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
            ...(result.generationTokensPerSecond !== undefined
                ? { generationTokensPerSecond: result.generationTokensPerSecond } : {}),
            ...(result.doneReason !== undefined ? { doneReason: result.doneReason } : {}),
            ...(result.note ? { note: result.note } : {})
        };
    });

    return {
        runId: run.runId,
        task: run.task.trim(),
        skill: run.skill,
        size: run.size,
        testedAt: new Date(run.testedAt).toISOString(),
        settings: {
            temperature: settings.temperature,
            contextTokens: settings.contextTokens,
            outputTokens: settings.outputTokens,
            think: settings.think
        },
        results
    };
}

async function readOllamaBaselineRuns(filePath) {
    let content;
    try {
        content = await fs.readFile(filePath, "utf8");
    } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
    }
    let data;
    try {
        data = JSON.parse(content);
    } catch {
        throw new Error("Saved Ollama baselines are not valid JSON.");
    }
    if (!data || typeof data !== "object" || Array.isArray(data) || data.version !== 1 || !Array.isArray(data.runs)) {
        throw new Error("Saved Ollama baselines did not match the required format.");
    }
    return data.runs.map(validateOllamaBaselineRun);
}

async function persistOllamaBaselineRun(input, filePath) {
    let run;
    try {
        run = validateOllamaBaselineRun(input);
    } catch (error) {
        error.statusCode = 400;
        throw error;
    }
    const operation = writeQueue.then(async () => {
        const runs = await readOllamaBaselineRuns(filePath);
        if (runs.some(existing => existing.runId === run.runId)) {
            const error = new Error("This Ollama baseline run has already been recorded.");
            error.statusCode = 409;
            throw error;
        }
        const directory = path.dirname(filePath);
        const temporaryPath = path.join(directory, `${path.basename(filePath)}.${randomUUID()}.tmp`);
        await fs.mkdir(directory, { recursive: true });
        try {
            await fs.writeFile(temporaryPath, JSON.stringify({ version: 1, runs: [...runs, run] }, null, 2), { flag: "wx" });
            await fs.rename(temporaryPath, filePath);
        } catch (error) {
            await fs.rm(temporaryPath, { force: true }).catch(() => {});
            throw error;
        }
        return run;
    });
    writeQueue = operation.catch(() => {});
    return operation;
}

function getLatestOllamaBaselines(runs, skill, size) {
    const latest = new Map();
    for (const run of runs) {
        if ((skill && run.skill !== skill) || (size && run.size !== size)) continue;
        for (const result of run.results) {
            const current = latest.get(result.model);
            if (!current || Date.parse(run.testedAt) >= Date.parse(current.testedAt)) {
                latest.set(result.model, {
                    runId: run.runId,
                    task: run.task,
                    skill: run.skill,
                    size: run.size,
                    testedAt: run.testedAt,
                    settings: run.settings,
                    ...result
                });
            }
        }
    }
    return Object.fromEntries(latest);
}

function getBaselineModelCatalog(runs) {
    const names = new Set(runs.flatMap(run => run.results.map(result => result.model)));
    return [...names].sort((left, right) => left.localeCompare(right)).map(name => ({ name }));
}

module.exports = {
    getBaselineModelCatalog,
    getLatestOllamaBaselines,
    persistOllamaBaselineRun,
    readOllamaBaselineRuns,
    validateOllamaBaselineRun
};
