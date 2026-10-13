# Spec Delta

## MODIFIED Requirements

### Requirement: Record schema is versioned
Each run record SHALL carry a `version` field; the current version is 2. Entries with any other version, including version 1 written before this change, SHALL be ignored during reconstruction.

#### Scenario: Future record
- **WHEN** a session contains a `pi-tps` entry with a higher version
- **THEN** reconstruction skips it without error

#### Scenario: Version-1 record
- **WHEN** a session resumed after this change holds version-1 entries only
- **THEN** the idle readout shows the empty state until the first run settles

### Requirement: Run TPS
The run TPS SHALL be the sum of reported output tokens (thinking included) divided by the sum of generation times (thinking time plus active output span) over the run's settled, non-burst requests whose own generation time is at least 1 s, marked estimated when a contributing request relied on the estimate; when no settled request qualifies, aborted ones that qualify SHALL be used. When every request was a burst, the run SHALL report the burst throughput (summed output tokens over summed elapsed times) instead; otherwise it has no TPS.

#### Scenario: Aggregate generation rate
- **WHEN** a run holds requests with 1000 output tokens over 10 s, 300 over 2 s, and a tool call with 80 over 0.2 s
- **THEN** the run TPS is 1300 / 12 ≈ 108.3 and the tool call does not contribute

#### Scenario: Thinking counts
- **WHEN** a run holds a request with 400 reasoning tokens over 5 s of thinking and 800 visible tokens over 10 s of output, and a tool call with 300 reasoning tokens over 3 s of thinking and 60 visible tokens over 0.4 s of output
- **THEN** the run TPS is (1200 + 360) / (15 + 3.4) ≈ 84.8 and both requests contribute

#### Scenario: Span just under one second
- **WHEN** a request's generation time is 999.6 ms and the record is persisted and read back
- **THEN** the request still does not contribute to the run or session TPS

#### Scenario: Burst tool call and short reply
- **WHEN** a run holds a burst tool-call request and a reply too short to measure
- **THEN** the run has no TPS and no burst throughput

#### Scenario: Aborted-only run
- **WHEN** the only request of a run was aborted after streaming 230 tokens over 2 s of generation time
- **THEN** the run TPS is 115 and the run TTFT is that request's TTFT

#### Scenario: Only burst requests
- **WHEN** both requests of a run were burst deliveries of 900 tokens in 4 s and 300 tokens in 2 s
- **THEN** the run has no TPS and reports a burst throughput of 200 tokens per second

### Requirement: Run TTFT, sums and elapsed time
The run TTFT SHALL be the mean over its non-aborted requests that have one, or over its aborted requests when no other request has one. Input, cache read, cache write and output tokens, thinking tokens, thinking time, stall time and stall count SHALL be summed over all request records; cost SHALL be summed over records that carry one and be absent when none does. The run's elapsed time SHALL be its wall time from `agent_start` to `agent_settled` on the monotonic clock.

#### Scenario: Burst and aborted requests
- **WHEN** a run holds two normal requests, one burst request and one aborted request
- **THEN** the run TPS uses the two normal requests, the mean TTFT excludes the aborted request, and the tokens and cost include all four

#### Scenario: Hidden and streamed thinking
- **WHEN** a run holds a request with 900 reasoning tokens over a 20 s hidden thinking phase and one with 100 estimated thinking tokens over 2 s of streamed thinking
- **THEN** the run's thinking tokens are 1000, marked estimated, and its thinking time is 22 s

### Requirement: Session aggregates
Session aggregates SHALL apply the run formulas to all request records of all runs on the current branch, and SHALL also count the runs.

#### Scenario: Mixed runs
- **WHEN** the branch holds a run whose requests total 600 output tokens over 10 s of generation time and a run with 900 tokens over 10 s
- **THEN** the session TPS is 75 and the run count is 2
