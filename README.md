# Offloading Orchestrator

A local Node.js service for coordinating browser-based provider jobs, workflows, and read-only repository improvement reviews.

## Requirements

- Node.js 24 or newer
- Ollama for local Qwen requests
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

## Configure local Ollama

Start Ollama separately and ensure the selected model is available. The default is `qwen3.5:9b` at `http://127.0.0.1:11434`.

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

## Submit a coding job

Submit a focused task with one or more workspace-relative source files:

```powershell
npm run code -- "Fix the total calculation" --provider ollama --context-file src/totals.js --context-file tests/totals.test.js --timeout-ms 300000 --confirm-provider-sharing
```

Each context file must resolve inside the current workspace, must not be a sensitive file (such as `.env` or credentials), and must be no larger than 4 KiB; combined context is also capped at 4 KiB of UTF-8 text. Common secret assignments and bearer tokens are redacted before file paths and contents are sent to the selected provider as untrusted reference data. `--timeout-ms` controls how long the CLI polls, from 1,000 ms to 900,000 ms; the default is 900,000 ms. The CLI prints the proposed result and never applies changes to the workspace. Omit `--context-file` when the task does not need source context; `--provider` defaults to automatic coding-job routing.

## Continuous integration

GitHub Actions runs `npm ci` and `npm test` on pushes and pull requests targeting `main`. This repository does not currently define an application deployment target; passing CI does not deploy or restart the service.
