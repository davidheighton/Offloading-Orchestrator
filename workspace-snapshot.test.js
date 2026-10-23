const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
    captureWorkspaceSnapshot,
    computeWorkspaceSnapshot,
    WorkspaceSnapshotError
} = require("./workspace-snapshot");

function makeWorkspace(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-snapshot-root-"));
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-snapshot-state-"));
    t.after(() => {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(stateDirectory, { recursive: true, force: true });
    });
    return { root, stateDirectory };
}

function errorCode(code) {
    return error => error instanceof WorkspaceSnapshotError && error.code === code;
}

test("workspace snapshots are deterministic and change with included files", t => {
    const first = makeWorkspace(t);
    const second = makeWorkspace(t);
    fs.writeFileSync(path.join(first.root, "a.js"), "module.exports = 1;\n");
    fs.writeFileSync(path.join(first.root, "README.md"), "snapshot\n");
    fs.writeFileSync(path.join(second.root, "README.md"), "snapshot\n");
    fs.writeFileSync(path.join(second.root, "a.js"), "module.exports = 1;\n");

    const initial = computeWorkspaceSnapshot(first.root, first.stateDirectory);
    assert.deepEqual(computeWorkspaceSnapshot(second.root, second.stateDirectory), initial);

    fs.writeFileSync(path.join(first.root, "a.js"), "module.exports = 2;\n");
    assert.notEqual(computeWorkspaceSnapshot(first.root, first.stateDirectory).hash, initial.hash);
    fs.renameSync(path.join(first.root, "a.js"), path.join(first.root, "renamed.js"));
    assert.notEqual(computeWorkspaceSnapshot(first.root, first.stateDirectory).hash, initial.hash);
});

test("captured workspace bytes and digest metadata come from the same bounded snapshot", t => {
    const { root, stateDirectory } = makeWorkspace(t);
    const source = "module.exports = true;\n";
    fs.writeFileSync(path.join(root, "module.js"), source);

    const captured = captureWorkspaceSnapshot(root, stateDirectory);

    assert.equal(captured.snapshot.hash, computeWorkspaceSnapshot(root, stateDirectory).hash);
    assert.deepEqual(captured.files.map(file => ({
        name: file.name,
        size: file.size,
        digest: file.digest,
        content: file.content.toString("utf8")
    })), [{
        name: "module.js",
        size: Buffer.byteLength(source),
        digest: createHash("sha256").update(source).digest("hex"),
        content: source
    }]);
});

test("recursive snapshots include nested text and binary files with portable relative names", t => {
    const { root, stateDirectory } = makeWorkspace(t);
    fs.mkdirSync(path.join(root, "src", "core"), { recursive: true });
    fs.mkdirSync(path.join(root, ".github"));
    fs.mkdirSync(path.join(root, "assets"));
    fs.writeFileSync(path.join(root, "src", "core", "module.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(root, ".github", "workflow.yml"), "name: build\n");
    fs.writeFileSync(path.join(root, "assets", "icon.bin"), Buffer.from([0, 255, 1, 2]));

    const captured = captureWorkspaceSnapshot(root, stateDirectory);

    assert.deepEqual(captured.files.map(file => file.name), [
        ".github/workflow.yml",
        "assets/icon.bin",
        "src/core/module.ts"
    ]);
    assert.deepEqual(captured.files.find(file => file.name === "assets/icon.bin").content, Buffer.from([0, 255, 1, 2]));
});

test("credentials, excluded directories, and state files are not fingerprinted", t => {
    const { root, stateDirectory } = makeWorkspace(t);
    fs.writeFileSync(path.join(root, "agent.js"), "module.exports = true;\n");
    const initial = computeWorkspaceSnapshot(root, stateDirectory);
    fs.writeFileSync(path.join(root, ".env"), "TOKEN=do-not-read\n");
    fs.writeFileSync(path.join(root, "auth.json"), "{\"token\":\"do-not-read\"}\n");
    fs.writeFileSync(path.join(root, "private.pem"), "private material\n");
    fs.mkdirSync(path.join(root, "src", "credentials"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "credentials", "token.json"), "{\"token\":\"do-not-read\"}\n");
    fs.mkdirSync(path.join(root, "src", ".env.local"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", ".env.local", "ignored.js"), "ignored\n");
    for (const directory of [".git", "node_modules", ".copilot-knowledge"]) {
        fs.mkdirSync(path.join(root, directory));
        fs.writeFileSync(path.join(root, directory, "hidden.js"), "ignored\n");
    }
    fs.writeFileSync(path.join(stateDirectory, "run-state.json"), "{\"secret\":\"ignored\"}\n");

    const originalOpen = fs.openSync;
    const openedPaths = [];
    fs.openSync = function (filePath, ...args) {
        openedPaths.push(filePath);
        return originalOpen.call(fs, filePath, ...args);
    };
    let after;
    try {
        after = computeWorkspaceSnapshot(root, stateDirectory);
    } finally {
        fs.openSync = originalOpen;
    }

    assert.equal(after.hash, initial.hash);
    assert.deepEqual(openedPaths, [path.join(root, "agent.js")]);
});

test("root state-directory overlap is rejected", t => {
    const { root } = makeWorkspace(t);

    assert.throws(
        () => computeWorkspaceSnapshot(root, root),
        errorCode("snapshot-state-directory-overlaps-workspace")
    );
});

test("snapshot bounds fail closed for entries, files, and bytes", t => {
    const { root, stateDirectory } = makeWorkspace(t);
    fs.writeFileSync(path.join(root, "a.js"), "1234");
    fs.writeFileSync(path.join(root, "b.js"), "5678");

    assert.throws(
        () => computeWorkspaceSnapshot(root, stateDirectory, { maxEntries: 1 }),
        errorCode("snapshot-too-many-entries")
    );
    assert.throws(
        () => computeWorkspaceSnapshot(root, stateDirectory, { maxFiles: 1 }),
        errorCode("snapshot-too-many-files")
    );
    assert.throws(
        () => computeWorkspaceSnapshot(root, stateDirectory, { maxFileBytes: 3 }),
        errorCode("snapshot-file-too-large")
    );
    assert.throws(
        () => computeWorkspaceSnapshot(root, stateDirectory, { maxTotalBytes: 7 }),
        errorCode("snapshot-too-large")
    );
});

test("nested symlinked files are rejected", t => {
    const { root, stateDirectory } = makeWorkspace(t);
    const target = path.join(root, "target-directory");
    fs.mkdirSync(target);
    try {
        fs.symlinkSync(target, path.join(root, "linked.js"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
        if (["EACCES", "EPERM", "ENOTSUP"].includes(error.code)) {
            t.skip(`Symlink creation is unavailable: ${error.code}`);
            return;
        }
        throw error;
    }

    assert.throws(
        () => computeWorkspaceSnapshot(root, stateDirectory),
        errorCode("snapshot-symlink")
    );
});

test("nested hardlinked files are rejected", t => {
    const { root, stateDirectory } = makeWorkspace(t);
    const target = path.join(root, "source.js");
    fs.writeFileSync(target, "module.exports = 1;\n");
    try {
        fs.linkSync(target, path.join(root, "linked.js"));
    } catch (error) {
        if (["EACCES", "EPERM", "ENOTSUP"].includes(error.code)) {
            t.skip(`Hardlink creation is unavailable: ${error.code}`);
            return;
        }
        throw error;
    }

    assert.throws(
        () => computeWorkspaceSnapshot(root, stateDirectory),
        errorCode("snapshot-hardlink")
    );
});

test("file read races are rejected", t => {
    const { root, stateDirectory } = makeWorkspace(t);
    fs.writeFileSync(path.join(root, "source.js"), "module.exports = 1;\n");
    const originalRead = fs.readSync;
    fs.readSync = () => 0;
    try {
        assert.throws(
            () => computeWorkspaceSnapshot(root, stateDirectory),
            errorCode("snapshot-read-race")
        );
    } finally {
        fs.readSync = originalRead;
    }
});
