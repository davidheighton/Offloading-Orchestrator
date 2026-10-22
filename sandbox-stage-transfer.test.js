"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");
const {
    SandboxStageTransferError,
    createSandboxStageTransferProbe
} = require("./sandbox-stage-transfer");
const { candidateTestFilename } = require("./candidate-diff");

const imageId = "sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205";
const imageReference = `node@${imageId}`;
const containerId = "a".repeat(64);

function makeStage() {
    const contents = [
        { name: "app.js", content: Buffer.from("module.exports = 1;\n") },
        { name: candidateTestFilename, content: Buffer.from("assert.equal(true, true);\n") }
    ].sort((left, right) => left.name.localeCompare(right.name));
    const files = contents.map(file => ({
        name: file.name,
        size: file.content.length,
        digest: createHash("sha256").update(file.content).digest("hex"),
        origin: file.name === candidateTestFilename ? "proposal" : "snapshot"
    }));
    const stagedSnapshotHash = createHash("sha256").update("verified-stage").digest("hex");
    return {
        status: "staged-unexecuted",
        manifest: {
            staged: true,
            validated: false,
            applied: false,
            stagedSnapshot: {
                hash: stagedSnapshotHash,
                fileCount: files.length,
                totalBytes: files.reduce((sum, file) => sum + file.size, 0)
            },
            files
        },
        verifyCalls: 0,
        verify() {
            this.verifyCalls += 1;
        },
        captureFiles() {
            return contents.map(file => ({
                ...file,
                content: Buffer.from(file.content),
                size: file.content.length,
                digest: createHash("sha256").update(file.content).digest("hex")
            }));
        }
    };
}

function makeImage() {
    return {
        Id: imageId,
        Os: "linux",
        Architecture: "amd64",
        RepoDigests: [`node@${imageId}`],
        Config: {
            Env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
            Volumes: null
        }
    };
}

function makeContainer(image = makeImage()) {
    return {
        Image: imageId,
        State: { Status: "created" },
        Config: {
            Image: imageReference,
            Entrypoint: ["node"],
            Cmd: ["-e", "setTimeout(() => process.exit(0), 300000)"],
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
            AutoRemove: true,
            PortBindings: {},
            PidMode: "",
            IpcMode: "private",
            UTSMode: "private",
            CgroupnsMode: "private",
            Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=4m" }
        },
        Mounts: []
    };
}

function makeFake(stage, { container = makeContainer(), fail = null } = {}) {
    const image = makeImage();
    const calls = [];
    let payloadBuffer = null;
    const invoke = (args, options) => {
        calls.push({ args, options });
        const command = args.slice(2);
        const failure = fail?.(command, calls);
        if (failure) return failure;
        if (command[0] === "context" && command[1] === "inspect") {
            return {
                status: 0,
                stdout: JSON.stringify({
                    Host: "npipe:////./pipe/dockerDesktopLinuxEngine",
                    SkipTLSVerify: false
                })
            };
        }
        if (command[0] === "info") return { status: 0, stdout: "linux" };
        if (command[0] === "image" && command[1] === "inspect") {
            return { status: 0, stdout: JSON.stringify(image) };
        }
        if (command[0] === "container" && command[1] === "create") {
            container.Config.Cmd = command.slice(-2);
            return { status: 0, stdout: containerId };
        }
        if (command[0] === "container" && command[1] === "inspect") {
            return { status: 0, stdout: JSON.stringify([container]) };
        }
        if (command[0] === "container" && command[1] === "start") {
            container.State.Status = "running";
            return { status: 0, stdout: "" };
        }
        if (command[0] === "container" && command[1] === "exec") {
            payloadBuffer = options.input;
            const payload = JSON.parse(payloadBuffer.toString("utf8"));
            const files = payload.files.map(({ name, size, digest, contentBase64 }) => {
                const content = Buffer.from(contentBase64, "base64");
                assert.equal(content.length, size);
                assert.equal(createHash("sha256").update(content).digest("hex"), digest);
                return { name, size, digest };
            });
            return {
                status: 0,
                stdout: JSON.stringify({
                    status: "verified",
                    stagedSnapshotHash: payload.stagedSnapshotHash,
                    files,
                    totalBytes: files.reduce((sum, file) => sum + file.size, 0)
                })
            };
        }
        return { status: 0, stdout: "" };
    };
    return { calls, invoke, get payload() { return payloadBuffer; } };
}

function runProbe(stage, fake) {
    return createSandboxStageTransferProbe({
        platform: "win32",
        env: {},
        makeId: () => "test-run",
        invoke: fake.invoke
    }).run(stage);
}

test("the probe transfers staged bytes and verifies their hashes without executing them", () => {
    const stage = makeStage();
    const fake = makeFake(stage);
    const result = runProbe(stage, fake);

    assert.equal(result.status, "passed");
    assert.equal(result.candidateCodeExecuted, false);
    assert.equal(result.workspaceMounted, false);
    assert.equal(result.transferredFileCount, 2);
    assert.equal(stage.verifyCalls, 2);
    assert.equal(fake.calls.at(-1).args.slice(2).join(" "), `container rm --force ${containerId}`);
    assert.ok(fake.calls.every(call => call.args.slice(0, 2).join(" ") === "--context desktop-linux"));

    const create = fake.calls.find(call =>
        call.args[2] === "container" && call.args[3] === "create"
    );
    assert.ok(create);
    assert.ok(create.args.includes("--pull=never"));
    assert.ok(create.args.includes("--rm"));
    assert.ok(create.args.includes("--network"));
    assert.ok(create.args.includes("none"));
    assert.ok(create.args.includes("--read-only"));
    assert.ok(create.args.includes("--tmpfs"));
    const exec = fake.calls.find(call =>
        call.args[2] === "container" && call.args[3] === "exec"
    );
    assert.ok(exec);
    assert.ok(exec.args.includes("--interactive"));
    assert.ok(exec.args.includes("65534:65534"));
    assert.equal(exec.args.at(-1).includes("require(\"./stage/"), false);
    assert.ok(fake.payload instanceof Buffer);
    const payload = JSON.parse(fake.payload.toString("utf8"));
    assert.equal(payload.files.length, 2);
    assert.ok(payload.files.every(file => typeof file.contentBase64 === "string"));
});

test("invalid stage content and container policy fail before verifier execution", () => {
    const stage = makeStage();
    const fake = makeFake(stage, {
        container: (() => {
            const value = makeContainer();
            value.HostConfig.NetworkMode = "bridge";
            return value;
        })()
    });
    assert.throws(
        () => runProbe(stage, fake),
        error => error instanceof SandboxStageTransferError && error.code === "container-policy-mismatch"
    );
    assert.equal(fake.calls.some(call =>
        call.args[2] === "container" && call.args[3] === "start"
    ), false);
    assert.equal(fake.calls.some(call =>
        call.args[2] === "container" && call.args[3] === "exec"
    ), false);
    assert.equal(fake.calls.at(-1).args.slice(2, 5).join(" "), "container rm --force");

    const tampered = makeStage();
    tampered.captureFiles = function () {
        const files = makeStage().captureFiles();
        files[0].content[0] ^= 0xff;
        return files;
    };
    const untouchedDocker = makeFake(tampered);
    assert.throws(
        () => runProbe(tampered, untouchedDocker),
        error => error instanceof SandboxStageTransferError && error.code === "staged-file-metadata-invalid"
    );
    assert.equal(untouchedDocker.calls.length, 0);
});

test("cleanup failures are reported rather than returning a transfer pass", () => {
    const stage = makeStage();
    const fake = makeFake(stage, {
        fail(command) {
            if (command[0] === "container" && command[1] === "rm") {
                return { status: 1, stdout: "", stderr: "cleanup failed" };
            }
            return null;
        }
    });
    assert.throws(
        () => runProbe(stage, fake),
        error => error instanceof SandboxStageTransferError && error.code === "docker-command-failed"
    );
});
