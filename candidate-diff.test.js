"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { applyProposalFileChange, parseProposalDiff } = require("./candidate-diff");

test("the parser accepts nested multi-file additions, modifications, and deletions", () => {
    const diff = [
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

    const parsed = parseProposalDiff(diff);

    assert.equal(parsed.eligible, true);
    assert.equal(parsed.files.length, 3);
    assert.deepEqual(parsed.files.map(file => [file.path, file.operation]), [
        ["src/core/module.mjs", "modify"],
        ["tests/nested/new.spec.js", "add"],
        ["docs/old.md", "delete"]
    ]);
    assert.equal(parsed.addedLineCount, 2);
    assert.equal(
        applyProposalFileChange(parsed.files[0], Buffer.from("export const value = 1;\r\n"))
            .toString("utf8"),
        "export const value = 2;\r\n"
    );
    assert.equal(
        applyProposalFileChange(parsed.files[1], null).toString("utf8"),
        "assert.ok(true);\n"
    );
    assert.equal(
        applyProposalFileChange(parsed.files[2], Buffer.from("old documentation\n")),
        null
    );
});

test("unsafe, excluded, credential, and case-colliding paths are rejected", () => {
    const cases = [
        ["../outside.js", "unsafe-target-path"],
        ["C:/outside.js", "unsafe-target-path"],
        ["src\\outside.js", "unsafe-target-path"],
        [".env", "sensitive-target-path"],
        ["src/client-secret.json", "sensitive-target-path"],
        ["node_modules/package/index.js", "excluded-target-path"],
        ["CON.txt", "unsafe-target-path"]
    ];
    for (const [filename, reasonCode] of cases) {
        const parsed = parseProposalDiff([
            `diff --git a/${filename} b/${filename}`,
            "new file mode 100644",
            "--- /dev/null",
            `+++ b/${filename}`,
            "@@ -0,0 +1 @@",
            "+content"
        ].join("\n"));
        assert.equal(parsed.eligible, false, filename);
        assert.equal(parsed.reasonCode, reasonCode, filename);
    }

    const collision = parseProposalDiff([
        "diff --git a/src/A.js b/src/A.js",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/A.js",
        "@@ -0,0 +1 @@",
        "+one",
        "diff --git a/src/a.js b/src/a.js",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/a.js",
        "@@ -0,0 +1 @@",
        "+two"
    ].join("\n"));
    assert.equal(collision.eligible, false);
    assert.equal(collision.reasonCode, "duplicate-target-path");

    const directoryCollision = parseProposalDiff([
        "diff --git a/src/A/one.js b/src/A/one.js",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/A/one.js",
        "@@ -0,0 +1 @@",
        "+one",
        "diff --git a/src/a/two.js b/src/a/two.js",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/a/two.js",
        "@@ -0,0 +1 @@",
        "+two"
    ].join("\n"));
    assert.equal(directoryCollision.eligible, false);
    assert.equal(directoryCollision.reasonCode, "overlapping-target-paths");
});

test("hunk counts and source context are exact, with no fuzzy application", () => {
    const malformed = parseProposalDiff([
        "diff --git a/src/module.js b/src/module.js",
        "--- a/src/module.js",
        "+++ b/src/module.js",
        "@@ -1 +1,2 @@",
        "-old",
        "+new"
    ].join("\n"));
    assert.equal(malformed.eligible, false);
    assert.equal(malformed.reasonCode, "hunk-line-count-mismatch");

    const parsed = parseProposalDiff([
        "diff --git a/src/module.js b/src/module.js",
        "--- a/src/module.js",
        "+++ b/src/module.js",
        "@@ -1 +1 @@",
        "-old",
        "+new"
    ].join("\n"));
    assert.equal(parsed.eligible, true);
    assert.throws(
        () => applyProposalFileChange(parsed.files[0], Buffer.from("nearby\n")),
        /hunk-context-does-not-match-source/
    );
});
