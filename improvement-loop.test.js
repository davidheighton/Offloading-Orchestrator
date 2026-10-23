const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const test = require("node:test");
const { createImprovementLoop, parseArguments } = require("./improvement-loop");
const { captureWorkspaceSnapshot } = require("./workspace-snapshot");

const validConfiguration = {
    confirmedProviderSharing: true,
    providers: ["claude", "gemini"],
    maxCycles: 3,
    maxProviderCalls: 15,
    maxSearches: 4,
    windowMinutes: 60
};
const workflowId = "7f7e39ec-60eb-42a2-810f-fb3b212c32ed";
const proposalWorkflowId = "883a844d-c485-4be6-a249-8f7bf889f8e4";
const candidateTestFilename = "improvement-loop.candidate.test.js";

function makeCandidateDiff(sourceLines, filename = candidateTestFilename) {
    return [
        `diff --git a/${filename} b/${filename}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${filename}`,
        `@@ -0,0 +1,${sourceLines.length} @@`,
        ...sourceLines.map(line => `+${line}`)
    ].join("\n");
}

function makeProposalResponse(diff, { tests = "Not run.", validation = "Not run." } = {}) {
    return [
        "## Summary",
        "Adds a focused regression test for retry behavior.",
        "## Unified diff",
        "```diff",
        diff,
        "```",
        "## Tests",
        tests,
        "## Validation",
        validation,
        "## Assumptions",
        "The retry boundary is testable.",
        "## Acceptance criteria",
        "- The test detects an unintended second retry."
    ].join("\n");
}

function jsonResponse(status, data) {
    const text = JSON.stringify(data);
    return {
        status,
        ok: status >= 200 && status < 300,
        body: new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(text));
                controller.close();
            }
        }),
        text: async () => text
    };
}

function makeTransferResult() {
    return {
        status: "passed",
        backend: "local-docker-desktop-linux",
        imageDigest: `sha256:${"1".repeat(64)}`,
        stagedSnapshotHash: "2".repeat(64),
        transferredFileCount: 2,
        transferredBytes: 256,
        checks: {
            localDockerContext: true,
            pinnedImage: true,
            noHostMounts: true,
            networkDisabled: true,
            readOnlyRootFilesystem: true,
            nonRootNoCapabilities: true,
            noNewPrivileges: true,
            resourceLimits: true,
            stagedHashesVerifiedInContainer: true
        },
        candidateCodeExecuted: false,
        workspaceMounted: false
    };
}

function createFixture(options = {}) {
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "improvement-loop-"));
    const workspaceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "improvement-loop-workspace-"));
    let currentTime = new Date("2025-01-01T00:00:00.000Z");
    const calls = [];
    const responses = [];
    const fetchImpl = async (url, requestOptions) => {
        calls.push({ url, options: requestOptions });
        const response = responses.shift();
        if (response === undefined) throw new Error("Unexpected service request.");
        if (response instanceof Error) throw response;
        return typeof response === "function" ? response(url, requestOptions) : response;
    };
    const loop = createImprovementLoop({
        stateDirectory,
        workspacePath: workspaceDirectory,
        now: () => new Date(currentTime),
        fetchImpl,
        ...options
    });
    return {
        stateDirectory,
        workspaceDirectory,
        loop,
        calls,
        restart() {
            return createImprovementLoop({
                stateDirectory,
                workspacePath: workspaceDirectory,
                now: () => new Date(currentTime),
                fetchImpl,
                ...options
            });
        },
        respond(response) {
            responses.push(response);
        },
        setTime(value) {
            currentTime = new Date(value);
        },
        cleanup() {
            fs.rmSync(stateDirectory, { recursive: true, force: true });
            fs.rmSync(workspaceDirectory, { recursive: true, force: true });
        }
    };
}

const repositorySummary = {
    summary: "A local Node.js service with provider workflows and an advice-only improvement controller.",
    keyFiles: [{ path: "improvement-loop.js", role: "bounded controller" }],
    entryPoints: ["offloading-agent.js"],
    dependencies: ["playwright"],
    risks: ["Provider workflow state is in memory."],
    limitations: ["No patch application or scheduling."]
};

async function prepareSubmission(fixture, configuration = validConfiguration) {
    fixture.loop.start(configuration);
    fixture.respond(jsonResponse(200, { summary: repositorySummary }));
    const result = await fixture.loop.tick();
    assert.equal(result.phase, "ready-to-submit");
    assert.equal(fixture.calls.length, 1);
    return result;
}

async function submitWorkflow(fixture, status = 202, configuration = validConfiguration) {
    await prepareSubmission(fixture, configuration);
    fixture.respond(jsonResponse(status, { id: workflowId, status: "queued" }));
    return fixture.loop.tick();
}

async function completeAdvice(fixture, configuration = validConfiguration) {
    await submitWorkflow(fixture, 202, configuration);
    fixture.setTime("2025-01-01T00:00:15.000Z");
    fixture.respond(jsonResponse(200, {
        id: workflowId,
        status: "completed",
        threads: [{ status: "completed", job: { provider: "claude", result: "branch advice" } }],
        synthesis: { provider: "claude", result: "Add a regression test for the retry boundary." }
    }));
    return fixture.loop.tick();
}

async function completeProposal(fixture, codingResult, configuration = validConfiguration) {
    await completeAdvice(fixture, configuration);
    fixture.respond(jsonResponse(202, { id: proposalWorkflowId, status: "queued" }));
    await fixture.loop.tick();
    fixture.setTime("2025-01-01T00:00:30.000Z");
    fixture.respond(jsonResponse(200, {
        id: proposalWorkflowId,
        status: "completed",
        threads: [{
            status: "completed",
            job: { provider: "claude", type: "coding", result: codingResult }
        }]
    }));
    return fixture.loop.tick();
}

function resealState(state) {
    delete state.stateHash;
    state.stateHash = createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

test("start records bounded cloud-only provider advice authorization", t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);

    const state = fixture.loop.start(validConfiguration);

    assert.equal(state.status, "configured");
    assert.equal(state.cycleExecution, "advice-and-proposal-only");
    assert.equal(state.budgetStatus, "provider calls reserved; searches unused");
    assert.equal(state.authorizationHash.length, 64);
    assert.deepEqual(state.authorization.providers, ["claude", "gemini"]);
    assert.equal(state.authorization.sandboxTransferAuthorizedAt, undefined);
    assert.deepEqual(state.usage, { cycles: 0, providerCalls: 0, searches: 0, patches: 0 });
    assert.equal(state.tickCount, 0);
});

test("sandbox-transfer authorization is explicit, timestamped, and included in the authorization hash", t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);

    const state = fixture.loop.start({
        ...validConfiguration,
        confirmedSandboxTransfer: true
    });

    assert.equal(
        state.authorization.sandboxTransferAuthorizedAt,
        state.authorization.createdAt
    );
    assert.equal(
        state.authorizationHash,
        createHash("sha256").update(JSON.stringify(state.authorization)).digest("hex")
    );
});

test("workspace changes during context collection prevent provider submission", async t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    fixture.loop.start(validConfiguration);
    fixture.respond(() => {
        fs.writeFileSync(path.join(fixture.workspaceDirectory, "changed.js"), "module.exports = true;\n");
        return jsonResponse(200, { summary: repositorySummary });
    });

    const result = await fixture.loop.tick();

    assert.equal(result.phase, "context");
    assert.equal(result.contextFailures, 1);
    assert.equal(result.lastErrorCode, "workspace-changed-during-context");
    assert.equal(result.workspaceBase, null);
    assert.equal(fixture.calls.length, 1);
});

test("start rejects unconfirmed, local, unknown, duplicate, and out-of-range authorization", t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);

    const invalidConfigurations = [
        { ...validConfiguration, confirmedProviderSharing: false },
        { ...validConfiguration, providers: ["ollama"] },
        { ...validConfiguration, providers: ["unknown-provider"] },
        { ...validConfiguration, providers: ["claude", "claude"] },
        { ...validConfiguration, maxCycles: 0 },
        { ...validConfiguration, maxCycles: 11 },
        { ...validConfiguration, maxProviderCalls: 0 },
        { ...validConfiguration, maxProviderCalls: 4 },
        { ...validConfiguration, maxProviderCalls: 51 },
        { ...validConfiguration, maxSearches: 21 },
        { ...validConfiguration, windowMinutes: 4 },
        { ...validConfiguration, windowMinutes: 721 },
        { ...validConfiguration, confirmedSandboxTransfer: "yes" }
    ];

    for (const configuration of invalidConfigurations) {
        assert.throws(() => fixture.loop.start(configuration));
    }
    assert.equal(fixture.loop.status().status, "idle");
});

test("a configured run cannot be overwritten until stopped or expired", t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);

    fixture.loop.start(validConfiguration);
    assert.throws(() => fixture.loop.start(validConfiguration), /already exists/);
    assert.equal(fixture.loop.stop().status, "stopped");
    assert.equal(fixture.loop.start(validConfiguration).status, "configured");
});

test("advice advances to a bounded code proposal, which is stored but never applied", async t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    fixture.loop.start(validConfiguration);

    fixture.respond(jsonResponse(200, { summary: repositorySummary }));
    const context = await fixture.loop.tick();
    assert.equal(context.phase, "ready-to-submit");
    assert.equal(fixture.calls.length, 1);
    assert.match(fixture.calls[0].url, /repository-context$/);
    assert.equal(fixture.calls[0].options.redirect, "error");

    fixture.respond(jsonResponse(202, { id: workflowId, status: "queued" }));
    const submitted = await fixture.loop.tick();
    assert.equal(submitted.phase, "polling");
    assert.equal(submitted.usage.providerCalls, 3);
    assert.equal(submitted.pendingProviderCalls, 3);
    assert.equal(fixture.calls.length, 2);
    const request = JSON.parse(fixture.calls[1].options.body);
    assert.deepEqual(request.threads.map(thread => thread.provider), ["claude", "gemini"]);
    assert.equal(request.synthesisProvider, "claude");
    assert.ok(request.threads.every(thread => thread.type === "thinking" && !thread.required));
    assert.ok(request.threads.every(thread => thread.prompt.length <= 7000));
    assert.doesNotMatch(JSON.stringify(request), /\b(?:auto|ollama)\b/i);
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.stateDirectory, "run-state.json"), "utf8"))
        .authorization.providers.length, 2);

    const deferredPoll = await fixture.loop.tick();
    assert.match(deferredPoll.message, /deferred/);
    assert.equal(fixture.calls.length, 2);

    fixture.setTime("2025-01-01T00:00:15.000Z");
    fixture.respond(jsonResponse(200, {
        id: workflowId,
        status: "completed",
        threads: [{ status: "completed", job: { provider: "claude", result: "branch advice" } }],
        synthesis: { provider: "claude", result: "Add a regression test for the retry boundary." }
    }));
    const advice = await fixture.loop.tick();

    assert.equal(advice.usage.cycles, 0);
    assert.equal(advice.cycleStage, "proposal");
    assert.equal(advice.phase, "ready-to-submit");
    assert.equal(advice.adviceArtifact, "latest-advice.json");
    assert.equal(fixture.calls.length, 3);

    fixture.respond(jsonResponse(202, { id: proposalWorkflowId, status: "queued" }));
    const proposalSubmission = await fixture.loop.tick();
    assert.equal(proposalSubmission.phase, "polling");
    assert.equal(proposalSubmission.cycleStage, "proposal");
    assert.equal(proposalSubmission.pendingProviderCalls, 2);
    assert.equal(proposalSubmission.usage.providerCalls, 5);
    const proposalRequest = JSON.parse(fixture.calls[3].options.body);
    assert.equal(proposalRequest.goal, "Create a bounded, multi-file implementation proposal for the prior reliability advice. Do not apply it, run commands, or claim validation.");
    assert.equal(proposalRequest.synthesisProvider, "claude");
    assert.deepEqual(proposalRequest.threads.map(thread => ({
        type: thread.type,
        provider: thread.provider,
        required: thread.required
    })), [{ type: "coding", provider: "claude", required: true }]);
    assert.match(proposalRequest.threads[0].prompt, /Add a regression test for the retry boundary/);
    assert.match(proposalRequest.threads[0].prompt, /any coherent multi-file changes/);
    assert.doesNotMatch(JSON.stringify(proposalRequest), /\b(?:auto|ollama)\b/i);

    const deferredProposalPoll = await fixture.loop.tick();
    assert.match(deferredProposalPoll.message, /deferred/);
    assert.equal(fixture.calls.length, 4);

    fixture.setTime("2025-01-01T00:00:30.000Z");
    const proposedDiff = makeCandidateDiff(["test('retries once', () => {});"]).replace(/\n/g, "\r\n");
    const proposalResponse = makeProposalResponse(proposedDiff);
    fixture.respond(jsonResponse(200, {
        id: proposalWorkflowId,
        status: "completed",
        threads: [{
            status: "completed",
            job: { provider: "claude", type: "coding", result: proposalResponse }
        }],
        synthesis: { provider: "claude", result: "Synthesis output is not the authoritative patch." }
    }));
    const completed = await fixture.loop.tick();

    assert.equal(completed.usage.cycles, 1);
    assert.equal(completed.usage.providerCalls, 5);
    assert.equal(completed.phase, "context");
    assert.equal(completed.cycleStage, "advice");
    assert.equal(completed.workflowId, null);
    assert.equal(completed.pendingProviderCalls, 0);
    assert.equal(completed.proposalArtifact, "latest-proposal.json");
    assert.match(completed.message, /not been validated or applied/);
    assert.equal(fixture.calls.length, 5);
    const stateText = fs.readFileSync(path.join(fixture.stateDirectory, "run-state.json"), "utf8");
    assert.doesNotMatch(stateText, /Add a regression test|improvement-loop\.candidate\.test\.js/);
    const adviceArtifact = JSON.parse(fs.readFileSync(path.join(fixture.stateDirectory, "latest-advice.json"), "utf8"));
    assert.equal(adviceArtifact.selectedResult, "Add a regression test for the retry boundary.");
    const proposalArtifact = JSON.parse(fs.readFileSync(path.join(fixture.stateDirectory, "latest-proposal.json"), "utf8"));
    assert.equal(proposalArtifact.proposalText, proposedDiff.trim());
    assert.equal(proposalArtifact.rationale, "Adds a focused regression test for retry behavior.");
    assert.deepEqual(proposalArtifact.acceptanceCriteria, ["The test detects an unintended second retry."]);
    assert.equal(proposalArtifact.testPlan, "Not run.");
    assert.equal(proposalArtifact.assumptions, "The retry boundary is testable.");
    assert.deepEqual({
        schemaVersion: proposalArtifact.staticPreflight.schemaVersion,
        status: proposalArtifact.staticPreflight.status,
        reasonCode: proposalArtifact.staticPreflight.reasonCode,
        target: proposalArtifact.staticPreflight.target,
        files: proposalArtifact.staticPreflight.files,
        addedLineCount: proposalArtifact.staticPreflight.addedLineCount
    }, {
        schemaVersion: 1,
        status: "eligible-for-sandbox-review",
        reasonCode: null,
        target: candidateTestFilename,
        files: [{
            path: candidateTestFilename,
            operation: "add",
            baseDigest: null
        }],
        addedLineCount: 1
    });
    assert.match(proposalArtifact.baseSnapshotHash, /^[a-f0-9]{64}$/);
    assert.equal(proposalArtifact.staticPreflight.baseSnapshotHash, proposalArtifact.baseSnapshotHash);
    assert.equal(proposalArtifact.staticPreflight.currentSnapshotHash, proposalArtifact.baseSnapshotHash);
    assert.equal(proposalArtifact.schemaVersion, 1);
    assert.equal(proposalArtifact.validated, false);
    assert.equal(proposalArtifact.applied, false);
    assert.equal(proposalArtifact.sandboxTransfer, undefined);
});

test("multi-file nested proposals are accepted with locally captured base-file hashes", async t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    fs.mkdirSync(path.join(fixture.workspaceDirectory, "src"), { recursive: true });
    fs.mkdirSync(path.join(fixture.workspaceDirectory, "docs"), { recursive: true });
    fs.writeFileSync(path.join(fixture.workspaceDirectory, "src", "module.js"), "module.exports = 1;\n");
    fs.writeFileSync(path.join(fixture.workspaceDirectory, "docs", "old.md"), "old documentation\n");
    const base = captureWorkspaceSnapshot(fixture.workspaceDirectory, fixture.stateDirectory);
    const diff = [
        "diff --git a/src/module.js b/src/module.js",
        "index 1234567..abcdef0 100644",
        "--- a/src/module.js",
        "+++ b/src/module.js",
        "@@ -1 +1 @@",
        "-module.exports = 1;",
        "+module.exports = 2;",
        "diff --git a/tests/nested/retry.spec.js b/tests/nested/retry.spec.js",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/tests/nested/retry.spec.js",
        "@@ -0,0 +1 @@",
        "+assert.equal(require('../../src/module'), 2);",
        "diff --git a/docs/old.md b/docs/old.md",
        "deleted file mode 100644",
        "--- a/docs/old.md",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-old documentation"
    ].join("\n");

    const result = await completeProposal(fixture, makeProposalResponse(diff));
    const proposal = JSON.parse(fs.readFileSync(
        path.join(fixture.stateDirectory, "latest-proposal.json"),
        "utf8"
    ));

    assert.equal(result.usage.cycles, 1);
    assert.equal(result.phase, "context");
    assert.equal(proposal.staticPreflight.status, "eligible-for-sandbox-review");
    assert.equal(proposal.staticPreflight.target, null);
    assert.deepEqual(proposal.staticPreflight.files.map(file => ({
        path: file.path,
        operation: file.operation
    })), [
        { path: "src/module.js", operation: "modify" },
        { path: "tests/nested/retry.spec.js", operation: "add" },
        { path: "docs/old.md", operation: "delete" }
    ]);
    assert.equal(
        proposal.staticPreflight.files[0].baseDigest,
        base.files.find(file => file.name === "src/module.js").digest
    );
    assert.equal(
        proposal.staticPreflight.files[2].baseDigest,
        base.files.find(file => file.name === "docs/old.md").digest
    );
    assert.equal(proposal.validated, false);
    assert.equal(proposal.applied, false);
});

test("sandbox-probe requires confirmation and transfers only the latest verified proposal", async t => {
    let suppliedWorkspace;
    let suppliedProposal;
    let cleanupCalled = false;
    const stagedWorkspace = {
        status: "staged-unexecuted",
        cleanup() {
            cleanupCalled = true;
        }
    };
    const fixture = createFixture({
        sandboxWorkspaceFactory(options) {
            suppliedWorkspace = options.workspacePath;
            suppliedProposal = options.proposal;
            assert.equal(options.stateDirectory, fixture.stateDirectory);
            assert.equal(options.baseSnapshot.hash, suppliedProposal.baseSnapshotHash);
            return stagedWorkspace;
        },
        sandboxTransferProbeFactory() {
            return {
                run(stage) {
                    assert.equal(stage, stagedWorkspace);
                    return makeTransferResult();
                }
            };
        }
    });
    t.after(fixture.cleanup);
    await completeProposal(
        fixture,
        makeProposalResponse(makeCandidateDiff(["test('retries once', () => {});"]))
    );
    const proposalPath = path.join(fixture.stateDirectory, "latest-proposal.json");
    const proposalBytesBefore = fs.readFileSync(proposalPath);
    const stateBytesBefore = fs.readFileSync(path.join(fixture.stateDirectory, "run-state.json"));

    assert.throws(
        () => fixture.loop.sandboxProbe(false),
        /explicit confirmation/
    );
    const result = fixture.loop.sandboxProbe(true);

    assert.equal(result.status, "passed");
    assert.equal(result.candidateCodeExecuted, false);
    assert.equal(result.workspaceMounted, false);
    assert.equal(result.validated, false);
    assert.equal(result.applied, false);
    assert.equal(result.proposalWorkflowId, proposalWorkflowId);
    assert.equal(suppliedWorkspace, fixture.workspaceDirectory);
    assert.equal(suppliedProposal.validated, false);
    assert.equal(cleanupCalled, true);
    assert.deepEqual(fs.readFileSync(proposalPath), proposalBytesBefore);
    assert.deepEqual(fs.readFileSync(path.join(fixture.stateDirectory, "run-state.json")), stateBytesBefore);
    assert.equal(fixture.calls.length, 5);
});

test("sandbox-probe refuses stale or tampered proposal artifacts before staging", async t => {
    let stageFactoryCalls = 0;
    const fixture = createFixture({
        sandboxWorkspaceFactory() {
            stageFactoryCalls += 1;
            throw new Error("Staging must not start for invalid inputs.");
        }
    });
    t.after(fixture.cleanup);
    await completeProposal(
        fixture,
        makeProposalResponse(makeCandidateDiff(["test('retries once', () => {});"]))
    );

    fs.writeFileSync(path.join(fixture.workspaceDirectory, "changed.js"), "module.exports = true;\n");
    assert.throws(
        () => fixture.loop.sandboxProbe(true),
        /no longer matches the live workspace snapshot/
    );
    assert.equal(stageFactoryCalls, 0);

    fs.unlinkSync(path.join(fixture.workspaceDirectory, "changed.js"));
    const proposalPath = path.join(fixture.stateDirectory, "latest-proposal.json");
    const tamperedProposal = JSON.parse(fs.readFileSync(proposalPath, "utf8"));
    tamperedProposal.rationale += " tampered";
    fs.writeFileSync(proposalPath, JSON.stringify(tamperedProposal));
    assert.throws(
        () => fixture.loop.sandboxProbe(true),
        /failed integrity validation/
    );
    assert.equal(stageFactoryCalls, 0);
});

test("sandbox-probe requires a complete non-execution attestation and still cleans staging", async t => {
    let cleanupCalled = false;
    const fixture = createFixture({
        sandboxWorkspaceFactory() {
            return { cleanup() { cleanupCalled = true; } };
        },
        sandboxTransferProbeFactory() {
            return {
                run() {
                    return {
                        status: "passed",
                        candidateCodeExecuted: false,
                        workspaceMounted: false,
                        checks: { networkDisabled: true, noHostMounts: true }
                    };
                }
            };
        }
    });
    t.after(fixture.cleanup);
    await completeProposal(
        fixture,
        makeProposalResponse(makeCandidateDiff(["test('retries once', () => {});"]))
    );

    assert.throws(
        () => fixture.loop.sandboxProbe(true),
        /required non-execution attestation/
    );
    assert.equal(cleanupCalled, true);
});

test("an opted-in run automatically persists the transfer attestation without validating the proposal", async t => {
    let cleanupCalled = false;
    let transferCalls = 0;
    const stagedWorkspace = { cleanup() { cleanupCalled = true; } };
    const fixture = createFixture({
        sandboxWorkspaceFactory({ proposal }) {
            assert.equal(proposal.validated, false);
            return stagedWorkspace;
        },
        sandboxTransferProbeFactory() {
            return {
                run(stage) {
                    assert.equal(stage, stagedWorkspace);
                    transferCalls += 1;
                    return makeTransferResult();
                }
            };
        }
    });
    t.after(fixture.cleanup);
    const completed = await completeProposal(
        fixture,
        makeProposalResponse(makeCandidateDiff(["test('retries once', () => {});"])),
        { ...validConfiguration, confirmedSandboxTransfer: true }
    );
    const state = fixture.loop.status();
    const proposalArtifact = JSON.parse(fs.readFileSync(
        path.join(fixture.stateDirectory, "latest-proposal.json"),
        "utf8"
    ));

    assert.equal(completed.phase, "context");
    assert.match(completed.message, /staged-byte transfer only/);
    assert.equal(transferCalls, 1);
    assert.equal(cleanupCalled, true);
    assert.equal(state.authorization.sandboxTransferAuthorizedAt, state.authorization.createdAt);
    assert.equal(state.sandboxTransfer.status, "passed");
    assert.equal(state.sandboxTransfer.transferredFileCount, 2);
    assert.equal(state.sandboxTransfer.candidateCodeExecuted, false);
    assert.equal(state.sandboxTransfer.proposalArtifactHash, state.proposalArtifactHash);
    assert.equal(proposalArtifact.sandboxTransfer, undefined);
    assert.equal(proposalArtifact.validated, false);
    assert.equal(proposalArtifact.applied, false);
    assert.equal(state.proposalArtifactHash, createHash("sha256")
        .update(JSON.stringify(proposalArtifact))
        .digest("hex"));
    assert.equal(fixture.calls.length, 5);

    const statePath = path.join(fixture.stateDirectory, "run-state.json");
    const interruptedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    interruptedState.phase = "sandboxing";
    interruptedState.cycleStage = "proposal";
    interruptedState.workflowId = null;
    interruptedState.pendingProviderCalls = 0;
    interruptedState.pollDeadlineAt = null;
    interruptedState.nextPollAt = null;
    interruptedState.pollCount = 0;
    interruptedState.sandboxTransfer = null;
    resealState(interruptedState);
    fs.writeFileSync(statePath, JSON.stringify(interruptedState));

    const restarted = fixture.restart();
    const interrupted = await restarted.tick();
    assert.equal(interrupted.status, "halted");
    assert.equal(interrupted.stopReason, "sandbox-transfer-interrupted");
    assert.equal(interrupted.lastErrorCode, "sandbox-transfer-interrupted");
    assert.equal(transferCalls, 1);
    assert.equal(fixture.calls.length, 5);
});

test("restart completes a persisted successful transfer without repeating it", async t => {
    let transferCalls = 0;
    const fixture = createFixture({
        sandboxWorkspaceFactory() {
            return { cleanup() {} };
        },
        sandboxTransferProbeFactory() {
            return {
                run() {
                    transferCalls += 1;
                    return makeTransferResult();
                }
            };
        }
    });
    t.after(fixture.cleanup);
    await completeProposal(
        fixture,
        makeProposalResponse(makeCandidateDiff(["test('retries once', () => {});"])),
        { ...validConfiguration, confirmedSandboxTransfer: true }
    );

    const statePath = path.join(fixture.stateDirectory, "run-state.json");
    const interruptedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    interruptedState.phase = "sandboxing";
    interruptedState.cycleStage = "proposal";
    interruptedState.usage.cycles = 0;
    interruptedState.lastCycleOutcome = null;
    resealState(interruptedState);
    fs.writeFileSync(statePath, JSON.stringify(interruptedState));

    const recovered = await fixture.restart().tick();
    assert.equal(recovered.phase, "context");
    assert.equal(recovered.usage.cycles, 1);
    assert.match(recovered.message, /without repeating the transfer/);
    assert.equal(transferCalls, 1);
    assert.equal(fixture.calls.length, 5);
});

test("automatic sandbox-transfer failures halt the run and clean up the stage", async t => {
    let cleanupCalled = false;
    const fixture = createFixture({
        sandboxWorkspaceFactory() {
            return { cleanup() { cleanupCalled = true; } };
        },
        sandboxTransferProbeFactory() {
            return {
                run() {
                    const error = new Error("container policy mismatch");
                    error.code = "container-policy-mismatch";
                    throw error;
                }
            };
        }
    });
    t.after(fixture.cleanup);
    const completed = await completeProposal(
        fixture,
        makeProposalResponse(makeCandidateDiff(["test('retries once', () => {});"])),
        { ...validConfiguration, confirmedSandboxTransfer: true }
    );
    const artifact = JSON.parse(fs.readFileSync(
        path.join(fixture.stateDirectory, "latest-proposal.json"),
        "utf8"
    ));

    assert.equal(completed.status, "halted");
    assert.equal(completed.stopReason, "sandbox-transfer-failed");
    assert.equal(completed.lastErrorCode, "container-policy-mismatch");
    assert.equal(completed.usage.cycles, 0);
    assert.equal(cleanupCalled, true);
    assert.equal(artifact.sandboxTransfer, undefined);
    assert.equal(artifact.validated, false);
    assert.equal(artifact.applied, false);
});

test("proposal preflight rejects a workspace changed after context collection", async t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    await completeAdvice(fixture);
    const baseSnapshotHash = fixture.loop.status().workspaceBase.hash;
    fixture.respond(jsonResponse(202, { id: proposalWorkflowId, status: "queued" }));
    await fixture.loop.tick();
    fs.writeFileSync(path.join(fixture.workspaceDirectory, "changed.js"), "module.exports = true;\n");
    fixture.setTime("2025-01-01T00:00:30.000Z");
    fixture.respond(jsonResponse(200, {
        id: proposalWorkflowId,
        status: "completed",
        threads: [{
            status: "completed",
            job: { provider: "claude", type: "coding", result: makeProposalResponse(
                makeCandidateDiff(["test('retries once', () => {});"])
            ) }
        }]
    }));

    const halted = await fixture.loop.tick();
    const artifact = JSON.parse(fs.readFileSync(
        path.join(fixture.stateDirectory, "latest-proposal.json"),
        "utf8"
    ));

    assert.equal(halted.status, "halted");
    assert.equal(halted.stopReason, "proposal-static-preflight-rejected");
    assert.equal(halted.usage.cycles, 0);
    assert.equal(artifact.baseSnapshotHash, baseSnapshotHash);
    assert.equal(artifact.staticPreflight.reasonCode, "workspace-changed-since-context");
    assert.equal(artifact.validated, false);
    assert.equal(artifact.applied, false);
});

test("a restart preserves the proposal stage and its authorized coding provider", async t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    const advice = await completeAdvice(fixture);
    assert.equal(advice.cycleStage, "proposal");
    const baseSnapshotHash = advice.workspaceBase.hash;

    fixture.respond(jsonResponse(202, { id: proposalWorkflowId, status: "queued" }));
    const restarted = fixture.restart();
    const submitted = await restarted.tick();

    assert.equal(submitted.phase, "polling");
    assert.equal(submitted.cycleStage, "proposal");
    assert.equal(submitted.usage.providerCalls, 5);
    assert.equal(submitted.workspaceBase.hash, baseSnapshotHash);
    const request = JSON.parse(fixture.calls[3].options.body);
    assert.equal(request.threads[0].provider, "claude");
    assert.equal(request.threads[0].type, "coding");
});

test("version-three state without a workspace snapshot fails closed at proposal preflight", async t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    await completeAdvice(fixture);
    const statePath = path.join(fixture.stateDirectory, "run-state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    delete state.workspaceBase;
    resealState(state);
    fs.writeFileSync(statePath, JSON.stringify(state));

    fixture.respond(jsonResponse(202, { id: proposalWorkflowId, status: "queued" }));
    const restarted = fixture.restart();
    const submitted = await restarted.tick();
    assert.equal(submitted.workspaceBase, null);
    fixture.setTime("2025-01-01T00:00:30.000Z");
    fixture.respond(jsonResponse(200, {
        id: proposalWorkflowId,
        status: "completed",
        threads: [{
            status: "completed",
            job: { provider: "claude", type: "coding", result: makeProposalResponse(
                makeCandidateDiff(["test('retries once', () => {});"])
            ) }
        }]
    }));

    const halted = await restarted.tick();
    const artifact = JSON.parse(fs.readFileSync(
        path.join(fixture.stateDirectory, "latest-proposal.json"),
        "utf8"
    ));

    assert.equal(halted.status, "halted");
    assert.equal(artifact.staticPreflight.reasonCode, "workspace-base-unavailable");
    assert.equal(artifact.validated, false);
});

test("malformed coding output halts without marking a cycle complete or proposal validated", async t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    await completeAdvice(fixture);
    fixture.respond(jsonResponse(202, { id: proposalWorkflowId, status: "queued" }));
    await fixture.loop.tick();
    fixture.setTime("2025-01-01T00:00:30.000Z");
    fixture.respond(jsonResponse(200, {
        id: proposalWorkflowId,
        status: "completed",
        threads: [{ status: "completed", job: { type: "coding", result: "Here is an unstructured patch." } }]
    }));

    const halted = await fixture.loop.tick();

    assert.equal(halted.status, "halted");
    assert.equal(halted.stopReason, "invalid-workflow-result");
    assert.equal(halted.usage.cycles, 0);
    assert.equal(halted.pendingProviderCalls, 0);
    assert.equal(halted.workflowId, null);
    assert.equal(fs.existsSync(path.join(fixture.stateDirectory, "latest-proposal.json")), false);
});

test("proposal output that claims tests ran is rejected", async t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    const diff = makeCandidateDiff(["test('retries once', () => {});"]);
    const halted = await completeProposal(fixture, makeProposalResponse(diff, { tests: "Tests passed." }));

    assert.equal(halted.status, "halted");
    assert.equal(halted.stopReason, "invalid-workflow-result");
    assert.equal(halted.usage.cycles, 0);
    assert.equal(fs.existsSync(path.join(fixture.stateDirectory, "latest-proposal.json")), false);
});

test("static preflight rejects unsafe paths, existing targets, and malformed hunks", async t => {
    const cases = [
        {
            diff: makeCandidateDiff(["test('retries once', () => {});"], "../retry.test.js"),
            reasonCode: "unsafe-target-path"
        },
        {
            diff: makeCandidateDiff(["test('retries once', () => {});"]),
            reasonCode: "target-already-exists",
            createTarget: true
        },
        {
            diff: makeCandidateDiff(["test('retries once', () => {});"])
                .replace("@@ -0,0 +1,1 @@", "@@ -0,0 +1,2 @@"),
            reasonCode: "hunk-line-count-mismatch"
        }
    ];

    for (const testCase of cases) {
        const fixture = createFixture();
        t.after(fixture.cleanup);
        if (testCase.createTarget) {
            fs.writeFileSync(path.join(fixture.workspaceDirectory, candidateTestFilename), "existing file");
        }

        const halted = await completeProposal(fixture, makeProposalResponse(testCase.diff));
        const artifact = JSON.parse(fs.readFileSync(
            path.join(fixture.stateDirectory, "latest-proposal.json"),
            "utf8"
        ));

        assert.equal(halted.status, "halted");
        assert.equal(halted.stopReason, "proposal-static-preflight-rejected");
        assert.equal(halted.usage.cycles, 0);
        assert.equal(artifact.staticPreflight.status, "rejected");
        assert.equal(artifact.staticPreflight.reasonCode, testCase.reasonCode);
        assert.equal(artifact.validated, false);
        assert.equal(artifact.applied, false);
    }
});

test("a 429 releases the write-ahead reservation and permits a later bounded retry", async t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    await prepareSubmission(fixture);

    fixture.respond(jsonResponse(429, { error: "queue is full" }));
    const rejected = await fixture.loop.tick();
    assert.equal(rejected.phase, "ready-to-submit");
    assert.equal(rejected.usage.providerCalls, 0);
    assert.equal(rejected.pendingProviderCalls, 0);
    assert.equal(rejected.lastHttpStatus, 429);

    fixture.respond(jsonResponse(202, { id: workflowId, status: "queued" }));
    const retried = await fixture.loop.tick();
    assert.equal(retried.phase, "polling");
    assert.equal(retried.usage.providerCalls, 3);
    assert.equal(fixture.calls.length, 3);
});

test("a 429 during proposal admission releases only the proposal reservation", async t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    await completeAdvice(fixture);

    fixture.respond(jsonResponse(429, { error: "queue is full" }));
    const rejected = await fixture.loop.tick();
    assert.equal(rejected.phase, "ready-to-submit");
    assert.equal(rejected.cycleStage, "proposal");
    assert.equal(rejected.usage.providerCalls, 3);
    assert.equal(rejected.pendingProviderCalls, 0);

    fixture.respond(jsonResponse(202, { id: proposalWorkflowId, status: "queued" }));
    const accepted = await fixture.loop.tick();
    assert.equal(accepted.phase, "polling");
    assert.equal(accepted.usage.providerCalls, 5);
    assert.equal(accepted.pendingProviderCalls, 2);
    assert.equal(fixture.calls.length, 5);
});

test("an ambiguous coding submission is never retried", async t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    await completeAdvice(fixture);
    fixture.respond(new TypeError("connection dropped after send"));

    const halted = await fixture.loop.tick();

    assert.equal(halted.status, "halted");
    assert.equal(halted.cycleStage, "proposal");
    assert.equal(halted.stopReason, "ambiguous-provider-submission");
    assert.equal(halted.usage.providerCalls, 5);
    assert.equal(halted.pendingProviderCalls, 2);
    assert.equal(fixture.loop.status().providerWorkMayContinue, true);
    await fixture.loop.tick();
    assert.equal(fixture.calls.length, 4);
});

test("an ambiguous submission is never retried and requires explicit acknowledgement to start again", async t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    await prepareSubmission(fixture);
    fixture.respond(new TypeError("connection dropped after send"));

    const halted = await fixture.loop.tick();

    assert.equal(halted.status, "halted");
    assert.equal(halted.stopReason, "ambiguous-provider-submission");
    assert.equal(halted.usage.providerCalls, 3);
    assert.equal(halted.pendingProviderCalls, 3);
    assert.equal(halted.lastHttpStatus, null);
    assert.equal(fixture.loop.status().providerWorkMayContinue, true);
    await fixture.loop.tick();
    assert.equal(fixture.calls.length, 2);
    assert.throws(() => fixture.loop.start(validConfiguration), /acknowledge-unknown-provider-work/);
    const restarted = fixture.loop.start({
        ...validConfiguration,
        acknowledgeUnknownProviderWork: true
    });
    assert.equal(restarted.status, "configured");
});

test("a restart from the persisted submitting phase halts without replaying an accepted POST", async t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    await prepareSubmission(fixture);
    let resolveSubmission;
    let notifySubmissionStarted;
    const submissionStarted = new Promise(resolve => {
        notifySubmissionStarted = resolve;
    });
    const pendingSubmission = new Promise(resolve => {
        resolveSubmission = resolve;
    });
    fixture.respond(() => {
        notifySubmissionStarted();
        return pendingSubmission;
    });

    const interruptedTick = fixture.loop.tick();
    await submissionStarted;
    const originalRename = fs.renameSync;
    fs.renameSync = () => {
        throw new Error("simulated persistence failure after admission");
    };
    try {
        resolveSubmission(jsonResponse(202, { id: workflowId, status: "queued" }));
        await assert.rejects(interruptedTick, /simulated persistence failure/);
    } finally {
        fs.renameSync = originalRename;
    }

    const restarted = createImprovementLoop({
        stateDirectory: fixture.stateDirectory,
        now: () => new Date("2025-01-01T00:00:00.000Z"),
        fetchImpl: async () => {
            throw new Error("Restart recovery must not contact the service.");
        }
    });
    const recovered = await restarted.tick();

    assert.equal(recovered.status, "halted");
    assert.equal(recovered.stopReason, "ambiguous-submission-after-restart");
    assert.equal(recovered.providerWorkMayContinue, true);
    assert.equal(recovered.usage.providerCalls, 3);
    assert.equal(fixture.calls.length, 2);
    assert.throws(() => restarted.start(validConfiguration), /acknowledge-unknown-provider-work/);
});

test("a lost workflow is halted and never resubmitted", async t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    await submitWorkflow(fixture);
    fixture.setTime("2025-01-01T00:00:15.000Z");
    fixture.respond(jsonResponse(404, { error: "not found" }));

    const lost = await fixture.loop.tick();

    assert.equal(lost.status, "halted");
    assert.equal(lost.stopReason, "workflow-lost-after-service-restart");
    assert.equal(lost.providerWorkMayContinue, true);
    await fixture.loop.tick();
    assert.equal(fixture.calls.length, 3);
});

test("a failed workflow clears active-work indicators and halts the run", async t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    await submitWorkflow(fixture);
    fixture.setTime("2025-01-01T00:00:15.000Z");
    fixture.respond(jsonResponse(200, { id: workflowId, status: "failed" }));

    const failed = await fixture.loop.tick();

    assert.equal(failed.status, "halted");
    assert.equal(failed.stopReason, "workflow-failed");
    assert.equal(failed.workflowId, null);
    assert.equal(failed.pendingProviderCalls, 0);
    assert.equal(failed.providerWorkMayContinue, undefined);
});

test("stop prevents future submissions and reports already-submitted provider work", async t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    await prepareSubmission(fixture);

    const stopped = fixture.loop.stop();
    const nextTick = await fixture.loop.tick();

    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.providerWorkMayContinue, false);
    assert.equal(nextTick.status, "stopped");
    assert.equal(fixture.calls.length, 1);
});

test("stopping an active workflow reports it and requires acknowledgement before a new run", async t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    await submitWorkflow(fixture);

    const stopped = fixture.loop.stop();

    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.providerWorkMayContinue, true);
    assert.throws(() => fixture.loop.start(validConfiguration), /acknowledge-unknown-provider-work/);
    assert.equal(fixture.loop.start({
        ...validConfiguration,
        acknowledgeUnknownProviderWork: true
    }).status, "configured");
});

test("authorization expiry prevents workflow submission", async t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    await prepareSubmission(fixture);
    fixture.setTime("2025-01-01T01:00:00.001Z");

    const expired = await fixture.loop.tick();

    assert.equal(expired.status, "expired");
    assert.equal(expired.usage.providerCalls, 0);
    assert.equal(fixture.calls.length, 1);
});

test("bounded polling may collect advice during the expiry grace without starting a code proposal", async t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    fixture.loop.start(validConfiguration);
    fixture.setTime("2025-01-01T00:59:45.000Z");
    fixture.respond(jsonResponse(200, { summary: repositorySummary }));
    await fixture.loop.tick();
    fixture.respond(jsonResponse(202, { id: workflowId, status: "queued" }));
    await fixture.loop.tick();
    fixture.setTime("2025-01-01T01:00:15.000Z");
    fixture.respond(jsonResponse(200, {
        id: workflowId,
        status: "completed",
        synthesis: { result: "Result collected during grace." }
    }));

    const result = await fixture.loop.tick();

    assert.equal(result.status, "expired");
    assert.equal(result.usage.cycles, 0);
    assert.equal(result.pendingProviderCalls, 0);
    assert.equal(result.workflowId, null);
    assert.equal(result.cycleStage, "advice");
    assert.equal(result.adviceArtifact, "latest-advice.json");
    assert.equal(fixture.calls.length, 3);
});

test("provider advice is UTF-8 truncated within the configured result-text bound", async t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    await submitWorkflow(fixture);
    fixture.setTime("2025-01-01T00:00:15.000Z");
    fixture.respond(jsonResponse(200, {
        id: workflowId,
        status: "completed",
        synthesis: { result: "💡".repeat(6000) }
    }));

    await fixture.loop.tick();

    const artifact = JSON.parse(fs.readFileSync(path.join(fixture.stateDirectory, "latest-advice.json"), "utf8"));
    assert.equal(artifact.truncated, true);
    assert.ok(Buffer.byteLength(artifact.selectedResult) <= 8 * 1024);
    assert.ok(fs.statSync(path.join(fixture.stateDirectory, "latest-advice.json")).size <= 16 * 1024);
});

test("oversized service responses are rejected without unbounded buffering", async t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    fixture.loop.start(validConfiguration);
    fixture.respond({
        status: 200,
        ok: true,
        body: new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array(1024 * 1024));
                controller.enqueue(new Uint8Array(1024 * 1024 + 1));
            }
        }),
        text: async () => {
            throw new Error("The bounded reader should not call text().");
        }
    });

    const result = await fixture.loop.tick();

    assert.equal(result.phase, "context");
    assert.equal(result.contextFailures, 1);
    assert.equal(result.lastErrorCode, "response-too-large");
});

test("a kill switch set during workflow submission stops the run without hiding possible provider work", async t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    await prepareSubmission(fixture);
    let resolveSubmission;
    let notifySubmissionStarted;
    const submissionStarted = new Promise(resolve => {
        notifySubmissionStarted = resolve;
    });
    const pendingSubmission = new Promise(resolve => {
        resolveSubmission = resolve;
    });
    fixture.respond(() => {
        notifySubmissionStarted();
        return pendingSubmission;
    });

    const tick = fixture.loop.tick();
    await submissionStarted;
    const stopResult = fixture.loop.stop();
    assert.equal(stopResult.status, "stop-requested");
    assert.equal(stopResult.providerWorkMayContinue, true);
    resolveSubmission(jsonResponse(202, { id: workflowId, status: "queued" }));

    const stopped = await tick;

    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.providerWorkMayContinue, true);
    assert.equal(stopped.workflowId, workflowId);
});

test("an active run cannot be overwritten; expired runs can be explicitly replaced", t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    const previous = fixture.loop.start(validConfiguration);
    assert.throws(() => fixture.loop.start(validConfiguration), /already exists/);
    fixture.setTime("2025-01-01T01:00:00.001Z");

    const next = fixture.loop.start(validConfiguration);

    assert.notEqual(next.runId, previous.runId);
    assert.equal(next.status, "configured");
});

test("backwards clock movement halts the run", async t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    fixture.loop.start(validConfiguration);
    fixture.respond(jsonResponse(200, { summary: repositorySummary }));
    await fixture.loop.tick();
    fixture.setTime("2024-12-31T23:59:59.000Z");

    const halted = await fixture.loop.tick();

    assert.equal(halted.status, "halted");
    assert.equal(halted.stopReason, "clock-moved-backwards");
});

test("a live lock skips a tick without mutating state", async t => {
    const fixture = createFixture({ isProcessAlive: () => true });
    t.after(fixture.cleanup);
    fixture.loop.start(validConfiguration);
    const lockPath = path.join(fixture.stateDirectory, "tick.lock");
    fs.writeFileSync(lockPath, JSON.stringify({
        pid: 4242,
        token: "held-by-another-process",
        startedAt: "2025-01-01T00:00:00.000Z"
    }));

    const result = await fixture.loop.tick();

    assert.equal(result.status, "locked");
    assert.equal(fixture.loop.status().tickCount, 0);
});

test("a stale lock from a dead process is recovered safely", async t => {
    const fixture = createFixture({ isProcessAlive: () => false });
    t.after(fixture.cleanup);
    fixture.loop.start(validConfiguration);
    const lockPath = path.join(fixture.stateDirectory, "tick.lock");
    fs.writeFileSync(lockPath, JSON.stringify({
        pid: 4242,
        token: "stale-lock",
        startedAt: "2024-12-31T23:55:00.000Z"
    }));
    fixture.respond(jsonResponse(200, { summary: repositorySummary }));

    const result = await fixture.loop.tick();

    assert.equal(result.tickCount, 1);
    assert.equal(fs.existsSync(lockPath), false);
});

test("corrupt or tampered state is not silently repaired or overwritten", t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    fixture.loop.start(validConfiguration);
    const statePath = path.join(fixture.stateDirectory, "run-state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    state.authorization.maxCycles = 9;
    fs.writeFileSync(statePath, JSON.stringify(state));
    const before = fs.readFileSync(statePath);

    assert.throws(() => fixture.loop.status(), /invalid or has an unsupported version/);
    assert.deepEqual(fs.readFileSync(statePath), before);
});

test("CLI requires explicit cloud-provider sharing authorization and parses unknown-work acknowledgement", () => {
    const parsedWithoutConsent = parseArguments(["start", "--providers", "claude", "--max-cycles", "1"]);
    assert.equal(parsedWithoutConsent.configuration.confirmedProviderSharing, undefined);
    assert.throws(() => parseArguments(["sandbox-probe"]), /requires --confirm-sandbox-transfer/);
    assert.deepEqual(parseArguments([
        "sandbox-probe",
        "--confirm-sandbox-transfer"
    ]), {
        command: "sandbox-probe",
        confirmedSandboxTransfer: true
    });
    assert.deepEqual(parseArguments([
        "start",
        "--providers", "claude,gemini",
        "--max-cycles", "3",
        "--max-provider-calls", "8",
        "--max-searches", "4",
        "--window-minutes", "60",
        "--confirm-provider-sharing",
        "--acknowledge-unknown-provider-work"
    ]).configuration, {
        providers: ["claude", "gemini"],
        maxCycles: 3,
        maxProviderCalls: 8,
        maxSearches: 4,
        windowMinutes: 60,
        confirmedProviderSharing: true,
        acknowledgeUnknownProviderWork: true
    });
    assert.equal(parseArguments([
        "start",
        "--providers", "claude",
        "--max-cycles", "1",
        "--max-provider-calls", "4",
        "--max-searches", "0",
        "--window-minutes", "30",
        "--confirm-provider-sharing",
        "--confirm-sandbox-transfer"
    ]).configuration.confirmedSandboxTransfer, true);
});

test("controller has no shell, browser, or provider-client imports", () => {
    const source = fs.readFileSync(path.join(__dirname, "improvement-loop.js"), "utf8");
    assert.doesNotMatch(source, /require\(["'](?:node:)?(?:child_process|http|https|playwright)["']/);
    assert.doesNotMatch(source, /require\(["'][^"']*(?:provider|coding-job|offloading-agent)[^"']*["']/);
});
