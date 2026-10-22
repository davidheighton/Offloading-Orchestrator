"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { candidateTestFilename } = require("./candidate-diff");

const dockerContext = "desktop-linux";
const dockerEndpoint = "npipe:////./pipe/dockerDesktopLinuxEngine";
const imageReference = "node@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205";
const imageDigest = "sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205";
const expectedImageId = imageDigest;
const memoryLimitBytes = 256 * 1024 * 1024;
const cpuLimitNanoCpus = 500000000;
const processLimit = 32;
const dockerCallTimeoutMs = 30000;
const maxDockerOutputBytes = 256 * 1024;
const maxTransferBytes = 2 * 1024 * 1024;
const maxTransferFiles = 500;
const tmpfsSize = "4m";
const idleScript = "setTimeout(() => process.exit(0), 300000)";
const receiverScript = String.raw`
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const inputLimit = 3 * 1024 * 1024;
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
        payload.files.length > 500 ||
        !/^[a-f0-9]{64}$/.test(payload.stagedSnapshotHash)) {
        throw new Error("invalid-transfer-manifest");
    }

    const root = "/tmp/stage";
    fs.mkdirSync(root, { mode: 0o700 });
    const names = new Set();
    const files = [];
    let totalBytes = 0;
    for (const expected of payload.files) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,89}\.js$/.test(expected.name) ||
            !Number.isSafeInteger(expected.size) ||
            expected.size < 0 ||
            expected.size > 256 * 1024 ||
            !/^[a-f0-9]{64}$/.test(expected.digest) ||
            typeof expected.contentBase64 !== "string" ||
            names.has(expected.name.toLowerCase())) {
            throw new Error("invalid-transfer-entry");
        }
        names.add(expected.name.toLowerCase());
        const content = Buffer.from(expected.contentBase64, "base64");
        if (content.toString("base64") !== expected.contentBase64 ||
            content.length !== expected.size ||
            crypto.createHash("sha256").update(content).digest("hex") !== expected.digest) {
            throw new Error("transfer-input-content-mismatch");
        }
        totalBytes += content.length;
        if (totalBytes > 2 * 1024 * 1024) throw new Error("transfer-size-limit-exceeded");
        fs.writeFileSync(path.join(root, expected.name), content, { flag: "wx", mode: 0o444 });
    }

    const expectedNames = payload.files.map(file => file.name).sort();
    const actualNames = fs.readdirSync(root).sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
        throw new Error("transferred-file-set-mismatch");
    }
    for (const expected of payload.files) {
        const filePath = path.join(root, expected.name);
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
    const actualFiles = [...capturedFiles].sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
    const names = new Set();
    let totalBytes = 0;
    const files = actualFiles.map((file, index) => {
        const expected = expectedFiles[index];
        if (!file ||
            file.name !== expected.name ||
            !/^[A-Za-z0-9][A-Za-z0-9._-]{0,89}\.js$/.test(file.name) ||
            (file.name !== candidateTestFilename && /\.(?:test|spec)\.js$/i.test(file.name)) ||
            names.has(file.name.toLowerCase()) ||
            !Buffer.isBuffer(file.content) ||
            file.content.length !== file.size ||
            file.size !== expected.size ||
            file.digest !== expected.digest ||
            file.digest !== createHash("sha256").update(file.content).digest("hex") ||
            !Number.isSafeInteger(file.size) ||
            file.size < 0 ||
            file.size > 256 * 1024) {
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
    if (payload.length > 3 * 1024 * 1024) {
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

    function run(stagedWorkspace) {
        const staged = validateCapturedFiles(stagedWorkspace);
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

    return { run };
}

module.exports = {
    SandboxStageTransferError,
    createSandboxStageTransferProbe
};
