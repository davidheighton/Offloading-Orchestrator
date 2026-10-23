"use strict";

const path = require("node:path");
const { isSensitiveFile } = require("./sensitive-text");

const maximumRelativePathLength = 240;
const excludedDirectories = new Set([".git", "node_modules", ".copilot-knowledge"]);

function normalizeRelativePath(value) {
    if (typeof value !== "string" ||
        value.length === 0 ||
        value.includes("\0") ||
        value.includes("\\") ||
        value.startsWith("/") ||
        /^[a-z]:/i.test(value)) {
        throw new Error("unsafe-relative-path");
    }
    const normalized = value.normalize("NFC");
    const segments = normalized.split("/");
    if (normalized.length > maximumRelativePathLength ||
        segments.length > 32 ||
        segments.some(segment =>
            !segment ||
            segment === "." ||
            segment === ".." ||
            segment.length > 255 ||
            /[<>:"|?*\x00-\x1f]/.test(segment) ||
            /[ .]$/.test(segment) ||
            /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
        )) {
        throw new Error("unsafe-relative-path");
    }
    return segments.join("/");
}

function isSensitiveRelativePath(relativePath) {
    return isSensitiveFile(relativePath.split("/").join(path.sep));
}

function isCredentialRelativePath(relativePath) {
    return isSensitiveRelativePath(relativePath) ||
        relativePath.split("/").some(part => {
            const name = part.toLowerCase();
            return name === ".npmrc" ||
                name === ".netrc" ||
                name === ".pypirc" ||
                name === ".git-credentials" ||
                name === "auth.json" ||
                name.endsWith("-auth-state.json") ||
                name.startsWith("id_rsa") ||
                name.startsWith("id_ed25519") ||
                /\.(?:pem|key|p12|pfx|kdbx)$/.test(name);
        });
}

function hasRelativePathCollision(relativePaths) {
    const components = new Map();
    const files = new Set();
    const directories = new Set();
    for (const relativePath of relativePaths) {
        const segments = relativePath.split("/");
        for (let index = 0; index < segments.length; index++) {
            const prefix = segments.slice(0, index + 1).join("/");
            const canonicalPrefix = prefix.toLowerCase();
            const existingPrefix = components.get(canonicalPrefix);
            if (existingPrefix && existingPrefix !== prefix) return true;
            components.set(canonicalPrefix, prefix);
            if (index < segments.length - 1) {
                if (files.has(canonicalPrefix)) return true;
                directories.add(canonicalPrefix);
            }
        }
        const canonicalPath = relativePath.toLowerCase();
        if (files.has(canonicalPath) || directories.has(canonicalPath)) return true;
        files.add(canonicalPath);
    }
    return false;
}

module.exports = {
    excludedDirectories,
    hasRelativePathCollision,
    isCredentialRelativePath,
    isSensitiveRelativePath,
    maximumRelativePathLength,
    normalizeRelativePath
};
