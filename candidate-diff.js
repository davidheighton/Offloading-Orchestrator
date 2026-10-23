"use strict";

const {
    excludedDirectories,
    hasRelativePathCollision,
    isCredentialRelativePath,
    normalizeRelativePath
} = require("./safe-relative-path");

const candidateTestFilename = "improvement-loop.candidate.test.js";
const maxCandidateTestLines = 200;
const maximumProposalFiles = 100;
const maximumProposalAddedLines = 10000;

function rejected(reasonCode) {
    return { eligible: false, reasonCode, files: [], addedLineCount: 0 };
}

function parseProposalDiff(diff) {
    if (typeof diff !== "string" || diff.includes("\0")) {
        return rejected("invalid-diff-content");
    }
    const normalizedDiff = diff.replace(/\r\n/g, "\n");
    if (normalizedDiff.includes("\r")) return rejected("invalid-line-endings");
    const lines = normalizedDiff.split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (lines.length < 5) return rejected("invalid-diff-content");

    const files = [];
    const canonicalPaths = new Set();
    let addedLineCount = 0;
    let cursor = 0;
    while (cursor < lines.length) {
        const header = lines[cursor++].match(/^diff --git a\/(.+) b\/(.+)$/);
        if (!header) return rejected("invalid-diff-header");
        let oldPath;
        let newPath;
        try {
            oldPath = normalizeRelativePath(header[1]);
            newPath = normalizeRelativePath(header[2]);
        } catch {
            return rejected("unsafe-target-path");
        }
        if (oldPath !== newPath) return rejected("renames-not-supported");
        const relativePath = oldPath;
        const pathParts = relativePath.split("/");
        if (pathParts.some(part => excludedDirectories.has(part.toLowerCase()))) {
            return rejected("excluded-target-path");
        }
        if (isCredentialRelativePath(relativePath)) return rejected("sensitive-target-path");
        const canonicalPath = relativePath.toLowerCase();
        if (canonicalPaths.has(canonicalPath)) return rejected("duplicate-target-path");
        canonicalPaths.add(canonicalPath);

        let isNewFile = false;
        let isDeletedFile = false;
        let indexSeen = false;
        while (cursor < lines.length &&
            /^(?:new file mode |deleted file mode |old mode |new mode |index )/.test(lines[cursor])) {
            const metadata = lines[cursor++];
            if (metadata === "new file mode 100644" && !isNewFile) {
                isNewFile = true;
            } else if (metadata === "deleted file mode 100644" && !isDeletedFile) {
                isDeletedFile = true;
            } else if (metadata === "old mode 100644" || metadata === "new mode 100644") {
                continue;
            } else if (/^index [a-f0-9]{7,64}\.\.[a-f0-9]{7,64}(?: 100644)?$/i.test(metadata) && !indexSeen) {
                indexSeen = true;
            } else {
                return rejected("unsupported-file-metadata");
            }
        }
        if (isNewFile && isDeletedFile) return rejected("invalid-file-operation");
        const operation = isNewFile ? "add" : isDeletedFile ? "delete" : "modify";
        if (lines[cursor++] !== (operation === "add" ? "--- /dev/null" : `--- a/${relativePath}`) ||
            lines[cursor++] !== (operation === "delete" ? "+++ /dev/null" : `+++ b/${relativePath}`)) {
            return rejected("invalid-file-path-headers");
        }

        const hunks = [];
        let fileAddedLines = 0;
        let fileChangedLines = 0;
        while (cursor < lines.length && lines[cursor].startsWith("@@ ")) {
            const hunkHeader = lines[cursor++].match(
                /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/
            );
            if (!hunkHeader) return rejected("invalid-hunk-header");
            const hunk = {
                oldStart: Number(hunkHeader[1]),
                oldCount: hunkHeader[2] === undefined ? 1 : Number(hunkHeader[2]),
                newStart: Number(hunkHeader[3]),
                newCount: hunkHeader[4] === undefined ? 1 : Number(hunkHeader[4]),
                lines: []
            };
            if (![hunk.oldStart, hunk.oldCount, hunk.newStart, hunk.newCount]
                .every(Number.isSafeInteger)) {
                return rejected("invalid-hunk-range");
            }
            let oldCount = 0;
            let newCount = 0;
            while (cursor < lines.length &&
                !lines[cursor].startsWith("@@ ") &&
                !lines[cursor].startsWith("diff --git ")) {
                const line = lines[cursor++];
                const kind = line[0];
                if (![" ", "+", "-"].includes(kind)) return rejected("invalid-hunk-content");
                if (kind !== "+") oldCount++;
                if (kind !== "-") newCount++;
                if (kind === "+") fileAddedLines++;
                if (kind !== " ") fileChangedLines++;
                hunk.lines.push({ kind, text: line.slice(1) });
            }
            if (oldCount !== hunk.oldCount || newCount !== hunk.newCount) {
                return rejected("hunk-line-count-mismatch");
            }
            hunks.push(hunk);
        }
        if (hunks.length === 0 || fileChangedLines === 0) {
            return rejected("missing-change-hunks");
        }
        if (operation === "add" &&
            hunks.some(hunk => hunk.oldCount !== 0 ||
                hunk.lines.some(line => line.kind !== "+"))) {
            return rejected("invalid-file-addition-hunks");
        }
        if (operation === "delete" &&
            hunks.some(hunk => hunk.newCount !== 0 ||
                hunk.lines.some(line => line.kind !== "-"))) {
            return rejected("invalid-file-deletion-hunks");
        }
        addedLineCount += fileAddedLines;
        if (addedLineCount > maximumProposalAddedLines) {
            return rejected("proposal-too-many-added-lines");
        }
        files.push({ path: relativePath, operation, hunks, addedLineCount: fileAddedLines });
        if (files.length > maximumProposalFiles) return rejected("proposal-too-many-files");
    }

    if (hasRelativePathCollision(files.map(file => file.path))) {
        return rejected("overlapping-target-paths");
    }
    return { eligible: true, reasonCode: null, files, addedLineCount };
}

function applyProposalFileChange(change, sourceContent) {
    if (!change || !["add", "modify", "delete"].includes(change.operation) ||
        !Array.isArray(change.hunks) ||
        (change.operation === "add" && sourceContent !== null && sourceContent !== undefined) ||
        (change.operation !== "add" && !Buffer.isBuffer(sourceContent))) {
        throw new Error("invalid-proposal-file-input");
    }
    const sourceText = sourceContent ? sourceContent.toString("utf8") : "";
    if (sourceContent && Buffer.from(sourceText, "utf8").compare(sourceContent) !== 0) {
        throw new Error("binary-file-patch-not-supported");
    }
    const hasCrLf = sourceText.includes("\r\n");
    const withoutCrLf = sourceText.replace(/\r\n/g, "");
    if (withoutCrLf.includes("\r") || (hasCrLf && withoutCrLf.includes("\n"))) {
        throw new Error("unsupported-source-line-endings");
    }
    const lineEnding = hasCrLf ? "\r\n" : "\n";
    const normalizedSource = hasCrLf ? sourceText.replace(/\r\n/g, "\n") : sourceText;
    const hasTrailingNewline = normalizedSource.endsWith("\n");
    const sourceLines = normalizedSource === "" ? [] : normalizedSource.split("\n");
    if (hasTrailingNewline) sourceLines.pop();

    let sourceCursor = 0;
    const outputLines = [];
    for (const hunk of change.hunks) {
        const oldIndex = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
        const newIndex = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
        if (oldIndex < sourceCursor || oldIndex > sourceLines.length) {
            throw new Error("hunk-range-does-not-match-source");
        }
        outputLines.push(...sourceLines.slice(sourceCursor, oldIndex));
        sourceCursor = oldIndex;
        if (newIndex !== outputLines.length) {
            throw new Error("hunk-range-does-not-match-source");
        }
        let oldCount = 0;
        let newCount = 0;
        for (const line of hunk.lines) {
            if (line.kind === " " || line.kind === "-") {
                if (sourceLines[sourceCursor] !== line.text) {
                    throw new Error("hunk-context-does-not-match-source");
                }
                sourceCursor++;
                oldCount++;
            }
            if (line.kind === " " || line.kind === "+") {
                outputLines.push(line.text);
                newCount++;
            }
        }
        if (oldCount !== hunk.oldCount || newCount !== hunk.newCount) {
            throw new Error("hunk-line-count-mismatch");
        }
    }
    outputLines.push(...sourceLines.slice(sourceCursor));
    if (change.operation === "delete" && outputLines.length !== 0) {
        throw new Error("deletion-does-not-remove-entire-file");
    }
    if (change.operation === "delete") return null;
    const finalText = outputLines.join("\n");
    const addTrailingNewline = change.operation === "add" || hasTrailingNewline;
    return Buffer.from(`${finalText}${addTrailingNewline ? "\n" : ""}`.replace(/\n/g, lineEnding), "utf8");
}

function parseCandidateTestDiff(diff) {
    const parsed = parseProposalDiff(diff);
    if (!parsed.eligible) {
        return {
            eligible: false,
            reasonCode: parsed.reasonCode,
            target: null,
            addedLineCount: 0,
            sourceText: null
        };
    }
    if (parsed.files.length !== 1) {
        return { eligible: false, reasonCode: "multiple-or-missing-file-sections", target: null, addedLineCount: 0, sourceText: null };
    }
    const [change] = parsed.files;
    if (change.path !== candidateTestFilename) {
        return { eligible: false, reasonCode: "path-not-allowlisted", target: null, addedLineCount: 0, sourceText: null };
    }
    if (change.operation !== "add") {
        return { eligible: false, reasonCode: "not-a-new-file-addition", target: null, addedLineCount: 0, sourceText: null };
    }
    if (change.addedLineCount < 1 || change.addedLineCount > maxCandidateTestLines) {
        return { eligible: false, reasonCode: "invalid-hunk-content", target: null, addedLineCount: 0, sourceText: null };
    }
    let sourceText;
    try {
        sourceText = applyProposalFileChange(change, null).toString("utf8");
    } catch {
        return { eligible: false, reasonCode: "invalid-hunk-content", target: null, addedLineCount: 0, sourceText: null };
    }
    if (Buffer.from(sourceText, "utf8").toString("utf8") !== sourceText) {
        return { eligible: false, reasonCode: "invalid-utf8-content", target: null, addedLineCount: 0, sourceText: null };
    }
    return {
        eligible: true,
        reasonCode: null,
        target: candidateTestFilename,
        addedLineCount: change.addedLineCount,
        sourceText
    };
}

module.exports = {
    candidateTestFilename,
    applyProposalFileChange,
    parseCandidateTestDiff,
    parseProposalDiff
};
