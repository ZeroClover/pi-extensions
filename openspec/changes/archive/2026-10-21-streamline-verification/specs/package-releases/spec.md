## ADDED Requirements

### Requirement: Preflight preparation artifacts before merge

Pull request validation SHALL run the same read-only tarball/load preflight as publication for the release records a pull request adds, relative to its merge base. A pull request without new release records SHALL pass it as a no-op.

#### Scenario: A broken artifact in a preparation pull request
- **WHEN** a preparation pull request adds a release record whose packed tarball misses a declared resource or fails to load in isolation
- **THEN** the pull request's CI fails before merge, so no release record reaches the default branch and no withdrawal is needed

#### Scenario: A pull request without release records
- **WHEN** a pull request adds no release records
- **THEN** the artifact preflight reports a no-op and passes without packing anything
