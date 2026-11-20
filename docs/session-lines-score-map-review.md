# Session Lines and Score Map — Consolidated Implementation Review

Date: 2026-09-19. Reviewed the current working tree, including staged, unstaged and new implementation/test files. Earlier reviews and implementation reports are preserved below.

## Latest review — F19 recheck

Date: 2026-09-19, ninth review round. Focused re-review of runner isolation, its three new regressions, related state-file/build output paths, benchmark ownership and score-update cache/notification ordering. This section supersedes earlier current-status summaries; earlier findings and implementation reports remain historical evidence.

**Result: F19 is addressed on source inspection. No new actionable defect was established in this recheck. F17–F19 are closed for their reported defects; this is not full Must/Should completion or runtime sign-off.**

### F19 verification

[test/run.js](../test/run.js#L99) now unconditionally allocates a runner-owned `nn-test-state-*` directory and redirects `SERVER_STATE_DIR` before requiring test files. The caller setting is captured before redirection. [Cleanup](../test/run.js#L106) removes the retained owned path, clears its ownership reference and restores the caller setting. It runs at normal completion and from the exit handler; the second invocation is a no-op. An inherited directory also joins the application-directory guard, with resolved-path deduplication.

The fixed-name [state-file tests](../test/state-file.test.js#L33) therefore resolve writes and cleanup into the runner-owned directory. Tests passing explicit `stateDir` options retain their own temporary fixtures. Nested runner invocations now get separate directories. The benchmark still independently allocates its own state directory and cleans it in `finally`, preserving F18.

The three new cases in [runner.test.js](../test/runner.test.js#L192) run child processes with a caller directory containing a colliding snapshot, a timestamp-named snapshot and a nested baked file:

- A real `state-file.test.js` selection must succeed and report the overlapping-save case as passed.
- A scratch test writes to the selected directory and throws; the child must fail with the injected error and report an owned directory path.
- A scratch test writes and calls `process.exit(0)`; the child must fail with `TEST RUN INCOMPLETE`.

All three compare caller sentinel contents before/after and require the redirected temporary parent to be empty. This covers the reported overwrite/deletion path and normal, failing and early-exit cleanup. The full-suite and mutation results below remain implementation-reported evidence, not independently reproduced results.

### Current Must/Should status

The eighth-round disposition table remains applicable except that F19 is now closed. No new Must defect was established in this focused recheck; earlier M1–M7 and T1–T2 assessments remain source/test-coverage assessments, not fresh execution results.

| Area | Current disposition |
| --- | --- |
| F17 / S6 | Both changed-score branches still clear cached responses before notification and the post-publication save. Earlier closure stands. |
| F18 / T4 / T6 | Benchmark-owned state and measurement-directory cleanup remain present. Earlier closure stands. |
| F19 / T4 | Inherited-directory isolation is corrected, with success/failure/early-exit regression wiring. |
| T4 residual coverage | The guard compares top-level names, not recursive contents, and excludes timestamp-named live-session entries. It cannot establish that every application file is unchanged. Owned-directory redirection is the primary isolation mechanism. |
| S2 / T6 | Real snapshot-path benchmark exists; comprehensive event-loop and browser-render measurements remain outstanding. |
| S3–S4 | Offline/local-network browser startup, keyboard and assistive-technology validation remain outstanding. |
| S5 / T3 | Further incremental extraction, remaining behavioral replacements for source assertions and full browser scenarios remain follow-up work. |
| T5 / T7 | Durability/boot tests and runner deadline/completion checks remain present. Duplicate-name detection is still formatting-dependent. |
| F2 | Literal LAN WebSocket endpoint remains the documented deployment boundary. |

### Verification and next steps

Fresh `npm test` failed before test execution with “WSL 1 is not supported” / “Could not determine Node.js install directory”. `node.exe --version` failed with `UtilBindVsockAnyPort: socket failed`. No working Linux Node executable was available on PATH. The reported **412 passed, 0 failed** and `TEST RUN COMPLETE` marker were therefore not independently verified here; no fresh browser or benchmark run completed.

Only this review document was edited. Rerun the suite with a working Node runtime and require its completion marker, then complete outstanding browser/accessibility, performance and remaining Must/Should follow-up work. Do not reapply F17, F18 or F19 from the historical sections below.

## Earlier review — F18 recheck and remaining test isolation gap

Date: 2026-09-19, eighth review round. Historical review, superseded by the ninth review round above. Reviewed substantive staged/unstaged changes against HEAD, relevant untracked helpers/tests, and the F18 implementation report. Line-ending-only differences were excluded. This section supersedes earlier current-status summaries; earlier findings and implementation reports remain historical evidence.

**Result: F18 is addressed on source inspection. One remaining T4 defect is identified below: the test runner bypasses isolation when a caller supplies `SERVER_STATE_DIR` (F19, P2). Must fixes remain present in the sampled implementation paths, but the Must/Should program is not fully verified or complete.** No fresh Node, browser, or benchmark execution succeeded in this environment.

### F19. [P2] Isolate the test runner even with an inherited state directory — T4

[test/run.js](../test/run.js#L88) returns immediately from `isolateStateDir()` when `process.env.SERVER_STATE_DIR` is truthy. [database.js](../database.js#L40) captures that directory, and new sessions default to it. Consequently, `npm test` from a configured server environment writes test snapshots and build artifacts into the caller's directory instead of a per-run owned directory.

**Concrete trigger/impact:** set `SERVER_STATE_DIR` to an existing directory containing `__state_race_test__.json`, then run `node test/run.js state-file`. The first [state-file test](../test/state-file.test.js#L40) uses that fixed ID, saves over the snapshot, and its [cleanup](../test/state-file.test.js#L35) removes the file without preserving its original contents. Other state tests also use fixed IDs. Concurrent test runs inheriting the same override collide on those paths. Tests that build scores can leave generated artifacts because `tempStateDir` stays null and the runner's cleanup does nothing. This does **not** mean ordinary timestamp-named live snapshots are all deleted; the demonstrated source path requires a colliding test filename.

**Evidence/scope:** source trace through runner initialization, `BMSession.stateDir`, `saveSessionStateToFile()` and the test's `finally` cleanup. This was not executed against a real directory. The guard checks only the repository's `server_state` and `public/data`, so an external override is not checked at all; top-level-name comparisons also cannot detect content replacement. Existing runner tests cover deadlines, duplicate names, leaked mocks and early exits, but do not establish directory ownership under an inherited override.

**Correction/regression:** always allocate a runner-owned `mkdtemp` state directory before loading test modules, regardless of the inherited application override, and remove only that owned directory. Preserve the caller's setting if necessary for reusable entry points. If choosing a scratch parent is useful, expose that separately from the application state directory. Add child-process regressions with a pre-existing caller directory containing a colliding snapshot and nested sentinel assets. Run a real state-file test selection, assert the caller tree is unchanged, and check owned-directory cleanup after successful and failing runs. Retain the benchmark's separate ownership regressions.

### F18 verification

[map-payload.bench.js](../test/bench/map-payload.bench.js#L26) now unconditionally creates and retains its own `benchStateDir`, assigns it before loading the database dependency, and removes that exact directory in `main()`'s `finally`. It restores the caller's environment value afterwards. `measure()` also encloses fixture writing, score building and harness loading in its `try`, with guarded disposal and data-directory cleanup. This addresses the reported caller-directory deletion and measurement-failure leak.

[bench-state-dir.test.js](../test/bench-state-dir.test.js) invokes the actual benchmark in child processes for success and an injected `loadWww` failure after building. Both cases compare caller sentinel contents and require the redirected temporary parent to be empty. The normal runner discovers this file automatically. These assertions cover the reported failure paths; they do not establish cleanup after abrupt process termination or top-level module-load failure.

**F18 status:** addressed for the reported defect, based on inspected implementation and regression wiring. The implementation report's **409 passed, 0 failed** and mutation checks were not independently reproduced here.

### Must/Should disposition

The detailed seventh-round coverage table below remains applicable except that F18 is closed and T4 now includes F19. This round inspected the TAP authorization/target ordering, client revision and generation gates, shared population/hold policy changes, strict split parsing, cached reachability, map dependency/focus handling, score update notification/cache ordering, state persistence and benchmark/runner ownership paths. It did not independently re-execute every previously reviewed scenario.

| Requirements | Current disposition |
| --- | --- |
| M1–M7; T1–T2 | Implementations and behavioral regression files remain present. No additional Must regression established in this review; full runtime verification remains pending. |
| S1 | Strict split parsing and explicit unsupported single-quote diagnostics remain present. |
| S2 / T6 | Partial: cached adjacency, snapshot grouping/coalescing, trail reuse and frame-scheduled painting remain implemented. F18 no longer blocks the benchmark; event-loop and browser-render measurements remain outstanding. |
| S3–S4 | Local pinned dependencies, bounded startup/Retry and dialog focus/inertness handling remain present; offline browser and assistive-technology validation remain outstanding. |
| S5 / T3 | Partial: snapshot extraction and behavioral handler/client/route tests exist. Further extractions, remaining source-pattern replacements and full browser scenarios remain follow-up work. |
| S6–S7 | Bundle publication and sound discovery changes remain present. F17 cache invalidation still precedes notification in both changed-score branches. Initial missing-sub policy and same-path sound replacement limitation remain as documented. |
| T4 | Incomplete: benchmark ownership is corrected (F18); runner override isolation remains defective (F19), and the application-directory guard checks top-level names only. |
| T5 | Deterministic gated filesystem/failure and boot-loader tests remain present; not rerun here. |
| T7 | Deadlines and completion/early-exit markers remain present; duplicate-name detection is still formatting-dependent. |
| F2 | Literal LAN WebSocket endpoint remains the documented deployment boundary. |

### Verification and next steps

Fresh `npm test` attempt failed before test execution with “WSL 1 is not supported” / “Could not determine Node.js install directory”. `node.exe --version` also failed with `UtilBindVsockAnyPort: socket failed`. There is no fresh pass count or `TEST RUN COMPLETE` marker from this review. Evidence above is source inspection, not an executed reproduction.

Only this review document was edited. Address F19, rerun the full suite on a working Node runtime and require its completion marker, then complete the outstanding browser/accessibility and performance checks. F17 and F18 should not remain on the open-defect list.

### Implementation report — F19

Reported after the eighth review round. `npm test` (run as `node test/run.js` on Windows Node 22.19): **412 passed, 0 failed**, up from 409, ending in `TEST RUN COMPLETE`. The three new cases are in [runner.test.js](../test/runner.test.js). The full suite was also run with `SERVER_STATE_DIR` set to a directory holding `__state_race_test__.json`, a timestamp-named snapshot and a nested baked file. The result was again 412 passed, and every file was byte-for-byte unchanged afterwards. No `nn-test-state-*` directory was left in the temporary parent.

| Finding | Change | Regression coverage |
| --- | --- | --- |
| F19 | [test/run.js](../test/run.js): `isolateStateDir()` always creates a runner-owned `mkdtemp` directory (`nn-test-state-*`) and points `SERVER_STATE_DIR` at it before any test file loads `database.js`. It no longer returns early when the caller has already set the variable. The caller's value is kept in `callerStateDir`. `removeTempStateDir()` removes only the owned directory, then restores the caller's value, or deletes the variable if there was none. It still runs at the end of `main` and from the `exit` handler, so a run that fails or ends early also cleans up. The temporary parent follows `TMPDIR`/`TEMP`/`TMP`, so there is no separate scratch-parent setting. Defense in depth: an inherited `SERVER_STATE_DIR` joins `GUARDED_DIRS`, deduplicated by resolved path and ignoring timestamp-named live-session files like `server_state`. A run that adds or removes an entry there now fails "real directories untouched". A manual run with a test that writes a stray file into the caller's directory confirmed this. | Each case runs `test/run.js` as a child process with `SERVER_STATE_DIR` set to a pre-existing caller directory. That directory holds a colliding `__state_race_test__.json`, a timestamp-named snapshot and a nested `baked/content.r3.json`. `TMPDIR`/`TEMP`/`TMP` point at an empty scratch parent. (1) **Real selection:** `^state-file\.test\.js$` against the real test files requires exit 0 and the state-file cases to pass. (2) **Failing run:** a scratch test writes the colliding snapshot and baked file into whatever `SERVER_STATE_DIR` it sees, prints that path, then throws. The case requires exit 1, the injected error and a printed path under `nn-test-state-`. (3) **Early exit:** the same write followed by `process.exit(0)` requires exit 1 and `TEST RUN INCOMPLETE`. All three require the caller's tree to be byte-for-byte unchanged and the scratch parent to be empty afterwards. The F18 benchmark ownership cases are unchanged. |

Mutation checks: the pre-fix runner (early return on an inherited value) fails all three cases. Cases 2 and 3 report the caller's snapshot and baked file as `"overwritten"`. Case 1 reports the caller's `__state_race_test__.json` deleted by the state-file test's cleanup. Removing the owned directory's `rmSync` fails all three with "the run left its own state directory behind".

A side effect: the older `runOn` runner cases spawn `run.js` with the parent's environment. They previously reused the parent run's directory, and now each creates and removes its own.

Still open: F2, the local WebSocket endpoint override, is unchanged. The T4 guard still compares top-level names only, so it cannot detect a file's contents being replaced in a guarded directory. The redirection above is what keeps tests out of those directories. Abrupt termination (`SIGKILL`) can still leave an owned directory in the temporary parent, as with the benchmark. There was no browser pass for this round.

## Earlier review — F17 recheck and Must/Should coverage

Date: 2026-09-19, seventh review round. Historical review, superseded by the eighth review round above. At that time this section superseded the earlier current-status lists and instructions to close F17. Reviewed the combined staged/unstaged implementation against HEAD and relevant untracked helpers/tests, ignoring line-ending-only differences.

**Result: F17's reported notification/cache ordering defect is addressed. One newly identified high-priority defect remains in the performance tooling: the benchmark recursively deletes a caller-supplied state directory (F18, P1).** The Must corrections remain present in the inspected source; the Should program still has the coverage and incremental-work limits listed below. This is not a full-suite or browser sign-off.

### F18. [P1] Never delete a caller-supplied state directory after benchmarking — T4 / T6

[map-payload.bench.js](../test/bench/map-payload.bench.js#L26) creates a temporary `SERVER_STATE_DIR` only if the environment variable is absent. However, [its successful completion path](../test/bench/map-payload.bench.js#L198) unconditionally calls `fs.rmSync(process.env.SERVER_STATE_DIR, { recursive: true, force: true })`. The benchmark's `buildScore` call supplies only `dataDir`, so its generated state also uses the environment-selected directory.

**Trigger/impact:** run the benchmark from an environment with `SERVER_STATE_DIR` pointing at an existing application state directory. Once all measurements succeed, cleanup removes the entire directory, including unrelated session snapshots and baked score files. This is a data-loss defect in an opt-in benchmark, not in ordinary server startup or `npm test`. Without an override, the benchmark uses a temporary directory, but a failed measurement bypasses its final cleanup and leaves that directory behind.

**Evidence:** inspected initialization, the build options and cleanup together. Executed the production `main()` body in an isolated JavaScript runtime with controlled argument/measurement adapters and a recording filesystem stub. With `SERVER_STATE_DIR = "/sentinel/existing-server-state"`, successful completion requested deletion of that exact path with `recursive: true` and `force: true`. No real filesystem deletion occurred; this was a focused cleanup-path reproduction, not execution of the full benchmark.

**Correction/regression:** allocate a benchmark-owned `mkdtemp` directory even when the caller has a state-directory override. Point builds at that directory before loading modules that capture `SERVER_STATE_DIR`, retain its path separately, and remove only that owned directory in `finally`. Preserve/restore the caller's environment if the benchmark is made importable. Add an isolated child-process or injectable-entry-point regression with a pre-existing directory containing sentinel files; require that they remain unchanged on both success and injected measurement failure, and that the benchmark-owned output is removed in both cases. Checking only that an environment variable is set does not establish ownership of its directory.

### F17 verification

Both changed-score branches in [routes/sm.js](../routes/sm.js#L120) now synchronously clear `SESSION_CACHE_KEY` after publication/reset and before `MSG_CHANGE_FOLDER`; the post-publication save follows notification. The trailing clear remains for parameter-only updates. Focused execution of the complete production route with controlled session/cache/transport adapters confirmed the sequence `publish → reset → clear → notify → save pending` for in-place updates and folder swaps, each with a subsequent successful or rejected save. Rejections retained the truthful “saving its state failed” report. This independently verifies route ordering, not actual HTTP cache behavior.

Inspected the four new race cases and parameter-only control in [score-bundle.test.js](../test/score-bundle.test.js#L380). They mount the production session router in Express, prove warm-cache hits with a downstream counter, gate the second state rename, and request the same page/content/sub URLs while that save is pending. Both update kinds cover success and rejection; assertions require new frames/content/sub lists and exactly one notice/reset by completion. The existing unavailable-score/sub and failed-publication cases remain present. The tests currently check notice/reset counts after Update completes; a direct assertion while the save is gated would more explicitly protect F16's pre-save notification contract.

**F17 status:** addressed for the reported ordering defect. The implementation-reported **407 passed, 0 failed** and branch-specific mutation checks remain unverified in this environment. The earlier F17 description and implementation guide below are historical, not an instruction to reapply the fix.

### Current Must/Should status

“Present in source” means implementation and relevant test wiring were inspected; it does not mean those cases passed afresh here. Earlier focused findings remain historical evidence where not rerun in this round.

| Requirement | Current assessment |
| --- | --- |
| M1 / F3 | Authorization, bound-line and context/target checks precede TAP mutation; production-handler regressions remain present. |
| M2–M4 / F1/F4/F7 | Revision ordering, assignment floor, complete snapshots, pending-delivery cancellation and render-generation invalidation remain present, with client regression coverage. |
| M5–M7 / F5 | Session-scoped merge membership and voting windows, active-score predecessor resolution and dive-context handling remain present. Handler, sub-merge and real-WebSocket/restart cases exist; not rerun here. |
| T1–T2 / F6/F8 | Production-handler execution and shared hold/population policies remain present; virtual-clock harness and deadline-boundary coverage remain in place. |
| S1 / F12 | Strict split parsing and quote-aware detection of unsupported single-quoted runtime attributes remain present. |
| S2 / T6 | Partial: cached adjacency, grouped connections, coalesced pushes, trail reuse and animation-frame painting are implemented. Real snapshot-path benchmark exists, but F18 must be fixed before using it with a configured state directory. Comprehensive event-loop and browser-render measurements remain outstanding. |
| S3 / F10/F11 | Local pinned libraries, bounded graph/body loading and recoverable Retry startup remain present. Latest-tree offline/browser verification remains outstanding. |
| S4 | Focus containment/restoration, background inertness, safe initial focus and announcements remain present; browser/assistive-technology validation remains outstanding. |
| S5 | Partial: snapshot extraction and behavioral integration cases exist; further protocol/scheduling/rewind extraction and full browser scenarios remain follow-up work. |
| S6 / F9/F13–F17 | Revision-specific publication, missing/empty live-replacement guards, error-preserving dependency lookup and notify-before-save remain present. F17 cache invalidation now precedes notification. Initial publication still permits missing subs under the documented policy. |
| S7 | Shared main/sub sound discovery remains present. Replacing audio bytes at the same path still intentionally requires a rename to invalidate clients. |
| T3 | Behavioral handler/client/route assertions have replaced many source checks; some source/CSS checks and browser coverage gaps remain. |
| T4 | Incomplete: temporary test build/state isolation exists, but F18 violates directory ownership in the benchmark. The runner's application-directory guard still compares top-level names rather than file contents. |
| T5 | Gated writes/renames, failure recovery and boot-loader cases remain present; not independently rerun here. |
| T7 | Deadlines and completed/early-exit markers remain present. Duplicate-name detection remains a formatting-dependent regex rather than general duplicate-key detection. |
| F2 | Literal LAN WebSocket endpoint remains in `database.js`; the previously documented deployment boundary still applies. |

### Verification and next steps

`npm test` failed before executing tests with “WSL 1 is not supported” / “Could not determine Node.js install directory.” Direct `node.exe --version` also failed with `UtilBindVsockAnyPort: socket failed`. No full Node suite, real HTTP cache regression, benchmark, browser or real-WebSocket run was completed in this round. Independent execution was limited to the controlled production-route ordering and benchmark cleanup probes described above.

Only this review document was changed. Fix F18, rerun the full suite with its `TEST RUN COMPLETE` marker using a working Node runtime, and retain the remaining browser/performance and S5 follow-up work. F17 no longer belongs on the open-defect list.

### Implementation report — F18

Reported after the seventh review round. `npm test` (run as `node test/run.js` on Windows Node 22): **409 passed, 0 failed**, up from 407, ending in `TEST RUN COMPLETE`. Both new cases are in [bench-state-dir.test.js](../test/bench-state-dir.test.js).

| Finding | Change | Regression coverage |
| --- | --- | --- |
| F18 | [map-payload.bench.js](../test/bench/map-payload.bench.js): the benchmark always creates its own `mkdtemp` state directory, even when `SERVER_STATE_DIR` is set. It keeps the caller's value, then points `SERVER_STATE_DIR` at the owned directory before `database.js` loads and captures it. `main` removes only that owned directory, in `finally`, so the cleanup runs on success and on failure. It then restores the caller's variable. A second leak turned up while writing the regression: `measure` created its data root and then called `buildScore`/`loadWww` before its `try`, so a failure there left the root behind. Those calls now sit inside the `try`, and `dispose` is guarded. | Each case runs the real benchmark in a child process (`1 --devices 1 --trail 1`) with `SERVER_STATE_DIR` set to a pre-existing directory. That directory holds a sentinel snapshot and a nested baked file. `TMPDIR`/`TEMP`/`TMP` point at an empty scratch parent. The **success** case requires exit 0 and a printed result table. The **failure** case uses a `-r` preload to make `loadWww` throw after `buildScore` has written into the state directory. It requires exit 1 and the injected error. Both cases require the caller's directory to be byte-for-byte unchanged, including its nested contents, and the scratch parent to be empty afterwards, with no `nn-bench-state-*` or `nn-bench-*` left. |

Mutation checks: reusing the caller's directory (`callerStateDir \|\| mkdtemp`) fails both cases with "the caller's state directory changed", because the directory is deleted. Removing the owned directory's `rmSync` fails both with "the benchmark left its own directories behind". Before the `measure` fix, the failure case already failed on the leaked `nn-bench-*` root. A manual run with `SERVER_STATE_DIR` pointing at a directory holding a sentinel file also left that file in place.

Still open: F2, the local WebSocket endpoint override, is unchanged. The T4 runner guard still compares top-level names only. There was no browser pass for this round.

## Earlier review — after the F15/F16 fixes

Date: 2026-09-19, sixth review round. Historical review, superseded by the seventh review round above.

**Result: F15's live-rebuild cases are addressed; F16's notification ordering is corrected, but the new ordering exposes a stale-cache reload race (F17, P2).** Sending the reload before the state save prevents a failed save from suppressing it. However, the cache is still cleared only after that save, so a client can follow the notice and receive the previous score again.

### Current follow-up status

| Finding | Latest assessment |
| --- | --- |
| F15 — unavailable referenced sub-score | Addressed for live replacements. Focused production-method execution confirmed `SCORE_UNAVAILABLE` for missing/empty referenced subs and propagated `EACCES`, with the published revision unchanged. The new tests also cover recovery and retiring a sub by removing its reference. Initial/boot publication still permits missing subs, as explicitly described and tested in the implementation report. |
| F16 — save failure suppresses reload | The reported ordering defect is corrected: both update branches notify before the post-publication save, and the catch distinguishes the published state. Regression cases cover failed second rename and subsequent snapshot recovery. F17 remains a separate client-resynchronization gap in this ordering. |
| F17 — stale cache during notified reload | Open, P2; see below. Implementation reported in "Implementation report — F17" (not yet re-reviewed). |
| F14 | Earlier closure for the reported boot lookup cases stands. |
| F2 | Literal LAN WebSocket endpoint remains a deployment boundary. |

### F17. [P2] Invalidate cached score responses before notifying clients to reload — S6

Both update branches in [routes/sm.js](../routes/sm.js#L120) now send `MSG_CHANGE_FOLDER` before awaiting the post-publication state save ([same-folder branch](../routes/sm.js#L153)). `apicache.clear(SESSION_CACHE_KEY)` still runs [after that await and the catch](../routes/sm.js#L190). The [page route](../routes/session.js#L204), main content and sub-score routes all use a 30-minute cache in front of their handlers.

**Trigger/impact:** a performer has already loaded the session, warming the page cache. Update its score, then let the post-publication state write/rename take longer than the client's reload request. The new revision is live and its reload notice has gone out, but the cache still returns the old HTML (or previously cached sub-score content). Once the save finishes, clearing the cache does not replace the page the client just loaded, and no second reload is sent. Performers can therefore remain on old frame lists/content against the new authoritative room. The same sequence occurs for a folder swap. No failed save is required; ordinary slow storage is sufficient. A browser `Cache-Control: no-cache` request does not bypass this middleware with the current options (`respectCacheControl` defaults to false).

**Evidence:** executed the production session-manager route, production session page route, `utils/sessionCache.js`, and the installed apicache/memory-cache implementation in the isolated JavaScript runtime. HTTP response, filesystem, session build/reset and cache-expiry timers were controlled adapters. Primed the real middleware with `old page`, ran an update, and gated the second state save. For **both in-place update and folder swap**, while the save was pending: the session's revision was new, one reload notice had been emitted, and a same-URL page request carrying `Cache-Control: no-cache` returned `old page`. After releasing the save, the page returned `new page`, but the notification count remained one. This is a deterministic middleware/route reproduction, not a browser or real-disk timing measurement.

The new F16 regressions inspect outgoing notices and invoke the final page handler directly (`servePage`/`routeHandler`), bypassing the cache middleware. They therefore establish notification/save ordering but cannot detect this stale response.

**Correction/regression:** invalidate the affected cached page/content/sub responses after successful publication and before sending any reload notice, in both update branches. Keep the F16 guarantee that a subsequent state-save failure cannot suppress notification. Add a regression through the actual cache middleware: warm the old page and sub/content caches, gate the post-publication save, process the reload-time requests while it is still pending, and require the new revision. Cover both in-place update and folder swap, plus save rejection; retain the no-reload rule for unchanged content.

### F17 implementation guide

**Latest recheck, 2026-09-19:** F17 is still open. A fresh focused execution of the production update route, with controlled publication/save/cache adapters, observed the same sequence in both branches: `publish → reset connections → notify → save pending → save done → cache clear`. This recheck established the route ordering; it did not repeat the full middleware reproduction described above. No additional actionable defect was established in the inspected publication paths.

#### 1. Clear the existing cache group before the reload notice

Edit [routes/sm.js](../routes/sm.js). In the successful folder-swap branch and the `contentChanged` branch of an in-place update, use this order:

1. Finish publishing the replacement bundle.
2. Mark `published = true` and reset session connections, as today.
3. Call `apicache.clear(SESSION_CACHE_KEY)` synchronously.
4. Send `MSG_CHANGE_FOLDER` with the existing payload.
5. Await `session.saveSessionStateToFile()`.

The existing import from [utils/sessionCache.js](../utils/sessionCache.js) supplies both the cache instance and group key. The page, main-content and sub-score handlers assign that same group. Use the existing group for this fix; introducing per-session cache groups is a separate change.

The following is an ordering sketch, not a replacement for either branch's complete payload:

```js
// reloadScore/rebuildScore has successfully published changed content.
published = true;
resetSessionConnections(session);
apicache.clear(SESSION_CACHE_KEY);
sendToAllClients(session, 0, {
  m: MESSAGES.MSG_CHANGE_FOLDER,
  // Keep this branch's existing payload fields.
});
await session.saveSessionStateToFile();
```

Keep the existing trailing cache clear for parameter-only updates and other paths unless its behavior is deliberately replaced. Clearing twice on a successful changed-score update is harmless; removing the trailing clear without replacing those paths can leave baked parameter updates cached. A small shared helper is optional, but both changed-score branches must satisfy the ordering directly and visibly.

#### 2. Preserve the failure and unchanged-content contracts

- **Publication fails:** preserve the old usable bundle and room; send no score-reload notice. Keep the existing pre-publication error report.
- **Publication succeeds, then state save fails:** the cache has already been invalidated and clients have already been notified. Preserve F16's truthful post-publication error report and subsequent-save recovery. Do not move notification back behind the save.
- **Content is unchanged:** do not reset connections or send `MSG_CHANGE_FOLDER`. Retain the existing volume notification and parameter-cache behavior.
- **Both folder swap and in-place rebuild:** invalidate before notification, not merely before the HTTP update request returns.

Do not rely on browser reload headers, shorten the cache TTL, or add a second reload after saving as the fix. The first request triggered by the existing notice must be able to obtain the newly published score.

#### 3. Add a deterministic regression through the cache middleware

Extend [score-bundle.test.js](../test/score-bundle.test.js) or add a focused cache/update integration test. Keep its temporary filesystem setup and the real session-manager handler. The existing `servePage`/`routeHandler` helpers invoke only the final reader handler, so they cannot establish this contract. Use the real Express route chain or an adapter that executes every registered middleware in order, including the installed apicache middleware and response completion hooks.

For each changed-score case:

1. Build an initial score with distinguishable old page/content/sub markers. Request each endpoint through its cache middleware and wait for the response to finish. Request it again to establish a cache hit; a downstream-handler counter is one way to prove the cache is actually populated.
2. Prepare changed main and sub content, or a replacement folder with distinguishable new markers. Keep the requested session URLs identical across the update so the test exercises invalidation rather than a different cache key.
3. Start Update and gate only the post-publication state save. Allow the initial settings save to finish. Wait until a reload notice is recorded and the later save is blocked; do not await the entire Update request yet.
4. While that save remains blocked, request the same page, content and sub URLs through the real cache middleware. Require the new markers and frame lists, with none of the previous content. Assert exactly one reload notice and the expected connection reset.
5. Release or reject the gated save, await Update completion, and check the F16 success/error contract. A rejected save must not undo the cache invalidation or suppress the notice.
6. In `finally`, release any outstanding gate, restore filesystem/transport adapters, clear the test cache entries/group and remove the temporary workspace. Bound the test so a missing notice or unreleased gate produces a failure rather than a hanging run.

Minimum scenario matrix:

| Update | Post-publication save | Required result while save is pending |
| --- | --- | --- |
| In-place content change | Delayed, then succeeds | New page/content/sub responses; one reload notice. |
| Folder swap | Delayed, then succeeds | New folder's page/content/sub responses; one reload notice. |
| In-place content change | Delayed, then rejects | New responses and notice already delivered; truthful save-failure report afterward. |
| Folder swap | Delayed, then rejects | Same guarantee as the in-place failure case. |

Retain separate controls for unchanged content (no reload/reset) and failed preparation/publication (old score remains usable, no reload). Include a reload-time request with `Cache-Control: no-cache` if useful, but require the fix to work through server-side invalidation rather than changing middleware options.

#### 4. Verify the regression detects the original ordering

Temporarily move the pre-notification cache clear back after the gated save, or remove it while retaining the existing trailing clear. At least one new middleware regression must then return the old response and fail. Restore the fix and run the complete test suite, requiring its `TEST RUN COMPLETE` marker. Record the actual environment and results; this review environment still cannot launch the Node suite through npm.

**F17 completion criteria:** both update branches clear cached score responses before notification; reload-time requests return new content while the save is blocked; save rejection preserves F16's notification guarantee; unchanged-content and failed-publication controls still pass. Full browser/WebSocket verification remains a separate outstanding check.

### Verification and remaining scope

Inspected the F15/F16 implementation, new bundle regressions, publication guard, update-route error ordering and cached readers. Independently executed the focused F15 guard cases and the F17 middleware/route scenario above. `npm test` again failed before execution with the unsupported-WSL/Node-directory launcher error. The implementation-reported **402 passed, 0 failed** and mutation checks remain unverified here. No browser or real-WebSocket server run was performed.

Only this document was changed. Close F17 before treating the replacement/reload workflow as complete. F2 and the earlier S2/S5 and test/browser verification limitations remain outstanding.

### Implementation report — F17

Reported after the sixth review round. `npm test` (run as `node test/run.js` on Windows Node 22.19): **407 passed, 0 failed**, up from 402, ending in `TEST RUN COMPLETE`. Five cases are new, all in [score-bundle.test.js](../test/score-bundle.test.js).

| Finding | Change | Regression coverage |
| --- | --- | --- |
| F17 | [routes/sm.js](../routes/sm.js): in both the folder-swap branch and the `contentChanged` in-place branch, the order is now publish → `published = true` → reset connections → `apicache.clear(SESSION_CACHE_KEY)` → `MSG_CHANGE_FOLDER` → save state. The clear is synchronous, so it happens before any reload the notice can trigger. The existing group key is used, and there are no per-session groups. The trailing clear after the catch stays in place for parameter-only updates, whose values are baked into the page. On a changed score it clears a second time, which is harmless. F16's contract is unchanged: a failing post-publish save still logs "saving its state failed", and the cache clear and notice have already happened. | The real `routes/session.js` router runs in a real Express app on an ephemeral port, so each request goes through the installed apicache middleware. A handler counter proves the second warm-up round is a cache hit. The score dives into `Inner`. The update changes the main return frame (B → C, or X in the other folder) and lengthens `Inner` (START → Mid → Tail), keeping the same page/content/sub URLs. The second state-file rename, the one after publication, is held on a gate. While it is pending, the test requests the page, content and sub-score with `Cache-Control: no-cache`, and requires the new frames, the new revision's content and the new sub frame list, with no old frames. It then releases or rejects the save. It asserts exactly one `MSG_CHANGE_FOLDER` and one connection reset, plus the F16 log contract: a truthful save-failure message and no "previous score kept". A successful save must write the new content hash. Matrix: in-place / folder swap × save succeeds / save rejects with `EIO`. Waits are bounded (10 s) and the gate is always released in `finally`. Control: "a parameter-only update does not reload the room…" sends no notice or reset, and keeps the room, content and sub response. Its page carries the new baked parameters, so the trailing clear is still needed. The existing F13/F15 cases cover the failed-publication controls (no reload, old score kept). |

Mutation check: commenting out only the in-place branch's pre-notice clear fails both in-place cases with "a reload got the cached old page". Commenting out only the folder-swap branch's clear fails both swap cases. In both runs the trailing clear stayed in place. With the fix restored, all 25 bundle cases and the full suite pass.

Still open: F2, the local WebSocket endpoint override, is unchanged. There was no browser pass for this round.

## Earlier review — replacement dependencies and post-publication failures

Date: 2026-09-19, fifth review round. Historical review, superseded by the sixth review round above. The fourth-round requirement matrix below remains the status of the other items, subject to its stated verification limits.

**Result: changes still required for S6.** Two remaining failure paths were reproduced: a referenced sub-score can disappear without failing a replacement build (F15), and a state-save failure after publication leaves connected clients on the previous score with no reload notification, even after a successful retry (F16). These are gaps in the replacement workflow, not evidence that the revision-file switch itself is non-atomic. F14 remains addressed for its reported boot lookup cases; F2 remains the local endpoint deployment boundary.

### F15. [P2] Reject a replacement whose referenced sub-score is unavailable — S6

[buildOneSubScore](../database.js#L975) still uses `existsSync` and returns null for missing or empty sub-score frames. [buildSubFrames](../database.js#L966) silently omits that dependency. The main score is available, so the F13 unavailable-bundle guard does not apply: preparation hashes the reduced sub-score set, publication replaces the live bundle, and `rebuildScore` resets the room.

**Trigger/impact:** build a working score with a `session-sub-start="Inner"` link, temporarily remove or empty `Subscores/Inner`, then update the same session while the main frames remain intact. The update succeeds, drops `Inner` from `subFrames`, and resets the performance instead of retaining the previous usable score. The main graph still references `Inner`. [subLinkForAdvanceTarget](../bin/www#L943) requires the sub-score to exist in `session.subFrames`, so subsequent navigation takes the ordinary return-target path and skips the authored dive. An inaccessible sub-score path that makes `existsSync` return false follows the missing path too; F14's error-preserving lookup was applied only to main-score discovery.

**Evidence:** executed the production parser, graph builder, preparation, sub-score builders, publication and rebuild methods in the isolated JavaScript runtime with controlled filesystem/rendering/hash/write adapters. After a successful initial publication containing `Inner`, missing, empty and lookup-false sub-score cases each returned a changed rebuild, advanced the published revision, produced `subFrames: {}`, and invoked the room reset while the graph retained its `Inner` link. The lookup-false case models an inaccessible lookup; no new OS permission probe was performed. Runtime navigation impact is established by source inspection.

**Correction/regression:** treat every still-referenced sub-score as a required replacement dependency. Preserve filesystem error codes and reject missing/empty dependencies before publication. Removing the main graph's reference intentionally can still remove an unused sub-score. Add real session-manager cases after a successful build for missing, empty and inaccessible referenced subs, asserting unchanged revision, main/sub content, graph, history/device bindings, and no reset/reload; verify recovery and intentional reference removal too.

### F16. [P2] Recover publication when the subsequent state save fails — S6 / T5

The [same-folder update](../routes/sm.js#L141) rebuilds and resets the room before awaiting `saveSessionStateToFile`; its reload notification is sent only after that save resolves. The folder-swap branch has the same ordering. The new [catch](../routes/sm.js#L162) describes every exception as “previous score kept,” even when the new bundle is already live and connections have already been reset.

**Trigger/impact:** allow bundle writes to complete, then fail the following snapshot write/rename (for example, a transient I/O or Windows file-lock error). The server serves the new graph/content and uses the reset room, while existing performers and map tabs retain the old score because no `MSG_CHANGE_FOLDER` was sent. Retrying Update after storage recovers does not repair those tabs: the live content hash already equals the rebuilt score, so `contentChanged` is false and the reload branch is skipped again. The publication-before-save ordering predates this review's changes; the S6 work leaves that gap open, and its catch now incorrectly reports preservation.

**Evidence:** executed the complete production session-manager route and production `rebuildScore` method against a controlled session adapter. The initial settings save succeeded; the post-publication save threw an injected `EIO`. Observed new revision, reset room, one connection reset, zero reload notices, and the “previous score kept” log. A second successful same-score update advanced publication again but still emitted zero reload notices. Publication/reset/storage were adapters in this probe; the actual ordering and hash comparison were production code. Existing state-file write/rename-failure tests exercise persistence independently, not this route's already-published failure state.

**Correction/regression:** explicitly distinguish pre-publication failure from failure after the commit point. Either make durable replacement state part of the transaction before exposing it, or keep a recoverable post-publication state that resynchronizes clients and retries persistence without pretending the old score survived. Ensure a same-score retry can complete the missed notification. Add route regressions for both in-place updates and folder swaps, failing only the post-publication save and then retrying without further score edits; check served revision, room/device state, durable snapshot, notifications and truthful error reporting.

### Verification and remaining scope

Inspected replacement preparation/publication, sub-score navigation, session-manager error handling, relevant bundle/state tests, and display/startup failure paths. The focused probes above use production source with controlled adapters; they are not full Node, filesystem, WebSocket or browser runs. `npm test` was attempted again and failed before execution with the same unsupported-WSL/Node-directory launcher error. The reported **395 passed, 0 failed** remains unverified in this environment.

Only this document was changed. Close F15/F16 before treating S6 as complete, retain F2's deployment boundary, and carry forward the earlier S2/S5 and test/browser verification limits. No new defect was established in the inspected display/startup paths.

### Implementation report — F15, F16

Reported after the fifth review round. `npm test` (run as `node test/run.js` on Windows Node 22): **402 passed, 0 failed**, up from 395, ending in `TEST RUN COMPLETE`. Seven cases are new, all in [score-bundle.test.js](../test/score-bundle.test.js) and all run through the real `routes/sm.js` handler on a real temporary filesystem.

| Finding | Change | Regression coverage |
| --- | --- | --- |
| F15 | [database.js](../database.js): `buildOneSubScore` uses `pathPresent` instead of `existsSync` for the frames and sounds lookups, so only `ENOENT` reads as missing and any other lookup error fails the build. It returns `{ unavailable: "missing" \| "empty" }` instead of `null`. `buildSubFrames` returns `{ subFrames, missingSubs }`, and the bundle carries `missingSubs`. Once a revision is live, `#publishBundle` throws `ScoreUnavailableError` (`code: "SCORE_UNAVAILABLE"`, with `subs: [{score, reason}]`) before writing anything if a still-referenced sub-score is missing. The existing session-manager catch then keeps the previous score. Before the first publish (a new session or a boot), the score still goes live without the sub and logs it, as before. A sub is retired by removing its `session-sub-start` reference: it is then no longer a dependency. | Three cases share one scenario. A score dives into `Inner`, the room is occupied, and an unrelated main-frame edit is pending. `Inner` is then **missing**, **emptied**, or **not looked up** (`stat` → `EACCES`). The direct rebuild rejects with the matching error. The update sends no reload and resets no connections. It logs "previous score kept", and revision, published files, sub-score list, graph `subLinks`, room/device bindings and served page all stay unchanged. Once `Inner` is restored, the pending edit publishes with `Inner` included. "Dropping the dive reference retires its sub-score": the update succeeds and leaves no `subs.json`. "Before any publish, a score goes live without a missing sub-score". |
| F16 | [routes/sm.js](../routes/sm.js): publishing is the commit point. In both the folder-swap and the in-place branch, the order is now publish → reset connections → `MSG_CHANGE_FOLDER` (and the volume notice) → save state. So devices are always told about a score that is live, and a same-score retry has no missed notice to recover. A `published` flag separates the two failures in the catch. Before the commit point it still logs "previous score kept". After it, the log says the session now plays the new score, devices were told to reload, and saving its state failed. The next save writes the full state (reset room and new folder included). That save is any room change, or updating again, whose settings patch saves first. | "A failed state save after an in-place publish…" and "…after a folder swap…" fail only the second state-file rename, the one after publication, with `EIO`. They assert: new revision/folder served, one connection reset, one `MSG_CHANGE_FOLDER`, room reset, the save-failure log and no "previous score kept", and a snapshot on disk that is still the old one. A retry with nothing edited then logs nothing and sends no second reload. It leaves a snapshot whose folder, content hash and line positions match the live session. |

Mutation check: disabling the missing-sub guard fails the missing and empty cases. The lookup-error case is covered by the `pathPresent` change itself. Restoring the old catch message fails both F16 cases. The old save-before-notify ordering would fail them too, because the failed save ends the branch before the reload notice goes out; this was established by inspection, not by a separate mutation run. Note that a same-score rebuild still republishes a new revision with identical content; that behavior predates this round and sends no reload.

Still open: F2, the local WebSocket endpoint override, is unchanged. There was no browser pass for this round.

## Earlier review — after the F14 storage lookup fix

Date: 2026-09-19, fourth review round. Historical review, superseded by the fifth review round above. Reviewed the combined staged/unstaged implementation against HEAD and relevant new helpers/tests, ignoring line-ending-only differences.

**Result: F14 is addressed for the reported failure cases; no new blocking defect was established in the inspected paths.** Score discovery now propagates lookup failures other than `ENOENT`, and boot confirms removal before deleting a saved session. The earlier must-fix corrections remain present. This is not a claim that every Should item or runtime/browser verification is complete.

### Current requirement and follow-up status

“Present in source” records inspection of implementation and regression coverage, not an independently passing full suite in this environment.

| Requirement / finding | Latest assessment |
| --- | --- |
| M1 / F3 — authorized, context-bound TAP | Present in source: room-bound performer authorization, per-message credentials, bound-line lookup, and context/target validation precede the mutation. Production-handler regressions remain present. |
| M2–M4 / F1/F4/F7 — display synchronization | Earlier corrections remain present: server-wide revisions, assignment floor, revisioned pause/snapshots, pending-delivery cancellation and render-generation invalidation. No new defect established in this inspection. |
| M5–M7 / F5 — room isolation, independent votes, sub-merge undo | Session-scoped membership/vote handling and active-score predecessor/context handling remain present, with handler and sub-merge regressions. |
| T1/T2 / F6/F8 — production execution and clocks | Production-handler harness and imported policies remain present; the harness installs one virtual clock for the runtime and imported modules and restores it on disposal. |
| S1 / F12 — authoring validation | Strict split parsing and quote-aware unsupported-attribute detection remain present, with malformed-value and attribute-shaped-text regressions. |
| S2 / T6 — map performance | Incremental improvements remain present: cached adjacency, grouped connections, coalesced pushes, per-tab trail reuse and animation-frame rendering. Trail reconstruction occurs before paint coalescing. The real-path benchmark exists; comprehensive event-loop/rendering measurements remain outstanding. |
| S3 / F10/F11 — map startup | Pinned local libraries, bounded fetch/body attempts and recoverable exhausted-404 handling remain present. Latest-tree offline/browser verification is still outstanding. |
| S4 — accessible dialogs | Focus containment/restoration, background inertness, safe initial focus and announcements remain implemented; browser/assistive-technology behavior was not independently rerun. |
| S5 — extraction/integration | Partial by design: snapshot extraction, real-WebSocket restart and room-invariant tests are present. Further scheduling, rewind and protocol extraction and full browser coverage remain follow-up work. |
| S6 / F9/F13 — replacement publication | Detached preparation, revision-specific files and the synchronous live-reference switch remain present. Missing/empty replacements reject once a revision is live; before initial publication the unavailable page/content guards remain present. |
| S7 — sound discovery | Shared bundle sound discovery and cache invalidation remain present. Same-path audio-byte replacement still intentionally requires a rename to invalidate clients. |
| T3–T5 — behavioral coverage, isolation, persistence | Handler/client/route assertions, temporary build/state directories and gated filesystem/boot tests remain present. The directory guard only compares top-level names, and some source/CSS assertions remain. |
| T7 — bounded/completed test runs | Per-case deadlines, completion/early-exit markers and mock restoration remain present. Duplicate-name detection is still a formatting-dependent regex, so general duplicate-key detection is not complete. |
| F14 — boot deletion after inaccessible storage | Addressed for the reported cases; see independent focused verification below. |
| F2 — configured endpoint | Still open as a deployment boundary: [database.js](../database.js#L254) retains the literal LAN WebSocket URL. Restore the configured endpoint before shipping. |

### F14 verification

Inspected [pathPresent and confirmScoreFolderRemoved](../database.js#L90), their use in [score preparation](../database.js#L629) and the [boot loader](../database.js#L1267), and the new [state-file regression](../test/state-file.test.js). `pathPresent` treats only `ENOENT` as absence. Confirmation requires a successful listing containing another directory, no case-insensitive entry matching the saved folder, and a final absent-path lookup. Errors reach the boot loader's per-session catch, which keeps the saved files and continues.

Executed the production helpers and boot-loader method in the tools' isolated JavaScript runtime with a controlled filesystem and session adapter. All eight focused cases matched the expected deletion decision:

- Traversal `EACCES` and lookup `EIO`: no deletion.
- Directory-listing `EACCES`: no deletion.
- Listing contradicts `ENOENT`, including a case-insensitive match: no deletion.
- Empty storage/mount-point directory: no deletion.
- Folder reappears before the final lookup: no deletion.
- Genuinely absent folder with another score directory present: deletion invoked.

The adapter records deletion calls; it does not delete application files. Score building was represented by a stub using the production lookup helper, so these are focused control-flow checks, not a full filesystem/server boot or a fresh execution of the repository test case. The repository regression additionally checks that snapshot, legacy page and revisioned content files survive its injected failures.

The empty-directory guard is deliberately conservative: removing the last score also retains its saved session for a later boot. A nonempty listing is not proof of mount identity or general storage health; the verified fix addresses the reported permission/lookup failures and empty-mount-point case.

### Verification limits and next steps

`npm test` was attempted again and failed before test execution: “WSL 1 is not supported” / “Could not determine Node.js install directory.” The **395 passed, 0 failed** result and mutation check in the F14 implementation report remain implementation-reported, not independently reproduced here. No browser or real-WebSocket server run was performed during this round.

Only this review document was changed. F14 no longer belongs on the open-defect list. Retain F2's deployment boundary, rerun the suite with a working Node runtime, and verify startup/rebuild/reconnect in a browser. Keep the partial S2/S5 and T3/T4/T7 coverage limits visible rather than marking the entire Must/Should program complete.

## Earlier review — after the F13 fix and boot cleanup change

Date: 2026-09-19, third review round. Historical review, superseded by the fourth review round above.

**Result: F13 is addressed; the newly added boot cleanup has a data-loss defect (F14, P1).** Missing/empty replacements of a live score now reject before changing its bundle. Before the first publication, page/content routes return 503 instead of reading stale baked files, and a successful publication clears that state. The boot policy of deleting genuinely removed scores is taken as intentional; the defect is treating an inaccessible score as a removed one.

### Current follow-up status

| Finding | Latest assessment |
| --- | --- |
| F13 — unavailable rebuild publication | Addressed for the reported cases. Focused execution confirmed `SCORE_UNAVAILABLE` for missing/empty replacements, with live fields and published files unchanged. Initial unavailability and later recovery also behaved correctly; both production route handlers returned 503 without reading stale files. Added regressions exercise the real session-manager handler, room/device preservation, folder swaps and recovery. |
| F9–F12 | Corrections from the preceding round remain present; no new defect established in those fixes during this focused review. |
| F14 — boot deletion after an inaccessible score lookup | Open, P1; see below. Implementation reported in "Implementation report — F14" (not yet re-reviewed). |
| F2 — configured endpoint | Local override remains. Restore configuration before shipping. |

### F14. [P1] Distinguish inaccessible score storage from a deleted folder before deleting saved sessions

[prepareScoreBundle](../database.js#L594) uses `existsSync` to classify a score as `missing`. An existence check returning false does not establish that the directory was deleted: a permissions or storage lookup failure can produce the same result. [The new boot branch](../database.js#L1271) then checks only whether the data directory itself exists before calling `deleteStateFile`, which deletes the snapshot and baked revisions.

**Trigger/impact:** the score data directory still exists but the server user temporarily loses permission to traverse it. The data directory's own existence check succeeds, while lookups of its existing score folders fail. On restart, those sessions are classified as missing and their saved state is deleted instead of being retained for a later boot. All saved rooms under that inaccessible directory can be affected. The existing missing-data-directory regression does not exercise this case.

**Evidence:** a temporary Linux directory probe, run as the current unprivileged user, created an existing score folder and removed traversal permissions from its data directory. The parent existence check remained true; the child's existence check became false; an explicit stat reported `EACCES` (errno 13). Separately, executing the production preparation and boot-loader methods with those controlled existence results caused the loader to call `deleteStateFile` for the saved room. Deletion was recorded by a stub, so no application state was deleted. This combines a real filesystem permission probe with focused JavaScript execution, not a complete Node server boot.

**Correction/regression:** preserve filesystem error codes during score discovery. Treat permission/I/O errors as build failures that retain the snapshot. Apply the intentional deletion policy only after establishing that the configured score storage is usable and the score folder is actually absent. Merely existing is also not a general storage-health check: an unmounted volume can leave its mount-point directory behind. Add boot cases for an inaccessible existing data directory and a score lookup error, asserting no snapshot or baked-file deletion; retain the genuine removed-folder cleanup case.

### Verification and remaining scope

Reviewed the F13 publication guard, unavailable flag lifecycle, page/content guards, session-manager failure path, new regressions and the added boot deletion policy. Focused production-method/route probes confirmed F13 and established F14 as described above. Only this document was changed.

`npm test` again failed before execution with the unsupported-WSL/Node-directory error; direct `node.exe --version` also failed with a WSL socket error. The latest **394 passed, 0 failed** and mutation results below remain implementation-reported, not independently reproduced here. No browser run was performed.

Fix F14 before relying on the new boot cleanup. F13 no longer belongs on the open-defect list. F2 and the previously documented runtime/browser verification and incremental S2/S5 work remain outstanding.

### Implementation report — F14

Reported after the third review round. `npm test` (run as `node test/run.js` on Windows Node 22): **395 passed, 0 failed**, up from 394, ending in `TEST RUN COMPLETE`. One case is new.

| Finding | Change | Regression coverage |
| --- | --- | --- |
| F14 | [database.js](../database.js): score discovery in `prepareScoreBundle` no longer uses `existsSync`. A new `pathPresent` helper `stat`s the path and treats **only `ENOENT`** as absent; any other error (`EACCES`, `EIO`, …) propagates, so the build fails and the boot loader's existing catch keeps the snapshot and baked files. The boot deletion branch no longer checks only that the data directory exists. It calls `confirmScoreFolderRemoved`, which requires all of: the score data directory **lists cleanly** (`readdir`, so a permission or I/O error throws); it holds **at least one score folder** (an unmounted volume's leftover mount point is empty); the folder is **absent from that listing**, compared case-insensitively; and a direct lookup also answers `ENOENT`. If any check fails, it throws, and the session is skipped for this boot with its files kept. A live rebuild or new session that hits a lookup error now fails as a build error too, rather than reading as a missing score. | [state-file.test.js](../test/state-file.test.js) "boot keeps sessions whose score storage cannot be read" boots one saved session (snapshot plus legacy and revisioned baked files) against an existing score folder under five conditions and checks the files after each. (1) Every lookup and listing under the existing data directory fails with `EACCES`. (2) The directory lists, but the score folder's lookup fails with `EACCES`. (3) The lookup falsely reports `ENOENT` while the listing still shows the folder. (4) The data directory is an empty mount point. (5) Control: the folder is genuinely removed. Cases 1–4 keep all three files; case 5 deletes them. The existing "gone session / missing data directory" case still passes. |

Mutation check: restoring the `existsSync` classification and the data-directory-exists-only guard fails the new case, and the other 10 state-file cases still pass. Faults are injected by patching `fs.promises` (`stat`/`readdir`), because Windows cannot remove traversal permission with `chmod`. The case does not repeat the reviewer's Linux permission probe.

Still open: F2, the local WebSocket endpoint override, is unchanged. There was no browser pass for this round.

## Earlier review — after the F9–F12 fixes

Date: 2026-09-19, second review round. Historical review, superseded by the third review round above.

**Result: F9–F12's reported cases are addressed; one S6 publication edge case remains (F13).** Revision-based publication preserves the old bundle during staging and on a late write failure. Graph startup now bounds body consumption and offers recovery after exhausted 404s. The quote tokenizer no longer reports attribute-looking text inside double-quoted values. F2 remains the owner's local endpoint override to exclude from deployment.

### Current follow-up status

| Finding | Latest assessment |
| --- | --- |
| F9 — partial bundle publication | Addressed for the reported staging/publication failure: new files use revision-specific names, and the live fields/reference switch synchronously after all writes succeed. Cleanup is best effort after the switch. Focused execution confirmed old content during a gated write and unchanged publication/files after a late failure. The unavailable-score branch is a separate remaining gap, F13. |
| F10 — graph body timeout | Addressed. A deadline races the complete fetch/body attempt and aborts it; focused execution confirmed a stalled body times out, the next attempt succeeds, and no deadline remains. |
| F11 — exhausted graph 404s | Addressed. Exhaustion throws the recoverable error instead of returning null; startup sends it to the Retry UI. Focused execution confirmed the thrown error. The added client case exercises Retry → draw → socket startup. |
| F12 — quote validator false positive | Addressed for the reported root/link cases. Production parser → graph → validator execution accepts attribute-shaped text inside double quotes and still rejects adjacent actual single-quoted runtime attributes. |
| F13 — unavailable rebuild publication | Open, P2; see below. Implementation reported in "Implementation report — F13" (not yet re-reviewed). |
| F2 — configured endpoint | Unchanged local override. Restore the configured endpoint before shipping. |

### F13. [P2] Preserve the published bundle when a rebuild finds no score — S6

[prepareScoreBundle](../database.js#L578) returns an `unavailable` bundle when the score directory is missing or its frame listing is empty. [The publication branch](../database.js#L790) then changes `folder` and calls `markScoreUnavailable`, which clears the live frame lists/graph and changes the hash, **without changing `bundleRevision` or its files**. It resolves successfully. Consequently, `rebuildScore` detects a content change and resets the room; the session-manager path saves it and announces a reload, while the page/content routes still serve the previous score's HTML/SVG. A missing folder selected during a folder-swap race follows the same branch.

**Trigger/impact:** temporarily remove or empty the active score's Frames directory during an edit, then update the session. Performers reload the old visible score against an empty authoritative frame list, and the current performance has been reset. This is a remaining branch of S6, not evidence that the new revision switch fails for a successfully prepared bundle.

**Evidence:** executed the production publication methods and `markScoreUnavailable` in an isolated class with a controlled filesystem adapter. After a valid publication, publishing `{ folder: "Score", unavailable: "empty" }` resolved normally, kept the same revision and old served HTML/SVG, but produced `listFiles: []`, an empty graph, and hash input `Score:empty`. Source inspection traces the successful return through `rebuildScore` to room reset/reload. The missing-directory branch supplies the same unavailable path. This is a focused method reproduction, not a browser or full session-manager run.

**Correction/regression:** for an existing usable session, treat a missing/empty replacement as a failed rebuild and preserve its folder, live fields, bundle reference and room state. If an unavailable state is intentionally supported for initial load or boot, handle that explicitly without exposing an old page as a valid new score. Add missing-directory and empty-frame-list cases after a successful build, asserting that page/content/graph remain consistent, history/device bindings remain unchanged, and no reload notification is emitted. Cover a failed folder swap as well as an in-place update.

### Verification and remaining scope

Inspected the updated publication helpers, page/content readers, cleanup/deletion and boot-loader handling, startup fetch/retry code, quote tokenizer and new regression cases. Focused production-code probes independently confirmed the F9–F12 corrections above and reproduced F13. Only this review document was changed.

Full tests remain blocked in this environment: `npm test` again failed before test execution with the unsupported-WSL/Node-directory error, and `node.exe --version` failed with a WSL socket error. The implementation report's **389 passed, 0 failed**, four full runs and mutation results remain reported results, not independently reproduced here. No browser run was performed. The report also correctly leaves the boot-registration/readiness race unresolved; moving the build log does not establish readiness, but this review did not newly reproduce that race.

Close F13, retain the F2 deployment boundary, then rerun the bundle/session-manager regressions and browser startup/rebuild checks. The earlier incremental S2/S5 work and verification limitations remain as documented; no other new defect was established in this focused round.

### Implementation report — F13

Reported after the latest review. `npm test` (run as `node test/run.js` on Windows Node 22): **393 passed, 0 failed**, up from 389, ending in `TEST RUN COMPLETE`. Four cases are new.

| Finding | Change | Regression coverage |
| --- | --- | --- |
| F13 | [database.js](../database.js) `#publishBundle`: once a score is live (`bundleRevision` set), a missing or empty replacement throws `ScoreUnavailableError` (`code: "SCORE_UNAVAILABLE"`). Nothing is assigned: folder, frame lists, graph, hash, revision and room all stay as they were. `rebuildScore` and `reloadScore` propagate it, and the session-manager catch logs "previous score kept" without resetting connections or sending `MSG_CHANGE_FOLDER`. The unavailable state is kept only when nothing has been published yet (a new session, or a boot), and it is now explicit: a non-persisted `scoreUnavailable` (`"missing"`/`"empty"`) is set there and cleared by the next successful publish. While it is set, the page and content routes in [routes/session.js](../routes/session.js) answer **503 "Score unavailable"**, so they never serve older unrevisioned baked files as the session's score. | Through the real `routes/sm.js` handler, on a real filesystem: after a successful build with the playhead moved and a device bound, an in-place update over an **emptied Frames folder** or a **missing score folder** rejects the direct rebuild, and the update sends no reload notice, resets no connections and logs the failure. It also leaves folder, revision, frame lists, graph, hash, served page/content, line history/positions and device bindings unchanged. Restoring the folder then updates with no reload and the room intact. A **folder swap** to a listed folder that has vanished, or to one with an empty `Frames/`, keeps the old folder, revision, served page and room. A session that finds no score **before any publish** has stale unrevisioned files on disk, and both routes answer 503; a later successful publish clears the flag and serves the new revision. |

Mutation check: letting the unavailable branch publish again for a live score (the old behavior) fails the three live-score cases. Removing the route guard fails the before-publish case.

Boot policy (owner decision): a stored session whose score folder no longer exists is **deleted** at boot: its state file and every baked file are removed, so dead sessions do not pile up. This happens only when the score data directory itself exists. An unmounted or misconfigured data directory deletes nothing: each snapshot is skipped for that boot and kept, like a build error. A score folder that exists but has no frames still loads in the unavailable state (routes answer 503). Coverage: [state-file.test.js](../test/state-file.test.js) boots a good session and a gone one. With the data directory missing, both files are kept. With it present, the gone session's state and baked files (legacy and revisioned) are removed, and the good session loads. Suite: **394 passed, 0 failed**.

Still open: F2, the local WebSocket endpoint override, is unchanged. There was no browser pass for this round.

## Earlier review — must-fix and should-fix implementation

Date: 2026-09-19, first review round. Historical review, superseded by the follow-up above.

**Result: changes still required.** The reported F7/F8 corrections are present, and the must-fix changes have substantial production-handler/client regression coverage. The Should implementation improves validation, map delivery, accessibility, rebuild preparation and test isolation. Four remaining defects are detailed below: incomplete bundle publication (F9), two startup recovery gaps (F10/F11), and a validator false positive (F12). F2 remains a separate deployment boundary for the owner's intentional local endpoint override.

### Current requirement status

“Addressed in source” means the implementation and relevant regression cases were inspected; it does not claim a fresh passing Node or browser run.

| Requirement | Current assessment |
| --- | --- |
| M1 / F3 — authorized, context-bound TAP | Addressed in source: bound performer and per-message credentials, target/context checks before voting/position changes, authored timing and line-index bounds. Handler cases cover unauthorized and stale-context taps. |
| M2–M4 / F1/F4/F7 — display synchronization | Addressed for the reported defects in source: server-wide revisions, assignment floor, revisioned pause, complete snapshots, pending-delivery cancellation, and generation invalidation on changed assignment/socket epoch. Client cases preserve the merge survivor and exercise retired fetch completions followed by authoritative rendering. |
| M5 — room isolation | Merge membership/rebinding filters by session; cross-room regressions are present. No new defect established in this pass. |
| M6 — independent voting windows | Split resolution captures and clears only the splitting line's connections; timer-driven handler coverage is present. |
| M7 / F5 — sub-merge undo | Active-score predecessor handling and full merge dive identity are present. Handler and real-WebSocket split → sub merge → undo → restart cases are present. |
| T1/T2 / F6/F8 — production execution and clocks | Handler harness executes production entry points; imported hold/population rules replace stale copies. Runtime and imported policies now share the virtual clock, with disposal and deadline-boundary cases. |
| S1 — strict authoring validation | Malformed split handling is implemented. Single-quote detection still rejects valid attribute text: F12. |
| S2 / T6 — map performance | Adjacency caching, queue cursor, grouped connections, coalesced pushes, per-tab trail reuse and animation-frame rendering are present. A real-path benchmark replaces the misleading broadcast timing assertion. Browser rendering/event-loop performance measurements remain incomplete. |
| S3 — reliable map startup | Pinned local libraries, script timeout and Retry UI are present. Graph body timeout and exhausted-404 recovery remain incomplete: F10/F11. |
| S4 — accessible dialogs | Inert background, focus containment/restoration, safe destructive-action focus, dialog labels and live announcements are present. The earlier browser pass remains reported evidence, not independently repeated here. |
| S5 — incremental extraction/integration | Snapshot builder extracted; real-WebSocket restart scenario added. Scheduling, rewind and protocol extraction remain incremental follow-up work; this is not full browser coverage of M1–M7. |
| S6 — complete replacement publication | Preparation and staging failures preserve the old score, and the content route handles stream errors. Publication itself still permits a mixed revision and partial failure: F9. |
| S7 — in-place sound discovery | Shared bundle discovery and subtree listing-cache eviction are present, with add/remove tests. Same-path byte replacement intentionally does not invalidate clients; this policy is documented. |
| T3 — behavioral assertions | Actual map payload/receipt, handler, lane, hold-gate and route tests replace many source checks. Some narrow source/CSS checks remain; browser behavior is not fully automated. |
| T4 — test isolation | Per-run temporary state and temporary build fixtures are present. The runner's real-directory guard compares top-level names only; it is not proof that existing file contents or nested files stayed unchanged. |
| T5 — persistence races/restart | Gated write/rename ordering, injected failures, deletion and boot-loader cases are present. These state-file tests do not cover bundle publication failure (F9). |
| T7 — bounded/completed test runs | Live per-case deadlines, completion/early-exit markers and mock restoration are present. Duplicate-name detection is a formatting-dependent regex, not general JavaScript duplicate-key detection. |
| F2 — endpoint override | Still present at [database.js:174](../database.js#L174). Keep the literal LAN address out of the shipped change and restore `WS_PATH`/configured fallback before deployment. |

### F9. [P2] Publish the bundle with one revision switch — S6

[publishFilesTogether](../database.js#L83) awaits each rename separately, followed by removals. The live graph, frame lists and hash switch only after this helper succeeds. After the first rename, HTTP can therefore serve new content with the old page/graph. If a later rename or removal fails, already-published files remain changed, the live fields remain old, and staged files are not cleaned up. The session-manager catch does not roll this back; a reload notice cannot repair a rebuild that failed before notification.

**Evidence:** executed the extracted production helper with an in-memory filesystem adapter. Staging both files succeeded; injecting an error on the `.html` rename left new `.content.svg`, old `.html`, and an orphan `.html.*.tmp`. Inspecting immediately after the first rename also showed the mixed revision before any failure. This is a focused helper reproduction, not a real-filesystem/HTTP integration run.

**Correction/regression:** publish immutable revision artifacts and switch one authoritative bundle reference only after all preparation succeeds. Have the page/content/graph readers use that revision consistently. Add a gated publication test with HTTP reads between swaps and failures at later rename/removal steps; assert the previous bundle stays usable, no client reload is announced on failure, and temporary artifacts are cleaned. The existing paused-read and staging-write tests do not exercise this phase.

### F10. [P2] Keep the graph timeout active through response-body consumption — S3

[fetchWithTimeout](../public/javascripts/session-map.js#L151) clears its abort timer when `fetch()` returns response headers. [fetchGraph](../public/javascripts/session-map.js#L188) then calls `res.json()` outside that timeout and retry catch. A response whose headers arrive but whose body stalls can keep startup on “loading…” indefinitely, without opening the socket or offering Retry. A body-read rejection also bypasses the automatic attempt loop.

**Evidence:** executed these extracted production functions with a successful response whose `json()` never resolves. Startup remained pending with **zero active timeout callbacks** after the headers resolved.

**Correction/regression:** bound fetching and consuming/parsing the graph as one attempt, keeping cancellation active until the body settles. Test stalled and rejected bodies after successful headers, then successful recovery through retry.

### F11. [P2] Offer recovery when graph-building 404 retries are exhausted — S3

[fetchGraph](../public/javascripts/session-map.js#L194) returns null after repeated 404s. [start](../public/javascripts/session-map.js#L4174) treats that as “this score has no session-lines graph” and returns without Retry or a socket. The graph route uses 404 for a score still building, and vanilla scores also have graphs. A slow boot can therefore strand the operator tab even after the server finishes building.

**Evidence:** the extracted production fetch loop returned null after three injected 404 responses; source inspection confirms that null bypasses `showStartupError` and `connectWebSocket`.

**Correction/regression:** route exhausted 404 attempts to the recoverable startup error, explaining that the score may still be building or unavailable. Test 404 exhaustion → visible Retry → later valid graph → map and socket startup without reloading the tab.

### F12. [P2] Scan actual attributes when detecting unsupported single quotes — S1

[singleQuotedNames](../lib/session-lines/parse.js#L49) scans the entire tag with a single-quote regex, including the contents of double-quoted attribute values. Valid markup such as `<svg data-note="write session-split='2' here">` is consequently rejected as an unsupported single-quoted `session-split`, although no such attribute exists.

**Evidence:** ran the production parser → graph builder → validator on a two-frame score containing that double-quoted note. It produced `attr-single-quoted` on `START.svg`. The existing test for an apostrophe inside a double-quoted value does not cover text shaped like a runtime attribute.

**Correction/regression:** tokenize attributes while respecting both quote delimiters, then inspect the delimiter of actual runtime-read attributes. Cover root/link attribute-looking text inside double-quoted values, alongside real unsupported single-quoted attributes.

### Verification and next steps

Reviewed staged and unstaged implementation changes against HEAD plus new helpers/tests. Focused execution in the tools' isolated JavaScript runtime reproduced F9–F12 using production modules or extracted functions with controlled adapters. No application code or tests were changed during this review.

`npm test` was attempted and failed before running tests: the launcher reports “WSL 1 is not supported” and cannot determine the Node.js installation directory. Direct `node.exe --version` also failed with a WSL socket error. The earlier **382 passed, 0 failed**, mutation checks, benchmark timings and browser pass below remain implementation-reported results; none was independently rerun here.

Close F9–F12 and preserve F2's deployment boundary, then rerun the suite and browser startup/rebuild checks. F7/F8 no longer belong on the current open-defect list; full independent runtime verification and the explicitly incremental S2/S5 work remain outstanding.

### Implementation report — F9–F12

Reported after the latest review. `npm test` (run as `node test/run.js` on Windows Node 22): **389 passed, 0 failed**, up from 382, ending in `TEST RUN COMPLETE`. It was green on four consecutive full runs. Seven cases are new.

| Finding | Change | Regression coverage |
| --- | --- | --- |
| F9 | [database.js](../database.js) no longer overwrites published files. Each build writes a new **revision** under its own names (`${id}.rev-<revision>.html`, `.content.svg`, `.subs.json`, `.about.svg`) with exclusive-create writes. `bundleRevision` is the one authoritative reference, and it switches in the same synchronous step as the live frame lists, graph and hash, only after every file is on disk. The page and content routes resolve their file through `session.bundleFile(kind)`. A failed write removes the files that revision had written, switches nothing and throws, so the session manager sends no reload notice. After a switch, older revisions are swept, but the one just replaced is kept for a request that resolved its path a moment earlier. The sweep is best effort: it never fails a publish that has already switched, and the next publish retries it. It also removes the unrevisioned files older builds wrote. Publishes are serialized per session, and `deleteStateFile` waits for them before removing every revision. | Real routes, real filesystem: the page write is held after the new content file lands, and both the page route and the content route still serve the previous revision, then the new one after release. A failure at the **last** write (about.svg, after content and page) keeps both routes on the previous revision and leaves no file behind. Sweep: current + previous kept, legacy name removed. An injected `EBUSY` on removal does not fail the publish, the next publish sweeps what it left, and deletion removes every revision. |
| F10 | [session-map.js](../public/javascripts/session-map.js) `fetchJsonWithTimeout` makes fetching and parsing the body **one attempt under one deadline**. The deadline aborts the request and also races the body read, because an abort is not guaranteed to reject a body read that is already under way. A body that fails to parse is retried like any other failed attempt. | Sandbox, manual clock: headers arrive but the body never does. The deadline stays armed, fires and aborts, and the retry returns the graph with no timer left behind. A body that fails to parse is retried and recovers. |
| F11 | Running out of attempts on 404s now throws the recoverable startup error ("the score may still be building, or this session no longer exists"), which shows Retry. The null return and the "no session-lines graph" dead end are gone, since every score, vanilla included, has a graph. A 2xx body without `main` counts as unreadable and is retried too. | 15 × 404 → Retry visible, error state set, no draw, no socket. The server then finishes building, and Retry in the same tab draws the map and opens the socket exactly once. |
| F12 | [parse.js](../lib/session-lines/parse.js) scans a tag with one tokenizer that accepts either delimiter. Each match consumes its whole quoted value, so attribute-shaped text inside a double-quoted value is never scanned. Only a real single-quoted attribute is reported. | The reported `data-note="write session-split='2' here"` and an `<a title="use xlink:href='C.svg' later">` both pass through the parser, graph builder and validator without `attr-single-quoted`. Real single-quoted `session-split`/`xlink:href` next to such notes are still reported. |

Mutation check: each defect was reintroduced on its own, and each made at least one new case fail. The reintroduced defects were: the old whole-tag single-quote regex (F12); returning null on 404 exhaustion (F11); the header-only timeout (F10); switching `bundleRevision` before the writes (F9, three cases fail); and a sweep failure that propagates (F9).

Other changes and findings:

- The end-to-end test treats the `Finish building svg content… with ID` log line as "room restored". Publication now logs it last, after the sweep. When it was logged before the sweep, the wider gap let devices connect before the boot loader had registered the room, and the e2e case failed on 3 of 4 full runs. With the log last, it passed 4 of 4. The underlying readiness race predates this change: the room is added to the session table only after the build returns. It is the same family as the known restart-reconnect wedge and was not changed.
- Test and tooling paths moved to `session.bundleFile(...)`: baseline, split-runtime, sub-session, state-file, `www-harness.removeBuildOutputs` (which now removes every revision), and `bin/build-score.js` output. The baseline re-capture instructions changed accordingly.

Still open:

- F2: the literal LAN WebSocket endpoint in [database.js](../database.js) is unchanged and remains the owner's local override. Restore the `WS_PATH`/configured fallback before anything is committed or deployed.
- There was no browser pass for this round. Startup and rebuild are covered by the sandboxed client tests and by real route handlers on a real filesystem, not by a headless-browser run.
- apicache still caches the page route for 30 minutes and is cleared after an update. A cached page from the previous revision is the existing reload-notice case and did not change.

## Earlier review — after the F1–F6 implementation update

Date: 2026-09-18. Historical review, superseded by the 2026-09-19 review above. Earlier findings and the implementation report are preserved below as history.

**Result: two correctness/verification gaps remain, plus the local endpoint override to exclude from deployment.** The original per-line revision mismatch (F1), ambiguous main/sub TAP (F3), missing pause revision (F4), and convergence return-context mismatch (F5) are addressed in the updated code. The new production-handler tests substantially address F6's missing coverage, but their clock is inconsistent (F8). An unfinished sub fetch can still render after reassignment or reconnect (F7).

### Current follow-up status

| Finding | Latest assessment |
| --- | --- |
| F1 — revisions across reassignment | Original mismatch addressed by the server-wide sequence and assignment revision floor. In-flight rendering is a separate remaining issue, F7. |
| F2 — configured WebSocket endpoint | Still present in the local tree. The implementation report identifies it as an intentional local override excluded from commits; retain that boundary and restore configuration for deployment. |
| F3 — TAP score context | Addressed for the reported main/sub collision. A focused production-validator probe now rejects the stale main-context tap. |
| F4 — pause supersedes queued SHOW | Server stamping and client revision checks are present. Handler/client regression cases were added; the handler clock needs F8's correction. |
| F5 — convergence dive context | Addressed for the reported return-context collision. The updated production-module probe returns only `m2`, rather than grouping `m2` with `m1` from a different return context. |
| F6 — real server handler coverage | Substantially addressed by `www-handlers.test.js`, including TAP, timer-driven split, snapshot and complete sub-merge undo cases. Timing fidelity remains open under F8. |
| F7 — unfinished rendering after reassignment/reconnect | Open, P2. |
| F8 — inconsistent test clocks | Open, P2. |

### F7. [P2] Invalidate unfinished sub rendering when assignment or socket epoch changes — M2/M4

[resetDisplayEpoch](../public/javascripts/session.js#L366) resets `appliedDisplayRev`, and [assignLine](../public/javascripts/session.js#L377) raises the accepted revision floor when the line changes. Neither invalidates `displayGeneration`. The [pending fetch completion](../public/javascripts/session.js#L449) checks only that generation, not whether its assignment or socket epoch is still current.

**Trigger/impact:** SUB_ENTER starts a slow load on L0; the device is assigned to L1 before the load completes, and L1's next display message has not yet been applied. The old completion still presents L0's passage. Similarly, a completion from the old connection can render after `resetDisplayEpoch` while the new connection is synchronizing. This occurs before a subsequent render transition advances the generation; it does not establish that an old fetch can overwrite a newer snapshot already applied.

**Evidence:** a focused execution of the production client using an adapted version of its DOM/fetch harness delivered assignment L0 → SUB_ENTER Tetra → assignment L1 → fetch completion. The page reported line L1 but rendered Tetra at index 0. A separate SUB_ENTER → epoch reset → fetch completion probe also rendered the old passage.

**Correction/regression:** invalidate pending rendering on an actual assignment change and on a socket epoch change. Cached asset loading can finish, but obsolete callbacks must not present a frame. Test completion after reassignment before the new line's scheduled display, and after reconnect before its snapshot; then assert that the new authoritative display renders normally. Preserve the merge-survivor case where the assignment does not change.

### F8. [P2] Use one controlled clock throughout the handler harness — T1

[www-harness.js](../test/www-harness.js#L115) injects virtual timer functions into the compiled runtime but does not inject `Date`. Its scheduler starts at zero and advances independently, while production `Date.now()` still returns wall-clock epoch time. Imported line timing policies also use the real clock by default.

**Trigger/impact:** advancing the virtual scheduler fires callbacks without advancing the clock used for display and hold deadlines. In the pause regression, `queued.t > h.now()` can pass merely because `queued.t` uses epoch time while `h.now()` starts at zero; it does not establish that a delivery is pending on a shared timeline. Elapsed-time behavior is therefore not tested faithfully, even when a test passes.

**Correction/regression:** use one controlled clock for the runtime, imported timing policies, timer scheduler and client delivery assertions. Verify deadlines immediately before and at expiry, and assert that advancing the scheduler advances the time production policies observe. Preserve the production-handler entry points introduced for F6. This finding is based on source inspection; no completed Node execution of the new harness is claimed in this review.

### Endpoint boundary, verification and next steps

F2 remains at [database.js:136](../database.js#L136): `ws://192.168.0.2:2382` bypasses deployment configuration. The implementation report below identifies this as an intentional local override. Keep it out of the shipped change; restore the configured endpoint before deployment. The latest review did not test a deployed browser connection.

Focused execution confirmed the F3/F5 corrections and reproduced F7 using production client code with an adapted test harness in an isolated V8 runtime. `npm test` was attempted again but could not start: the installed launcher reports unsupported WSL and cannot determine the Node.js installation directory. The implementation report's **331 passed, 0 failed** and mutation-check results are retained as reported results, not independently reproduced by this review.

Fix F7 and F8, rerun the handler/client regressions with a consistent clock, and preserve the F2 deployment boundary. Full browser/WebSocket verification remains outstanding. Only this document was changed while recording the latest review.

### Implementation report — F7, F8

Reported after the latest review. `npm test` (run as `node test/run.js` on Windows Node 22): **337 passed, 0 failed**, up from 331. Six cases are new.

| Finding | Change | Regression coverage |
| --- | --- | --- |
| F7 | In [session.js](../public/javascripts/session.js), `assignLine` now advances `displayGeneration` when the line **changes**, and so does `resetDisplayEpoch`. An unfinished sub load then fails its generation check and presents nothing. The fetched assets still go into `__subCache`. A merge survivor (told the line it already has) does not advance the generation, so its dive still presents. | Client: L0 dive → assigned L1 → fetch lands: nothing rendered and the context stays main. L1's frame then renders, and a later dive uses the cache without a second fetch. Dive → epoch reset → fetch lands: nothing rendered, and the snapshot then renders from the cache with its context. A merge survivor's dive still presents. |
| F8 | [www-harness.js](../test/www-harness.js) now runs one virtual clock, starting at a fixed epoch instead of zero. It is passed to `bin/www` as `Date` and the timer functions. While a harness is active, it is also installed on the global object, so imported modules read the same clock. Those modules are `landingHoldElapsed`/`holdPendingAtFrame`, the orchestrator timestamps and the `clearTimeout`/`clearInterval` calls in `BMLine.clearAllTimer` and `BMSession`. Before this change, a timer started on the virtual scheduler and cleared with the real `clearTimeout` was never cancelled. `dispose()` puts the real clock and timers back, and `withRoom` always calls it. | Handler: `Date.now()`, `new Date()` and the imported default-clock hold rule all follow `advance()`. A real 19 s barrier hold is still holding and parked 1 ms before its deadline, then ends and releases exactly at it. The pause test now checks that the queued frame's `t` falls within the preload window on the harness timeline. |
| — (found while fixing F8) | `tryReleaseBarriers` called `parkedLines.some(holdPendingAtFrame)`, which passed the array index as the rule's injectable clock. A line flagged holding with no timer behind it and a recorded deadline threw `now is not a function`, so the barrier never released. That state occurs after a mid-hold restore, or after `clearAllTimer` leaves `isHolding` set. Fixed in [bin/www](../bin/www) by passing the line alone. | Handler: a restored mid-hold line parked on a barrier stays parked before and 1 ms before its deadline, and releases at it. |

Mutation check: each change was reintroduced on its own, and each made at least one new test fail. The changes were: no generation bump on a line change; no bump on an epoch reset; a bump on **every** assignment (breaks the merge survivor); the `.some(holdPendingAtFrame)` call; and no global clock install. Starting the clock at zero instead of the epoch does not fail a test, because the clock stays consistent either way. The epoch start is there for realism, not correctness.

Still open:

- F2: the literal LAN WebSocket endpoint in [database.js](../database.js#L136) is unchanged and remains the owner's local override. Restore the `WS_PATH` fallback before anything is committed or deployed.
- After a retired load, the page keeps showing its loading indicator until the new line's frame or the snapshot arrives. It renders no stale content.
- `BMSession.recordRewind` and migration expiry stamps in `line.js` use `Date.now()` as log timestamps. Under the harness they now read the virtual clock too. They have no timing semantics.
- Browser/WebSocket end-to-end runs are still outstanding. The handler tests stub the transport.

## Implementation report — Should findings (S1–S7, T3–T7)

`npm test`: **382 passed, 0 failed** (up from 337). The run ends with `TEST RUN COMPLETE`. Each new regression was mutation-checked: reintroducing the defect alone fails at least one case. A headless-browser pass on an isolated server (run-session sandbox) covered the map items S2–S4.

| Finding | Change | Regression coverage |
| --- | --- | --- |
| S1 | [parse.js](../lib/session-lines/parse.js) accepts only a whole-number `session-split` and keeps the declaration as written (`splitRaw`). A malformed count never enters `graph.splits`, so the runtime never splits on it. The validator reports it as `split-malformed`. Runtime-read attributes written with single quotes (root `session-*`, `voting`, `holding`; `<a>` `href`, `xlink:href`, `session-sub-start`) are reported as `attr-single-quoted`, in main and sub scores alike. The build's link rewrite reads double quotes only. No score in `public/data` trips either new error. | `2.5`, `2x`, `oops`, empty, space, `-2`, `1e1`; a padded `" 2 "` still validates; single quotes on main and sub frames; a quote inside a double-quoted value is not flagged. |
| S6 | `buildSVGContent` is now prepare → publish. `prepareScoreBundle` reads and renders everything off to the side. `publishScoreBundle` stages every file to a temp file, renames them only once all are written (`publishFilesTogether`), then swaps the live fields in one synchronous step. A failed read or write leaves the previous score complete. `reloadScore` keeps the old folder when the new one fails to build. The content route answers stream errors (404/500) instead of crashing. A failed update in [routes/sm.js](../routes/sm.js) is logged, not left as an unhandled rejection. | Rebuild paused mid-read still serves the old score, then switches whole; injected frame-read failure; injected staging-write failure (no temp files left); failed folder swap; content route on a missing file. |
| S7 | Sound discovery moved into the bundle, so it runs for the initial build, folder swap, in-place rebuild and boot alike. **Found along the way:** directory listings are memoized per process, so an in-place rebuild never saw frames *or* sounds added or removed on disk. A build now refreshes its own folder's listings (`clearDirCacheUnder`). A sound is identified by its path: replacing the bytes behind an existing path is not detected. This was chosen because a hash change resets the room; rename the file to force a reload. | Add, remove, and remove-folder all report a change and update the page's inventory; an untouched rebuild leaves the room alone; subtree cache eviction. |
| S3 | Cytoscape 3.34.3, dagre 0.8.5 and cytoscape-dagre 2.5.0 are served from [public/javascripts/vendor](../public/javascripts/vendor/README.md) (pinned, licences included). Script loads time out at 15 s. Each graph fetch times out at 10 s, and network errors are retried like a 404. A failure shows the reason and a **retry** button that re-runs startup without reloading the tab. | Browser: libraries load from `/javascripts/vendor` and nothing from a CDN. With `cytoscape.min.js` blocked, the page shows the error, focuses retry and announces it. Unblocked, retry draws the map. |
| S4 | The dialog makes every other body child `inert` while it is open. Tab/Shift+Tab wrap inside it. A destructive confirm opens on **Cancel**. Closing restores focus, falling back to the canvas when the menu that opened it has gone. Refusals use `role="alertdialog"`. The body is `aria-describedby`, and the stale-room note is `role="alert"`. Results and startup errors are read once through a visually-hidden `role="status"` region. | Browser: split-undo confirm opens with Cancel focused and 10/10 page regions inert; Tab cycles Cancel↔Confirm; Escape closes, removes inert, restores focus, and the room is unchanged. |
| S2 | Measured first (`node test/bench/map-payload.bench.js`). Changes: `canReachFrames` uses a per-score adjacency index and a queue cursor. The snapshot groups connections by line once instead of per line. Pushes within one event-loop turn coalesce into one, sent after the turn. A map tab is sent a line's trails only when they changed since its last push (`trailKept`; the page reuses its copy, and both sides key by line `uid`). The map repaints at most once per animation frame. | Handler: coalescing, trail elision with full trails for a new tab, no detail bodies on count pushes, details only on request. Client: kept trails reused, forgotten lines not resurrected. |
| S5 | Incremental, as recommended. The admin snapshot builder moved out of `bin/www` into [admin-snapshot.js](../lib/session-lines/admin-snapshot.js) (pure; room answers injected). All map rewinds leave through one `commitRewind`. Real-transport coverage: [e2e-websocket.test.js](../test/e2e-websocket.test.js) spawns `node bin/www` on free ports with temporary state (`SERVER_STATE_DIR`) and fixture scores (`SCORE_DATA_DIR`). It then runs split → sub merge → map undo → **server restart** over real sockets, checking the room invariants. [room-invariants.test.js](../test/room-invariants.test.js) covers dormancy and revival. | The e2e test fails if the device registry is not persisted; devices reconnect in reverse order so line balancing cannot mask that. |
| T3 | Source-proximity checks replaced by execution. The map client runs in a sandbox and its actual payloads and receipt handling are asserted. Server receipts, log entry and save are checked through the real handler. Taps and the voting, standby, holding and attrition timers are shown to wait for a held mutation. The session-manager rebuild is shown to run on the lane. Hold gating is checked on real landings. The `/map` authorization is exercised as real requests. Retained narrow checks: one `sendToServer(MSG_SELECT_HISTORY…)` in the map, the single `holdDuration` read, and the sub-end rule statement. | Each lane entry (message, voting, holding, attrition) and the hold gate mutated alone fails a case. |
| T4 | The runner gives every run its own `SERVER_STATE_DIR` and removes it afterwards. `build-graph` builds from a temporary data directory. The run fails if anything new appears in, or disappears from, the real `server_state` or `public/data`. | Suite runs leave both directories unchanged. |
| T5 | Deterministic tests with gated/injected `fs.promises`. They cover exact write→rename ordering, write failure, rename failure, and delete-wins mid-write. Boot restores valid sessions around a corrupt file (quarantined), a score that fails to build (skipped, file kept — new loader behaviour, previously fatal to boot), an orphan `.subs.json` and a crashed save's temp file. | Removing the save queue, or the loader's per-session catch, fails a case. |
| T6 | The summaries test is renamed and has no wall-clock budget. The real path is benchmarked (below) and bounded by size-only handler cases. | — |
| T7 | Per-case deadline (live timer, `TEST_TIMEOUT_MS`, default 30 s). Completion marker, plus `TEST RUN INCOMPLETE` and a non-zero exit when the process ends early. Global/`fs` replacements left behind fail the case and are restored. Duplicate case names fail the run. | The runner's own tests spawn it against deliberately broken files. |

Benchmark, 40 devices, one 300-frame trail, cycles of split + merge (before → after the S2 changes):

| Events (split + merge) | Cold push | Warm push | Unchanged map push | of which trails | Pushes per lap | Detail reply (once per topology) |
| --- | --- | --- | --- | --- | --- | --- |
| 11 + 11 | 0.8 → 0.6 ms | 0.2 ms | 8.7 → 3.3 KB | 5.4 KB → 13 B | 7 → 5 | 25 KB |
| 51 + 51 | 9.3 → 9.2 ms | 0.7 ms | 19.2 → 13.8 KB | 5.4 KB → 13 B | 7 → 5 | 412 KB |

Still open:

- The structural summaries ride every map push (≈260 B per event), and the detail reply grows quadratically. Both are kept, per "preserve complete undo evidence"; revisit only if a real performance approaches these sizes.
- S5 beyond this increment: `bin/www` is still ≈7,200 lines. Transition scheduling, rewind execution and protocol validation are the next extraction candidates.
- T3's browser-computed menu bounds: checked by hand in the browser pass; the suite keeps the CSS-rule check.
- F2 (literal LAN `wsPath`) is untouched, as before.

## Earlier follow-up review of the must-fix implementation

Date: 2026-09-18. This section supersedes the original must-fix status and priority below. The original review is retained as the implementation rationale and historical evidence; its reproductions describe the earlier working tree, not failures re-established against the latest changes.

**Result: changes still required.** The implementation addresses substantial parts of M1–M7 and T2, but the display revision protocol breaks across line reassignment, TAP validation still lacks score context, and convergence grouping still conflates different dive return contexts. A hardcoded WebSocket address is also present in the local changes.

### Current requirement status

| Requirement | Implementation observed in the local changes | Remaining work |
| --- | --- | --- |
| M1 — mutation authorization/validation | Explicit session binding and performer credentials, map exclusion, bound-line lookup, target validation, authored voting duration lookup, and line index bounds checks. | Bind TAP to the actual displayed score/transition; see F3. |
| M2 — asynchronous sub loading | Display generation checks, deduplicated in-flight loads, and a loading/error state with retry. | Full browser/runtime validation remains outstanding; this follow-up does not certify every loading path. |
| M3 — complete display snapshot | Context, frame, pause, hold, voting and waiting state are sent explicitly and applied together. | A snapshot can be rejected after reassignment by the revision defect in F1. |
| M4 — stale scheduled messages | Pending delivery timers are tracked and cancelled on teardown; SHOW/SUB_ENTER/SUB_EXIT carry revisions. | Revisions must remain valid across line changes and include pause transitions; see F1 and F4. |
| M5 — room-scoped merges | `applyRecombine` filters connections to the current room and excludes spectators from new durable membership writes. | Retain cross-room/observer regressions; no full-suite verification claimed. |
| M6 — scoped split vote clearing | `resolveSplit` captures the splitting connections before reassignment and clears only that population. | Exercise the actual handler, not a reconstruction; see F6. |
| M7 — sub merge undo | Sub-aware predecessor resolution, sub-qualified map actions/badges, and a gesture-local settlement exclusion are present. | Compare complete dive contexts when grouping convergence events; see F5. Verify the complete undo gesture. |
| T1 — real runtime coverage | Client display harness tests were added; some component tests were renamed to reflect their scope. | Server command/arrival handler coverage remains incomplete; see F6. |
| T2 — production policy reuse | Hold-clock helpers are exported/imported, and population fixtures/checks were updated. | Changes observed in source; the Node suite could not be run here. |

### F1. [P1] Keep display revisions ordered across line reassignment — M3/M4

[The server](../bin/www#L231) increments `line.displayRev` independently for each line, but [the browser](../public/javascripts/session.js#L348) compares every display message against one `appliedDisplayRev`. `MSG_LINE_ASSIGNED` changes only the line ID; it does not establish a new revision domain.

**Trigger/impact:** a performer receives revision 20 on L0, then a split assigns it to a newly created L1. L1's first display revision is 1, so the browser rejects its valid frame updates and snapshots until its counter catches up. A merge into a line with a lower counter has the same problem. A focused execution of the production revision predicate accepted 20 and then rejected 1.

**Correction/regression:** use revisions that remain ordered across reassignment, or an explicit line identity/epoch protocol that also rejects pending messages from the old assignment. Simply resetting the counter on assignment is insufficient if an old line's delayed SHOW can still fire. Test split, merge and restored-line assignment with unequal counters, including an old pending delivery and a fresh snapshot.

### F2. [P1] Restore the configured WebSocket endpoint

[database.js](../database.js#L136) replaces `process.env.WS_PATH || \`wss://${serverIp}\`` with the literal `ws://192.168.0.2:2382`.

**Trigger/impact:** browsers deployed outside that LAN are directed to an unrelated or unreachable endpoint. HTTPS deployments also face mixed-content blocking of the insecure WebSocket. This is an additional local-change regression, independent of M1–M7.

**Correction/regression:** restore configuration-based endpoint selection and keep any local override in deployment configuration. Verify generated client configuration for both a local server and an HTTPS deployment. This finding is source-based; no deployment/browser connection test was run.

### F3. [P1] Validate the displayed score context on TAP — M1

[validateTapTarget](../lib/session-lines/orchestrator.js#L232) checks a source filename when supplied, but the [TAP payload](../public/javascripts/voting.js#L76) carries no score context or transition revision. A filename and numeric `cid` do not identify a frame across main/sub-score boundaries.

**Trigger/impact:** main and sub scores both have `START.svg` at index 0 and an outgoing destination at index 1. A delayed main-score tap `1#START.svg#0` passes validation after the line enters the sub and can advance the sub without the performer choosing its link. A focused execution of the production validator returned target index 1 for this ambiguous payload against the sub's frame list.

**Correction/regression:** send the context/transition actually displayed to the performer and validate it against the bound line before changing votes, timing or position. Test delayed taps across entry, exit and another dive with overlapping filenames/indexes, as well as legitimate zero-duration navigation.

### F4. [P2] Make pause supersede a scheduled SHOW — M4

[DISPLAY_MESSAGES](../bin/www#L225) includes only SHOW, SUB_ENTER and SUB_EXIT. The server's pause broadcast is unstamped, and [the client pause handler](../public/javascripts/session.js#L217) does not advance the accepted revision.

**Trigger/impact:** an ordinary advance schedules SHOW for the preload deadline. The operator pauses before that deadline; the browser renders the pause placeholder immediately. The queued SHOW subsequently passes the unchanged revision check and replaces the placeholder while the room remains paused.

**Correction/regression:** include pause transitions in the invalidation protocol and check their revisions on the client. Test scheduled SHOW → pause → delivery deadline, plus resume afterward. A focused execution confirmed that the production stamping helper adds `dr` to SHOW but leaves a subsequent PAUSE unstamped; the visible overwrite follows the source control flow and was not reproduced in a browser.

### F5. [P2] Compare complete dive contexts when grouping convergence — M7

[mergeConvergenceEvents](../lib/session-lines/orchestrator.js#L2105) compares survivor identity, frame and sub-score name, but omits the dive stack's return destinations. Unlike `lineNodeKey`, it does not identify the full node context.

**Trigger/impact:** the same survivor visits the same sub-score twice, with matching sub trails but different return destinations, and merges on the same named frame. Sub histories restart on entry, so the trail-prefix check can treat the visits as one convergence. A focused production-module probe grouped events with return destinations `A.svg` and `B.svg` into `[m2, m1]`. The undo projection/gesture can consequently include an earlier, separate passage.

**Correction/regression:** preserve and compare the complete dive context, consistently with co-location checks. Test separate visits with identical sub trails and different return destinations, and genuine sequential arrivals within one dive that should still group together.

### F6. [P2] Drive the actual server handlers in regression tests — T1

[split-vote-scope.test.js](../test/split-vote-scope.test.js#L13) reconstructs the filtering/split/clearing sequence rather than invoking `resolveSplit`. [tap-authorization.test.js](../test/tap-authorization.test.js#L5) exercises predicates rather than the message handler. [sub-merge-undo.test.js](../test/sub-merge-undo.test.js#L13) executes orchestration over real lines but stops before the complete runtime undo/settlement gesture. Renaming component tests makes their scope clearer but does not supply T1's missing coverage.

**Correction/regression:** retain these component checks and add tests through the production command/arrival handlers with controlled transport and time. Assert emitted display/context messages, authorization refusals without mutation, unrelated votes, hold deadlines, device bindings, persistence, and stable separation after final settlement. Reintroducing a session-wide vote reset or removing a handler's authorization call must fail a regression test.

### Follow-up verification and priority

Focused JavaScript execution used the actual pure modules or extracted production functions in an isolated V8 runtime. It confirmed F1's counter rejection, F3's ambiguous target acceptance, F5's convergence grouping, and F4's missing pause stamp. These are targeted probes, not full WebSocket/browser integration tests. `npm test` was attempted but could not start: the installed launcher reports unsupported WSL and cannot determine the Node.js installation directory. No completed suite result is claimed.

Fix F1–F3 first, then F4–F5, with F6's real-handler regressions alongside them. Preserve the implemented room isolation, scoped vote clearing, sub-aware predecessor lookup, display snapshot and asynchronous-load guards. The original Should/Nice-to-have findings below were not comprehensively re-reviewed during this follow-up. Only this review document was changed while recording the findings.

### Implementation report — F1–F6

Reported after the earlier follow-up, before the latest review above. `npm test`: 331 passed, 0 failed (from 315; 16 new cases). These results were not independently reproduced in the latest review environment.

| Finding | Change | Regression coverage |
| --- | --- | --- |
| F1 | [bin/www](../bin/www) numbers display messages from one server-wide sequence instead of `line.displayRev`. `MSG_LINE_ASSIGNED` and `MSG_BEGIN_SPLIT` are revisioned, and [session.js](../public/javascripts/session.js) `assignLine` raises the page's floor to the assignment's revision when the line **changes**, which retires what the previous line had queued. A merge survivor, told the id it already has, keeps its own queued frame. | Handler: a split resolved by the voting timer numbers each device's assignment and later frames above everything its old line sent; the moved device's real output replayed into the real page shows its new line's frame. Client: split, merge-survivor and restored-line cases with a queued old SHOW, plus a fresh snapshot. |
| F2 | **Not changed.** The literal LAN address in [database.js](../database.js#L136) is the owner's local override and is deliberately kept out of commits. Restore the `process.env.WS_PATH` fallback, or supply the address through `WS_PATH`, before anything is committed. | — |
| F3 | Every `MSG_SHOW`/`SUB_ENTER`/`SUB_EXIT`/`PAUSE` (and the snapshot) carries `ctx` = `orch.diveContextKey(subStack)`. The page records it when a frame of that context is on screen (`window.displayContext`), and [voting.js](../public/javascripts/voting.js) sends it with each tap. `validateTapTarget` refuses a tap whose context is not the line's; on session-lines scores, a missing context is refused too. | Handler, new `ctx-collision` fixture (main and sub both open on `START.svg` at index 0): the delayed main tap `1#START.svg#0` is refused inside the sub, although the validator without context accepts it. A missing context is refused. Legitimate zero-duration navigation into the sub end and back out still works. |
| F4 | `MSG_PAUSE` is a revisioned display message on every server path (`sendToLine`, and the per-connection sends in rider re-home and `driveLineDisplays` now use `sendDisplayToClient`). The client pause handler checks the revision and records the line's index as the tap position. | Handler: an advance queues its SHOW for the preload deadline; the operator pauses; the device's real output, replayed in delivery order, keeps the placeholder. Resume shows the frame. |
| F5 | `mergeConvergenceEvents` compares `mergeDiveIdentity`: the survivor snapshot's complete dive stack (sub + return landing at every level) plus the main trail each dive saved. | Component: two visits with different return landings; two visits with the same return landing; arrivals within one dive still group. |
| F6 | New [www-harness.js](../test/www-harness.js) runs the real `bin/www` source in-process: HTTP, WebSocket, Express and the database are stubbed, and the server's own timers run on a virtual clock. [www-handlers.test.js](../test/www-handlers.test.js) drives `messageHandle` directly. The client harness moved to [client-harness.js](../test/client-harness.js) so real server output can be replayed into the real page. | TAP refusals (pre-handshake, rider, map tab, bad per-message credentials, unlinked/out-of-range/NaN/foreign-source targets) leave the line and votes untouched. An unrelated line's votes survive a timer-driven split and still resolve. The reconnect snapshot inside a sub is covered. The complete M7 gesture runs on the new `sub-merge` fixture: split, same-way dives, merge on a sub `JOIN.svg`, then map `MSG_SELECT_HISTORY {mergeEventId}`. Each route returns to its own sub predecessor with its devices and registry seats; no fresh rejoin is created, and the separation holds after later ticks. |

Mutation check: each of these was reintroduced one at a time, and each made at least one new test fail: dropping `canPerform` from MSG_TAP; the session-wide vote reset in `resolveSplit`; dropping the context check; an unrevisioned pause; per-line counters; no client floor on a line change; the old sub-name-only convergence key; a dive key without the saved trail; the old `preMergeLanding` null for dived snapshots; and sub trails resolved against the main list.

Still open from this follow-up:

- F2 (above).
- Browser/WebSocket end-to-end runs of the new protocol fields. The handler tests stub the transport.
- The offline validator was not run on the two new fixtures, because the CLI resolves folders only under `public/data`.
- A delayed tap from an earlier visit to the **same** sub, taken the same way and still on the same frame, has the same dive context and passes. It names the frame the performer is now looking at.

## Original review — before the must-fix implementation

**Second-opinion method:** completed the independent source review and froze its conclusions before opening the existing review. This document combines both viewpoints, preserves the original finding IDs, and adds M5–M7 and S6–S7. Overlapping findings are consolidated rather than counted twice. Prior test-review observations are retained where supported by the current source; prior executable claims are identified as such.

**Priority:** fix cross-room mutation (M5), mutation authorization (M1), unrelated vote clearing (M6), and sub-score merge undo (M7) first. Then address the display synchronization failures (M2–M4). Refactoring should make these contracts testable, not delay their correction.

The implementation has useful foundations: pure orchestration helpers, serialized session mutations, atomic persistence, explicit spectator rules, guarded structural rewinds, and cached structural map projections. Preserve these while fixing the boundary issues below. The highest priorities are preventing unauthorized or invalid moves and keeping performer displays consistent with server state.

Scope: score parsing/validation and graph construction; line routing, coordination, sub-sessions and rewind integration; persistence; WebSocket transport; performer and map clients; routes, views, documentation, and regression-test structure. This is a source review with focused executable reproductions, not a certification of every orchestration path.

Verification: this second review executed the actual pure orchestration/line modules, parser/graph/validator, sub-view functions, and extracted `resolveSplit` function in an isolated V8 JavaScript runtime. Small transport/DOM/IO stubs were used where necessary. These focused probes confirmed:

| Probe | Observed result |
| --- | --- |
| Merge L0/L1 in room A with room B's L1 connection also present | Room B's connection changed to L0; its device ID entered room A's registry and merge snapshot. |
| Resolve a split while another line has an outstanding vote | The unrelated line's `currentVoteTo` changed to `-1`. |
| Start a sub fetch, exit to main, then resolve the fetch | Browser context switched back to the obsolete sub. |
| Merge then undo two lines inside the same sub | Both restored at JOIN, not their respective A/B predecessor frames. |
| Validate a two-link frame with `session-split="abc"`, `"2junk"`, or `"2.5"` | All returned zero validation errors. |

These probes execute production logic but are not full server/browser integration tests. `npm test` could not start: the available npm launcher reports unsupported WSL, no Linux Node executable was found, and Windows Node interop also failed. No full-suite result, browser rendering test, or performance benchmark is claimed. Application code was not changed.

Test-review addendum: most pure-function expectations make sense. Keep the routing/spectator cases, split/merge identity and cascade cases, registry corroboration, line history/migration cases, directory-order checks, rewind-log round trip, and vanilla build baseline. They protect meaningful contracts. The main weakness is that several tests described as runtime/UI coverage do not execute those layers, and some test helpers have drifted from production. Findings T1–T9 below review the tests themselves. The previous review also reported an in-memory mutation probe for T3; this second pass checked the source assertions but did not repeat that particular mutation probe. The Node-suite execution limitation still applies.

## Must

### M1. Authenticate and validate every performer mutation before touching a line

**Correctness — confirmed control-flow defect.** [bin/www](../bin/www#L6550) only initializes `conn.isStaff` during PING, then rejects spectators using `conn.isStaff === false`. A new socket has an undefined flag, so it can send TAP first and bypass that check. `lineForConn` falls back to an active line. The instant-advance branch accepts `Number(nextFrameIndex)` without checking that it is a valid outgoing destination; [setCurrIdxTo](../lib/session-lines/line.js#L173) does not enforce bounds either.

**Trigger/impact:** on an unheld frame, a socket knowing the session ID/current index can submit a zero-duration tap without authenticating. An invalid or out-of-range target can put the playhead/history into invalid state. Even authenticated clients can submit stale or malformed destinations through this branch. Tally-time validation does not protect instant advances.

**Correction:** require an authenticated performer bound to the same session for TAP, exclude map sockets from performer actions, and validate the complete source context and outgoing vote ID before any mutation. Derive timing from authored/server state. Validate numeric bounds at the line mutation boundary too. Test pre-PING taps, cross-session messages, invalid destinations, and legitimate zero-duration navigation.

### M2. Make asynchronous sub-score loading respect the latest display state

**Correctness/UX — reproduced.** [session.js](../public/javascripts/session.js#L275) starts `enterSubSessionView()` without serializing later display messages. After its fetch completes, [the loader](../public/javascripts/session.js#L339) unconditionally switches the frame context to that sub; the caller then displays the original entry index.

**Trigger/impact:** delay the first sub fetch, then eject/exit/rewind the line or let another performer advance it. When the old fetch finishes, it can overwrite the newer frame or return the browser to a sub-score the server already left. A failed fetch only logs to the console, leaving the performer without a recovery affordance.

**Correction:** give display transitions a generation/context token, discard obsolete completions, deduplicate in-flight asset loads, and render the latest desired frame once assets are ready. Show a recoverable loading/error state and resynchronize after failure. Regression-test delayed entry followed by SHOW, EXIT, another sub entry, and a fetch rejection.

### M3. Reconnect using a complete display snapshot, including explicit cleared states

**Correctness/UX — confirmed protocol gap.** [NEED_DISPLAY](../bin/www#L6710) sends SUB_ENTER when currently in a sub, but only SHOW when back in the main score. [SHOW](../public/javascripts/session.js#L108) changes the index without restoring the main frame list. The same response sends a waiting banner only when waiting/straggling, with no corresponding clear when neither applies. Paused sessions also skip the context-bearing display message.

**Trigger/impact:** disconnect inside a sub, let the line return to the main score, then reconnect the same page. The main index is interpreted against the retained sub frame list. Likewise, a missed barrier release can leave a stale waiting banner after reconnect. A newly loaded paused sub session lacks the sub context needed when resumed.

**Correction:** return one authoritative snapshot containing context, frame, pause, hold, voting, and waiting state, including explicit false/null values. Apply it atomically, coordinating with M2's asset loading. Test reconnects across both sub boundaries, barrier release, pause/resume, and browser back/forward restoration.

### M4. Invalidate scheduled messages when a connection or display generation changes

**Correctness — confirmed timer lifecycle gap.** [ws-client.js](../public/javascripts/ws-client.js#L168) schedules future messages with `setTimeout(parseMessage, delay, data)` but retains neither their handles nor a generation identifier. [Socket teardown](../public/javascripts/ws-client.js#L96) removes socket handlers but cannot cancel those callbacks.

**Trigger/impact:** receive a future SHOW/phase message, then reconnect or perform an authoritative rewind before it fires. The old callback can overwrite the newly synchronized display or restart an obsolete phase. A socket generation alone does not cover a rewind on the same socket.

**Correction:** track pending deliveries, cancel them on teardown, and attach a server display/transition revision so clients reject messages superseded by a rewind, context change, or snapshot. Test a delayed SHOW followed by reconnect and by a same-socket rewind.

### M5. Scope merge membership and device snapshots to the current room

**Correctness — reproduced; highest impact additional finding.** [runRejoin](../bin/www#L1749) passes the entire `wsServer.connections` collection to [applyRecombine](../lib/session-lines/orchestrator.js#L3338). Its `deviceIdsFor` helper checks only `lineId`, and its rebinding loop checks only whether that line ID is absorbed. Line IDs such as L0/L1 are reused in every room.

**Trigger/impact:** room A merges L1 into L0 while room B also has a connection on L1. The production-module probe changed room B's connection to L0 and persisted its device ID in room A's registry and merge snapshot. Room B receives no corresponding transition and its mutation lane is bypassed. Even without malformed messages, one performance can disrupt another. The rebinding loop also persists observer IDs, although map connections must never enter durable performer membership.

**Correction:** filter connections by `session.id` inside the orchestration boundary before collecting device IDs or rebinding. Rebind same-room observers for display, but exclude map/rider connections from durable performer membership; preserve valid offline performer records. Caller-side filtering is useful but should not be the sole protection.

**Regression:** use two rooms with identical line numbers and explicit player/rider/map fixtures; merge only one. Assert the other room's connections, votes, registry, and snapshots are unchanged, and no observer is added to durable performer records. Existing single-room recombination scenarios miss this boundary.

### M6. A split must not erase votes on unrelated lines

**Correctness — reproduced.** [resolveSplit](../bin/www#L988) clears `currentVoteTo` for **every connection in the session** after assigning the split's children. Independent lines can have overlapping voting windows.

**Trigger/impact:** L0 resolves a split while L2 is voting at another frame or split. L2's votes disappear. The cached tally can temporarily hide the loss, but a later vote recalculates from the cleared connection values; another split's partition reads those cleared votes directly. Performers can receive destinations they did not choose.

**Correction:** clear only the original splitting population and any explicitly coordinated group participants. Capture that connection set before reassignment; do not use a session-wide loop.

**Regression:** run two simultaneous windows, resolve one split, and assert the unrelated line keeps each vote and resolves to the same result. Include another split on the unrelated line and a vote arriving after the first split. A probe executing the extracted production `resolveSplit` changed the unrelated vote from `3#OTHER.svg#0` to `-1`.

### M7. Make sub-score co-presence merges undoable in the correct context

**Correctness/UX — reproduced restore defect; subsequent remerge follows the runtime control flow.** [Arrival handling](../bin/www#L1117) now merges co-located lines inside sub-scores too. However, [preMergeLanding](../lib/session-lines/orchestrator.js#L2406) explicitly returns null for every snapshot with a `subStack`, so merge undo restores those lines on the merge node itself. [handleSelectHistory](../bin/www#L6222) then calls `settleCoLocatedLines`, merging them again.

**Trigger/impact:** in the same Tetra dive/return context, L0 travels A → JOIN and L1 travels B → JOIN. Executing production merge and undo restored both at Tetra/JOIN instead of A and B. A full undo gesture can therefore report separation while immediately undoing that separation. The map compounds this: structural badges use `main:<frame>` ([session-map.js](../public/javascripts/session-map.js#L882)), so a sub merge can mark an unrelated same-named main frame or have no badge at all.

**Correction:** carry a context-qualified merge location through events, projections, guards and menus. Resolve each participant's predecessor using its active score's frame list; preserve its return context. Ensure undo's final settlement does not recreate the event just undone. Also audit convergence grouping for identical filenames in different score contexts.

**Regression:** merge/undo two real `BMLine` instances inside a sub, through the complete runtime gesture, and assert distinct predecessor landings, correct device ownership, a stable undone event, and the badge/action on the sub node. Include a same-named main frame and two different dive return contexts.

### T1. Exercise the real runtime transitions behind the existing “runtime” tests

**Test coverage — Must.** [sub-session.test.js](../test/sub-session.test.js#L153) claims an ejected line lands holding, but performs `exitSub()`/`setCurrIdxTo()` itself and then explicitly sets `line.isHolding = true`. It never invokes the eject handler or starts a hold. Removing the production hold-start call would not fail this test. Likewise, [barrier-runtime.test.js](../test/barrier-runtime.test.js#L24) manually marks targets and calls recombination; it does not execute barrier release or automatic arrival handling. These are useful component scenarios, but their names overstate their coverage.

Keep the component checks, label their scope accurately, and add tests that drive the real command/arrival handlers with controlled transport and time. Assert emitted frames, waiting state, hold deadlines, device bindings and persistence. Include M1–M7's authentication, delayed fetch, reconnect, delayed-message, cross-room, simultaneous-vote and sub-merge regressions. [sub-countdown-transition.test.js](../test/sub-countdown-transition.test.js#L109) executes an exit/countdown case, but entry is checked only by source text; it provides no asynchronous fetch coverage.

### T2. Remove stale copies of the hold and population rules from test setup

**Test correctness — Must.** [arrival-release-order.test.js](../test/arrival-release-order.test.js#L43) defines `holdPending` as `isHolding || standbyTimer != null`. Production now delegates to the elapsed-hold clock. A line flagged holding with an elapsed deadline and no timer is considered pending by the test helper but completed by production. The existing inputs never expose this disagreement. [target-hold-gate.test.js](../test/target-hold-gate.test.js#L44) also copies production functions instead of importing them, so changing the real clock logic need not fail its behavioral cases.

[barrier-runtime.test.js](../test/barrier-runtime.test.js#L234) uses `performerLineConnections` for population although production uses `populationLineConnections`; the former includes riders. Its fixtures omit `isStaff`, and contain no rider-only incoming line, masking the mismatch.

Extract/import the production policies and use explicit player/admin/rider/map connection fixtures. Add elapsed-hold boundaries and a rider-only reachable branch. Preserve small independent expected outcomes, rather than duplicating the algorithm being tested.

## Should

### S1. Reject malformed split declarations instead of silently changing their meaning

**Correctness — reproduced.** [parse.js](../lib/session-lines/parse.js#L136) uses `parseInt`: `session-split="2.5"` and `"2x"` become `2`, while `"oops"` becomes null. [graph.js](../lib/session-lines/graph.js#L63) excludes null splits, so [validation](../lib/session-lines/validate.js#L205) never examines that declaration. All three passed with zero errors/warnings in a two-link fixture.

Preserve declaration presence/raw value and require a finite, safe integer of at least two before checking link count. Add malformed and empty-value tests. Audit the parser's double-quote-only attribute handling as well: valid single-quoted SVG markup should either work consistently across build/validation or produce an explicit authoring error.

### S2. Reduce repeated work in coordination and live map updates

**Performance — source-based scaling concern; not benchmarked here.** [canReachFrames](../lib/session-lines/orchestrator.js#L2887) rebuilds lowercase adjacency for every query and consumes its BFS queue with `shift()`. Barrier/group evaluation calls it repeatedly. [Map snapshots](../bin/www#L5490) scan connections per line, build full trails, calculate checkpoint plans and merge latecomers, and send trails again on ordinary updates. [The client](../public/javascripts/session-map.js#L833) clears/repaints badges and traverses history on each push.

Build immutable adjacency/reverse-reachability indexes per score revision and use a queue cursor. Group connections once per snapshot. Separate live counts/phases from trail revisions, coalesce redundant pushes, and render at most once per animation frame. Preserve complete undo evidence; do not truncate history merely to shrink payloads. Measure event-loop delay, payload size, and rendering time on long looping scores with many devices and structural events before choosing further optimizations.

### S3. Make the operational map load reliably on a local network

**UX/reliability — confirmed dependency.** [session-map.js](../public/javascripts/session-map.js#L12) loads Cytoscape from a public CDN using a floating major version. [Initialization](../public/javascripts/session-map.js#L3797) waits for graph and scripts before opening its socket. If the essential script fails, the map and its recovery controls remain unavailable. Script loads have no application timeout; thrown graph-fetch errors bypass the HTTP retry loop.

Serve pinned, tested graph libraries with the application. Add bounded loading timeouts and an in-page Retry action with an actionable error message. Verify startup with internet disabled while the local session server remains reachable.

### S4. Complete keyboard and assistive-technology support for operator dialogs

**UX — confirmed implementation gap.** [The custom dialog](../public/javascripts/session-map.js#L1613) sets `aria-modal` and focuses the confirmation button, but does not trap focus, make the background inert, or restore prior focus when closed. Tab can reach controls behind an apparently modal confirmation; opening a destructive confirmation focuses the action immediately.

Use a native modal dialog or implement equivalent focus containment/restoration and background inertness. Choose safe initial focus for destructive actions and announce results/errors through a live region. Verify Tab/Shift+Tab, Escape, screen-reader labels, and return focus after cancellation or invalidation.

### S5. Refactor around state transitions and add behavioral integration coverage

**Maintainability/correctness.** [bin/www](../bin/www) is approximately 7,000 lines, [orchestrator.js](../lib/session-lines/orchestrator.js) 3,600, and [session-map.js](../public/javascripts/session-map.js) 3,850. Transport, timing, topology, persistence and presentation remain tightly connected. Some regression coverage, such as [mutation-serialization.test.js](../test/mutation-serialization.test.js#L62), verifies source patterns; that cannot establish end-to-end ordering across sockets, timers, asset fetches and DOM changes.

Extract protocol validation/snapshots, transition scheduling, rewind execution/projection, and map dialog/rendering concerns incrementally. Keep the existing session mutation lane as the owner of runtime changes. Add real WebSocket and browser scenarios for M1–M7, plus invariants covering split → merge → undo, dormant revival, and restart. Prefer small extractions after the correctness fixes over a wholesale rewrite.

### S6. Build a replacement score before publishing any part of it

**Correctness/reliability — confirmed non-atomic build path; fault injection still needed.** [buildSVGContent](../database.js#L496) replaces live frame lists, removes the published `.content.svg`, and appends its replacement frame by frame. Only later does it replace the graph/sub-score data and finalize the content hash. The session mutation lane serializes WebSocket work, but HTTP readers of the graph/content do not acquire that lane. [The content route](../routes/session.js#L33) also pipes a file stream without handling stream errors.

**Trigger/impact:** rebuild a running score while a new page loads, or fail a frame read midway through rebuilding. A reader can receive partial content, and a rejected rebuild can leave new frame indexes alongside old graph/history or an incomplete published file. Missing-file reads can emit an unhandled stream error. Atomic JSON state persistence does not make generated score assets atomic.

**Correction:** build and validate into a detached score bundle and temporary/versioned artifacts. Publish the complete bundle only after success, then update the live state/cache and notify clients. Preserve the previous usable score on failure, and explicitly handle content stream errors. For consistency across several files, use a revision/bundle switch rather than relying on individual renames alone.

**Regression:** pause a rebuild between frames while requesting graph/content; inject a read/write failure and verify the old score remains complete and usable. Then complete a successful rebuild and verify clients receive one consistent revision.

### S7. Refresh main-score sound discovery on an in-place rebuild

**Correctness/UX — confirmed call-path omission.** [reloadScore](../database.js#L388) refreshes `hasSounds` and `soundList`; [rebuildScore](../database.js#L400) only invokes `buildSVGContent`. The latter hashes the existing `soundList` rather than rediscovering the main score's sound files. [The same-folder update](../routes/sm.js#L137) uses that incomplete hash to decide whether clients reload.

**Trigger/impact:** add or remove a main-score sound file without changing SVG frames, then update the session. The server retains the old sound list, the hash can remain unchanged, and connected performers do not receive the updated audio inventory. Sub-score sounds are rebuilt separately and do not fix the main-score omission.

**Correction:** make sound discovery part of building the replacement bundle, shared by initial load, folder change and in-place rebuild. Define whether replacing bytes at the same sound path should invalidate clients too; currently path hashing cannot detect that case.

**Regression:** add/remove a main sound file and toggle whether the score has sounds; assert the fresh list, content revision and reload notification. Retain the existing guarantee that a parameter-only update does not reload the performance.

### T3. Replace source-pattern assertions where the requirement is behavioral

**Test quality — Should.** [session-map-ui.test.js](../test/session-map-ui.test.js#L55) accepts any occurrence of `operationId` near each send. The previous review reported that an in-memory mutation setting the client operation-ID fields to `undefined` still passed all seven request-field checks; source inspection confirms these assertions check proximity of text rather than payload values. Its persistence checks find `recordRewind` and `saveSessionStateToFile` anywhere in the runtime, without establishing that the same operation calls them. [map-payload.test.js](../test/map-payload.test.js#L136) searches for route authorization text rather than making an unauthorized request. [mutation-serialization.test.js](../test/mutation-serialization.test.js#L81) searches only 220 characters after each timer declaration; [hold-gate.test.js](../test/hold-gate.test.js#L61) relies on a six-line neighborhood.

These checks can pass broken wiring and fail harmless formatting/refactoring. Capture actual outgoing payloads, run two-operator receipt scenarios, execute unauthorized HTTP requests, and hold a real mutation open while firing timers/taps. Use browser-computed bounds and focus assertions for menu responsiveness. Retain narrowly scoped architectural checks where justified; the actual-instance export check in `orchestrator-surface.test.js` is useful, though regex discovery of callers remains limited.

### T4. Isolate test files from application data and clean every artifact

**Test isolation — Should.** [build-graph.test.js](../test/build-graph.test.js#L31) creates a fixed directory under `DATA_DIR` and recursively deletes it afterward. Build tests use fixed session IDs and write into `SERVER_STATE_DIR`; [baseline.test.js](../test/baseline.test.js#L74) and the shared [session fixture](../test/session-lines-fixture.js) have no general output teardown. [state-file.test.js](../test/state-file.test.js#L27) removes fixed filenames without preserving a pre-existing file. Separate concurrent test runs can collide, and a coincidentally named existing fixture can be overwritten/deleted.

Inject a temporary state/output directory and use `mkdtemp` per run. Keep source fixtures read-only, clean outputs in `finally`, and verify the real score/state directories remain unchanged. Do this before adding parallel test execution.

### T5. Make durability race tests deterministic and cover failed writes/restarts

**Test reliability — Should.** [state-file.test.js](../test/state-file.test.js#L33) starts two real saves, but does not force their filesystem operations to overlap in the old failing order. It is a useful smoke test, not deterministic proof of serialization or crash safety. The snapshot-at-call-time case is stronger and should remain. The suite does not exercise the actual boot loader's corrupt-file quarantine, orphan-cache filtering, or continuation after one bad snapshot.

Add a controllable filesystem adapter to pause writes/renames and assert exact ordering, then inject write and rename failures. Assert the previous complete snapshot survives, the next queued save succeeds, deletion wins, and a fresh loader restores remaining valid sessions. Keep a small real-filesystem smoke test in an isolated directory.

### T6. Measure the actual map update path before calling the test a broadcast budget

**Performance coverage — Should.** [map-payload.test.js](../test/map-payload.test.js#L69), “100, 200 and 500 event broadcasts stay compact,” measures only `structuralEventSummaries()` over synthetic arrays. It excludes building the projection, checkpoint/latecomer calculations, trails in the actual payload, serialization time, transport fan-out and rendering. Its single `<250 ms` assertion is host-load-sensitive and does not bound a real update.

Keep the deterministic summary-size test and rename it accordingly. Separately benchmark the real snapshot builder with long trails, connected performers and repeated topology, recording cold/warm projection costs and serialized bytes. Verify cached detail bodies are not resent on ordinary count pushes, and add a browser rendering workload if a UI performance budget is required.

### T7. Bound test execution and require a completed-run result

**Test infrastructure — Should.** [test/run.js](../test/run.js#L42) awaits each case with no timeout. A stuck socket/timer can hang the suite indefinitely; an unresolved promise with no active Node handles can let the process exit before the final summary. The runner also discovers tests from object keys, so duplicate names silently replace earlier cases before it can count them.

Add per-case deadlines with a live timeout handle, clear failure attribution, and a completed-run marker checked by CI. Detect duplicate test names through linting or an explicit registration API. Ensure mocks/timers are restored on failure; the existing `finally` cleanup in `read-dir.test.js` is a good pattern.

## Nice to have

### N1. Reconcile documentation and comments with current behavior

[score-map.md](score-map.md#L94) still calls orphan `.subs.json` loading a known limitation, although [database.js](../database.js#L1058) explicitly filters those files. Its verification section reports an older fixed test count. Several map comments still describe split parents as retired or receipts as lacking operation IDs despite the updated implementation.

Remove resolved limitations, date verification claims, and keep comments focused on current invariants. This reduces the chance that later refactoring restores an obsolete behavior.

### N2. Offer a searchable, keyboard-accessible frame/line navigator

[The map view](../views/session-map.jade) offers zoom and layout controls, while [node actions](../public/javascripts/session-map.js#L3572) are reached through canvas interaction. For large scores, finding a named frame or navigating without precise pointing is cumbersome.

Add a compact searchable list that focuses a frame or live line and opens the existing action menu. Reuse the same menu projection and server guards so this does not create a second set of rewind rules.

### T8. Correct misleading test names and stale scenario comments

[split-runtime.test.js](../test/split-runtime.test.js#L46) says “parent retired,” while its assertions correctly require that branch zero is the original active parent. [orchestrator.test.js](../test/orchestrator.test.js#L1707) says a merge undo is refused after movement, but verifies that the higher-level cascade option remains available. The admin-population comment in `barrier-runtime.test.js` initially includes map tabs despite its dedicated observer test.

Rename these cases around their current contract. Keep the correct assertions; do not change production to satisfy obsolete titles. Distinguish single-step refusal from availability of a complete cascade.

### T9. Organize tests by contract and keep simple fakes away from history invariants

The approximately 3,900-line `orchestrator.test.js` combines many independent subjects. Its [fakeLine](../test/orchestrator.test.js#L61) always appends history, unlike `BMLine.setCurrIdxTo`, which truncates rewind tails and avoids adjacent duplicates. That fake is adequate for basic partitioning but can hide interactions when used in structural-history scenarios.

Split the suite into routing/partition, barriers/groups, rewind planning, structural execution and migration files. Use real `BMLine` objects for history-sensitive scenarios; keep lightweight fakes for pure inputs and transport. Add seeded sequence tests for split → merge → rewind with independently asserted device conservation, unique live route identities, valid frame indexes and preservation of unrelated lines.

Suggested order: close M5/M1/M6/M7 with real regression coverage, implement M2–M4 together as a coherent display protocol fix, then S1/S6/S7. Address T1–T2 alongside those fixes; isolate test output before expanding execution. Profile the real pipeline before undertaking the larger performance refactors. Preserve the current pure helpers, durable line identities, mutation lane and atomic state-file writes.
