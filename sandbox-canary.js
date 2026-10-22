"use strict";

const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const dockerContext = "desktop-linux";
const dockerEndpoint = "npipe:////./pipe/dockerDesktopLinuxEngine";
const imageReference = "node@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205";
const imageDigest = "sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205";
const expectedImageId = "sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205";
const memoryLimitBytes = 256 * 1024 * 1024;
const cpuLimitNanoCpus = 500000000;
const processLimit = 32;
const dockerCallTimeoutMs = 30000;
const maxDockerOutputBytes = 256 * 1024;

const canaryScript = String.raw`
const fs = require("node:fs");
const os = require("node:os");

function fail(message) {
    throw new Error(message);
}

const status = fs.readFileSync("/proc/self/status", "utf8");
const effectiveCapabilities = status.match(/^CapEff:\s+([a-f0-9]+)$/mi)?.[1];
const noNewPrivileges = status.match(/^NoNewPrivs:\s+(\d+)$/mi)?.[1];
if (typeof process.getuid !== "function" || process.getuid() !== 65534) fail("wrong-user");
if (effectiveCapabilities !== "0000000000000000") fail("capabilities-present");
if (noNewPrivileges !== "1") fail("no-new-privileges-disabled");

const mounts = fs.readFileSync("/proc/self/mountinfo", "utf8")
    .trim()
    .split("\n")
    .map(line => line.split(" - ")[0].split(" "))
    .filter(fields => fields.length > 5);
const rootMount = mounts.find(fields => fields[4] === "/");
const tempMount = mounts.find(fields => fields[4] === "/tmp");
if (!rootMount || !rootMount[5].split(",").includes("ro")) fail("root-filesystem-writable");
if (!tempMount) fail("temporary-filesystem-missing");
const temporaryOptions = tempMount[5].split(",");
if (!["rw", "noexec", "nosuid", "nodev"].every(option => temporaryOptions.includes(option))) {
    fail("temporary-filesystem-policy-mismatch");
}

const routes = fs.readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1);
if (routes.some(route => route.trim().split(/\s+/)[1] === "00000000")) fail("default-route-present");
if (Object.keys(os.networkInterfaces()).some(name => name !== "lo")) fail("non-loopback-interface-present");

console.log(JSON.stringify({
    uid: process.getuid(),
    effectiveCapabilities: "0000000000000000",
    noNewPrivileges: true,
    rootFilesystemReadOnly: true,
    temporaryFilesystemNoExec: true,
    noDefaultRoute: true,
    loopbackOnly: true
}));
`;

const expectedCanaryResult = {
    uid: 65534,
    effectiveCapabilities: "0000000000000000",
    noNewPrivileges: true,
    rootFilesystemReadOnly: true,
    temporaryFilesystemNoExec: true,
    noDefaultRoute: true,
    loopbackOnly: true
};

class SandboxCanaryError extends Error {
    constructor(code, cause) {
        super(`Sandbox canary failed: ${code}`, cause ? { cause } : undefined);
        this.name = "SandboxCanaryError";
        this.code = code;
        this.details = cause?.failedChecks || null;
    }
}

function defaultInvoke(args, options) {
    return spawnSync("docker", args, {
        encoding: "utf8",
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

function assertContainerPolicy(container, imageConfig) {
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
        ["rw", "noexec", "nosuid", "nodev", "size=1m"].every(option =>
            tmpfs["/tmp"].split(",").includes(option)
        );

    const checks = {
        createdState: container?.State?.Status === "created",
        pinnedImageId: container?.Image === expectedImageId && config?.Image === imageReference,
        fixedEntryPoint: JSON.stringify(config?.Entrypoint) === JSON.stringify(["node"]),
        fixedCanaryCommand: JSON.stringify(config?.Cmd) === JSON.stringify(["-e", canaryScript]),
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
        throw new SandboxCanaryError("container-policy-mismatch", { failedChecks });
    }
}

function createSandboxCanary({
    platform = process.platform,
    env = process.env,
    invoke = defaultInvoke,
    makeId = randomUUID
} = {}) {
    function docker(args) {
        let result;
        try {
            result = invoke(["--context", dockerContext, ...args], {
                timeout: dockerCallTimeoutMs,
                maxBuffer: maxDockerOutputBytes
            });
        } catch (error) {
            throw new SandboxCanaryError("docker-invocation-failed", error);
        }
        if (result?.error) {
            const code = result.error.code === "ETIMEDOUT"
                ? "docker-command-timeout"
                : "docker-invocation-failed";
            throw new SandboxCanaryError(code, result.error);
        }
        const outputBytes = Buffer.byteLength(result?.stdout || "") + Buffer.byteLength(result?.stderr || "");
        if (outputBytes > maxDockerOutputBytes) {
            throw new SandboxCanaryError("docker-output-limit-exceeded");
        }
        if (result?.status !== 0) {
            throw new SandboxCanaryError("docker-command-failed", {
                status: result?.status,
                stderr: result?.stderr || ""
            });
        }
        return (result.stdout || "").trim();
    }

    function run() {
        if (platform !== "win32") throw new SandboxCanaryError("unsupported-host-platform");
        if (env.DOCKER_HOST || env.DOCKER_CONTEXT) {
            throw new SandboxCanaryError("docker-environment-override-present");
        }

        let endpoint;
        try {
            endpoint = JSON.parse(docker([
                "context", "inspect", dockerContext, "--format", "{{json .Endpoints.docker}}"
            ]));
        } catch (error) {
            if (error instanceof SandboxCanaryError) throw error;
            throw new SandboxCanaryError("invalid-docker-context-response", error);
        }
        if (endpoint?.Host !== dockerEndpoint || endpoint?.SkipTLSVerify !== false) {
            throw new SandboxCanaryError("docker-context-not-local");
        }
        if (docker(["info", "--format", "{{.OSType}}"]) !== "linux") {
            throw new SandboxCanaryError("docker-backend-not-linux");
        }

        let image;
        try {
            image = JSON.parse(docker([
                "image", "inspect", imageReference, "--format", "{{json .}}"
            ]));
        } catch (error) {
            if (error instanceof SandboxCanaryError) throw error;
            throw new SandboxCanaryError("pinned-image-unavailable-or-invalid", error);
        }
        if (image?.Id !== expectedImageId ||
            image?.Os !== "linux" ||
            image?.Architecture !== "amd64" ||
            !Array.isArray(image?.RepoDigests) ||
            !image.RepoDigests.includes(`node@${imageDigest}`) ||
            !isEmptyList(image?.Config?.Volumes)) {
            throw new SandboxCanaryError("pinned-image-policy-mismatch");
        }

        const containerName = `offloading-sandbox-probe-${makeId()}`;
        let containerId = null;
        let containerMayExist = false;
        let result;
        let failure = null;
        try {
            containerMayExist = true;
            containerId = docker([
                "container", "create",
                "--pull=never",
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
                "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=1m",
                "--entrypoint", "node",
                imageReference,
                "-e", canaryScript
            ]);
            if (!/^[a-f0-9]{64}$/.test(containerId)) {
                throw new SandboxCanaryError("invalid-container-id");
            }

            let inspected;
            try {
                inspected = JSON.parse(docker(["container", "inspect", containerId]));
            } catch (error) {
                if (error instanceof SandboxCanaryError) throw error;
                throw new SandboxCanaryError("invalid-container-inspect-response", error);
            }
            if (!Array.isArray(inspected) || inspected.length !== 1) {
                throw new SandboxCanaryError("invalid-container-inspect-response");
            }
            assertContainerPolicy(inspected[0], image);

            docker(["container", "start", containerId]);
            const exitCodeText = docker(["container", "wait", containerId]);
            if (!/^\d+$/.test(exitCodeText) || Number(exitCodeText) !== 0) {
                throw new SandboxCanaryError("canary-container-failed");
            }
            let canaryResult;
            try {
                canaryResult = JSON.parse(docker(["container", "logs", containerId]));
            } catch (error) {
                if (error instanceof SandboxCanaryError) throw error;
                throw new SandboxCanaryError("invalid-canary-output", error);
            }
            if (JSON.stringify(canaryResult) !== JSON.stringify(expectedCanaryResult)) {
                throw new SandboxCanaryError("canary-check-failed");
            }
            result = {
                status: "passed",
                backend: "local-docker-desktop-linux",
                imageDigest,
                checks: {
                    localDockerContext: true,
                    pinnedImage: true,
                    noHostMounts: true,
                    networkDisabled: true,
                    readOnlyRootFilesystem: true,
                    nonRootNoCapabilities: true,
                    noNewPrivileges: true,
                    resourceLimits: true,
                    runtimeCanaries: true
                },
                candidateExecutionEnabled: false,
                workspaceMounted: false
            };
        } catch (error) {
            failure = error instanceof SandboxCanaryError
                ? error
                : new SandboxCanaryError("sandbox-canary-failed", error);
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
                        const cleanupError = error instanceof SandboxCanaryError
                            ? error
                            : new SandboxCanaryError("container-cleanup-failed", error);
                        if (failure) {
                            failure.cleanupError = cleanupError.code;
                        } else {
                            failure = cleanupError;
                        }
                    }
                }
            }
        }
        if (failure) throw failure;
        return result;
    }

    return { run };
}

if (require.main === module) {
    try {
        console.log(JSON.stringify(createSandboxCanary().run(), null, 2));
    } catch (error) {
        console.error(JSON.stringify({
            status: "failed",
            reasonCode: error instanceof SandboxCanaryError ? error.code : "unexpected-error",
            failedChecks: error.details,
            cleanupError: error.cleanupError || null
        }));
        process.exitCode = 1;
    }
}

module.exports = {
    SandboxCanaryError,
    createSandboxCanary
};
