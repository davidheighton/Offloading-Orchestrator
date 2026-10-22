"use strict";

const candidateTestFilename = "improvement-loop.candidate.test.js";
const maxCandidateTestLines = 200;

function parseCandidateTestDiff(diff) {
    const rejected = reasonCode => ({
        eligible: false,
        reasonCode,
        target: null,
        addedLineCount: 0,
        sourceText: null
    });
    if (typeof diff !== "string" || diff.includes("\0")) {
        return rejected("invalid-diff-content");
    }
    const withoutCrLf = diff.replace(/\r\n/g, "");
    if (withoutCrLf.includes("\r") ||
        (diff.includes("\r\n") && withoutCrLf.includes("\n"))) {
        return rejected("invalid-line-endings");
    }
    const lines = diff.replace(/\r\n/g, "\n").split("\n");
    if (lines.filter(line => line.startsWith("diff --git ")).length !== 1) {
        return rejected("multiple-or-missing-file-sections");
    }
    const header = lines[0]?.match(/^diff --git a\/([^ \t]+) b\/([^ \t]+)$/);
    if (!header) return rejected("invalid-diff-header");
    if (header[1] !== header[2] || header[1] !== candidateTestFilename) {
        return rejected("path-not-allowlisted");
    }
    if (lines[1] !== "new file mode 100644" ||
        lines[2] !== "--- /dev/null" ||
        lines[3] !== `+++ b/${candidateTestFilename}`) {
        return rejected("not-a-new-file-addition");
    }
    const hunk = lines[4]?.match(/^@@ -0,0 \+1,(\d+) @@$/);
    if (!hunk) return rejected("invalid-hunk-header");
    const addedLineCount = Number(hunk[1]);
    if (!Number.isSafeInteger(addedLineCount) ||
        addedLineCount < 1 ||
        addedLineCount > maxCandidateTestLines ||
        lines.length !== 5 + addedLineCount ||
        lines.slice(5).some(line => !line.startsWith("+"))) {
        return rejected("invalid-hunk-content");
    }
    const sourceText = `${lines.slice(5).map(line => line.slice(1)).join("\n")}\n`;
    if (Buffer.from(sourceText, "utf8").toString("utf8") !== sourceText) {
        return rejected("invalid-utf8-content");
    }
    return {
        eligible: true,
        reasonCode: null,
        target: candidateTestFilename,
        addedLineCount,
        sourceText
    };
}

module.exports = {
    candidateTestFilename,
    parseCandidateTestDiff
};
