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

## Improvement loop controller (scaffold only)

The controller provides bounded run configuration, durable local state, stop controls, and restartable bookkeeping ticks. It does not yet research the web, call providers, generate or apply patches, run tests, or execute commands. Every command prints this limitation; tick counters are not completed improvement cycles.

State is stored outside the workspace under the current user's local application-data directory. To configure a run, explicitly provide cloud providers, budgets, a time window, and provider-sharing authorization:

```powershell
npm run improve:loop -- start --providers claude,gemini --max-cycles 3 --max-provider-calls 8 --max-searches 4 --window-minutes 240 --confirm-provider-sharing
npm run improve:loop -- status
npm run improve:loop -- tick
npm run improve:loop -- stop
```

The provider allowlist excludes Ollama. The saved authorization is configuration for future implementation only; it does not satisfy or bypass the offloading service's provider-sharing checks. State files contain run metadata and counters, not prompts or provider output. The controller does not create a scheduler; an external scheduler may invoke `tick`, which currently records a heartbeat only. Promotion to the live branch and deployment remain out of scope.
Hard limits are 10 cycles, 50 provider calls, 20 searches, and a 12-hour window; the window must be at least 5 minutes. Budgets are recorded but unused until cycle execution is implemented.

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
