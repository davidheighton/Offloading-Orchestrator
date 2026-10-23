"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const snapshotAlgorithmVersion = 2;
const snapshotLimits = Object.freeze({
    maxEntries: 5000,
    maxFiles: 2000,
    maxFileBytes: 2 * 1024 * 1024,
    maxTotalBytes: 20 * 1024 * 1024
});
const {
    excludedDirectories,
    isCredentialRelativePath,
    normalizeRelativePath
} = require("./safe-relative-path");

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

function hasReparsePoint(stat) {
    return Number.isInteger(stat.attributes) && (stat.attributes & 0x400) !== 0;
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

function readDirectoryEntries(directory, counters, limits, countEntries = true) {
    let entries;
    try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
        translateFilesystemError(error, "snapshot-directory-unreadable");
    }
    if (countEntries) counters.entryCount += entries.length;
    if (counters.entryCount > limits.maxEntries) {
        throw new WorkspaceSnapshotError("snapshot-too-many-entries");
    }
    return entries;
}

function safeRelativeName(name) {
    try {
        return normalizeRelativePath(name);
    } catch {
        throw new WorkspaceSnapshotError("snapshot-unsafe-name");
    }
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
    if (stateDirectory !== null) {
        let stateRoot;
        try {
            stateRoot = fs.realpathSync(stateDirectory);
        } catch (error) {
            translateFilesystemError(error, "snapshot-state-directory-unavailable");
        }
        if (pathsOverlap(root, stateRoot)) {
            throw new WorkspaceSnapshotError("snapshot-state-directory-overlaps-workspace");
        }
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
    const files = [];
    const fileIdentities = new Set();
    const canonicalPaths = new Set();
    const counters = { entryCount: 0, totalBytes: 0 };

    function captureDirectory(directoryPath, relativeDirectory, beforeDirectory) {
        const entries = readDirectoryEntries(directoryPath, counters, limits);
        const beforeNames = [];
        for (const entry of entries) {
            const relativeName = safeRelativeName(
                relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
            );
            const canonicalName = relativeName.toLowerCase();
            if (canonicalPaths.has(canonicalName)) {
                throw new WorkspaceSnapshotError("snapshot-case-collision");
            }
            canonicalPaths.add(canonicalName);
            beforeNames.push(relativeName);

            const leafName = relativeName.slice(relativeName.lastIndexOf("/") + 1).toLowerCase();
            if (excludedDirectories.has(leafName)) continue;
            const filePath = path.join(directoryPath, entry.name);
            let stat;
            try {
                stat = fs.lstatSync(filePath);
            } catch (error) {
                translateFilesystemError(error, "snapshot-read-race");
            }
            if (stat.isSymbolicLink() || hasReparsePoint(stat)) {
                throw new WorkspaceSnapshotError("snapshot-symlink");
            }
            if (stat.isDirectory()) {
                if (!isCredentialRelativePath(relativeName)) {
                    captureDirectory(filePath, relativeName, stat);
                }
                continue;
            }
            if (isCredentialRelativePath(relativeName)) continue;
            if (!stat.isFile()) throw new WorkspaceSnapshotError("snapshot-unsupported-object");
            if (!Number.isFinite(stat.ino) || stat.ino === 0 || !Number.isFinite(stat.dev)) {
                throw new WorkspaceSnapshotError("snapshot-file-identity-unavailable");
            }
            if (stat.nlink > 1) throw new WorkspaceSnapshotError("snapshot-hardlink");
            if (stat.size > limits.maxFileBytes) {
                throw new WorkspaceSnapshotError("snapshot-file-too-large");
            }
            counters.totalBytes += stat.size;
            if (counters.totalBytes > limits.maxTotalBytes) {
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
                name: relativeName,
                size: stat.size,
                digest: hashedFile.digest,
                content: hashedFile.content
            });
        }

        const afterNames = readDirectoryEntries(directoryPath, counters, limits, false)
            .map(entry => safeRelativeName(
                relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
            ))
            .sort();
        let afterDirectory;
        try {
            afterDirectory = fs.lstatSync(directoryPath);
        } catch (error) {
            translateFilesystemError(error, "snapshot-read-race");
        }
        if (JSON.stringify(beforeNames.sort()) !== JSON.stringify(afterNames) ||
            !sameDirectoryMetadata(beforeDirectory, afterDirectory) ||
            afterDirectory.isSymbolicLink() ||
            hasReparsePoint(afterDirectory)) {
            throw new WorkspaceSnapshotError("snapshot-read-race");
        }
    }

    captureDirectory(root, "", beforeRoot);
    let afterRoot;
    try {
        afterRoot = fs.lstatSync(root);
    } catch (error) {
        translateFilesystemError(error, "snapshot-read-race");
    }
    if (!sameDirectoryMetadata(beforeRoot, afterRoot) ||
        afterRoot.isSymbolicLink() ||
        hasReparsePoint(afterRoot)) {
        throw new WorkspaceSnapshotError("snapshot-read-race");
    }

    files.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    const digest = createHash("sha256");
    for (const file of files) digest.update(`${file.name}\0${file.size}\0${file.digest}\n`);
    const snapshot = {
        algorithmVersion: snapshotAlgorithmVersion,
        hash: digest.digest("hex"),
        fileCount: files.length,
        totalBytes: counters.totalBytes
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
