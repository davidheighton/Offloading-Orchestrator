"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const snapshotAlgorithmVersion = 1;
const snapshotLimits = Object.freeze({
    maxEntries: 1000,
    maxFiles: 500,
    maxFileBytes: 256 * 1024,
    maxTotalBytes: 2 * 1024 * 1024
});
const excludedDirectories = new Set([".git", "node_modules", ".copilot-knowledge"]);

class WorkspaceSnapshotError extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}

function translateFilesystemError(error, code) {
    if (["EACCES", "ELOOP", "ENOENT", "ENOTDIR", "EPERM"].includes(error.code)) {
        throw new WorkspaceSnapshotError(code);
    }
    throw error;
}

function normalizeName(name) {
    if (!name ||
        name.includes("\0") ||
        name.includes("/") ||
        name.includes("\\") ||
        /[ .]$/.test(name)) {
        throw new WorkspaceSnapshotError("snapshot-unsafe-name");
    }
    const normalized = name.normalize("NFC");
    const canonical = normalized.toLowerCase();
    if (!canonical || canonical === "." || canonical === ".." || /^[a-z]:/.test(canonical)) {
        throw new WorkspaceSnapshotError("snapshot-unsafe-name");
    }
    return normalized;
}

function isCredentialName(name) {
    return name === ".env" ||
        name.startsWith(".env.") ||
        name === ".npmrc" ||
        name === ".netrc" ||
        name === ".pypirc" ||
        name === ".git-credentials" ||
        name === "auth.json" ||
        name.endsWith("-auth-state.json") ||
        name.startsWith("id_rsa") ||
        name.startsWith("id_ed25519") ||
        /\.(?:pem|key|p12|pfx|kdbx)$/.test(name);
}

function hasReparsePoint(stat) {
    return Number.isInteger(stat.attributes) && (stat.attributes & 0x400) !== 0;
}

function isIncludedName(name) {
    return name === "package.json" || name.endsWith(".js") || name.startsWith("readme");
}

function sameFileMetadata(left, right) {
    return left.isFile() &&
        right.isFile() &&
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.mtimeMs === right.mtimeMs &&
        left.ctimeMs === right.ctimeMs &&
        left.nlink === right.nlink;
}

function sameDirectoryMetadata(left, right) {
    return left.isDirectory() &&
        right.isDirectory() &&
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.mtimeMs === right.mtimeMs &&
        left.ctimeMs === right.ctimeMs;
}

function hashFile(filePath, before) {
    let descriptor;
    try {
        const noFollow = typeof fs.constants.O_NOFOLLOW === "number"
            ? fs.constants.O_NOFOLLOW
            : 0;
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
        const opened = fs.fstatSync(descriptor);
        if (!sameFileMetadata(before, opened) || opened.nlink > 1) {
            throw new WorkspaceSnapshotError("snapshot-read-race");
        }

        const content = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < before.size) {
            const bytesRead = fs.readSync(
                descriptor,
                content,
                offset,
                before.size - offset,
                offset
            );
            if (bytesRead === 0) throw new WorkspaceSnapshotError("snapshot-read-race");
            offset += bytesRead;
        }
        const extra = Buffer.alloc(1);
        if (fs.readSync(descriptor, extra, 0, 1, before.size) !== 0) {
            throw new WorkspaceSnapshotError("snapshot-read-race");
        }

        const after = fs.fstatSync(descriptor);
        const pathAfter = fs.lstatSync(filePath);
        if (pathAfter.isSymbolicLink() ||
            hasReparsePoint(pathAfter) ||
            !sameFileMetadata(before, after) ||
            !sameFileMetadata(before, pathAfter)) {
            throw new WorkspaceSnapshotError("snapshot-read-race");
        }
        return {
            digest: createHash("sha256").update(content).digest("hex"),
            content
        };
    } catch (error) {
        if (error instanceof WorkspaceSnapshotError) throw error;
        translateFilesystemError(error, "snapshot-read-race");
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
    }
}

function readRootEntries(root, maximumEntries) {
    let entries;
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
        translateFilesystemError(error, "snapshot-root-unreadable");
    }
    if (entries.length > maximumEntries) {
        throw new WorkspaceSnapshotError("snapshot-too-many-entries");
    }
    return entries;
}

function captureWorkspaceSnapshot(workspacePath, stateDirectory, requestedLimits = {}) {
    const limits = { ...snapshotLimits, ...requestedLimits };
    for (const value of Object.values(limits)) {
        if (!Number.isSafeInteger(value) || value < 1) {
            throw new WorkspaceSnapshotError("invalid-snapshot-limits");
        }
    }

    let root;
    try {
        root = fs.realpathSync(workspacePath);
    } catch (error) {
        translateFilesystemError(error, "snapshot-root-unavailable");
    }
    let stateRoot;
    try {
        stateRoot = fs.realpathSync(stateDirectory);
    } catch (error) {
        translateFilesystemError(error, "snapshot-state-directory-unavailable");
    }
    if (path.relative(root, stateRoot) === "") {
        throw new WorkspaceSnapshotError("snapshot-state-directory-overlaps-workspace");
    }

    let beforeRoot;
    try {
        beforeRoot = fs.lstatSync(root);
    } catch (error) {
        translateFilesystemError(error, "snapshot-root-unavailable");
    }
    if (!beforeRoot.isDirectory() || beforeRoot.isSymbolicLink() || hasReparsePoint(beforeRoot)) {
        throw new WorkspaceSnapshotError("snapshot-root-unavailable");
    }
    const entries = readRootEntries(root, limits.maxEntries);
    const names = [];
    const canonicalNames = new Set();
    const files = [];
    const fileIdentities = new Set();
    let totalBytes = 0;

    for (const entry of entries) {
        const normalizedName = normalizeName(entry.name);
        const canonicalName = normalizedName.toLowerCase();
        if (canonicalNames.has(canonicalName)) {
            throw new WorkspaceSnapshotError("snapshot-case-collision");
        }
        names.push(normalizedName);
        canonicalNames.add(canonicalName);
        if (excludedDirectories.has(canonicalName) || isCredentialName(canonicalName)) continue;
        if (!isIncludedName(canonicalName)) continue;

        const filePath = path.join(root, entry.name);
        let stat;
        try {
            stat = fs.lstatSync(filePath);
        } catch (error) {
            translateFilesystemError(error, "snapshot-read-race");
        }
        if (stat.isSymbolicLink() || hasReparsePoint(stat)) {
            throw new WorkspaceSnapshotError("snapshot-symlink");
        }
        if (!stat.isFile()) throw new WorkspaceSnapshotError("snapshot-unsupported-object");
        if (!Number.isFinite(stat.ino) || stat.ino === 0 || !Number.isFinite(stat.dev)) {
            throw new WorkspaceSnapshotError("snapshot-file-identity-unavailable");
        }
        if (stat.nlink > 1) throw new WorkspaceSnapshotError("snapshot-hardlink");
        if (stat.size > limits.maxFileBytes) {
            throw new WorkspaceSnapshotError("snapshot-file-too-large");
        }
        totalBytes += stat.size;
        if (totalBytes > limits.maxTotalBytes) {
            throw new WorkspaceSnapshotError("snapshot-too-large");
        }
        if (files.length >= limits.maxFiles) {
            throw new WorkspaceSnapshotError("snapshot-too-many-files");
        }

        const identity = `${stat.dev}:${stat.ino}`;
        if (fileIdentities.has(identity)) throw new WorkspaceSnapshotError("snapshot-hardlink");
        fileIdentities.add(identity);
        const hashedFile = hashFile(filePath, stat);
        files.push({
            name: normalizedName,
            size: stat.size,
            digest: hashedFile.digest,
            content: hashedFile.content
        });
    }

    const afterEntries = readRootEntries(root, limits.maxEntries)
        .map(entry => normalizeName(entry.name))
        .sort();
    const beforeNames = [...names].sort();
    let afterRoot;
    try {
        afterRoot = fs.lstatSync(root);
    } catch (error) {
        translateFilesystemError(error, "snapshot-read-race");
    }
    if (JSON.stringify(beforeNames) !== JSON.stringify(afterEntries) ||
        !sameDirectoryMetadata(beforeRoot, afterRoot)) {
        throw new WorkspaceSnapshotError("snapshot-read-race");
    }

    files.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    const digest = createHash("sha256");
    for (const file of files) digest.update(`${file.name}\0${file.size}\0${file.digest}\n`);
    const snapshot = {
        algorithmVersion: snapshotAlgorithmVersion,
        hash: digest.digest("hex"),
        fileCount: files.length,
        totalBytes
    };
    return {
        workspaceRoot: root,
        snapshot,
        files
    };
}

function computeWorkspaceSnapshot(workspacePath, stateDirectory, requestedLimits = {}) {
    return captureWorkspaceSnapshot(workspacePath, stateDirectory, requestedLimits).snapshot;
}

module.exports = {
    captureWorkspaceSnapshot,
    computeWorkspaceSnapshot,
    WorkspaceSnapshotError,
    snapshotAlgorithmVersion,
    snapshotLimits
};
