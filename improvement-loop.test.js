const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createImprovementLoop, parseArguments } = require("./improvement-loop");

const validConfiguration = {
    confirmedProviderSharing: true,
    providers: ["claude", "gemini"],
    maxCycles: 3,
    maxProviderCalls: 8,
    maxSearches: 4,
    windowMinutes: 60
};

function createFixture(options = {}) {
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "improvement-loop-"));
    let currentTime = new Date("2025-01-01T00:00:00.000Z");
    const loop = createImprovementLoop({
        stateDirectory,
        now: () => new Date(currentTime),
        ...options
    });
    return {
        stateDirectory,
        loop,
        setTime(value) {
            currentTime = new Date(value);
        },
        cleanup() {
            fs.rmSync(stateDirectory, { recursive: true, force: true });
        }
    };
}

test("start records a bounded cloud-only run configuration", t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);

    const state = fixture.loop.start(validConfiguration);

    assert.equal(state.status, "configured");
    assert.equal(state.cycleExecution, "not implemented");
    assert.equal(state.budgetStatus, "configured, unused");
    assert.equal(state.authorizationHash.length, 64);
    assert.deepEqual(state.authorization.providers, ["claude", "gemini"]);
    assert.deepEqual(state.usage, { cycles: 0, providerCalls: 0, searches: 0, patches: 0 });
    assert.equal(state.tickCount, 0);
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
        { ...validConfiguration, maxProviderCalls: 51 },
        { ...validConfiguration, maxSearches: 21 },
        { ...validConfiguration, windowMinutes: 4 },
        { ...validConfiguration, windowMinutes: 721 }
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

test("ticks only advance bookkeeping and never consume configured work budgets", t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    fixture.loop.start(validConfiguration);

    const first = fixture.loop.tick();
    const second = fixture.loop.tick();

    assert.equal(first.tickCount, 1);
    assert.equal(second.tickCount, 2);
    assert.equal(second.status, "configured");
    assert.equal(second.cycleExecution, "not implemented");
    assert.deepEqual(second.usage, { cycles: 0, providerCalls: 0, searches: 0, patches: 0 });
    assert.match(second.message, /cycle execution is not implemented/);
});

test("run state survives controller restarts", t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    fixture.loop.start(validConfiguration);
    const restarted = createImprovementLoop({
        stateDirectory: fixture.stateDirectory,
        now: () => new Date("2025-01-01T00:00:00.000Z")
    });

    assert.equal(restarted.status().tickCount, 0);
    assert.equal(restarted.tick().tickCount, 1);
});

test("expired authorization is terminal and cannot be extended by a tick", t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    fixture.loop.start(validConfiguration);
    fixture.setTime("2025-01-01T01:00:00.001Z");

    const expired = fixture.loop.tick();
    const later = fixture.loop.tick();

    assert.equal(expired.status, "expired");
    assert.equal(later.status, "expired");
    assert.equal(later.tickCount, 0);
    assert.equal(later.usage.providerCalls, 0);
    assert.equal(fixture.loop.status().authorization.expiresAt, "2025-01-01T01:00:00.000Z");
});

test("an expired run can be replaced without a separate expiry tick", t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    const previous = fixture.loop.start(validConfiguration);
    fixture.setTime("2025-01-01T01:00:00.001Z");

    const next = fixture.loop.start(validConfiguration);

    assert.notEqual(next.runId, previous.runId);
    assert.equal(next.status, "configured");
});

test("a backwards system-clock jump halts the run without reducing timestamps", t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    fixture.loop.start(validConfiguration);
    fixture.loop.tick();
    fixture.setTime("2024-12-31T23:59:59.000Z");

    const halted = fixture.loop.tick();

    assert.equal(halted.status, "halted");
    assert.equal(halted.stopReason, "clock-moved-backwards");
    assert.equal(halted.tickCount, 1);
    assert.equal(halted.updatedAt, "2025-01-01T00:00:00.000Z");
});

test("stop signal is observed before any cycle work", t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    fixture.loop.start(validConfiguration);

    const stopped = fixture.loop.stop();
    const nextTick = fixture.loop.tick();

    assert.equal(stopped.status, "stopped");
    assert.equal(nextTick.status, "stopped");
    assert.equal(nextTick.usage.providerCalls, 0);
    assert.equal(nextTick.tickCount, 0);
});

test("kill switch takes precedence over corrupt run state", t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    fixture.loop.start(validConfiguration);
    const statePath = path.join(fixture.stateDirectory, "run-state.json");
    const stopPath = path.join(fixture.stateDirectory, "STOP");
    fs.writeFileSync(statePath, "{broken");
    fs.writeFileSync(stopPath, "{}");
    const before = fs.readFileSync(statePath);

    const result = fixture.loop.tick();

    assert.equal(result.status, "stop-requested");
    assert.match(result.message, /run state is invalid/);
    assert.deepEqual(fs.readFileSync(statePath), before);
});

test("a live lock skips a tick without mutating state", t => {
    const fixture = createFixture({ isProcessAlive: () => true });
    t.after(fixture.cleanup);
    fixture.loop.start(validConfiguration);
    const lockPath = path.join(fixture.stateDirectory, "tick.lock");
    fs.writeFileSync(lockPath, JSON.stringify({
        pid: 4242,
        token: "held-by-another-process",
        startedAt: "2025-01-01T00:00:00.000Z"
    }));

    const result = fixture.loop.tick();

    assert.equal(result.status, "locked");
    assert.equal(fixture.loop.status().tickCount, 0);
});

test("a stale lock from a dead process is recovered safely", t => {
    const fixture = createFixture({ isProcessAlive: () => false });
    t.after(fixture.cleanup);
    fixture.loop.start(validConfiguration);
    const lockPath = path.join(fixture.stateDirectory, "tick.lock");
    fs.writeFileSync(lockPath, JSON.stringify({
        pid: 4242,
        token: "stale-lock",
        startedAt: "2024-12-31T23:55:00.000Z"
    }));

    const result = fixture.loop.tick();

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

    assert.throws(() => fixture.loop.tick(), /invalid or has an unsupported version/);
    assert.deepEqual(fs.readFileSync(statePath), before);
});

test("decreased counters are rejected and the state file remains unchanged", t => {
    const fixture = createFixture();
    t.after(fixture.cleanup);
    fixture.loop.start(validConfiguration);
    fixture.loop.tick();
    const statePath = path.join(fixture.stateDirectory, "run-state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    state.tickCount = 0;
    fs.writeFileSync(statePath, JSON.stringify(state));
    const before = fs.readFileSync(statePath);

    assert.throws(() => fixture.loop.tick(), /invalid or has an unsupported version/);
    assert.deepEqual(fs.readFileSync(statePath), before);
});

test("CLI requires explicit cloud-provider sharing authorization", () => {
    const fixture = createFixture();
    try {
        const parsed = parseArguments(["start", "--providers", "claude", "--max-cycles", "1"]);
        assert.throws(() => fixture.loop.start(parsed.configuration), /confirm-provider-sharing/);
    } finally {
        fixture.cleanup();
    }
    assert.deepEqual(parseArguments([
        "start",
        "--providers", "claude,gemini",
        "--max-cycles", "3",
        "--max-provider-calls", "8",
        "--max-searches", "4",
        "--window-minutes", "60",
        "--confirm-provider-sharing"
    ]).configuration, {
        providers: ["claude", "gemini"],
        maxCycles: 3,
        maxProviderCalls: 8,
        maxSearches: 4,
        windowMinutes: 60,
        confirmedProviderSharing: true
    });
});

test("controller has no provider, network, browser, or command-execution imports", () => {
    const source = fs.readFileSync(path.join(__dirname, "improvement-loop.js"), "utf8");
    assert.doesNotMatch(source, /require\(["'](?:node:)?(?:child_process|http|https|playwright)["']/);
    assert.doesNotMatch(source, /require\(["'][^"']*(?:provider|coding-job|offloading-agent)[^"']*["']/);
});
