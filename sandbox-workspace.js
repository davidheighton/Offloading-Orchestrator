"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const {
    applyProposalFileChange,
    candidateTestFilename,
    parseProposalDiff
} = require("./candidate-diff");
const { hasSensitiveContent } = require("./sensitive-text");
const {
    excludedDirectories,
    hasRelativePathCollision,
    isCredentialRelativePath,
    normalizeRelativePath
} = require("./safe-relative-path");
const {
    captureWorkspaceSnapshot,
    computeWorkspaceSnapshot,
    snapshotAlgorithmVersion,
    snapshotLimits,
    WorkspaceSnapshotError
} = require("./workspace-snapshot");

const stagingDirectoryName = "sandbox-staging";
const stagingPrefix = "candidate-";
const maximumProposalDiffBytes = 256 * 1024;
const maximumManifestBytes = 1024 * 1024;
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
        preflight.baseSnapshotHash !== baseSnapshot.hash ||
        preflight.currentSnapshotHash !== baseSnapshot.hash ||
        !Array.isArray(preflight.files) ||
        preflight.files.length < 1 ||
        preflight.files.length > 100 ||
        !Number.isInteger(preflight.addedLineCount) ||
        preflight.addedLineCount < 0 ||
        typeof proposal.proposalText !== "string" ||
        Buffer.byteLength(proposal.proposalText, "utf8") > maximumProposalDiffBytes) {
        throw new SandboxWorkspaceError("proposal-preflight-invalid");
    }
    const parsedDiff = parseProposalDiff(proposal.proposalText);
    if (!parsedDiff.eligible ||
        parsedDiff.addedLineCount !== preflight.addedLineCount ||
        parsedDiff.files.length !== preflight.files.length ||
        parsedDiff.files.some((file, index) => {
            const expected = preflight.files[index];
            return !expected ||
                expected.path !== file.path ||
                expected.operation !== file.operation ||
                (file.operation === "add"
                    ? expected.baseDigest !== null
                    : !/^[a-f0-9]{64}$/.test(expected.baseDigest || ""));
        })) {
        throw new SandboxWorkspaceError("proposal-diff-invalid");
    }
    const addedText = parsedDiff.files
        .flatMap(file => file.hunks.flatMap(hunk =>
            hunk.lines.filter(line => line.kind === "+").map(line => line.text)
        ))
        .join("\n");
    if (hasSensitiveContent(addedText, { allowCodeExpressions: true })) {
        throw new SandboxWorkspaceError("candidate-content-rejected");
    }
    return {
        parsedDiff,
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
    let normalizedName;
    try {
        normalizedName = normalizeRelativePath(name);
    } catch {
        throw new SandboxWorkspaceError("staging-path-invalid");
    }
    const segments = normalizedName.split("/");
    const destination = path.resolve(stageDirectory, ...segments);
    if (!isStrictDescendant(stageDirectory, destination) ||
        destination.length > maximumWindowsPathLength) {
        throw new SandboxWorkspaceError("staging-path-invalid");
    }
    let parent = stageDirectory;
    for (const segment of segments.slice(0, -1)) {
        parent = path.join(parent, segment);
        try {
            fs.mkdirSync(parent, { mode: 0o700 });
        } catch (error) {
            if (error.code !== "EEXIST") {
                throw new SandboxWorkspaceError("staging-directory-create-failed", error);
            }
        }
        const stat = fs.lstatSync(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink() || hasReparsePoint(stat) ||
            !isStrictDescendant(stageDirectory, fs.realpathSync(parent))) {
            throw new SandboxWorkspaceError("staging-path-invalid");
        }
    }
    writeExclusiveFile(destination, content, "staging-file-write-failed");
}

function listStagingEntries(stageDirectory) {
    const entries = [];
    function visit(directory, relativeDirectory) {
        let children;
        try {
            children = fs.readdirSync(directory);
        } catch (error) {
            throw new SandboxWorkspaceError("staging-directory-unreadable", error);
        }
        for (const child of children) {
            let relativePath;
            try {
                relativePath = normalizeRelativePath(
                    relativeDirectory ? `${relativeDirectory}/${child}` : child
                );
            } catch {
                throw new SandboxWorkspaceError("staging-path-invalid");
            }
            const childPath = path.join(directory, child);
            let stat;
            try {
                stat = fs.lstatSync(childPath);
            } catch (error) {
                throw new SandboxWorkspaceError("staging-entry-identity-unavailable", error);
            }
            if (stat.isSymbolicLink() || hasReparsePoint(stat)) {
                throw new SandboxWorkspaceError("staging-symlink");
            }
            if (stat.isDirectory()) {
                entries.push(`d:${relativePath}`);
                visit(childPath, relativePath);
            } else if (stat.isFile() && stat.nlink === 1) {
                entries.push(`f:${relativePath}`);
            } else {
                throw new SandboxWorkspaceError("staging-unsupported-object");
            }
        }
    }
    visit(stageDirectory, "");
    return entries.sort();
}

function expectedStagingEntries(files) {
    const expected = new Set();
    for (const file of files) {
        expected.add(`f:${file.name}`);
        const segments = file.name.split("/");
        for (let index = 1; index < segments.length; index++) {
            expected.add(`d:${segments.slice(0, index).join("/")}`);
        }
    }
    return [...expected].sort();
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
    const actualEntries = listStagingEntries(stageDirectory);
    if (JSON.stringify(actualEntries) !== JSON.stringify(expectedStagingEntries(manifest.files))) {
        throw new SandboxWorkspaceError("staging-file-set-changed");
    }
    let captured;
    try {
        captured = captureWorkspaceSnapshot(stageDirectory, null);
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
    const stagedFiles = [...sourceFiles]
        .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    if (stagedFiles.length === 0) throw new SandboxWorkspaceError("staging-source-empty");
    for (const file of stagedFiles) {
        let normalizedName;
        try {
            normalizedName = normalizeRelativePath(file.name);
        } catch {
            throw new SandboxWorkspaceError("staging-path-invalid");
        }
        if (normalizedName !== file.name ||
            isCredentialRelativePath(file.name) ||
            file.name.split("/").some(part => excludedDirectories.has(part.toLowerCase()))) {
            throw new SandboxWorkspaceError("sensitive-filename-in-snapshot");
        }
        if (!Buffer.isBuffer(file.content) ||
            createHash("sha256").update(file.content).digest("hex") !== file.digest) {
            throw new SandboxWorkspaceError("source-content-changed-after-snapshot");
        }
        const referenceOnlyPath = /\.(?:md|mdx|rst|txt|adoc)$/i.test(file.name) ||
            file.name.split("/").some(part =>
                /^(?:tests?|specs?|fixtures?|examples?)$/i.test(part) ||
                /\.(?:test|spec)\.[^.]+$/i.test(part)
            );
        const text = file.content.toString("utf8");
        if (!referenceOnlyPath &&
            Buffer.from(text, "utf8").compare(file.content) === 0 &&
            !text.includes("\0") &&
            (text.charCodeAt(0) === 0xfeff ||
                hasSensitiveContent(text, { allowCodeExpressions: true }))) {
            throw new SandboxWorkspaceError("sensitive-or-invalid-source-content");
        }
    }
    return stagedFiles;
}

function applyProposalChanges(sourceFiles, parsedDiff, preflightFiles) {
    const sourceByPath = new Map(sourceFiles.map(file => [file.name.toLowerCase(), file]));
    const resultByPath = new Map(sourceFiles.map(file => [file.name, {
        name: file.name,
        content: Buffer.from(file.content),
        origin: "snapshot"
    }]));

    for (const [index, change] of parsedDiff.files.entries()) {
        const preflight = preflightFiles[index];
        const canonicalPath = change.path.toLowerCase();
        const existing = sourceByPath.get(canonicalPath);
        if (change.operation === "add") {
            if (existing) throw new SandboxWorkspaceError("proposal-target-already-exists");
            let content;
            try {
                content = applyProposalFileChange(change, null);
            } catch (error) {
                throw new SandboxWorkspaceError("proposal-patch-invalid", error);
            }
            resultByPath.set(change.path, { name: change.path, content, origin: "proposal" });
            continue;
        }
        if (!existing ||
            existing.name !== change.path ||
            existing.digest !== preflight.baseDigest) {
            throw new SandboxWorkspaceError("proposal-base-file-mismatch");
        }
        let content;
        try {
            content = applyProposalFileChange(change, Buffer.from(existing.content));
        } catch (error) {
            throw new SandboxWorkspaceError("proposal-patch-does-not-match-base", error);
        }
        resultByPath.delete(existing.name);
        if (change.operation !== "delete") {
            resultByPath.set(change.path, { name: change.path, content, origin: "proposal" });
        }
    }

    const result = [...resultByPath.values()].sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
    if (result.length === 0 || result.length > snapshotLimits.maxFiles) {
        throw new SandboxWorkspaceError("staging-limits-exceeded");
    }
    if (hasRelativePathCollision(result.map(file => file.name))) {
        throw new SandboxWorkspaceError("staging-path-collision-or-exclusion");
    }
    let totalBytes = 0;
    const names = new Set();
    for (const file of result) {
        let normalizedName;
        try {
            normalizedName = normalizeRelativePath(file.name);
        } catch {
            throw new SandboxWorkspaceError("staging-path-invalid");
        }
        const canonicalName = normalizedName.toLowerCase();
        if (canonicalName !== file.name.toLowerCase() ||
            names.has(canonicalName) ||
            isCredentialRelativePath(file.name) ||
            file.name.split("/").some(part => excludedDirectories.has(part.toLowerCase()))) {
            throw new SandboxWorkspaceError("staging-path-collision-or-exclusion");
        }
        names.add(canonicalName);
        if (!Buffer.isBuffer(file.content) || file.content.length > snapshotLimits.maxFileBytes) {
            throw new SandboxWorkspaceError("staging-limits-exceeded");
        }
        totalBytes += file.content.length;
        if (totalBytes > snapshotLimits.maxTotalBytes) {
            throw new SandboxWorkspaceError("staging-limits-exceeded");
        }
        file.digest = createHash("sha256").update(file.content).digest("hex");
    }
    return result;
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
    const sourceFiles = validateStagedSource(sourceCapture.files);
    const stagedContent = applyProposalChanges(
        sourceFiles,
        validatedProposal.parsedDiff,
        proposal.staticPreflight.files
    );
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
        if (stagedContent.some(file =>
            path.resolve(realStageDirectory, ...file.name.split("/")).length > maximumWindowsPathLength
        )) {
            throw new SandboxWorkspaceError("staging-path-too-long");
        }
        stageIdentity = directoryIdentity(realStageDirectory);
        stageDirectory = realStageDirectory;

        const stagedFiles = [];
        for (const file of stagedContent) {
            writeStagedFile(stageDirectory, file.name, file.content);
            stagedFiles.push(digestFile(file.name, file.content, file.origin));
        }

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
        const candidateChange = validatedProposal.parsedDiff.files.find(file =>
            file.path === candidateTestFilename && file.operation !== "delete"
        );
        const candidateEntry = candidateChange &&
            manifestFiles.find(file => file.name === candidateTestFilename);
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
            candidateFile: candidateEntry ? candidateTestFilename : null,
            candidateDigest: candidateEntry?.digest || null,
            proposalFiles: Object.freeze(validatedProposal.parsedDiff.files.map((change, index) => {
                const resultFile = manifestFiles.find(file => file.name === change.path);
                return Object.freeze({
                    path: change.path,
                    operation: change.operation,
                    baseDigest: proposal.staticPreflight.files[index].baseDigest,
                    resultDigest: change.operation === "delete" ? null : resultFile?.digest || null
                });
            })),
            files: Object.freeze(manifestFiles.map(file => Object.freeze({ ...file }))),
            excluded: Object.freeze([
                ".git",
                "node_modules",
                ".copilot-knowledge",
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
