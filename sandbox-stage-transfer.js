"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { candidateTestFilename } = require("./candidate-diff");
const {
    excludedDirectories,
    hasRelativePathCollision,
    isCredentialRelativePath,
    normalizeRelativePath
} = require("./safe-relative-path");
const { snapshotLimits } = require("./workspace-snapshot");

const dockerContext = "desktop-linux";
const dockerEndpoint = "npipe:////./pipe/dockerDesktopLinuxEngine";
const imageReference = "node@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205";
const imageDigest = "sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205";
const expectedImageId = imageDigest;
const memoryLimitBytes = 256 * 1024 * 1024;
const cpuLimitNanoCpus = 500000000;
const processLimit = 32;
const dockerCallTimeoutMs = 60000;
const maxDockerOutputBytes = 2 * 1024 * 1024;
const maxTransferBytes = snapshotLimits.maxTotalBytes;
const maxTransferFiles = snapshotLimits.maxFiles;
const maxTransferFileBytes = snapshotLimits.maxFileBytes;
const maxTransferPayloadBytes = 32 * 1024 * 1024;
const tmpfsSize = "32m";
const evaluationTimeoutMs = 15000;
const evaluationStreamLimitBytes = 8 * 1024;
const idleScript = "setTimeout(() => process.exit(0), 300000)";
const receiverScript = String.raw`
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const inputLimit = ${maxTransferPayloadBytes};
const chunks = [];
let inputBytes = 0;

process.stdin.on("data", chunk => {
    inputBytes += chunk.length;
    if (inputBytes > inputLimit) throw new Error("transfer-input-limit-exceeded");
    chunks.push(chunk);
});

process.stdin.on("end", () => {
    const payload = JSON.parse(Buffer.concat(chunks, inputBytes).toString("utf8"));
    if (!payload ||
        !Array.isArray(payload.files) ||
        payload.files.length < 1 ||
        payload.files.length > ${maxTransferFiles} ||
        !/^[a-f0-9]{64}$/.test(payload.stagedSnapshotHash)) {
        throw new Error("invalid-transfer-manifest");
    }

    const root = "/tmp/stage";
    fs.mkdirSync(root, { mode: 0o700 });
    const names = new Set();
    const fileNameKeys = new Set(payload.files.map(file =>
        typeof file?.name === "string" ? file.name.toLowerCase() : ""
    ));
    const componentNames = new Map();
    const directoryKeys = new Set();
    const files = [];
    let totalBytes = 0;
    function safeRelativeName(name) {
        if (typeof name !== "string" ||
            name.length === 0 ||
            name.length > 240 ||
            name.includes("\\") ||
            name.includes("\0") ||
            name.startsWith("/") ||
            /^[a-z]:/i.test(name) ||
            name.normalize("NFC") !== name) return false;
        const parts = name.split("/");
        if (parts.length > 32 || parts.some(part =>
            !part ||
            part === "." ||
            part === ".." ||
            part.length > 255 ||
            /[<>:"|?*\x00-\x1f]/.test(part) ||
            /[ .]$/.test(part) ||
            /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
            ["${[...excludedDirectories].join('","')}"].includes(part.toLowerCase())
        )) return false;
        const sensitive = parts.some(part => {
            const lower = part.toLowerCase();
            return lower.startsWith(".env") ||
                /(^|[._-])(secret|secrets|credential|credentials|private|token)([._-]|$)/i.test(lower) ||
                lower === ".npmrc" ||
                lower === ".netrc" ||
                lower === ".pypirc" ||
                lower === ".git-credentials" ||
                lower === "auth.json" ||
                lower.endsWith("-auth-state.json") ||
                lower.startsWith("id_rsa") ||
                lower.startsWith("id_ed25519") ||
                /\.(?:pem|key|p12|pfx|kdbx)$/.test(lower);
        });
        return !sensitive;
    }
    function collectEntries(directory, relativeDirectory, result) {
        for (const child of fs.readdirSync(directory)) {
            const relativeName = relativeDirectory ? relativeDirectory + "/" + child : child;
            const stat = fs.lstatSync(path.join(directory, child));
            if (stat.isSymbolicLink()) throw new Error("transferred-symlink-detected");
            if (stat.isDirectory()) {
                result.push("d:" + relativeName);
                collectEntries(path.join(directory, child), relativeName, result);
            } else if (stat.isFile() && stat.nlink === 1) {
                result.push("f:" + relativeName);
            } else {
                throw new Error("transferred-unsupported-object");
            }
        }
    }
    for (const expected of payload.files) {
        if (!safeRelativeName(expected.name) ||
            !Number.isSafeInteger(expected.size) ||
            expected.size < 0 ||
            expected.size > ${maxTransferFileBytes} ||
            !/^[a-f0-9]{64}$/.test(expected.digest) ||
            typeof expected.contentBase64 !== "string" ||
            names.has(expected.name.toLowerCase()) ||
            !normalizeNameMatches(expected.name)) {
            throw new Error("invalid-transfer-entry");
        }
        const parts = expected.name.split("/");
        for (let index = 0; index < parts.length; index++) {
            const prefix = parts.slice(0, index + 1).join("/");
            const canonicalPrefix = prefix.toLowerCase();
            const existingPrefix = componentNames.get(canonicalPrefix);
            if (existingPrefix && existingPrefix !== prefix) {
                throw new Error("transfer-path-case-collision");
            }
            componentNames.set(canonicalPrefix, prefix);
            if (index < parts.length - 1) {
                if (names.has(canonicalPrefix) || fileNameKeys.has(canonicalPrefix)) {
                    throw new Error("transfer-file-directory-collision");
                }
                directoryKeys.add(canonicalPrefix);
            }
        }
        if (directoryKeys.has(expected.name.toLowerCase())) {
            throw new Error("transfer-file-directory-collision");
        }
        names.add(expected.name.toLowerCase());
        const content = Buffer.from(expected.contentBase64, "base64");
        if (content.toString("base64") !== expected.contentBase64 ||
            content.length !== expected.size ||
            crypto.createHash("sha256").update(content).digest("hex") !== expected.digest) {
            throw new Error("transfer-input-content-mismatch");
        }
        totalBytes += content.length;
        if (totalBytes > ${maxTransferBytes}) throw new Error("transfer-size-limit-exceeded");
        let directory = root;
        for (const part of parts.slice(0, -1)) {
            directory = path.join(directory, part);
            try {
                fs.mkdirSync(directory, { mode: 0o700 });
            } catch (error) {
                if (error.code !== "EEXIST") throw error;
            }
            const directoryStat = fs.lstatSync(directory);
            if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
                throw new Error("transfer-parent-directory-mismatch");
            }
        }
        const filePath = path.resolve(root, ...parts);
        if (!filePath.startsWith(root + path.sep)) throw new Error("transfer-path-escape");
        fs.writeFileSync(filePath, content, { flag: "wx", mode: 0o444 });
    }

    const expectedEntries = new Set();
    for (const file of payload.files) {
        expectedEntries.add("f:" + file.name);
        const parts = file.name.split("/");
        for (let index = 1; index < parts.length; index++) {
            expectedEntries.add("d:" + parts.slice(0, index).join("/"));
        }
    }
    const actualEntries = [];
    collectEntries(root, "", actualEntries);
    actualEntries.sort();
    if (JSON.stringify(actualEntries) !== JSON.stringify([...expectedEntries].sort())) {
        throw new Error("transferred-file-set-mismatch");
    }
    for (const expected of payload.files) {
        const filePath = path.resolve(root, ...expected.name.split("/"));
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
            stat.size !== expected.size || (stat.mode & 0o111) !== 0) {
            throw new Error("transferred-file-metadata-mismatch");
        }
        const content = fs.readFileSync(filePath);
        const digest = crypto.createHash("sha256").update(content).digest("hex");
        if (digest !== expected.digest) throw new Error("transferred-file-hash-mismatch");
        files.push({ name: expected.name, size: content.length, digest });
    }

    console.log(JSON.stringify({
        status: "verified",
        stagedSnapshotHash: payload.stagedSnapshotHash,
        files,
        totalBytes
    }));
});

function normalizeNameMatches(name) {
    try {
        return name === name.normalize("NFC") &&
            name.split("/").join("/") === normalizePath(name);
    } catch {
        return false;
    }
}

function normalizePath(name) {
    if (name.includes("\\") || path.posix.isAbsolute(name) || path.win32.isAbsolute(name)) {
        return "";
    }
    return name;
}
`;

const candidateEvaluationScript = String.raw`
const { spawnSync } = require("node:child_process");
const candidateFilename = "improvement-loop.candidate.test.js";
const maximumStreamBytes = 8192;

function boundedText(value) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || "");
    return {
        text: buffer.subarray(0, maximumStreamBytes).toString("utf8"),
        truncated: buffer.length > maximumStreamBytes
    };
}

let execution;
try {
    execution = spawnSync(process.execPath, [
        "--test",
        "--test-reporter=tap",
        candidateFilename
    ], {
        cwd: "/tmp/stage",
        env: { PATH: process.env.PATH || "" },
        shell: false,
        timeout: ${evaluationTimeoutMs},
        maxBuffer: maximumStreamBytes * 2,
        windowsHide: true
    });
} catch (error) {
    execution = { error: { code: error?.code || "RUNNER_ERROR" } };
}

const stdout = boundedText(execution?.stdout);
const stderr = boundedText(execution?.stderr);
const errorCode = execution?.error?.code || null;
const outputTruncated = stdout.truncated || stderr.truncated || errorCode === "ENOBUFS";
const status = errorCode === "ETIMEDOUT"
    ? "timed-out"
    : outputTruncated
        ? "output-limited"
        : errorCode
            ? "runner-error"
            : execution.status === 0
                ? "passed"
                : "failed";

process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    status,
    exitCode: Number.isInteger(execution?.status) ? execution.status : null,
    errorCode: errorCode === "ETIMEDOUT" || errorCode === "ENOBUFS"
        ? errorCode
        : errorCode ? "runner-error" : null,
    signal: typeof execution?.signal === "string" ? execution.signal : null,
    stdout: stdout.text,
    stderr: stderr.text,
    outputTruncated
}));
`;

class SandboxStageTransferError extends Error {
    constructor(code, cause) {
        super(`Sandbox stage transfer failed: ${code}`, cause ? { cause } : undefined);
        this.name = "SandboxStageTransferError";
        this.code = code;
        this.cleanupError = null;
    }
}

function defaultInvoke(args, options) {
    return spawnSync("docker", args, {
        encoding: "utf8",
        input: options.input,
        maxBuffer: maxDockerOutputBytes,
        shell: false,
        timeout: options.timeout,
        windowsHide: true
    });
}

function isEmptyList(value) {
    return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

function isEmptyCollection(value) {
    return isEmptyList(value) ||
        (value !== null && typeof value === "object" &&
            !Array.isArray(value) && Object.keys(value).length === 0);
}

function validateCapturedFiles(stagedWorkspace) {
    if (!stagedWorkspace ||
        stagedWorkspace.status !== "staged-unexecuted" ||
        typeof stagedWorkspace.verify !== "function" ||
        typeof stagedWorkspace.captureFiles !== "function" ||
        !stagedWorkspace.manifest ||
        stagedWorkspace.manifest.staged !== true ||
        stagedWorkspace.manifest.validated !== false ||
        stagedWorkspace.manifest.applied !== false) {
        throw new SandboxStageTransferError("staged-workspace-invalid");
    }

    let capturedFiles;
    try {
        stagedWorkspace.verify();
        capturedFiles = stagedWorkspace.captureFiles();
    } catch (error) {
        throw new SandboxStageTransferError("staged-workspace-verification-failed", error);
    }
    const manifest = stagedWorkspace.manifest;
    if (!Array.isArray(manifest.files) ||
        manifest.files.length === 0 ||
        manifest.files.length > maxTransferFiles ||
        !manifest.stagedSnapshot ||
        !/^[a-f0-9]{64}$/.test(manifest.stagedSnapshot.hash) ||
        !Array.isArray(capturedFiles) ||
        capturedFiles.length !== manifest.files.length) {
        throw new SandboxStageTransferError("staged-manifest-invalid");
    }

    const expectedFiles = [...manifest.files].sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
    if (hasRelativePathCollision(expectedFiles.map(file => file.name))) {
        throw new SandboxStageTransferError("staged-file-path-collision");
    }
    const actualFiles = [...capturedFiles].sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
    const names = new Set();
    let totalBytes = 0;
    const files = actualFiles.map((file, index) => {
        const expected = expectedFiles[index];
        let normalizedName;
        try {
            normalizedName = normalizeRelativePath(file?.name);
        } catch {
            throw new SandboxStageTransferError("staged-file-metadata-invalid");
        }
        if (!file ||
            file.name !== expected.name ||
            normalizedName !== file.name ||
            isCredentialRelativePath(file.name) ||
            file.name.split("/").some(part => excludedDirectories.has(part.toLowerCase())) ||
            names.has(file.name.toLowerCase()) ||
            !Buffer.isBuffer(file.content) ||
            file.content.length !== file.size ||
            file.size !== expected.size ||
            file.digest !== expected.digest ||
            file.digest !== createHash("sha256").update(file.content).digest("hex") ||
            !Number.isSafeInteger(file.size) ||
            file.size < 0 ||
            file.size > maxTransferFileBytes) {
            throw new SandboxStageTransferError("staged-file-metadata-invalid");
        }
        names.add(file.name.toLowerCase());
        totalBytes += file.size;
        if (totalBytes > maxTransferBytes) {
            throw new SandboxStageTransferError("staged-transfer-size-limit-exceeded");
        }
        return { name: file.name, size: file.size, digest: file.digest, content: file.content };
    });
    if (totalBytes !== manifest.stagedSnapshot.totalBytes ||
        files.length !== manifest.stagedSnapshot.fileCount) {
        throw new SandboxStageTransferError("staged-snapshot-metadata-invalid");
    }
    return { files, totalBytes, snapshotHash: manifest.stagedSnapshot.hash };
}

function createTransferPayload(staged) {
    const metadata = {
        stagedSnapshotHash: staged.snapshotHash,
        files: staged.files.map(({ name, size, digest, content }) => ({
            name,
            size,
            digest,
            contentBase64: content.toString("base64")
        }))
    };
    const payload = Buffer.from(JSON.stringify(metadata), "utf8");
    if (payload.length > maxTransferPayloadBytes) {
        throw new SandboxStageTransferError("transfer-payload-size-limit-exceeded");
    }
    return {
        payload,
        expectedOutput: {
            status: "verified",
            stagedSnapshotHash: staged.snapshotHash,
            files: staged.files.map(({ name, size, digest }) => ({ name, size, digest })),
            totalBytes: staged.totalBytes
        }
    };
}

function assertContainerPolicy(container, imageConfig, expectedState) {
    const config = container?.Config;
    const host = container?.HostConfig;
    const mounts = container?.Mounts;
    const tmpfs = host?.Tmpfs;
    const validMounts = Array.isArray(mounts) &&
        mounts.every(mount => mount?.Type === "tmpfs" && mount?.Destination === "/tmp");
    const validTmpfs = tmpfs &&
        typeof tmpfs === "object" &&
        Object.keys(tmpfs).length === 1 &&
        typeof tmpfs["/tmp"] === "string" &&
        ["rw", "noexec", "nosuid", "nodev", `size=${tmpfsSize}`].every(option =>
            tmpfs["/tmp"].split(",").includes(option)
        );
    const checks = {
        state: container?.State?.Status === expectedState,
        pinnedImageId: container?.Image === expectedImageId && config?.Image === imageReference,
        fixedEntryPoint: JSON.stringify(config?.Entrypoint) === JSON.stringify(["node"]),
        fixedIdleCommand: JSON.stringify(config?.Cmd) === JSON.stringify(["-e", idleScript]),
        nonRootUser: config?.User === "65534:65534",
        imageOnlyEnvironment: JSON.stringify(config?.Env) === JSON.stringify(imageConfig?.Config?.Env),
        noImageVolumes: isEmptyList(config?.Volumes),
        disabledNetwork: host?.NetworkMode === "none",
        readOnlyRoot: host?.ReadonlyRootfs === true,
        notPrivileged: host?.Privileged === false,
        droppedCapabilities: Array.isArray(host?.CapDrop) && host.CapDrop.includes("ALL"),
        noAddedCapabilities: isEmptyList(host?.CapAdd),
        noNewPrivileges: Array.isArray(host?.SecurityOpt) &&
            host.SecurityOpt.includes("no-new-privileges:true"),
        boundedMemory: host?.Memory === memoryLimitBytes && host?.MemorySwap === memoryLimitBytes,
        boundedCpu: host?.NanoCpus === cpuLimitNanoCpus,
        boundedProcesses: host?.PidsLimit === processLimit,
        noHostBinds: isEmptyList(host?.Binds) && isEmptyList(host?.Mounts),
        noHostDevices: isEmptyList(host?.Devices) && isEmptyList(host?.DeviceRequests),
        automaticRemoval: host?.AutoRemove === true,
        noPublishedPorts: isEmptyCollection(host?.PortBindings),
        noSharedNamespaces: !host?.PidMode &&
            host?.IpcMode !== "host" &&
            host?.UTSMode !== "host" &&
            host?.CgroupnsMode !== "host",
        restrictedTmpfs: Boolean(validTmpfs),
        onlyTmpfsMount: Boolean(validMounts)
    };
    const failedChecks = Object.entries(checks)
        .filter(([, passed]) => !passed)
        .map(([name]) => name);
    if (failedChecks.length > 0) {
        throw new SandboxStageTransferError("container-policy-mismatch", { failedChecks });
    }
}

function parseTapTestSummary(output) {
    const readCount = name => {
        const match = output.match(new RegExp(`^# ${name} (\\d+)$`, "m"));
        return match ? Number(match[1]) : null;
    };
    const summary = {
        tests: readCount("tests"),
        passed: readCount("pass"),
        failed: readCount("fail"),
        cancelled: readCount("cancelled"),
        skipped: readCount("skipped"),
        todo: readCount("todo")
    };
    return Object.values(summary).every(Number.isSafeInteger) ? summary : null;
}

function validateEvaluationOutput(output, stagedWorkspace, staged, { runId, durationMs }) {
    let evaluation;
    try {
        evaluation = JSON.parse(output);
    } catch (error) {
        throw new SandboxStageTransferError("invalid-evaluator-output", error);
    }
    const validStatuses = new Set(["passed", "failed", "timed-out", "output-limited", "runner-error"]);
    if (!evaluation ||
        typeof evaluation !== "object" ||
        evaluation.schemaVersion !== 1 ||
        !validStatuses.has(evaluation.status) ||
        (evaluation.exitCode !== null &&
            (!Number.isInteger(evaluation.exitCode) || evaluation.exitCode < 0 || evaluation.exitCode > 255)) ||
        ![null, "ETIMEDOUT", "ENOBUFS", "runner-error"].includes(evaluation.errorCode) ||
        (evaluation.signal !== null &&
            (typeof evaluation.signal !== "string" || evaluation.signal.length > 16)) ||
        typeof evaluation.stdout !== "string" ||
        Buffer.byteLength(evaluation.stdout, "utf8") > evaluationStreamLimitBytes ||
        typeof evaluation.stderr !== "string" ||
        Buffer.byteLength(evaluation.stderr, "utf8") > evaluationStreamLimitBytes ||
        typeof evaluation.outputTruncated !== "boolean" ||
        (evaluation.status === "passed" && evaluation.exitCode !== 0) ||
        (evaluation.status === "failed" &&
            (evaluation.exitCode === null || evaluation.exitCode === 0)) ||
        (evaluation.status === "timed-out" && evaluation.errorCode !== "ETIMEDOUT") ||
        (evaluation.status === "output-limited" && !evaluation.outputTruncated)) {
        throw new SandboxStageTransferError("invalid-evaluator-output");
    }

    const manifest = stagedWorkspace.manifest;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId) ||
        !Number.isFinite(durationMs) ||
        durationMs < 0 ||
        durationMs > dockerCallTimeoutMs * 2) {
        throw new SandboxStageTransferError("evaluation-metadata-invalid");
    }
    return {
        schemaVersion: 1,
        runId,
        status: evaluation.status,
        command: "node --test --test-reporter=tap improvement-loop.candidate.test.js",
        imageDigest,
        sourceSnapshotHash: manifest.sourceSnapshotHash,
        stagedSnapshotHash: staged.snapshotHash,
        candidateDigest: manifest.candidateDigest,
        transferredFileCount: staged.files.length,
        transferredBytes: staged.totalBytes,
        durationMs,
        completedAt: new Date().toISOString(),
        exitCode: evaluation.exitCode,
        errorCode: evaluation.errorCode,
        signal: evaluation.signal,
        stdout: evaluation.stdout,
        stderr: evaluation.stderr,
        outputHash: createHash("sha256")
            .update(JSON.stringify({ stdout: evaluation.stdout, stderr: evaluation.stderr }))
            .digest("hex"),
        testSummary: parseTapTestSummary(evaluation.stdout),
        outputTruncated: evaluation.outputTruncated,
        checks: {
            localDockerContext: true,
            pinnedImage: true,
            noHostMounts: true,
            networkDisabled: true,
            readOnlyRootFilesystem: true,
            nonRootNoCapabilities: true,
            noNewPrivileges: true,
            resourceLimits: true,
            stagedHashesVerifiedInContainer: true,
            fixedCandidateTestCommand: true
        },
        candidateCodeExecuted: true,
        workspaceMounted: false,
        validated: false,
        applied: false
    };
}

function createSandboxStageTransferProbe({
    platform = process.platform,
    env = process.env,
    invoke = defaultInvoke,
    makeId = randomUUID
} = {}) {
    function docker(args, input) {
        let result;
        try {
            result = invoke(["--context", dockerContext, ...args], {
                timeout: dockerCallTimeoutMs,
                maxBuffer: maxDockerOutputBytes,
                ...(input ? { input } : {})
            });
        } catch (error) {
            throw new SandboxStageTransferError("docker-invocation-failed", error);
        }
        if (result?.error) {
            const code = result.error.code === "ETIMEDOUT"
                ? "docker-command-timeout"
                : "docker-invocation-failed";
            throw new SandboxStageTransferError(code, result.error);
        }
        const outputBytes = Buffer.byteLength(result?.stdout || "") + Buffer.byteLength(result?.stderr || "");
        if (outputBytes > maxDockerOutputBytes) {
            throw new SandboxStageTransferError("docker-output-limit-exceeded");
        }
        if (result?.status !== 0) {
            throw new SandboxStageTransferError("docker-command-failed", {
                status: result?.status,
                stderr: result?.stderr || ""
            });
        }
        return (result.stdout || "").trim();
    }

    function runStage(stagedWorkspace, evaluateCandidate) {
        const staged = validateCapturedFiles(stagedWorkspace);
        if (evaluateCandidate) {
            const candidateFile = staged.files.find(file => file.name === candidateTestFilename);
            if (!candidateFile ||
                stagedWorkspace.manifest.candidateFile !== candidateTestFilename ||
                stagedWorkspace.manifest.candidateDigest !== candidateFile.digest ||
                !/^[a-f0-9]{64}$/.test(stagedWorkspace.manifest.sourceSnapshotHash || "")) {
                throw new SandboxStageTransferError("staged-candidate-metadata-invalid");
            }
        }
        const evaluationRunId = evaluateCandidate ? randomUUID() : null;
        const transfer = createTransferPayload(staged);
        const containerName = `offloading-stage-probe-${makeId()}`;
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(containerName)) {
            throw new SandboxStageTransferError("container-name-invalid");
        }
        if (platform !== "win32") throw new SandboxStageTransferError("unsupported-host-platform");
        if (env.DOCKER_HOST || env.DOCKER_CONTEXT) {
            throw new SandboxStageTransferError("docker-environment-override-present");
        }

        let endpoint;
        try {
            endpoint = JSON.parse(docker([
                "context", "inspect", dockerContext, "--format", "{{json .Endpoints.docker}}"
            ]));
        } catch (error) {
            if (error instanceof SandboxStageTransferError) throw error;
            throw new SandboxStageTransferError("invalid-docker-context-response", error);
        }
        if (endpoint?.Host !== dockerEndpoint || endpoint?.SkipTLSVerify !== false) {
            throw new SandboxStageTransferError("docker-context-not-local");
        }
        if (docker(["info", "--format", "{{.OSType}}"]) !== "linux") {
            throw new SandboxStageTransferError("docker-backend-not-linux");
        }

        let image;
        try {
            image = JSON.parse(docker([
                "image", "inspect", imageReference, "--format", "{{json .}}"
            ]));
        } catch (error) {
            if (error instanceof SandboxStageTransferError) throw error;
            throw new SandboxStageTransferError("pinned-image-unavailable-or-invalid", error);
        }
        if (image?.Id !== expectedImageId ||
            image?.Os !== "linux" ||
            image?.Architecture !== "amd64" ||
            !Array.isArray(image?.RepoDigests) ||
            !image.RepoDigests.includes(`node@${imageDigest}`) ||
            !isEmptyList(image?.Config?.Volumes)) {
            throw new SandboxStageTransferError("pinned-image-policy-mismatch");
        }

        let containerId = null;
        let containerMayExist = false;
        let result = null;
        let failure = null;
        try {
            containerMayExist = true;
            containerId = docker([
                "container", "create",
                "--pull=never",
                "--rm",
                "--name", containerName,
                "--network", "none",
                "--read-only",
                "--cap-drop", "ALL",
                "--security-opt", "no-new-privileges:true",
                "--user", "65534:65534",
                "--memory", String(memoryLimitBytes),
                "--memory-swap", String(memoryLimitBytes),
                "--cpus", "0.5",
                "--pids-limit", String(processLimit),
                "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${tmpfsSize}`,
                "--entrypoint", "node",
                imageReference,
                "-e", idleScript
            ]);
            if (!/^[a-f0-9]{64}$/.test(containerId)) {
                throw new SandboxStageTransferError("invalid-container-id");
            }

            function inspectAndAssert(expectedState) {
                let inspected;
                try {
                    inspected = JSON.parse(docker(["container", "inspect", containerId]));
                } catch (error) {
                    if (error instanceof SandboxStageTransferError) throw error;
                    throw new SandboxStageTransferError("invalid-container-inspect-response", error);
                }
                if (!Array.isArray(inspected) || inspected.length !== 1) {
                    throw new SandboxStageTransferError("invalid-container-inspect-response");
                }
                assertContainerPolicy(inspected[0], image, expectedState);
            }

            inspectAndAssert("created");
            docker(["container", "start", containerId]);
            inspectAndAssert("running");
            const output = docker([
                "container", "exec", "--interactive", "--user", "65534:65534",
                containerId, "node", "-e", receiverScript
            ], transfer.payload);
            try {
                stagedWorkspace.verify();
            } catch (error) {
                throw new SandboxStageTransferError("staged-workspace-changed-during-transfer", error);
            }
            let actualOutput;
            try {
                actualOutput = JSON.parse(output);
            } catch (error) {
                throw new SandboxStageTransferError("invalid-transfer-verifier-output", error);
            }
            if (JSON.stringify(actualOutput) !== JSON.stringify(transfer.expectedOutput)) {
                throw new SandboxStageTransferError("transfer-verification-mismatch");
            }
            if (evaluateCandidate) {
                const evaluationStartedAt = process.hrtime.bigint();
                const evaluationOutput = docker([
                    "container", "exec", "--interactive", "--user", "65534:65534",
                    containerId, "node", "-e", candidateEvaluationScript
                ]);
                const durationMs = Number(process.hrtime.bigint() - evaluationStartedAt) / 1e6;
                try {
                    stagedWorkspace.verify();
                } catch (error) {
                    throw new SandboxStageTransferError("staged-workspace-changed-during-evaluation", error);
                }
                result = validateEvaluationOutput(evaluationOutput, stagedWorkspace, staged, {
                    runId: evaluationRunId,
                    durationMs
                });
            } else {
                result = {
                    status: "passed",
                    backend: "local-docker-desktop-linux",
                    imageDigest,
                    stagedSnapshotHash: staged.snapshotHash,
                    transferredFileCount: staged.files.length,
                    transferredBytes: staged.totalBytes,
                    checks: {
                        localDockerContext: true,
                        pinnedImage: true,
                        noHostMounts: true,
                        networkDisabled: true,
                        readOnlyRootFilesystem: true,
                        nonRootNoCapabilities: true,
                        noNewPrivileges: true,
                        resourceLimits: true,
                        stagedHashesVerifiedInContainer: true
                    },
                    candidateCodeExecuted: false,
                    workspaceMounted: false
                };
            }
        } catch (error) {
            failure = error instanceof SandboxStageTransferError
                ? error
                : new SandboxStageTransferError("stage-transfer-probe-failed", error);
        } finally {
            if (containerMayExist) {
                const cleanupTarget = containerId && /^[a-f0-9]{64}$/.test(containerId)
                    ? containerId
                    : containerName;
                try {
                    docker(["container", "rm", "--force", cleanupTarget]);
                } catch (error) {
                    const containerAlreadyAbsent = error.code === "docker-command-failed" &&
                        error.cause?.stderr?.includes(`No such container: ${cleanupTarget}`);
                    if (!containerAlreadyAbsent) {
                        const cleanupError = error instanceof SandboxStageTransferError
                            ? error
                            : new SandboxStageTransferError("container-cleanup-failed", error);
                        if (failure) failure.cleanupError = cleanupError.code;
                        else failure = cleanupError;
                    }
                }
            }
        }
        if (failure) throw failure;
        return result;
    }

    return {
        run(stagedWorkspace) {
            return runStage(stagedWorkspace, false);
        },
        evaluate(stagedWorkspace) {
            return runStage(stagedWorkspace, true);
        }
    };
}

module.exports = {
    SandboxStageTransferError,
    createSandboxStageTransferProbe
};
