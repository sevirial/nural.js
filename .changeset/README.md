# Changesets

This folder holds [changesets](https://github.com/changesets/changesets) — one Markdown file per set of changes describing the intended semver bump and a human summary. On release, `pnpm changeset version` consumes them into each package's `CHANGELOG.md` and bumps versions; `pnpm changeset publish` then publishes.

**Pre-1.0 convention:** these packages are in `0.x`, so **breaking changes use a `minor` bump** (`0.1.0 → 0.2.0`) and non-breaking additions use `patch`.
