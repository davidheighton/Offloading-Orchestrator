# Offloading Orchestrator

A local Node.js service for coordinating browser-based provider jobs, workflows, and read-only repository improvement reviews.

## Requirements

- Node.js 24 or newer
- Optional Ollama installation for direct, idle-time text cleanup jobs
- Browser sign-in for any browser-backed provider you use

## Install and test

```powershell
npm ci
npm test
```

The test suite uses local fixtures and mocked providers; it does not require signing in to provider websites.

## Start the service

The service listens on `127.0.0.1:8765` by default. In PowerShell, set a different port before starting it:

```powershell
$env:PORT = '8766'
npm start
```

Open `http://127.0.0.1:8766` in a browser when using port 8766. The health endpoint is `/health`.
API requests must use `127.0.0.1` or `localhost` on the service port. Browser `Origin` headers must match that loopback origin; command-line clients may omit `Origin`.
The dashboard includes coding/thinking rankings for providers and Ollama models, with a request-size filter for model rankings. Ranking data refreshes every 15 seconds; overview activity refreshes every 5 seconds.
Finished workflows are retained for up to 24 hours and 200 records; active workflows are never evicted. Expired workflow IDs return 404.

## Optional local text cleanup with Ollama

Ollama is restricted to direct text cleanup jobs. It is not available for coding or thinking jobs, workflow branches or synthesis, or automatic provider routing. Cleanup jobs run only when no non-cleanup job is queued or running; sustained normal traffic can therefore defer cleanup indefinitely. A normal job may start while cleanup is already running.

Start Ollama separately and ensure its configured model is available. The default is `qwen3.5:9b` at `http://127.0.0.1:11434`.

```powershell
$env:OLLAMA_HOST = 'http://127.0.0.1:11434'
$env:OLLAMA_MODEL = 'qwen3.5:9b'
$env:OLLAMA_TIMEOUT_MS = '600000'
```

`OLLAMA_TIMEOUT_MS` accepts values from 1,000 to 900,000 milliseconds. The default is 600,000 milliseconds. Ollama requests are local-only; non-loopback URLs are rejected.

## Run a read-only improvement review

Set the service URL in a second PowerShell terminal and run:

```powershell
$env:OFFLOADING_AGENT_URL = 'http://127.0.0.1:8766'
npm run improve -- "Describe the improvement goal" --confirm-provider-sharing --no-followups
```

The explicit confirmation flag is required. Repository context is collected locally, bounded and redacted before being shared with the configured review providers. The review workflow does not edit files or deploy changes.

## Improvement loop controller (proposal capture only)

The controller runs bounded, restartable cycles through the local offloading service. Each tick makes at most one service request: it collects a local repository summary, submits an advice workflow, then on a later tick submits one coding workflow based on that advice; both workflows are polled at a bounded interval. Advice and the resulting unified-diff proposal are stored as separate small artifacts outside the workspace; run state contains metadata and counters, not prompts or provider output.

The coding workflow generates untrusted proposal text only; it does not run proposed tests or execute proposal-supplied commands. Provider output is never executed. A separately authorized local transfer check may run a fixed trusted verifier, but does not load candidate code. The controller does not schedule itself or promote changes. Start the offloading service with the same workspace root as the controller so the local summary describes the intended repository. An external scheduler may invoke `tick`, but must respect the configured authorization window and stop signal.

State is stored outside the workspace under the current user's local application-data directory. To configure a run, explicitly provide cloud providers, budgets, a time window, and provider-sharing authorization:

```powershell
npm run improve:loop -- start --providers claude,gemini --max-cycles 3 --max-provider-calls 15 --max-searches 4 --window-minutes 240 --confirm-provider-sharing --confirm-sandbox-transfer
npm run improve:loop -- status
npm run improve:loop -- tick
npm run improve:loop -- stop
```

The provider allowlist excludes Ollama and `auto` routing. Advice uses only the configured providers; code proposals use the first authorized provider, with the same explicit provider selected for synthesis. The explicit confirmation flag authorizes sharing a bounded, locally redacted repository summary and advice with those providers; the controller also confirms sharing to the local service API. Provider-call budgets reserve one call per configured advice provider plus advice synthesis, then one coding call plus proposal synthesis. Search, candidate validation, patch, and proposal-execution budgets remain unused.

Runs remain proposal-only by default. Add `--confirm-sandbox-transfer` to `start` to authorize at most one non-executing staged-byte transfer per eligible proposal, bounded by `--max-cycles`. The controller persists a `sandboxing` phase before invoking the existing local Docker hash probe, then records a compact transfer attestation in the integrity-protected run state before continuing the cycle. If a restart finds that attestation, it verifies the linked proposal and completes the cycle without repeating the transfer; if the transfer outcome was not persisted, the run halts without retry. A failed transfer halts the run. The candidate is still not validated or applied, and this opt-in does not authorize running its JavaScript.

The coding response must follow the expected headings, contain a bounded unified diff, and explicitly state that tests and validation were not run. A logic-only static preflight permits exactly one new root file, `improvement-loop.candidate.test.js`, and checks its add-only diff structure, hunk count, and target-file absence. It also compares a bounded local workspace fingerprint captured before and after repository-context collection with a fresh fingerprint when the proposal arrives; any change rejects the proposal. The fingerprint covers only root-level JavaScript files, `package.json`, and `README*`, with limits of 500 files, 2 MiB total, and 256 KiB per file. It excludes credentials and dependency/metadata directories and never stores or shares file contents. Malformed, stale, or out-of-allowlist proposals are stored as rejected and halt the run. This is not code validation or a full-repository lock: the controller does not write the candidate file, invoke Git, apply the diff, or execute it, and a later sandbox must recheck its own snapshot before any application.

### Docker isolation canary (proof only)

On this Windows Docker Desktop setup, `npm run improve:loop:sandbox-probe` runs a separate, fixed canary using the locally available Node 24 image pinned by digest. The probe forces the `desktop-linux` context, verifies its local named-pipe endpoint and Linux backend, and refuses Docker environment overrides or an unavailable/mismatched image. It creates a container with image pulling disabled, no network, no host mounts, a read-only root filesystem, a non-root UID, all capabilities dropped, `no-new-privileges`, bounded memory/CPU/processes, and a small no-exec temporary filesystem. Before starting the container it inspects the effective configuration; it then runs only embedded trusted canary checks and removes the container, reporting cleanup failures.

The canary does not receive or execute a proposal, mount the workspace or loop state, apply a patch, or enable execution in the improvement loop. A pass demonstrates only that these specific Docker restrictions were observed for this pinned image and local engine at that time; it is not a general container escape guarantee and does not authorize future candidate execution. Proposal execution remains disabled.

### Candidate staging (not validation)

The standalone `sandbox-workspace.js` helper can prepare a minimal, temporary workspace copy for an eligible, unapplied proposal. It accepts only the same strict add-only `improvement-loop.candidate.test.js` diff as static preflight, and stages only root production `.js` files plus that candidate test. It excludes `package.json`, README files, existing tests/specs, hidden directories, dependency/metadata directories, and credential-like filenames. The helper captures the source bytes and snapshot together, checks the source snapshot before and after copying, and rechecks both the source and staged file set/content hashes when `verify()` is called.

Staging lives under `<stateDirectory>\sandbox-staging`, outside the source workspace. Its external manifest contains only paths, file sizes, hashes, origin labels, and explicit `staged: true`, `validated: false`, and `applied: false` state. Stages are not automatically retained as proposal artifacts; callers must invoke `cleanup()`. A bounded stale-stage sweep removes only old directories matching the helper's fixed name pattern.

The best-effort sensitive-content scan rejects recognized private-key blocks, bearer/token patterns, credential-bearing URLs, and redactor-detected assignments. It cannot prove content is secret-free and may miss or incorrectly flag data. Staged files are a second copy of source code, and Windows inherited ACLs are not independently verified by the helper; the state directory's ACL is assumed, not established as a security boundary. Staging does not install dependencies, execute/import candidate code, invoke Docker, validate candidate behavior, apply a patch, or authorize future execution. Any later consumer must independently recheck the live workspace and stage immediately before use.

`npm run improve:loop:sandbox-stage-probe` is the synthetic transfer proof. It stages a trusted test fixture, sends verified in-memory bytes to the pinned local Docker image over stdin without mounting the workspace, and has the container check file names, sizes, and SHA-256 hashes. The container uses a bounded five-minute lifetime and Docker auto-removal after start. The candidate bytes are never imported, parsed, or executed. A pass proves only this restricted transfer-and-integrity path for the local Docker engine, not candidate behavior or an execution boundary.

To run that same non-executing transfer check against the latest eligible proposal artifact, use `npm run improve:loop -- sandbox-probe --confirm-sandbox-transfer`. This explicit command requires a valid artifact hash, no active provider workflow or stop signal, and a current workspace snapshot matching the proposal. It holds the loop lock, stages the proposal, transfers and verifies its bytes, then cleans the stage. It does not modify loop state or the proposal artifact; the proposal remains unvalidated and unapplied. Set `WORKSPACE_ROOT` consistently with the controller if the repository is not the current directory.

The loop state and three capped artifacts (`repository-context.json`, `latest-advice.json`, and `latest-proposal.json`) are stored outside the workspace under the current user's local application-data directory. Proposal artifacts record static-preflight eligibility and remain explicitly unvalidated and unapplied; the run state records any completed transfer attestation. A stop prevents future requests but cannot cancel work already submitted. If submission outcome is ambiguous or a workflow is lost, the controller halts without retrying. Starting a new run while prior provider work may still be active requires an explicit acknowledgement. `--confirm-sandbox-transfer` is optional; without it, proposals stop at static preflight:

```powershell
npm run improve:loop -- start --providers claude,gemini --max-cycles 3 --max-provider-calls 15 --max-searches 4 --window-minutes 240 --confirm-provider-sharing --acknowledge-unknown-provider-work
```

Hard limits are 10 advice-and-proposal cycles, 50 reserved provider calls, 20 searches, and a 12-hour authorization window; the window must be at least 5 minutes. Proposals are not validated or applied, and no promotion to the live branch or deployment is performed.

Submit a direct cleanup job with `POST /jobs`:

```powershell
$body = @{
  confirmedProviderSharing = $true
  type = 'cleanup'
  provider = 'ollama'
  message = 'Please fix grammar and punctuation in this text.'
} | ConvertTo-Json
Invoke-RestMethod -Uri 'http://127.0.0.1:8765/jobs' -Method Post -ContentType 'application/json' -Body $body
```

Cleanup is limited to grammar, punctuation, and formatting; the prompt treats the submitted text as untrusted data and requests only the cleaned text in response. The result is advisory text and must not be executed or automatically passed into another job. Optional Ollama model ranking and model-management endpoints remain available for local model analytics; they do not enable Ollama coding or thinking jobs.

## Submit a coding job

Submit a focused task with one or more workspace-relative source files:

```powershell
npm run code -- "Fix the total calculation" --provider auto --context-file src/totals.js --context-file tests/totals.test.js --timeout-ms 300000 --confirm-provider-sharing
```

Automatic coding and thinking workflows use cloud providers only. Model overrides and local model rankings do not route coding or thinking jobs to Ollama.

Each context file must resolve inside the current workspace, must not be a sensitive file (such as `.env` or credentials), and must be no larger than 4 KiB; combined context is also capped at 4 KiB of UTF-8 text. Common secret assignments and bearer tokens are redacted before file paths and contents are sent to the selected provider as untrusted reference data. `--timeout-ms` controls how long the CLI polls, from 1,000 ms to 900,000 ms; the default is 900,000 ms. The CLI prints the proposed result and never applies changes to the workspace. Omit `--context-file` when the task does not need source context; `--provider` defaults to automatic coding-job routing.

## Continuous integration

GitHub Actions runs `npm ci` and `npm test` on pushes and pull requests targeting `main`. This repository does not currently define an application deployment target; passing CI does not deploy or restart the service.
