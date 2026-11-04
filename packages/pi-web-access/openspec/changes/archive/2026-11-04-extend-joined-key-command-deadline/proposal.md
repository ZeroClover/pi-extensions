# Proposal

## Why

When an attempt joins a key command that is already running (left behind by a cancelled call, or started by a parallel call), the command keeps its original deadline. Once that passes, the command is killed and started again, but the attempt's own timeout has been counting since the attempt began, so the new command has only as long as the two started apart. A password manager waiting for the user's approval therefore prompts a second time and the call fails, although the provider's `timeoutMs` promises the attempt its full time.

The same mechanism makes a test unstable: `test/credentials.test.ts` asserts that the second command wrote its counter file within that short remainder, which failed once on CI (#30, run 41788739469, first attempt).

Observed on Pi 1.5.0 through real Pi sessions, with `timeoutMs: 3000` and a command that takes 3.5 s, a call cancelled at once, and a second call 1.5 s after the command started:

| | Today | With this change |
|---|---|---|
| Second call | fails after 3 s with `timeout after 3000 ms` | succeeds after about 2 s |
| Command runs | 2 | 1 |

## What Changes

- An attempt that begins while the provider's key command is still running waits for that command and moves the command's deadline to `timeoutMs` from that moment. The command is not killed and started again, for cancelled and parallel calls alike. The one exception is a narrow window: an attempt that begins just as the command's deadline expires is too late to move it, so it runs its own command with its own full time, which may prompt again. This is an accepted trade-off.
- The attempt itself stays bounded by `timeoutMs`, as is the whole of its credential resolution.
- A command nobody joins behaves as today: it ends at its deadline, and a later call runs it again.
- The unstable test now asserts one run, which removes the race instead of widening its margin.

Not changed: provider routing, retry and fallback policy, key expression parsing, and other extensions.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `provider-routing`: "Timeouts and cancellation": joining a running key command moves its deadline and does not run it again.
- `web-access-configuration`: "Key expression syntax": a command times out relative to the last attempt that began waiting for it.

## Impact

- `src/credentials.ts`: the key command's deadline and `CredentialStore`.
- `test/credentials.test.ts`: new end-to-end scenarios, and the assertion that used to expect two runs.
- `README.md`: the key expression paragraph.
- `/web-access` text does not change, but the number in `timed out after N ms` now counts from the last attempt that began waiting for the command, not from its start.
- Release: patch for `@zeroclover/pi-web-access`.
