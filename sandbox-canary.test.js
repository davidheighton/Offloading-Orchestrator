"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { SandboxCanaryError, createSandboxCanary } = require("./sandbox-canary");

const imageId = "sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205";
const imageDigest = "sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205";
const containerId = "a".repeat(64);

function makeImage() {
    return {
        Id: imageId,
        Os: "linux",
        Architecture: "amd64",
        RepoDigests: [`node@${imageDigest}`],
        Config: { Volumes: null, Env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"] }
    };
}

function makeContainer(image = makeImage()) {
    return {
        Id: containerId,
        Image: imageId,
        State: { Status: "created" },
        Config: {
            Image: "node@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205",
            Entrypoint: ["node"],
            Cmd: ["-e", ""],
            User: "65534:65534",
            Env: image.Config.Env,
            Volumes: null
        },
        HostConfig: {
            NetworkMode: "none",
            ReadonlyRootfs: true,
            Privileged: false,
            CapDrop: ["ALL"],
            CapAdd: null,
            SecurityOpt: ["no-new-privileges:true"],
            Memory: 268435456,
            MemorySwap: 268435456,
            NanoCpus: 500000000,
            PidsLimit: 32,
            Binds: null,
            Mounts: null,
            Devices: null,
            DeviceRequests: null,
            PortBindings: {},
            PidMode: "",
            Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=1m" }
        },
        Mounts: []
    };
}

function successInvoke({
    endpoint = { Host: "npipe:////./pipe/dockerDesktopLinuxEngine", SkipTLSVerify: false },
    backend = "linux",
    image = makeImage(),
    container = null,
    canaryOutput = JSON.stringify({
        uid: 65534,
        effectiveCapabilities: "0000000000000000",
        noNewPrivileges: true,
        rootFilesystemReadOnly: true,
        temporaryFilesystemNoExec: true,
        noDefaultRoute: true,
        loopbackOnly: true
    }),
    fail = null
} = {}) {
    const actualContainer = container || makeContainer(image);
    const calls = [];
    const invoke = (args, options) => {
        calls.push({ args, options });
        if (fail) {
            const failureResult = fail(args, calls);
            if (failureResult !== undefined) return failureResult;
        }
        const command = args.slice(2);
        if (command[0] === "context" && command[1] === "inspect") {
            return { status: 0, stdout: JSON.stringify(endpoint) };
        }
        if (command[0] === "info") return { status: 0, stdout: backend };
        if (command[0] === "image" && command[1] === "inspect") {
            return { status: 0, stdout: JSON.stringify(image) };
        }
        if (command[0] === "container" && command[1] === "create") {
            actualContainer.Config.Cmd = args.slice(-2);
            return { status: 0, stdout: containerId };
        }
        if (command[0] === "container" && command[1] === "inspect") {
            return { status: 0, stdout: JSON.stringify([actualContainer]) };
        }
        if (command[0] === "container" && command[1] === "wait") {
            return { status: 0, stdout: "0" };
        }
        if (command[0] === "container" && command[1] === "logs") {
            return { status: 0, stdout: canaryOutput };
        }
        return { status: 0, stdout: "" };
    };
    return { invoke, calls };
}

function runCanary(options = {}) {
    const fake = successInvoke(options);
    return {
        fake,
        result: createSandboxCanary({
            platform: "win32",
            env: {},
            makeId: () => "test-run",
            invoke: fake.invoke
        }).run()
    };
}

test("the probe verifies a local, pinned, restricted container and always removes it", () => {
    const { fake, result } = runCanary();

    assert.equal(result.status, "passed");
    assert.equal(result.candidateExecutionEnabled, false);
    assert.equal(result.workspaceMounted, false);
    assert.equal(fake.calls.at(-1).args.slice(2).join(" "), `container rm --force ${containerId}`);
    assert.ok(fake.calls.every(call => call.args.slice(0, 2).join(" ") === "--context desktop-linux"));
    const create = fake.calls.find(call => call.args[2] === "container" && call.args[3] === "create");
    assert.ok(create);
    assert.ok(create.args.includes("--pull=never"));
    assert.ok(create.args.includes("--network"));
    assert.ok(create.args.includes("none"));
    assert.ok(create.args.includes("--read-only"));
    assert.ok(create.args.includes("--cap-drop"));
    assert.ok(create.args.includes("ALL"));
    assert.ok(create.args.includes("no-new-privileges:true"));
    assert.ok(create.args.includes("--user"));
    assert.ok(create.args.includes("65534:65534"));
    assert.equal(create.options.timeout, 30000);
    assert.equal(create.options.maxBuffer, 256 * 1024);
});

test("the probe fails closed on remote context, wrong backend, and Docker environment overrides", () => {
    for (const options of [
        { endpoint: { Host: "tcp://example.invalid:2376", SkipTLSVerify: false } },
        { backend: "windows" }
    ]) {
        const fake = successInvoke(options);
        assert.throws(
            () => createSandboxCanary({
                platform: "win32",
                env: {},
                invoke: fake.invoke
            }).run(),
            SandboxCanaryError
        );
        assert.equal(fake.calls.some(call => call.args[2] === "container" && call.args[3] === "create"), false);
    }
    assert.throws(
        () => createSandboxCanary({
            platform: "win32",
            env: { DOCKER_HOST: "tcp://example.invalid:2376" },
            invoke: () => assert.fail("Docker must not be invoked with environment overrides")
        }).run(),
        error => error.code === "docker-environment-override-present"
    );
});

test("the probe refuses unsupported host platforms and images without the pinned digest", () => {
    assert.throws(
        () => createSandboxCanary({ platform: "linux", env: {}, invoke: () => assert.fail() }).run(),
        error => error.code === "unsupported-host-platform"
    );

    const image = makeImage();
    image.RepoDigests = [];
    const fake = successInvoke({ image });
    assert.throws(
        () => createSandboxCanary({
            platform: "win32",
            env: {},
            invoke: fake.invoke
        }).run(),
        error => error.code === "pinned-image-policy-mismatch"
    );
    assert.equal(fake.calls.some(call => call.args[2] === "container" && call.args[3] === "create"), false);
});

test("an inspected policy mismatch prevents start and triggers container cleanup", () => {
    const container = makeContainer();
    container.HostConfig.NetworkMode = "bridge";
    const fake = successInvoke({ container });
    assert.throws(
        () => createSandboxCanary({
            platform: "win32",
            env: {},
            makeId: () => "test-run",
            invoke: fake.invoke
        }).run(),
        error => error.code === "container-policy-mismatch"
    );
    assert.equal(fake.calls.some(call => call.args[2] === "container" && call.args[3] === "start"), false);
    assert.equal(fake.calls.at(-1).args.slice(2, 5).join(" "), "container rm --force");
});

test("cleanup failures are surfaced instead of returning a successful proof", () => {
    const fake = successInvoke({
        fail(args, calls) {
            const command = args.slice(2);
            if (command[0] === "container" && command[1] === "rm") {
                return { status: 1, stdout: "", stderr: "cleanup failed" };
            }
            return undefined;
        }
    });
    assert.throws(
        () => createSandboxCanary({
            platform: "win32",
            env: {},
            makeId: () => "test-run",
            invoke: fake.invoke
        }).run(),
        error => error.code === "docker-command-failed"
    );
    assert.equal(fake.calls.at(-1).args.slice(2, 5).join(" "), "container rm --force");
});

test("a timed-out create is cleaned up by its unique name when no ID was returned", () => {
    const name = "offloading-sandbox-probe-test-run";
    const fake = successInvoke({
        fail(args) {
            const command = args.slice(2);
            if (command[0] === "container" && command[1] === "create") {
                const error = new Error("timed out");
                error.code = "ETIMEDOUT";
                return { error, status: null, stdout: "", stderr: "" };
            }
            if (command[0] === "container" && command[1] === "rm") {
                return {
                    status: 1,
                    stdout: "",
                    stderr: `Error response from daemon: No such container: ${name}`
                };
            }
            return undefined;
        }
    });

    assert.throws(
        () => createSandboxCanary({
            platform: "win32",
            env: {},
            makeId: () => "test-run",
            invoke: fake.invoke
        }).run(),
        error => error.code === "docker-command-timeout"
    );
    assert.equal(fake.calls.at(-1).args.slice(2).join(" "), `container rm --force ${name}`);
});
