"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { candidateTestFilename, parseCandidateTestDiff } = require("./candidate-diff");
const { hasSensitiveContent, isSensitiveFile } = require("./sensitive-text");
const {
    captureWorkspaceSnapshot,
    computeWorkspaceSnapshot,
    snapshotAlgorithmVersion,
    snapshotLimits,
    WorkspaceSnapshotError
} = require("./workspace-snapshot");

const stagingDirectoryName = "sandbox-staging";
const stagingPrefix = "candidate-";
const maximumProposalDiffBytes = 4 * 1024;
const maximumManifestBytes = 32 * 1024;
const maximumStagingEntries = 1000;
const staleStagingTtlMs = 24 * 60 * 60 * 1000;
const maximumWindowsPathLength = 240;

class SandboxWorkspaceError extends Error {
    constructor(code, cause) {
        super(`Sandbox workspace staging failed: ${code}`, cause ? { cause } : undefined);
        this.name = "SandboxWorkspaceError";
        this.code = code;
        this.cleanupError = null;
    }
}

function hasReparsePoint(stat) {
    return Number.isInteger(stat.attributes) && (stat.attributes & 0x400) !== 0;
}

function pathsOverlap(left, right) {
    const contains = (parent, child) => {
        const relative = path.relative(parent, child);
        return relative === "" ||
            (relative !== ".." &&
                !relative.startsWith(`..${path.sep}`) &&
                !path.isAbsolute(relative));
    };
    return contains(left, right) || contains(right, left);
}

function isStrictDescendant(parent, child) {
    const relative = path.relative(parent, child);
    return relative !== "" &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative);
}

function digestFile(name, content, origin) {
    return {
        name,
        size: content.length,
        digest: createHash("sha256").update(content).digest("hex"),
        origin
    };
}

function snapshotFromManifest(files) {
    const orderedFiles = [...files].sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
    const hash = createHash("sha256");
    let totalBytes = 0;
    for (const file of orderedFiles) {
        totalBytes += file.size;
        hash.update(`${file.name}\0${file.size}\0${file.digest}\n`);
    }
    return {
        algorithmVersion: snapshotAlgorithmVersion,
        hash: hash.digest("hex"),
        fileCount: orderedFiles.length,
        totalBytes
    };
}

function validateBaseSnapshot(snapshot) {
    return snapshot &&
        typeof snapshot === "object" &&
        snapshot.algorithmVersion === snapshotAlgorithmVersion &&
        typeof snapshot.hash === "string" &&
        /^[a-f0-9]{64}$/.test(snapshot.hash) &&
        Number.isInteger(snapshot.fileCount) &&
        snapshot.fileCount >= 0 &&
        snapshot.fileCount <= snapshotLimits.maxFiles &&
        Number.isInteger(snapshot.totalBytes) &&
        snapshot.totalBytes >= 0 &&
        snapshot.totalBytes <= snapshotLimits.maxTotalBytes;
}

function validateProposal(proposal, baseSnapshot) {
    if (!proposal ||
        proposal.schemaVersion !== 1 ||
        !["completed", "partial"].includes(proposal.status) ||
        proposal.validated !== false ||
        proposal.applied !== false ||
        !validateBaseSnapshot(baseSnapshot) ||
        proposal.baseSnapshotHash !== baseSnapshot.hash) {
        throw new SandboxWorkspaceError("proposal-or-base-invalid");
    }
    const preflight = proposal.staticPreflight;
    if (!preflight ||
        preflight.schemaVersion !== 1 ||
        preflight.status !== "eligible-for-sandbox-review" ||
        preflight.reasonCode !== null ||
        preflight.target !== candidateTestFilename ||
        preflight.baseSnapshotHash !== baseSnapshot.hash ||
        preflight.currentSnapshotHash !== baseSnapshot.hash ||
        !Number.isInteger(preflight.addedLineCount) ||
        preflight.addedLineCount < 1 ||
        preflight.addedLineCount > 200 ||
        typeof proposal.proposalText !== "string" ||
        Buffer.byteLength(proposal.proposalText, "utf8") > maximumProposalDiffBytes) {
        throw new SandboxWorkspaceError("proposal-preflight-invalid");
    }
    const parsedDiff = parseCandidateTestDiff(proposal.proposalText);
    if (!parsedDiff.eligible ||
        parsedDiff.target !== preflight.target ||
        parsedDiff.addedLineCount !== preflight.addedLineCount) {
        throw new SandboxWorkspaceError("proposal-diff-invalid");
    }
    const candidateBuffer = Buffer.from(parsedDiff.sourceText, "utf8");
    if (candidateBuffer.toString("utf8") !== parsedDiff.sourceText ||
        parsedDiff.sourceText.charCodeAt(0) === 0xfeff ||
        hasSensitiveContent(parsedDiff.sourceText, { allowCodeExpressions: true })) {
        throw new SandboxWorkspaceError("candidate-content-rejected");
    }
    return {
        candidateText: parsedDiff.sourceText,
        candidateBuffer,
        proposalDigest: createHash("sha256").update(proposal.proposalText, "utf8").digest("hex")
    };
}

function snapshotFailure(error) {
    if (error instanceof WorkspaceSnapshotError) {
        return new SandboxWorkspaceError("workspace-snapshot-failed", error);
    }
    return error;
}

function ensureNormalDirectory(directory, code) {
    let stat;
    try {
        stat = fs.lstatSync(directory);
    } catch (error) {
        throw new SandboxWorkspaceError(code, error);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || hasReparsePoint(stat)) {
        throw new SandboxWorkspaceError(code);
    }
    return stat;
}

function ensureStagingRoot(stateRoot, create = false) {
    const stagingRoot = path.join(stateRoot, stagingDirectoryName);
    try {
        ensureNormalDirectory(stagingRoot, "staging-parent-invalid");
    } catch (error) {
        if (!(error instanceof SandboxWorkspaceError) ||
            error.cause?.code !== "ENOENT" ||
            !create) {
            throw error;
        }
        try {
            fs.mkdirSync(stagingRoot, { mode: 0o700 });
        } catch (createError) {
            if (createError.code !== "EEXIST") {
                throw new SandboxWorkspaceError("staging-parent-create-failed", createError);
            }
        }
        ensureNormalDirectory(stagingRoot, "staging-parent-invalid");
    }
    let realStagingRoot;
    try {
        realStagingRoot = fs.realpathSync(stagingRoot);
    } catch (error) {
        throw new SandboxWorkspaceError("staging-parent-unavailable", error);
    }
    if (!isStrictDescendant(stateRoot, realStagingRoot)) {
        throw new SandboxWorkspaceError("staging-parent-outside-state");
    }
    return realStagingRoot;
}

function directoryIdentity(directory) {
    const stat = ensureNormalDirectory(directory, "staging-directory-identity-unavailable");
    if (!Number.isFinite(stat.dev) || !Number.isFinite(stat.ino) || stat.ino === 0) {
        throw new SandboxWorkspaceError("staging-directory-identity-unavailable");
    }
    return { dev: stat.dev, ino: stat.ino };
}

function fileIdentity(filePath) {
    let stat;
    try {
        stat = fs.lstatSync(filePath);
    } catch (error) {
        throw new SandboxWorkspaceError("staging-manifest-identity-unavailable", error);
    }
    if (!stat.isFile() ||
        stat.isSymbolicLink() ||
        hasReparsePoint(stat) ||
        stat.nlink > 1 ||
        !Number.isFinite(stat.dev) ||
        !Number.isFinite(stat.ino) ||
        stat.ino === 0) {
        throw new SandboxWorkspaceError("staging-manifest-identity-unavailable");
    }
    return { dev: stat.dev, ino: stat.ino, size: stat.size };
}

function ensureDirectoryIdentity(directory, expectedIdentity) {
    const currentIdentity = directoryIdentity(directory);
    if (currentIdentity.dev !== expectedIdentity.dev ||
        currentIdentity.ino !== expectedIdentity.ino) {
        throw new SandboxWorkspaceError("staging-directory-changed");
    }
}

function ensureFileIdentity(filePath, expectedIdentity) {
    const currentIdentity = fileIdentity(filePath);
    if (currentIdentity.dev !== expectedIdentity.dev ||
        currentIdentity.ino !== expectedIdentity.ino ||
        currentIdentity.size !== expectedIdentity.size) {
        throw new SandboxWorkspaceError("staging-manifest-changed");
    }
}

function writeExclusiveFile(destination, content, code) {
    let descriptor;
    try {
        descriptor = fs.openSync(destination, "wx", 0o600);
        fs.writeFileSync(descriptor, content);
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
    } catch (error) {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        throw new SandboxWorkspaceError(code, error);
    }
}

function writeStagedFile(stageDirectory, name, content) {
    const destination = path.resolve(stageDirectory, name);
    if (path.dirname(destination) !== stageDirectory) {
        throw new SandboxWorkspaceError("staging-path-invalid");
    }
    writeExclusiveFile(destination, content, "staging-file-write-failed");
}

function verifyManifestFile(manifestPath, expectedIdentity, manifest) {
    ensureFileIdentity(manifestPath, expectedIdentity);
    if (expectedIdentity.size > maximumManifestBytes) {
        throw new SandboxWorkspaceError("staging-manifest-too-large");
    }
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (error) {
        throw new SandboxWorkspaceError("staging-manifest-invalid", error);
    }
    if (JSON.stringify(parsed) !== JSON.stringify(manifest)) {
        throw new SandboxWorkspaceError("staging-manifest-changed");
    }
}

function verifyStagedDirectory(
    stageDirectory,
    stateRoot,
    stageIdentity,
    stagingRoot,
    stagingRootIdentity,
    manifestPath,
    manifestIdentity,
    manifest,
    includeContents = false
) {
    ensureDirectoryIdentity(stagingRoot, stagingRootIdentity);
    ensureDirectoryIdentity(stageDirectory, stageIdentity);
    let entries;
    try {
        entries = fs.readdirSync(stageDirectory).sort();
    } catch (error) {
        throw new SandboxWorkspaceError("staging-directory-unreadable", error);
    }
    const expectedNames = manifest.files.map(file => file.name).sort();
    if (JSON.stringify(entries) !== JSON.stringify(expectedNames)) {
        throw new SandboxWorkspaceError("staging-file-set-changed");
    }
    let captured;
    try {
        captured = captureWorkspaceSnapshot(stageDirectory, stateRoot);
    } catch (error) {
        throw snapshotFailure(error);
    }
    const actualFiles = captured.files.map(({ name, size, digest }) => ({ name, size, digest }));
    const expectedFiles = manifest.files.map(({ name, size, digest }) => ({ name, size, digest }));
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles) ||
        captured.snapshot.hash !== manifest.stagedSnapshot.hash) {
        throw new SandboxWorkspaceError("staging-content-changed");
    }
    if (manifestPath && manifestIdentity) {
        verifyManifestFile(manifestPath, manifestIdentity, manifest);
    }
    ensureDirectoryIdentity(stagingRoot, stagingRootIdentity);
    ensureDirectoryIdentity(stageDirectory, stageIdentity);
    return {
        status: "verified",
        stagedSnapshot: captured.snapshot,
        ...(includeContents ? {
            files: captured.files.map(file => ({
                name: file.name,
                size: file.size,
                digest: file.digest,
                content: Buffer.from(file.content)
            }))
        } : {})
    };
}

function cleanupStaleSandboxWorkspaces(stateDirectory, now = Date.now()) {
    let stateRoot;
    try {
        const stat = fs.lstatSync(stateDirectory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || hasReparsePoint(stat)) {
            throw new SandboxWorkspaceError("state-directory-invalid");
        }
        stateRoot = fs.realpathSync(stateDirectory);
    } catch (error) {
        if (error instanceof SandboxWorkspaceError) throw error;
        throw new SandboxWorkspaceError("state-directory-unavailable", error);
    }
    let stagingRoot;
    try {
        stagingRoot = ensureStagingRoot(stateRoot);
    } catch (error) {
        if (error.cause?.code === "ENOENT") return { removed: 0 };
        throw error;
    }
    let entries;
    try {
        entries = fs.readdirSync(stagingRoot, { withFileTypes: true });
    } catch (error) {
        throw new SandboxWorkspaceError("staging-parent-unreadable", error);
    }
    if (entries.length > maximumStagingEntries) {
        throw new SandboxWorkspaceError("staging-parent-too-many-entries");
    }

    const removedNames = new Set();
    const staleStages = entries.filter(entry =>
        entry.isDirectory() &&
        new RegExp(`^${stagingPrefix}[a-z0-9_-]{6,}$`, "i").test(entry.name)
    );
    for (const entry of staleStages) {
        const stagePath = path.join(stagingRoot, entry.name);
        const stat = ensureNormalDirectory(stagePath, "stale-staging-entry-invalid");
        if (now - stat.mtimeMs < staleStagingTtlMs) continue;
        const realStagePath = fs.realpathSync(stagePath);
        if (!isStrictDescendant(stagingRoot, realStagePath)) {
            throw new SandboxWorkspaceError("stale-staging-path-invalid");
        }
        fs.rmSync(realStagePath, { recursive: true, force: false });
        removedNames.add(entry.name);
        const manifestPath = path.join(stagingRoot, `${entry.name}.manifest.json`);
        try {
            fileIdentity(manifestPath);
            fs.unlinkSync(manifestPath);
        } catch (error) {
            if (error.cause?.code !== "ENOENT" && error.code !== "staging-manifest-identity-unavailable") {
                throw error;
            }
            if (error.code === "staging-manifest-identity-unavailable" &&
                error.cause?.code !== "ENOENT") {
                throw error;
            }
        }
    }

    for (const entry of entries) {
        const match = entry.name.match(new RegExp(`^(${stagingPrefix}[a-z0-9_-]{6,})\\.manifest\\.json$`, "i"));
        if (!match || staleStages.some(stage => stage.name.toLowerCase() === match[1].toLowerCase())) continue;
        const manifestPath = path.join(stagingRoot, entry.name);
        const stat = fileIdentity(manifestPath);
        if (now - fs.statSync(manifestPath).mtimeMs < staleStagingTtlMs) continue;
        fs.unlinkSync(manifestPath);
        removedNames.add(entry.name);
    }
    return { removed: removedNames.size };
}

function validateStagedSource(sourceFiles) {
    const stagedFiles = sourceFiles
        .filter(file => file.name.endsWith(".js") && !/(?:\.test|\.spec)\.js$/i.test(file.name))
        .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    if (stagedFiles.length === 0) throw new SandboxWorkspaceError("staging-source-empty");
    for (const file of stagedFiles) {
        if (isSensitiveFile(file.name)) {
            throw new SandboxWorkspaceError("sensitive-filename-in-snapshot");
        }
        const text = file.content.toString("utf8");
        if (Buffer.from(text, "utf8").compare(file.content) !== 0 ||
            text.charCodeAt(0) === 0xfeff ||
            hasSensitiveContent(text, { allowCodeExpressions: true })) {
            throw new SandboxWorkspaceError("sensitive-or-invalid-source-content");
        }
    }
    return stagedFiles;
}

function createSandboxWorkspace({
    workspacePath,
    stateDirectory,
    baseSnapshot,
    proposal
} = {}) {
    if (typeof workspacePath !== "string" ||
        typeof stateDirectory !== "string" ||
        !validateBaseSnapshot(baseSnapshot)) {
        throw new SandboxWorkspaceError("staging-input-invalid");
    }
    const validatedProposal = validateProposal(proposal, baseSnapshot);

    let sourceCapture;
    let stateRoot;
    try {
        sourceCapture = captureWorkspaceSnapshot(workspacePath, stateDirectory);
        stateRoot = fs.realpathSync(stateDirectory);
    } catch (error) {
        throw snapshotFailure(error);
    }
    if (sourceCapture.snapshot.hash !== baseSnapshot.hash) {
        throw new SandboxWorkspaceError("workspace-changed-before-staging");
    }
    if (pathsOverlap(sourceCapture.workspaceRoot, stateRoot)) {
        throw new SandboxWorkspaceError("staging-root-overlaps-workspace");
    }
    const candidateName = candidateTestFilename.toLowerCase();
    if (sourceCapture.files.some(file => file.name.toLowerCase() === candidateName)) {
        throw new SandboxWorkspaceError("candidate-already-present-in-snapshot");
    }

    const sourceFiles = validateStagedSource(sourceCapture.files);
    const stagedRoot = ensureStagingRoot(stateRoot, true);
    if (!isStrictDescendant(stateRoot, stagedRoot) ||
        pathsOverlap(sourceCapture.workspaceRoot, stagedRoot)) {
        throw new SandboxWorkspaceError("staging-root-overlaps-protected-path");
    }
    cleanupStaleSandboxWorkspaces(stateRoot);
    const stagedRootIdentity = directoryIdentity(stagedRoot);

    let stageDirectory = null;
    let manifestPath = null;
    let stageIdentity = null;
    let manifestIdentity = null;
    try {
        stageDirectory = fs.mkdtempSync(path.join(stagedRoot, stagingPrefix));
        const realStageDirectory = fs.realpathSync(stageDirectory);
        if (!isStrictDescendant(stagedRoot, realStageDirectory) ||
            pathsOverlap(realStageDirectory, sourceCapture.workspaceRoot)) {
            throw new SandboxWorkspaceError("staging-directory-location-invalid");
        }
        if (realStageDirectory.length + candidateTestFilename.length + 1 > maximumWindowsPathLength) {
            throw new SandboxWorkspaceError("staging-path-too-long");
        }
        stageIdentity = directoryIdentity(realStageDirectory);
        stageDirectory = realStageDirectory;

        const stagedFiles = [];
        for (const file of sourceFiles) {
            if (createHash("sha256").update(file.content).digest("hex") !== file.digest) {
                throw new SandboxWorkspaceError("source-content-changed-after-snapshot");
            }
            writeStagedFile(stageDirectory, file.name, file.content);
            stagedFiles.push(digestFile(file.name, file.content, "snapshot"));
        }
        writeStagedFile(stageDirectory, candidateTestFilename, validatedProposal.candidateBuffer);
        stagedFiles.push(digestFile(candidateTestFilename, validatedProposal.candidateBuffer, "proposal"));

        const afterCopy = captureWorkspaceSnapshot(workspacePath, stateDirectory);
        if (afterCopy.snapshot.hash !== baseSnapshot.hash) {
            throw new SandboxWorkspaceError("workspace-changed-during-staging");
        }
        const manifestFiles = stagedFiles.sort((left, right) =>
            left.name < right.name ? -1 : left.name > right.name ? 1 : 0
        );
        const stagedSnapshot = snapshotFromManifest(manifestFiles);
        if (stagedSnapshot.fileCount > snapshotLimits.maxFiles ||
            stagedSnapshot.totalBytes > snapshotLimits.maxTotalBytes ||
            manifestFiles.some(file => file.size > snapshotLimits.maxFileBytes)) {
            throw new SandboxWorkspaceError("staging-limits-exceeded");
        }
        const stageName = path.basename(stageDirectory);
        manifestPath = path.join(stagedRoot, `${stageName}.manifest.json`);
        const manifest = Object.freeze({
            schemaVersion: 1,
            algorithmVersion: snapshotAlgorithmVersion,
            stageName,
            staged: true,
            validated: false,
            applied: false,
            sourceSnapshotHash: baseSnapshot.hash,
            stagedSnapshot,
            proposalDigest: validatedProposal.proposalDigest,
            candidateFile: candidateTestFilename,
            candidateDigest: manifestFiles.find(file => file.origin === "proposal").digest,
            files: Object.freeze(manifestFiles.map(file => Object.freeze({ ...file }))),
            excluded: Object.freeze([
                "package.json",
                "readme-files",
                "test-files",
                "spec-files",
                "dependencies",
                "hidden-directories",
                "credential-like-filenames"
            ])
        });
        verifyStagedDirectory(
            stageDirectory,
            stateRoot,
            stageIdentity,
            stagedRoot,
            stagedRootIdentity,
            null,
            null,
            manifest
        );
        const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
        if (manifestBytes.length > maximumManifestBytes) {
            throw new SandboxWorkspaceError("staging-manifest-too-large");
        }
        writeExclusiveFile(manifestPath, manifestBytes, "staging-manifest-write-failed");
        manifestIdentity = fileIdentity(manifestPath);
        verifyStagedDirectory(
            stageDirectory,
            stateRoot,
            stageIdentity,
            stagedRoot,
            stagedRootIdentity,
            manifestPath,
            manifestIdentity,
            manifest
        );
        const afterVerification = captureWorkspaceSnapshot(workspacePath, stateDirectory);
        if (afterVerification.snapshot.hash !== baseSnapshot.hash) {
            throw new SandboxWorkspaceError("workspace-changed-after-verification");
        }

        let stageRemoved = false;
        let manifestRemoved = false;
        function verify(includeContents = false) {
            if (stageRemoved || manifestRemoved) {
                throw new SandboxWorkspaceError("staging-workspace-already-cleaned");
            }
            let currentSource;
            try {
                currentSource = computeWorkspaceSnapshot(workspacePath, stateDirectory);
            } catch (error) {
                throw snapshotFailure(error);
            }
            if (currentSource.hash !== manifest.sourceSnapshotHash) {
                throw new SandboxWorkspaceError("workspace-changed-after-staging");
            }
            const result = verifyStagedDirectory(
                stageDirectory,
                stateRoot,
                stageIdentity,
                stagedRoot,
                stagedRootIdentity,
                manifestPath,
                manifestIdentity,
                manifest,
                includeContents
            );
            if (includeContents) {
                let sourceAfterCapture;
                try {
                    sourceAfterCapture = computeWorkspaceSnapshot(workspacePath, stateDirectory);
                } catch (error) {
                    throw snapshotFailure(error);
                }
                if (sourceAfterCapture.hash !== manifest.sourceSnapshotHash) {
                    throw new SandboxWorkspaceError("workspace-changed-after-staging");
                }
            }
            return result;
        }
        return Object.freeze({
            status: "staged-unexecuted",
            stageDirectory,
            manifestPath,
            manifest,
            verify() { return verify(); },
            captureFiles() { return verify(true).files; },
            cleanup() {
                if (stageRemoved && manifestRemoved) return false;
                ensureDirectoryIdentity(stagedRoot, stagedRootIdentity);
                if (!stageRemoved) {
                    ensureDirectoryIdentity(stageDirectory, stageIdentity);
                    fs.rmSync(stageDirectory, { recursive: true, force: false });
                    stageRemoved = true;
                }
                if (!manifestRemoved) {
                    ensureFileIdentity(manifestPath, manifestIdentity);
                    fs.unlinkSync(manifestPath);
                    manifestRemoved = true;
                }
                return true;
            }
        });
    } catch (error) {
        const failure = error instanceof SandboxWorkspaceError
            ? error
            : snapshotFailure(error);
        if (stageDirectory && stageIdentity) {
            try {
                ensureDirectoryIdentity(stagedRoot, stagedRootIdentity);
                ensureDirectoryIdentity(stageDirectory, stageIdentity);
                fs.rmSync(stageDirectory, { recursive: true, force: false });
            } catch (cleanupError) {
                failure.cleanupError = cleanupError.code || "staging-directory-cleanup-failed";
            }
        }
        if (manifestPath) {
            try {
                fileIdentity(manifestPath);
                fs.unlinkSync(manifestPath);
            } catch (cleanupError) {
                if (cleanupError.cause?.code !== "ENOENT" &&
                    cleanupError.code !== "staging-manifest-identity-unavailable") {
                    failure.cleanupError ||= cleanupError.code || "staging-manifest-cleanup-failed";
                } else if (cleanupError.cause?.code !== "ENOENT") {
                    failure.cleanupError ||= cleanupError.code || "staging-manifest-cleanup-failed";
                }
            }
        }
        throw failure;
    }
}

module.exports = {
    SandboxWorkspaceError,
    cleanupStaleSandboxWorkspaces,
    createSandboxWorkspace
};
