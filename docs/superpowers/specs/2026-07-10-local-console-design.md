# Vibe-one Local Console Design

**Date:** 2026-07-10
**Status:** Approved direction

## Goal

Add a local browser console to Vibe-one so a user can describe an app, run the existing bounded generation pipeline, follow progress live, inspect repair evidence, and preview the generated result without using the CLI directly.

## Product Boundary

The console is a thin local interface over the existing pipeline. It does not replace the planner, builder, reviewer, fixer, runner, or reporter. It does not add accounts, remote hosting, team collaboration, billing, or concurrent generation.

Version one supports one active job at a time. Completed and failed runs remain available as local history. The existing CLI remains fully supported.

## Architecture

The console runs from the same Node process as the pipeline:

```text
browser UI
  -> local HTTP API
  -> console job manager
  -> runPipeline()
  -> existing events, screenshots, report, and generated app
```

The server uses Node's built-in HTTP APIs and serves framework-free HTML, CSS, and JavaScript. This matches the repository's small Node ESM stack and avoids introducing a second build toolchain.

The pipeline receives an optional event callback through its run context. Every event is still appended to `events.jsonl`; the callback only mirrors the sanitized event to current SSE subscribers.

## Server Components

- `server.js`: local HTTP server, routing, static asset delivery, startup, and shutdown.
- `jobManager.js`: one-active-job state machine, temporary target creation, pipeline invocation, event fan-out, and job summaries.
- `runStore.js`: safe scanning and reading of existing run directories and public artifacts.
- `previewManager.js`: starts one Vite preview process for a completed run, reuses it while selected, and stops it during server shutdown or preview replacement.
- `http.js`: JSON, body-size, MIME, path, and error-response helpers.

All filesystem access is rooted under the configured Vibe-one project and runs roots. User-provided IDs and artifact paths are resolved through a path jail before reading.

## Job Lifecycle

Jobs use these states:

```text
queued -> planning -> building -> verifying -> repairing -> success
                                                   \-> failed
```

The job manager derives the visible stage from existing pipeline event types. Unknown event types remain visible in the log but do not break the state machine.

Starting a job creates a generated target directory under `runs/.console-inputs/<job-id>/input/`. It writes only `brief.md` and non-secret constraints. The API key is merged into the in-memory config after loading the target and is never written to the target, run directory, event stream, report, or API response.

Version one rejects a second start request with HTTP 409 while a job is active. A server restart may lose the in-memory live-job state, but completed artifacts remain discoverable from `runs/`.

## HTTP API

### `GET /api/status`

Returns server readiness, whether an API key is available in the environment or current process session, and the active job ID. It never returns the key value.

### `POST /api/session/config`

Accepts optional `apiKey`, `baseUrl`, and `model`. The key is stored only in process memory. Empty values clear session overrides and fall back to environment variables.

### `POST /api/jobs`

Accepts `title`, `brief`, `mode`, `baseUrl`, and `model`. `mode` is `run` or `plan`. The response returns the job summary immediately while pipeline execution continues asynchronously.

Validation rejects empty briefs, unsupported modes, oversized bodies, and a missing effective API key. Endpoint and model values are included in job metadata; the key is not.

### `GET /api/jobs`

Returns the active job followed by summaries reconstructed from completed run directories.

### `GET /api/jobs/:id`

Returns the job summary, sanitized events, screenshots, report availability, repair count, and preview state.

### `GET /api/jobs/:id/events`

Sends existing sanitized events followed by live events as SSE. It sends periodic comments to keep the connection alive and closes after a terminal state.

### `GET /api/jobs/:id/report`

Returns the run's `DELIVERY_REPORT.md` as UTF-8 text.

### `GET /api/jobs/:id/screenshots/:name`

Returns a jailed PNG artifact from the run screenshots directory.

### `POST /api/jobs/:id/preview`

Starts or reuses a local Vite preview for a successful generated app and returns its loopback URL. Failed, planned-only, missing, or incomplete jobs return a conflict response.

## User Interface

The first screen is the working product, not a landing page.

Desktop layout uses three stable regions:

- Left rail: product identity, New Run command, active status, and run history.
- Main workspace: brief editor and configuration before launch; stage timeline and live event log during execution.
- Evidence pane: generated-app preview, screenshots, report, and repair history tabs.

On narrow screens the rail becomes a compact top bar and the workspace/evidence pane become tabs. Fixed-height toolbars and bounded panes prevent status text or long model names from shifting the layout.

The visual direction is an industrial delivery workstation: light gray canvas, near-black type, white work surfaces, coral active/error accents, and teal success accents. Typography is compact and editorial rather than oversized. Cards are reserved for repeated run and screenshot items; primary page sections remain unframed.

Buttons use Lucide icons when the existing dependency policy permits it; because the console has no frontend package step, version one uses familiar text commands plus Unicode-free CSS indicators rather than adding an icon package or hand-drawn SVGs.

## Interaction Details

- The brief editor starts with a useful neutral example and remains editable until launch.
- Full Run and Plan Only use a segmented control.
- Endpoint and model are normal inputs; API key uses a password input with a clear-session action.
- Launch is disabled until the brief and effective key are present.
- Live events show timestamp, stage label, and summary. Fatal and retry events are visually distinct.
- Selecting a historical run updates the evidence pane without navigating away.
- Preview is loaded only on request to avoid leaving multiple Vite processes running.
- Screenshot thumbnails open an in-page larger view.
- Report content is rendered as readable preformatted text in version one; raw HTML from artifacts is never injected.

## Error Handling

API errors use `{ "error": { "code": "...", "message": "..." } }` with appropriate 4xx or 5xx status codes. User errors are shown next to the command that caused them. Pipeline failures remain first-class jobs with their events and partial artifacts available.

The server catches rejected pipeline promises and records a terminal failed state. Preview startup failure does not alter the completed pipeline result. Server shutdown stops the active preview process and closes SSE clients.

## Security

- Listen on `127.0.0.1` by default, never all interfaces.
- Never serialize, log, echo, or persist API keys.
- Cap JSON request bodies and brief length.
- Jail all target, run, screenshot, report, and static paths.
- Serve only known console assets and explicitly supported run artifacts.
- Do not render generated report or log content as HTML.
- Keep model-generated install/build safety contracts unchanged.

## Testing

Unit and integration tests use Node's test runner and temporary directories:

- session configuration never returns or writes an API key;
- one-active-job enforcement and job state transitions;
- event callback and SSE replay/live delivery;
- run history reconstruction and path-jail rejection;
- preview eligibility and process lifecycle through injected adapters;
- HTTP validation and structured errors.

A Playwright console smoke test starts the real local server with a stub pipeline, submits a brief, observes live stages, selects evidence, and verifies desktop and mobile layouts. Existing offline and opt-in pipeline tests must remain green.

## Acceptance Criteria

1. `npm run console` opens a usable local control plane at a printed loopback URL.
2. A user can enter a brief and session-only model credentials and start Plan Only or Full Run.
3. The page updates progress and events without manual refresh.
4. Success, failed, and repaired runs remain inspectable from history.
5. A successful full run can be launched in an embedded live preview and its screenshots/report are accessible.
6. No API key appears in repository files, run artifacts, server responses, or logs.
7. Existing CLI behavior and tests remain unchanged.

## Deferred Work

Remote access, authentication, multiple concurrent jobs, durable credential storage, job cancellation in the middle of external commands, screenshot input, visual similarity scoring, and hosted deployment remain outside this version.
