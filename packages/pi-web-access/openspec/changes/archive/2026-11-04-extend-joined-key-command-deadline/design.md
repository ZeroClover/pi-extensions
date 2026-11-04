# Design

## Context

See proposal.md "Why" for the symptom. The facts below were read and measured on Pi 1.5.0 and Node 26.

- `src/routing.ts:83` creates the attempt's `AbortSignal.timeout(entry.timeoutMs)` before the attempt runs. Credential resolution is its first step, so the attempt's clock includes any wait for a key.
- `src/credentials.ts`: `runCommand` arms one timer of `timeoutMs` when it spawns the command. `CredentialStore.keys` holds the pending result per provider, so a later or parallel attempt joins the same command, and it keeps the deadline it had.
- When that deadline passes, the timer settles the result with `retry: true` and sends SIGTERM to the process group. `resolve()` then calls `resolveKey` again, which spawns a new command. If the two attempts began `d` ms apart, the new command has about `d` ms left of the later attempt's timeout, not the "own time" that the code comment claims or the "own full `timeoutMs`" that the spec's "Slow key command" scenario claims.
- The test at `test/credentials.test.ts:137` asserts `["run", "run"]` on line 157. The second run has only that short window to write its counter file. The window is about 0.4 s there, so a loaded CI machine can miss it. This cause is inferred: the failure happened once on CI, and it did not reproduce locally on the unfixed code in 8 runs at three times the CPU load or in 12 runs at ten times.

## Goals / Non-Goals

**Goals:**

- An attempt that joins a running key command gets its full `timeoutMs` for that command.
- One command run per wait, so that the user is not prompted twice, except in the narrow window described under "Keep the retry branch in `resolve()`".
- The race in the test, the second command's short window to write its counter file, is gone. The rewritten test depends on a different thing: the attempt's timer running before the command's (see "What the rewritten test depends on").

**Non-Goals:**

- Provider routing, retry and fallback policy, key expression parsing, other extensions.
- A limit on how long a command can be extended (see Risks).
- A command left by a previous `CredentialStore` after `/reload`: it runs out on its own timer as it does today, and the new store starts its own.

## Decisions

### Joining moves the running command's deadline

When `resolveKey` finds a pending key, it moves the command's deadline to `timeoutMs` from now and returns the pending result. While the deadline can still move, the command is not killed or started again. Cancelled and parallel calls take the same path, because both reach it as "a pending key exists".

The deadline moves with `timer.refresh()` on the existing timer, which reschedules it for its original duration from now. There is no second timer to leak, however often attempts join, and the callback and its message stay as they are. `runCommand` returns `{ result, extendDeadline }`, and `CredentialStore.keys` holds that pair.

`extendDeadline` does nothing once the command has ended, which a `running` flag states directly. The flag turns false when the timer fires as well as on `close` and `error`. A finished command's entry stays in `keys` for the rest of the session, so every later call reaches `extendDeadline`, and refreshing a timer that has fired reactivates it (documented by Node, and measured). Its callback would then send SIGTERM to a process group that no longer exists and whose id may have been reused; the code comment says so. `refresh()` on a cleared timer did not fire when measured, but Node does not document that case. No scenario can observe the flag.

A template key's `extendDeadline` is a no-op, because it has no command or timer.

### Keep the retry branch in `resolve()`

`resolve()` keeps its second wait: a timeout result that reaches an attempt whose own signal has not fired makes that attempt run the command itself. Ordinary joining no longer depends on this branch, but two cases still do:

- **An attempt that joins just as the command's timer expires.** `refresh()` cannot save a timer that `listOnTimeout` has already picked, so the timer fires straight after the join and reports its timeout to an attempt that has only just begun. Without the branch that attempt fails within a few milliseconds as `skipped`, with `key command … timed out`. With it, the attempt runs its own command with practically its full `timeoutMs`. That can prompt the user a second time, which is an accepted trade-off for this window (see Risks). The spec's "Key command reaching its deadline as the attempt begins" scenario states this; "the next call runs it again" in "Slow key command" describes a call after the command has ended, and does not cover it. A scripted model repeating a failed call with no delay reaches this case through real Pi (task 1.6).
- **The order of two timers that expire together.** If the command's timer ever ran before the attempt's, the same attempt would see the timeout, start a new command with almost none of its own time left, and its signal would then abort. It is still recorded as `timeout after N ms`, so the record does not depend on the order. The new command keeps running until its own deadline, or until its key serves the next call. This case does not occur on the Node versions below.

The branch's comment now says this. The `retry` field stays for the branch and for `.then` in `resolveKey`, which drops a timed-out command from the cache.

Alternatives considered:

| Option | Result | Verdict |
|---|---|---|
| (a) The attempt's timeout does not count the wait for an old command (change `routing.ts`) | An attempt can outlast `timeoutMs`, against the requirement that each attempt, "including the resolution of its credentials", is bounded by it. | Rejected |
| (b) A new call kills the old command at once and starts its own | Full time for the new command, but the user is prompted twice, and an approval in progress is lost. Contradicts "may instead finish and serve the next call". | Rejected |
| (c) End the command as soon as no attempt waits for it | Same double prompt after every cancellation: the next call has nothing to join. | Rejected |
| (d) Keep today's retry, and only start the retry earlier | Still two runs and two prompts; the time left is still under `timeoutMs`. | Rejected |
| Clear the timer and arm a new one instead of `refresh()` | Same behavior with more code. | Rejected |

Measured in a scratch copy with the fix applied, against the scenarios in `tasks.md`:

| Case | Today, or the fix without the deadline move | With the fix |
|---|---|---|
| Cancelled, then a call 1.5 s into the command (`timeoutMs` 3000, command 3.5 s) | fails `timeout after 3000 ms` after 3 s, 2 runs | succeeds after about 2 s, 1 run |
| Cancelled, then a call at once (`timeoutMs` 2000, command 4 s) | `timeout after 2000 ms`, 2 runs | `timeout after 2000 ms` after 2 s, 1 run |
| Parallel in one codemode script, 2 s apart | both fail, 2 runs | first `timeout after 3000 ms`, second succeeds, 1 run |
| Three cancelled calls, then a call | fails, 2 or 3 runs | succeeds, 1 run |

Three calls in one scripted round, with no delay, on a 30 s command behave the same today and with the fix: each lasts its full 1000 ms and reports `timeout after 1000 ms`, with 3 runs today and 1 to 3 with the fix. Removing the retry branch makes that scenario fail in 10 of 10 runs, with a call ending within a few milliseconds as `key command … timed out`.

### Boundaries

- **Cancelled, and no later call:** the timer is untouched, so the command ends at its deadline. Measured 1503 ms with `timeoutMs: 1500`, and `/web-access` shows the timeout.
- **Timer and attempt timeout together:** an attempt's signal is created before it can join, and the timer is rearmed after that, with the same duration, so the attempt's timeout fires first (see "What the rewritten test depends on"). The retry branch would keep the record the same in the other order. Under load in a scratch copy, with the branch kept (8 runs with 48 busy processes on 16 cores), all 8 reported exactly `timeout after 2000 ms`, after 2003 to 2015 ms, and three sequential calls in each run all reported `timeout after 1000 ms`.
- **Repeated joins:** one timer. A cancelled attempt's abort listener is released on abort, but the `.then` reaction `untilAborted` put on the shared promise stays until the command settles (see Risks).
- **`close` after the timer:** resolving a settled promise does nothing, and `clearTimeout` on a fired timer does nothing. This is unchanged.
- **`/web-access`:** the status text is unchanged. `timed out after N ms` now means N ms after the last attempt began waiting, which can be less than the command's total lifetime. The message stays because N is the configured limit that a user would change.

### Update the existing test instead of widening it

The test at `test/credentials.test.ts:137` changes its count assertion on line 157 from two runs to one, because the behavior it describes changes: a call after an abort no longer starts a command. It keeps the assertions that the call lasts its full 2 s and reports `timeout after 2000 ms`. The second command's counter write, which raced against the short window, no longer happens.

### What the rewritten test depends on

The rewritten test expects one run, which holds only if the attempt's timer runs before the command's timer of the same duration. Otherwise the retry branch would start a second command. The Node source gives that order, read for v24.22.2, the latest v24 (`gh api repos/nodejs/node/contents/...`), and for the local v26.13.0 (the same line numbers in `lib/internal/timers.js`):

- `AbortSignal.timeout(delay)` calls `setWeakAbortSignalTimeout`, which is an ordinary `setTimeout(callback, delay)` followed by `unref()` (`lib/internal/abort_controller.js:202`). `unref()` only changes the reference count (`lib/internal/timers.js:282`), so the timer stays in its list.
- `insert()` picks the list by duration, `timerListMap[msecs]`, and appends to it (`lib/internal/timers.js:426,446`). `refresh()` reaches the same `insert()` through `active()` and `insertGuarded()` (`:273,386,400`), and `L.append` first removes the item, so a refreshed timer moves to the tail (`lib/internal/linkedlist.js:31`).
- `listOnTimeout` takes the oldest timer in the list, checks that it has expired, runs `runNextTicks()` between timers, and only then removes and fires it (`lib/internal/timers.js:623`).

An attempt's signal is created before its command's timer is armed or refreshed, with the same `timeoutMs`, so it is earlier in the same list, and the rejection it causes is handled during `runNextTicks()`, before the command's callback. The same code explains the window above: a join during that `runNextTicks()` refreshes a timer the loop already holds, and the loop fires it anyway.

This order is structural in the implementation but not a promise: `doc/api/timers.md:275-276` says "Node.js makes no guarantees about the exact timing of when callbacks will fire, nor of their ordering." If a Node release changed it, the test would fail on its run count, and the record would still read `timeout after N ms`. The pull request's CI is re-run several times on Ubuntu with Node 24, the environment where the instability appeared.

### New scenarios use the command's duration as a lower bound

`sleep` cannot finish early, so "the command outlives its old deadline" holds under any load. The joined case uses `timeoutMs: 3000` and a 3.5 s command, and starts the second call 1.5 s after the command reports that it started. Its old deadline counts from the spawn, and the shell's startup comes before that report (about 0.4 s for the first command on the zsh of the machine measured), so that leaves about 1.1 s before the old deadline and about 1 s between the command's end and the new one. A later join shrinks the first margin and grows the second, so 1.5 s balances them.

The parallel scenario keeps its 2 s gap, because it counts from the spawn, not from the command's report: about 1 s remains before the old deadline and about 1.1 s after the command ends, and 1.5 s would cut the second to about 0.6 s. The repeated-join scenario steps 0.8 s, which leaves about 0.8 s before the first command's old deadline and 1.2 s after that.

A scenario that waits for a moment checks that it reached it in time. On a machine too slow for that, it fails with "too slow for this scenario" instead of skipping the wait and reporting a second run, which would look like the defect this change fixes.

## Risks / Trade-offs

- [A hung command is not replaced while attempts keep joining it] → Measured with a command that never prints, `timeoutMs: 1000`:
  - Cancel and retry every 700 ms: 1 run over 3.5 s, and the command ended about 960 ms after the last cancel. This keeps extending the command, as overlapping calls do.
  - A codemode script retrying at once after each failure, 5 retries: 6 runs of 6 calls in each of 4 measurements, and each command was gone by the end of the script, or moments later. This does not extend it.
  - A scripted model repeating the call with no delay as new prompts, 5 repeats: 5 or 6 runs of 6 calls. A call landed in the few milliseconds between the attempt's timeout and the command's timer once in some runs, which extends that command once. Each call still lasted its full 1000 ms.

  Each attempt stays bounded by `timeoutMs`, and the command ends `timeoutMs` after the last attempt joined it. A cap on total lifetime would be speculative, so this change does not add one.
- [Waiting attempts hold memory until the command settles] → Each attempt that joined keeps one `.then` reaction on the shared promise, even after it was cancelled or timed out. The number grows with each join, and none is released while the command keeps being extended. Each is small, about 1.2 KB measured in an isolated copy of `untilAborted` on Node 26, so about 60 KB for 50 cancelled retries. This is accepted, and this change adds no waiter management.
- [An attempt that joins just as the command's deadline expires runs its own command, and the user may be prompted twice] → It takes a join during the `runNextTicks()` drain, after Node has already picked the expired timer. A scripted model with no delay reaches it, and a real model's turn is far longer. The alternative is that attempt failing at once, which is worse: the call fails and the user must retry anyway.
- [The stored error message can understate a command's lifetime] → See `/web-access` above.
- [Tests gain about 13 s of wall time in `credentials.test.ts`] → Real commands and real timeouts are what these scenarios check.
