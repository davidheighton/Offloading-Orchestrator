"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
    SandboxWorkspaceError,
    cleanupStaleSandboxWorkspaces,
    createSandboxWorkspace
} = require("./sandbox-workspace");
const {
    candidateTestFilename,
    parseCandidateTestDiff,
    parseProposalDiff
} = require("./candidate-diff");
const {
    captureWorkspaceSnapshot,
    computeWorkspaceSnapshot,
    snapshotAlgorithmVersion
} = require("./workspace-snapshot");

function fixture(t) {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-source-"));
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-state-"));
    fs.writeFileSync(path.join(workspacePath, "app.js"), "module.exports = 1;\n");
    fs.writeFileSync(path.join(workspacePath, "app.test.js"), "assert.ok(true);\n");
    fs.writeFileSync(path.join(workspacePath, "README.md"), "Documentation stays out of stage.\n");
    fs.writeFileSync(path.join(workspacePath, "package.json"), JSON.stringify({
        type: "commonjs",
        scripts: { test: "node --test" }
    }));
    fs.mkdirSync(path.join(workspacePath, "node_modules"));
    fs.writeFileSync(path.join(workspacePath, "node_modules", "dependency.js"), "module.exports = 2;\n");
    fs.mkdirSync(path.join(workspacePath, ".git"));
    fs.writeFileSync(path.join(workspacePath, ".git", "history.js"), "ignored\n");
    fs.mkdirSync(path.join(workspacePath, ".copilot-knowledge"));
    fs.writeFileSync(path.join(workspacePath, ".copilot-knowledge", "summary.js"), "ignored\n");
    fs.writeFileSync(path.join(workspacePath, ".env"), "API_KEY=must-not-stage\n");

    t.after(() => {
        fs.rmSync(workspacePath, { recursive: true, force: true });
        fs.rmSync(stateDirectory, { recursive: true, force: true });
    });
    return { workspacePath, stateDirectory };
}

function makeDiff(lines, filename = candidateTestFilename) {
    return [
        `diff --git a/${filename} b/${filename}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${filename}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map(line => `+${line}`)
    ].join("\n");
}

function makeProposal(baseSnapshot, lines = [
    'const assert = require("node:assert/strict");',
    'assert.equal(require("./app"), 1);'
]) {
    const proposalText = makeDiff(lines);
    const parsed = parseCandidateTestDiff(proposalText);
    assert.equal(parsed.eligible, true);
    const genericParsed = parseProposalDiff(proposalText);
    return {
        schemaVersion: 1,
        status: "completed",
        proposalText,
        staticPreflight: {
            schemaVersion: 1,
            status: "eligible-for-sandbox-review",
            reasonCode: null,
            target: candidateTestFilename,
            files: genericParsed.files.map(file => ({
                path: file.path,
                operation: file.operation,
                baseDigest: null
            })),
            addedLineCount: lines.length,
            baseSnapshotHash: baseSnapshot.hash,
            currentSnapshotHash: baseSnapshot.hash
        },
        baseSnapshotHash: baseSnapshot.hash,
        validated: false,
        applied: false
    };
}

function makeProposalFromDiff(paths, proposalText) {
    const captured = captureWorkspaceSnapshot(paths.workspacePath, paths.stateDirectory);
    const parsed = parseProposalDiff(proposalText);
    assert.equal(parsed.eligible, true);
    return {
        schemaVersion: 1,
        status: "completed",
        proposalText,
        staticPreflight: {
            schemaVersion: 1,
            status: "eligible-for-sandbox-review",
            reasonCode: null,
            target: parsed.files.length === 1 ? parsed.files[0].path : null,
            files: parsed.files.map(file => ({
                path: file.path,
                operation: file.operation,
                baseDigest: captured.files.find(baseFile => baseFile.name === file.path)?.digest ?? null
            })),
            addedLineCount: parsed.addedLineCount,
            baseSnapshotHash: captured.snapshot.hash,
            currentSnapshotHash: captured.snapshot.hash
        },
        baseSnapshotHash: captured.snapshot.hash,
        validated: false,
        applied: false
    };
}

function createStage(t, values = {}) {
    const paths = fixture(t);
    const baseSnapshot = computeWorkspaceSnapshot(paths.workspacePath, paths.stateDirectory);
    const proposal = makeProposal(baseSnapshot);
    const staged = createSandboxWorkspace({
        ...paths,
        baseSnapshot,
        proposal,
        ...values
    });
    t.after(() => {
        if (fs.existsSync(staged.stageDirectory)) staged.cleanup();
    });
    return { ...paths, baseSnapshot, proposal, staged };
}

test("nested multi-file proposals are applied only to a full staged copy", t => {
    const paths = fixture(t);
    fs.mkdirSync(path.join(paths.workspacePath, "src", "core"), { recursive: true });
    fs.writeFileSync(path.join(paths.workspacePath, "src", "core", "module.mjs"), "export const value = 1;\n");
    fs.mkdirSync(path.join(paths.workspacePath, "docs"));
    fs.writeFileSync(path.join(paths.workspacePath, "docs", "old.md"), "old documentation\n");
    const proposalText = [
        "diff --git a/src/core/module.mjs b/src/core/module.mjs",
        "index 1234567..abcdef0 100644",
        "--- a/src/core/module.mjs",
        "+++ b/src/core/module.mjs",
        "@@ -1 +1 @@",
        "-export const value = 1;",
        "+export const value = 2;",
        "diff --git a/tests/nested/new.spec.js b/tests/nested/new.spec.js",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/tests/nested/new.spec.js",
        "@@ -0,0 +1 @@",
        "+assert.ok(true);",
        "diff --git a/docs/old.md b/docs/old.md",
        "deleted file mode 100644",
        "--- a/docs/old.md",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-old documentation"
    ].join("\n");
    const proposal = makeProposalFromDiff(paths, proposalText);
    const baseSnapshot = computeWorkspaceSnapshot(paths.workspacePath, paths.stateDirectory);
    const staged = createSandboxWorkspace({ ...paths, baseSnapshot, proposal });
    t.after(() => {
        if (fs.existsSync(staged.stageDirectory)) staged.cleanup();
    });

    assert.equal(
        fs.readFileSync(path.join(staged.stageDirectory, "src", "core", "module.mjs"), "utf8"),
        "export const value = 2;\n"
    );
    assert.equal(
        fs.readFileSync(path.join(staged.stageDirectory, "tests", "nested", "new.spec.js"), "utf8"),
        "assert.ok(true);\n"
    );
    assert.equal(fs.existsSync(path.join(staged.stageDirectory, "docs", "old.md")), false);
    assert.equal(
        fs.readFileSync(path.join(paths.workspacePath, "src", "core", "module.mjs"), "utf8"),
        "export const value = 1;\n"
    );
    assert.equal(fs.existsSync(path.join(paths.workspacePath, "docs", "old.md")), true);
    assert.deepEqual(staged.manifest.proposalFiles.map(file => file.operation), [
        "modify",
        "add",
        "delete"
    ]);
    assert.ok(staged.manifest.proposalFiles[0].baseDigest);
    assert.equal(staged.manifest.validated, false);
    assert.equal(staged.manifest.applied, false);
    assert.equal(staged.verify().status, "verified");
});

test("the stager captures the recursive project tree and applies additions only in the stage", t => {
    const { workspacePath, stateDirectory, staged } = createStage(t);
    const stagedNames = fs.readdirSync(staged.stageDirectory).sort();

    assert.equal(staged.status, "staged-unexecuted");
    assert.deepEqual(stagedNames, [
        "README.md",
        "app.js",
        "app.test.js",
        candidateTestFilename,
        "package.json"
    ]);
    assert.equal(path.dirname(staged.stageDirectory), path.join(stateDirectory, "sandbox-staging"));
    assert.equal(path.dirname(staged.manifestPath), path.dirname(staged.stageDirectory));
    assert.equal(staged.manifest.sourceSnapshotHash, computeWorkspaceSnapshot(workspacePath, stateDirectory).hash);
    assert.equal(staged.manifest.stagedSnapshot.hash, staged.verify().stagedSnapshot.hash);
    assert.equal(staged.manifest.candidateFile, candidateTestFilename);
    assert.equal(staged.manifest.validated, false);
    assert.equal(staged.manifest.applied, false);
    assert.equal(staged.manifest.staged, true);
    assert.ok(staged.manifest.files.every(file => ["snapshot", "proposal"].includes(file.origin)));
    assert.equal(staged.manifest.files.some(file => file.name === "app.test.js"), true);
    assert.equal(staged.manifest.files.some(file => file.name === "README.md"), true);
    assert.equal(staged.manifest.files.some(file => file.name === "package.json"), true);
    assert.equal(staged.manifest.files.some(file => /node_modules|\.git|copilot-knowledge|\.env/.test(file.name)), false);
    assert.equal(fs.readFileSync(path.join(staged.stageDirectory, candidateTestFilename), "utf8").endsWith("\n"), true);
    assert.equal(staged.cleanup(), true);
    assert.equal(fs.existsSync(staged.stageDirectory), false);
    assert.equal(fs.existsSync(staged.manifestPath), false);
    assert.equal(staged.cleanup(), false);
});

test("candidate diffs are re-parsed and proposal metadata must remain unvalidated", t => {
    const paths = fixture(t);
    const baseSnapshot = computeWorkspaceSnapshot(paths.workspacePath, paths.stateDirectory);
    const proposal = makeProposal(baseSnapshot);
    proposal.proposalText = makeDiff(["module.exports = true;"], "../outside.js");

    assert.throws(
        () => createSandboxWorkspace({ ...paths, baseSnapshot, proposal }),
        error => error instanceof SandboxWorkspaceError && error.code === "proposal-diff-invalid"
    );

    proposal.proposalText = makeDiff(["module.exports = true;"]);
    proposal.validated = true;
    assert.throws(
        () => createSandboxWorkspace({ ...paths, baseSnapshot, proposal }),
        error => error instanceof SandboxWorkspaceError && error.code === "proposal-or-base-invalid"
    );
});

test("verified stage capture returns detached bytes and rechecks the source", t => {
    const staged = createStage(t);
    const files = staged.staged.captureFiles();
    const app = files.find(file => file.name === "app.js");

    assert.ok(app);
    assert.equal(app.content.toString("utf8"), "module.exports = 1;\n");
    assert.equal(app.digest, staged.staged.manifest.files.find(file => file.name === "app.js").digest);
    app.content.fill(0);
    assert.equal(fs.readFileSync(path.join(staged.staged.stageDirectory, "app.js"), "utf8"), "module.exports = 1;\n");

    fs.writeFileSync(path.join(staged.workspacePath, "app.js"), "module.exports = 2;\n");
    assert.throws(
        () => staged.staged.captureFiles(),
        error => error instanceof SandboxWorkspaceError && error.code === "workspace-changed-after-staging"
    );
});

test("addition targets must not already exist in any case in the source snapshot", t => {
    const paths = fixture(t);
    fs.writeFileSync(
        path.join(paths.workspacePath, "Improvement-Loop.Candidate.Test.js"),
        "existing\n"
    );
    const baseSnapshot = computeWorkspaceSnapshot(paths.workspacePath, paths.stateDirectory);
    const proposal = makeProposal(baseSnapshot);

    assert.throws(
        () => createSandboxWorkspace({ ...paths, baseSnapshot, proposal }),
        error => error instanceof SandboxWorkspaceError && error.code === "proposal-target-already-exists"
    );
});

test("stale source snapshots, secret-like source, and candidate content fail closed", t => {
    const stale = fixture(t);
    const oldSnapshot = computeWorkspaceSnapshot(stale.workspacePath, stale.stateDirectory);
    const oldProposal = makeProposal(oldSnapshot);
    fs.writeFileSync(path.join(stale.workspacePath, "changed.js"), "module.exports = 2;\n");
    assert.throws(
        () => createSandboxWorkspace({ ...stale, baseSnapshot: oldSnapshot, proposal: oldProposal }),
        error => error instanceof SandboxWorkspaceError && error.code === "workspace-changed-before-staging"
    );

    const secret = fixture(t);
    fs.writeFileSync(path.join(secret.workspacePath, "app.js"), 'const apiKey = "hard-coded-secret-value";\n');
    const secretSnapshot = computeWorkspaceSnapshot(secret.workspacePath, secret.stateDirectory);
    const secretProposal = makeProposal(secretSnapshot);
    assert.throws(
        () => createSandboxWorkspace({ ...secret, baseSnapshot: secretSnapshot, proposal: secretProposal }),
        error => error instanceof SandboxWorkspaceError && error.code === "sensitive-or-invalid-source-content"
    );

    const candidate = fixture(t);
    const candidateSnapshot = computeWorkspaceSnapshot(candidate.workspacePath, candidate.stateDirectory);
    const unsafeCandidate = makeProposal(candidateSnapshot, ['const apiKey = "hard-coded-secret-value";']);
    assert.throws(
        () => createSandboxWorkspace({ ...candidate, baseSnapshot: candidateSnapshot, proposal: unsafeCandidate }),
        error => error instanceof SandboxWorkspaceError && error.code === "candidate-content-rejected"
    );
});

test("code references to runtime credentials are permitted but not executed", t => {
    const paths = fixture(t);
    fs.writeFileSync(path.join(paths.workspacePath, "app.js"), "const token = process.env.ACCESS_TOKEN;\nmodule.exports = token;\n");
    const baseSnapshot = computeWorkspaceSnapshot(paths.workspacePath, paths.stateDirectory);
    const proposal = makeProposal(baseSnapshot);
    const staged = createSandboxWorkspace({ ...paths, baseSnapshot, proposal });
    t.after(() => {
        if (fs.existsSync(staged.stageDirectory)) staged.cleanup();
    });

    assert.match(
        fs.readFileSync(path.join(staged.stageDirectory, "app.js"), "utf8"),
        /process\.env\.ACCESS_TOKEN/
    );
    assert.equal(staged.status, "staged-unexecuted");
});

test("source changes during copying cause partial staging cleanup", t => {
    const paths = fixture(t);
    const baseSnapshot = computeWorkspaceSnapshot(paths.workspacePath, paths.stateDirectory);
    const proposal = makeProposal(baseSnapshot);
    const originalWrite = fs.writeFileSync;
    let changed = false;
    fs.writeFileSync = function (filePath, ...args) {
        const result = originalWrite.call(fs, filePath, ...args);
        if (!changed && typeof filePath === "number") {
            changed = true;
            originalWrite.call(fs, path.join(paths.workspacePath, "app.js"), "module.exports = 3;\n");
        }
        return result;
    };
    try {
        assert.throws(
            () => createSandboxWorkspace({ ...paths, baseSnapshot, proposal }),
            error => error instanceof SandboxWorkspaceError && error.code === "workspace-changed-during-staging"
        );
    } finally {
        fs.writeFileSync = originalWrite;
    }
    assert.deepEqual(fs.readdirSync(path.join(paths.stateDirectory, "sandbox-staging")), []);
});

test("post-staging verification detects altered and unexpected files", t => {
    const altered = createStage(t);
    fs.writeFileSync(path.join(altered.staged.stageDirectory, "app.js"), "module.exports = 99;\n");
    assert.throws(
        () => altered.staged.verify(),
        error => error instanceof SandboxWorkspaceError && error.code === "staging-content-changed"
    );

    const extra = createStage(t);
    fs.writeFileSync(path.join(extra.staged.stageDirectory, ".env"), "API_KEY=unexpected\n");
    assert.throws(
        () => extra.staged.verify(),
        error => error instanceof SandboxWorkspaceError && error.code === "staging-file-set-changed"
    );

    const changedSource = createStage(t);
    fs.writeFileSync(path.join(changedSource.workspacePath, "app.js"), "module.exports = 10;\n");
    assert.throws(
        () => changedSource.staged.verify(),
        error => error instanceof SandboxWorkspaceError && error.code === "workspace-changed-after-staging"
    );

    const changedManifest = createStage(t);
    const manifestText = fs.readFileSync(changedManifest.staged.manifestPath, "utf8");
    fs.writeFileSync(changedManifest.staged.manifestPath, `${manifestText} `);
    assert.throws(
        () => changedManifest.staged.verify(),
        error => error instanceof SandboxWorkspaceError && error.code === "staging-manifest-changed"
    );
});

test("staging refuses a state directory nested inside the workspace", t => {
    const paths = fixture(t);
    const baseSnapshot = computeWorkspaceSnapshot(paths.workspacePath, paths.stateDirectory);
    const proposal = makeProposal(baseSnapshot);
    const nestedStateDirectory = path.join(paths.workspacePath, "state");
    fs.mkdirSync(nestedStateDirectory);

    assert.throws(
        () => createSandboxWorkspace({
            ...paths,
            stateDirectory: nestedStateDirectory,
            baseSnapshot,
            proposal
        }),
        error => error instanceof SandboxWorkspaceError && error.code === "workspace-snapshot-failed"
    );
});

test("manifest hashes are deterministic and contain no file contents", t => {
    const { staged } = createStage(t);
    const manifestText = JSON.stringify(staged.manifest);

    assert.match(staged.manifest.stagedSnapshot.hash, /^[a-f0-9]{64}$/);
    assert.ok(staged.manifest.files.every(file =>
        /^[a-f0-9]{64}$/.test(file.digest) &&
        Number.isInteger(file.size) &&
        !Object.hasOwn(file, "content")
    ));
    assert.equal(manifestText.includes("module.exports = 1"), false);
    assert.equal(staged.manifest.stagedSnapshot.algorithmVersion, snapshotAlgorithmVersion);
});

test("stale-stage cleanup removes only old entries with the fixed stage pattern", t => {
    const paths = fixture(t);
    const stagingRoot = path.join(paths.stateDirectory, "sandbox-staging");
    fs.mkdirSync(stagingRoot);
    const staleDirectory = path.join(stagingRoot, "candidate-stale123");
    const retainedDirectory = path.join(stagingRoot, "keep-me");
    fs.mkdirSync(staleDirectory);
    fs.mkdirSync(retainedDirectory);
    const manifestPath = `${staleDirectory}.manifest.json`;
    fs.writeFileSync(manifestPath, JSON.stringify({ staged: true }));
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(staleDirectory, oldTime, oldTime);
    fs.utimesSync(manifestPath, oldTime, oldTime);

    const result = cleanupStaleSandboxWorkspaces(paths.stateDirectory);

    assert.equal(result.removed, 1);
    assert.equal(fs.existsSync(staleDirectory), false);
    assert.equal(fs.existsSync(manifestPath), false);
    assert.equal(fs.existsSync(retainedDirectory), true);
});

test("the staging module has no execution, network, or controller-tick integration", () => {
    const source = fs.readFileSync(path.join(__dirname, "sandbox-workspace.js"), "utf8");

    assert.doesNotMatch(source, /child_process|node:(?:vm|http|https|net|dgram)|\beval\s*\(|new Function/);
    assert.doesNotMatch(source, /require\(["']\.\/improvement-loop["']\)/);
});
