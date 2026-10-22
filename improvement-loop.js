const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const cloudProviders = new Set(["copilot", "chatgpt", "gemini", "claude", "meta"]);
const stateVersion = 1;
const lockStaleAfterMs = 2 * 60 * 1000;
const maxStateBytes = 32 * 1024;
const maxCycles = 10;
const maxProviderCalls = 50;
const maxSearches = 20;
const maxWindowMinutes = 12 * 60;
const cycleExecution = "not implemented";

class StateFileError extends Error {}

function getDefaultStateDirectory(workspacePath = process.env.WORKSPACE_ROOT || process.cwd()) {
    const workspace = fs.realpathSync(path.resolve(workspacePath));
    const workspaceKey = createHash("sha256").update(workspace).digest("hex").slice(0, 20);
    return path.join(process.env.LOCALAPPDATA || os.homedir(), "OffloadingAgent", "ImprovementLoop", workspaceKey);
}

function ensureDirectory(directory) {
    const resolved = path.resolve(directory);
    const root = path.parse(resolved).root;
    let current = root;

    for (const segment of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        try {
            const stat = fs.lstatSync(current);
            if (stat.isSymbolicLink()) throw new Error(`State path must not contain a symbolic link: ${current}`);
            if (!stat.isDirectory()) throw new Error(`State path component is not a directory: ${current}`);
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            try {
                fs.mkdirSync(current, { mode: 0o700 });
            } catch (createError) {
                if (createError.code !== "EEXIST") throw createError;
                const stat = fs.lstatSync(current);
                if (stat.isSymbolicLink() || !stat.isDirectory()) {
                    throw new Error(`State path component is unsafe: ${current}`);
                }
            }
        }
    }
    return resolved;
}

function getPaths(stateDirectory) {
    const directory = ensureDirectory(stateDirectory);
    return {
        directory,
        state: path.join(directory, "run-state.json"),
        lock: path.join(directory, "tick.lock"),
        recoveryLock: path.join(directory, "tick-recovery.lock"),
        stop: path.join(directory, "STOP")
    };
}

function fileExists(filePath) {
    try {
        const stat = fs.lstatSync(filePath);
        if (stat.isSymbolicLink()) throw new Error(`State file must not be a symbolic link: ${filePath}`);
        if (!stat.isFile()) throw new Error(`State path is not a regular file: ${filePath}`);
        return true;
    } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
    }
}

function readJsonFile(filePath) {
    if (!fileExists(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (stat.size > maxStateBytes) throw new StateFileError(`State file exceeds the ${maxStateBytes}-byte limit.`);
    let value;
    try {
        value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
        if (error instanceof SyntaxError) throw new StateFileError("State file contains invalid JSON.");
        throw error;
    }
    return value;
}

function atomicWriteJson(filePath, value) {
    const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
    const content = JSON.stringify(value, null, 2);
    if (Buffer.byteLength(content) > maxStateBytes) throw new Error("State data exceeds the configured size limit.");

    let descriptor;
    try {
        descriptor = fs.openSync(temporaryPath, "wx", 0o600);
        fs.writeFileSync(descriptor, content, "utf8");
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporaryPath, filePath);
    } catch (error) {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        if (fileExists(temporaryPath)) fs.unlinkSync(temporaryPath);
        throw error;
    }
}

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error.code === "ESRCH") return false;
        if (error.code === "EPERM") return true;
        throw error;
    }
}

function readLock(lockPath) {
    const lock = readJsonFile(lockPath);
    if (!lock) return null;
    if (!Number.isInteger(lock.pid) || lock.pid < 1 ||
        typeof lock.token !== "string" || !lock.token ||
        typeof lock.startedAt !== "string" || !Number.isFinite(Date.parse(lock.startedAt))) {
        throw new Error("Lock file is malformed; manual recovery is required.");
    }
    return lock;
}

function createLock(lockPath, token, pid, now) {
    let descriptor;
    try {
        descriptor = fs.openSync(lockPath, "wx", 0o600);
        fs.writeFileSync(descriptor, JSON.stringify({
            pid,
            token,
            startedAt: now.toISOString()
        }), "utf8");
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        return true;
    } catch (error) {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        if (error.code === "EEXIST") return false;
        if (fileExists(lockPath)) fs.unlinkSync(lockPath);
        throw error;
    }
}

function releaseLock(lockPath, token) {
    const lock = readLock(lockPath);
    if (!lock || lock.token !== token) throw new Error("Loop lock ownership changed; refusing to release it.");
    fs.unlinkSync(lockPath);
}

function isStaleLock(lock, now, processAlive) {
    const age = now.getTime() - Date.parse(lock.startedAt);
    return age >= lockStaleAfterMs && !processAlive(lock.pid);
}

function acquireLock(paths, now, processAlive, pid) {
    const token = randomUUID();
    if (createLock(paths.lock, token, pid, now)) return token;

    const observed = readLock(paths.lock);
    if (!observed || !isStaleLock(observed, now, processAlive)) return null;

    const recoveryToken = randomUUID();
    if (!createLock(paths.recoveryLock, recoveryToken, pid, now)) return null;
    try {
        const current = readLock(paths.lock);
        if (current && current.token === observed.token && isStaleLock(current, now, processAlive)) {
            const stalePath = path.join(paths.directory, `stale-${randomUUID()}.lock`);
            try {
                fs.renameSync(paths.lock, stalePath);
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
            }
            if (fileExists(stalePath)) fs.unlinkSync(stalePath);
        }
    } finally {
        releaseLock(paths.recoveryLock, recoveryToken);
    }

    return createLock(paths.lock, token, pid, now) ? token : null;
}

function validateStartOptions(options, now) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
        throw new Error("Run configuration must be an object.");
    }
    if (options.confirmedProviderSharing !== true) {
        throw new Error("Pass --confirm-provider-sharing to authorize provider sharing for this run.");
    }
    if (!Array.isArray(options.providers) || options.providers.length === 0 ||
        options.providers.length > cloudProviders.size ||
        options.providers.some(provider => !cloudProviders.has(provider)) ||
        new Set(options.providers).size !== options.providers.length) {
        throw new Error(`Providers must be a unique non-empty list from: ${[...cloudProviders].join(", ")}. Ollama is not available.`);
    }
    const integerInRange = (value, minimum, maximum) =>
        Number.isInteger(value) && value >= minimum && value <= maximum;
    if (!integerInRange(options.maxCycles, 1, maxCycles)) {
        throw new Error(`maxCycles must be an integer from 1 to ${maxCycles}.`);
    }
    if (!integerInRange(options.maxProviderCalls, 1, maxProviderCalls)) {
        throw new Error(`maxProviderCalls must be an integer from 1 to ${maxProviderCalls}.`);
    }
    if (!integerInRange(options.maxSearches, 0, maxSearches)) {
        throw new Error(`maxSearches must be an integer from 0 to ${maxSearches}.`);
    }
    if (!integerInRange(options.windowMinutes, 5, maxWindowMinutes)) {
        throw new Error(`windowMinutes must be an integer from 5 to ${maxWindowMinutes}.`);
    }
    return {
        providers: [...options.providers].sort(),
        maxCycles: options.maxCycles,
        maxProviderCalls: options.maxProviderCalls,
        maxSearches: options.maxSearches,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + options.windowMinutes * 60 * 1000).toISOString(),
        providerSharingAuthorizedAt: now.toISOString()
    };
}

function hashAuthorization(authorization) {
    return createHash("sha256").update(JSON.stringify(authorization)).digest("hex");
}

function hashState(state) {
    const content = { ...state };
    delete content.stateHash;
    return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

function writeState(filePath, state) {
    const sealedState = { ...state, stateHash: hashState(state) };
    atomicWriteJson(filePath, sealedState);
    Object.assign(state, sealedState);
    return state;
}

function validateState(state) {
    if (!state || typeof state !== "object" || Array.isArray(state) ||
        state.version !== stateVersion ||
        typeof state.runId !== "string" ||
        !["configured", "stopped", "expired", "halted"].includes(state.status) ||
        state.cycleExecution !== cycleExecution ||
        state.budgetStatus !== "configured, unused" ||
        !Number.isInteger(state.tickCount) || state.tickCount < 0 ||
        !state.usage || typeof state.usage !== "object" ||
        ["cycles", "providerCalls", "searches", "patches"].some(key =>
            !Number.isInteger(state.usage[key]) || state.usage[key] < 0
        ) ||
        typeof state.updatedAt !== "string" || !Number.isFinite(Date.parse(state.updatedAt)) ||
        !state.authorization || typeof state.authorization !== "object" ||
        typeof state.authorizationHash !== "string" ||
        state.authorizationHash !== hashAuthorization(state.authorization) ||
        typeof state.stateHash !== "string" ||
        state.stateHash !== hashState(state)) {
        throw new StateFileError("Run state is invalid or has an unsupported version; it was not changed.");
    }
    if (!Number.isFinite(Date.parse(state.authorization.expiresAt)) ||
        !Number.isFinite(Date.parse(state.authorization.createdAt)) ||
        !Number.isFinite(Date.parse(state.authorization.providerSharingAuthorizedAt))) {
        throw new StateFileError("Run authorization timestamps are invalid; it was not changed.");
    }
    try {
        validateStartOptions({
            confirmedProviderSharing: true,
            providers: state.authorization.providers,
            maxCycles: state.authorization.maxCycles,
            maxProviderCalls: state.authorization.maxProviderCalls,
            maxSearches: state.authorization.maxSearches,
            windowMinutes: Math.round((Date.parse(state.authorization.expiresAt) -
                Date.parse(state.authorization.createdAt)) / 60000)
        }, new Date(state.authorization.createdAt));
    } catch (error) {
        throw new StateFileError(`Run authorization is invalid; it was not changed: ${error.message}`);
    }
    return state;
}

function terminalStatus(status) {
    return ["stopped", "expired", "halted"].includes(status);
}

function createImprovementLoop(options = {}) {
    const stateDirectory = path.resolve(options.stateDirectory || getDefaultStateDirectory(options.workspacePath));
    const nowFunction = options.now || (() => new Date());
    const processAlive = options.isProcessAlive || isProcessAlive;
    const pid = options.pid || process.pid;

    function currentTime() {
        const now = nowFunction();
        if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
            throw new Error("The loop clock returned an invalid time.");
        }
        return now;
    }

    function paths() {
        return getPaths(stateDirectory);
    }

    function readState(filePath) {
        const state = readJsonFile(filePath);
        return state === null ? null : validateState(state);
    }

    function withLock(pathsValue, action) {
        const token = acquireLock(pathsValue, currentTime(), processAlive, pid);
        if (!token) return { locked: true };
        try {
            return { locked: false, value: action() };
        } finally {
            releaseLock(pathsValue.lock, token);
        }
    }

    function start(configuration) {
        const pathsValue = paths();
        const now = currentTime();
        const authorization = validateStartOptions(configuration, now);
        const result = withLock(pathsValue, () => {
            const existing = readState(pathsValue.state);
            if (existing && !terminalStatus(existing.status) && fileExists(pathsValue.stop)) {
                existing.status = "stopped";
                existing.stopReason = "kill-switch";
                existing.updatedAt = currentTime().toISOString();
                writeState(pathsValue.state, existing);
            }
            if (existing && !terminalStatus(existing.status) &&
                currentTime().getTime() >= Date.parse(existing.authorization.expiresAt)) {
                existing.status = "expired";
                existing.stopReason = "authorization-window-ended";
                existing.updatedAt = currentTime().toISOString();
                writeState(pathsValue.state, existing);
            }
            if (existing && !terminalStatus(existing.status)) {
                throw new Error("An improvement-loop run already exists; stop or expire it before starting another.");
            }
            if (fileExists(pathsValue.stop)) fs.unlinkSync(pathsValue.stop);
            const state = {
                version: stateVersion,
                runId: randomUUID(),
                status: "configured",
                cycleExecution,
                budgetStatus: "configured, unused",
                authorization,
                authorizationHash: hashAuthorization(authorization),
                tickCount: 0,
                usage: { cycles: 0, providerCalls: 0, searches: 0, patches: 0 },
                updatedAt: now.toISOString()
            };
            writeState(pathsValue.state, state);
            return state;
        });
        if (result.locked) throw new Error("Loop state is locked by another process; start was not performed.");
        return result.value;
    }

    function status() {
        const pathsValue = paths();
        const state = readState(pathsValue.state);
        if (!state) return { status: fileExists(pathsValue.stop) ? "stop-requested" : "idle", cycleExecution };
        return {
            ...state,
            ...(fileExists(pathsValue.stop) && !terminalStatus(state.status) ? { stopRequested: true } : {})
        };
    }

    function tick() {
        const pathsValue = paths();
        const result = withLock(pathsValue, () => {
            const now = currentTime();
            if (fileExists(pathsValue.stop)) {
                let state;
                try {
                    state = readState(pathsValue.state);
                } catch (error) {
                    if (!(error instanceof StateFileError)) throw error;
                    return {
                        status: "stop-requested",
                        cycleExecution,
                        message: "Kill switch is set; run state is invalid and was not changed. No cycle was executed."
                    };
                }
                if (!state) {
                    return {
                        status: "stop-requested",
                        cycleExecution,
                        message: "Kill switch is set; no cycle was executed."
                    };
                }
                if (!terminalStatus(state.status)) {
                    state.status = "stopped";
                    state.stopReason = "kill-switch";
                    state.updatedAt = now.toISOString();
                    writeState(pathsValue.state, state);
                }
                return { ...state, message: "Kill switch is set; no cycle was executed." };
            }

            const state = readState(pathsValue.state);
            if (!state) {
                return {
                    status: "idle",
                    cycleExecution,
                    message: "No run is configured; no cycle was executed."
                };
            }
            if (terminalStatus(state.status)) {
                return { ...state, message: `Run is ${state.status}; no cycle was executed.` };
            }
            if (now.getTime() < Date.parse(state.updatedAt)) {
                state.status = "halted";
                state.stopReason = "clock-moved-backwards";
                writeState(pathsValue.state, state);
                return { ...state, message: "System clock moved backwards; run halted without executing a cycle." };
            }
            if (now.getTime() >= Date.parse(state.authorization.expiresAt)) {
                state.status = "expired";
                state.stopReason = "authorization-window-ended";
                state.updatedAt = now.toISOString();
                writeState(pathsValue.state, state);
                return { ...state, message: "Authorization window ended; no cycle was executed." };
            }

            state.tickCount += 1;
            state.updatedAt = now.toISOString();
            writeState(pathsValue.state, state);
            return {
                ...state,
                message: `Bookkeeping tick ${state.tickCount} recorded; cycle execution is not implemented.`
            };
        });
        if (result.locked) return { status: "locked", cycleExecution, message: "Tick skipped because another process holds the loop lock." };
        return result.value;
    }

    function stop() {
        const pathsValue = paths();
        if (!fileExists(pathsValue.stop)) {
            let descriptor;
            try {
                descriptor = fs.openSync(pathsValue.stop, "wx", 0o600);
                fs.writeFileSync(descriptor, JSON.stringify({ requestedAt: currentTime().toISOString() }), "utf8");
                fs.fsyncSync(descriptor);
                fs.closeSync(descriptor);
                descriptor = undefined;
            } catch (error) {
                if (descriptor !== undefined) fs.closeSync(descriptor);
                if (error.code !== "EEXIST") throw error;
            }
        }

        const result = withLock(pathsValue, () => {
            const state = readState(pathsValue.state);
            if (!state || terminalStatus(state.status)) return state || { status: "stop-requested", cycleExecution };
            state.status = "stopped";
            state.stopReason = "user-request";
            state.updatedAt = currentTime().toISOString();
            writeState(pathsValue.state, state);
            return state;
        });
        return result.locked
            ? { status: "stop-requested", cycleExecution, message: "Stop signal recorded; the next tick will observe it." }
            : result.value;
    }

    return { start, status, tick, stop };
}

function parseArguments(args) {
    const [command = "status", ...values] = args;
    if (!["start", "status", "tick", "stop"].includes(command)) {
        throw new Error("Command must be start, status, tick, or stop.");
    }
    if (command !== "start") {
        if (values.length > 0) throw new Error(`${command} does not accept options.`);
        return { command };
    }

    const configuration = { providers: [] };
    for (let index = 0; index < values.length; index += 1) {
        const value = values[index];
        if (value === "--confirm-provider-sharing") {
            configuration.confirmedProviderSharing = true;
        } else {
            const flags = {
                "--providers": "providers",
                "--max-cycles": "maxCycles",
                "--max-provider-calls": "maxProviderCalls",
                "--max-searches": "maxSearches",
                "--window-minutes": "windowMinutes"
            };
            const key = flags[value];
            if (!key) throw new Error(`Unknown option: ${value}`);
            if (!values[index + 1] || values[index + 1].startsWith("--")) {
                throw new Error(`${value} requires a value.`);
            }
            const rawValue = values[++index];
            configuration[key] = key === "providers"
                ? rawValue.split(",").map(provider => provider.trim()).filter(Boolean)
                : Number(rawValue);
        }
    }
    return { command, configuration };
}

function main(args = process.argv.slice(2)) {
    const parsed = parseArguments(args);
    const loop = createImprovementLoop();
    let result;
    if (parsed.command === "start") result = loop.start(parsed.configuration);
    else if (parsed.command === "status") result = loop.status();
    else if (parsed.command === "tick") result = loop.tick();
    else result = loop.stop();
    console.log(JSON.stringify(result, null, 2));
    console.log(`Cycle execution: ${cycleExecution}. No provider calls, searches, patches, or commands were executed.`);
    console.log(`Budgets: ${result.authorization ? "configured, unused" : "not configured"}.`);
    return result;
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = {
    cloudProviders,
    createImprovementLoop,
    getDefaultStateDirectory,
    parseArguments
};
