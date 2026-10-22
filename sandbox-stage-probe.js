"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { candidateTestFilename, parseCandidateTestDiff } = require("./candidate-diff");
const { createSandboxStageTransferProbe } = require("./sandbox-stage-transfer");
const { createSandboxWorkspace } = require("./sandbox-workspace");
const { computeWorkspaceSnapshot } = require("./workspace-snapshot");

function getDirectoryIdentity(directory) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        (Number.isInteger(stat.attributes) && (stat.attributes & 0x400) !== 0) ||
        !Number.isFinite(stat.dev) || !Number.isFinite(stat.ino) || stat.ino === 0) {
        throw new Error("Temporary probe directory identity is unsafe.");
    }
    return { dev: stat.dev, ino: stat.ino };
}

function matchesDirectoryIdentity(directory, expected) {
    const actual = getDirectoryIdentity(directory);
    return actual.dev === expected.dev && actual.ino === expected.ino;
}

function createSyntheticProposal(baseSnapshot) {
    const lines = [
        'const assert = require("node:assert/strict");',
        "assert.equal(true, true);"
    ];
    const proposalText = [
        `diff --git a/${candidateTestFilename} b/${candidateTestFilename}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${candidateTestFilename}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map(line => `+${line}`)
    ].join("\n");
    const parsed = parseCandidateTestDiff(proposalText);
    if (!parsed.eligible) throw new Error("Synthetic candidate failed static preflight.");
    return {
        schemaVersion: 1,
        status: "completed",
        proposalText,
        staticPreflight: {
            schemaVersion: 1,
            status: "eligible-for-sandbox-review",
            reasonCode: null,
            target: candidateTestFilename,
            addedLineCount: lines.length,
            baseSnapshotHash: baseSnapshot.hash,
            currentSnapshotHash: baseSnapshot.hash
        },
        baseSnapshotHash: baseSnapshot.hash,
        validated: false,
        applied: false
    };
}

function runStageProbe() {
    const workspacePath = path.resolve(__dirname);
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-stage-probe-"));
    const stateIdentity = getDirectoryIdentity(stateDirectory);
    let stagedWorkspace = null;
    let result = null;
    let failure = null;

    try {
        const baseSnapshot = computeWorkspaceSnapshot(workspacePath, stateDirectory);
        const proposal = createSyntheticProposal(baseSnapshot);
        stagedWorkspace = createSandboxWorkspace({
            workspacePath,
            stateDirectory,
            baseSnapshot,
            proposal
        });
        result = createSandboxStageTransferProbe().run(stagedWorkspace);
    } catch (error) {
        failure = error;
    } finally {
        if (stagedWorkspace) {
            try {
                stagedWorkspace.cleanup();
            } catch (error) {
                if (failure) failure.cleanupError = error.code || "stage-cleanup-failed";
                else failure = error;
            }
        }
        const stagingRoot = path.join(stateDirectory, "sandbox-staging");
        try {
            if (!matchesDirectoryIdentity(stateDirectory, stateIdentity)) {
                throw new Error("Temporary state directory changed identity during cleanup.");
            }
            if (fs.existsSync(stagingRoot)) fs.rmdirSync(stagingRoot);
            if (!matchesDirectoryIdentity(stateDirectory, stateIdentity)) {
                throw new Error("Temporary state directory changed identity during cleanup.");
            }
            fs.rmdirSync(stateDirectory);
        } catch (error) {
            if (failure) failure.cleanupError ||= error.code || "temporary-state-cleanup-failed";
            else failure = error;
        }
    }

    if (failure) throw failure;
    return result;
}

if (require.main === module) {
    try {
        console.log(JSON.stringify(runStageProbe(), null, 2));
    } catch (error) {
        const diagnostic = typeof error.cause?.stderr === "string"
            ? error.cause.stderr.slice(0, 512)
            : undefined;
        console.error(JSON.stringify({
            status: "failed",
            reasonCode: error.code || "unexpected-error",
            cleanupError: error.cleanupError || null,
            ...(diagnostic ? { diagnostic } : {})
        }));
        process.exitCode = 1;
    }
}

module.exports = { runStageProbe };
