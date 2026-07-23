# @nuraljs/testing

## 2.0.0

### Patch Changes

- Updated dependencies
  - @nuraljs/core@1.1.0

## 1.0.1

### Patch Changes

- Updated dependencies [669dd05]
  - @nuraljs/core@1.0.1

## 1.0.0

### Major Changes

- **First stable (1.0.0) release.** Aligned with `@nuraljs/core@^1.0.0`; public API is now semver-stable.

## 0.1.1

### Patch Changes

- Updated dependencies
  - @nuraljs/core@0.5.1

## 0.1.0

### Minor Changes

- **Rebrand `@nural/testing` → `@nuraljs/testing` (breaking).** The package is renamed, its core dependency moves `nural` → `@nuraljs/core` (`workspace:*`), and its imports/symbols follow the core rebrand: `import { Nuraljs } from "@nuraljs/core"`, `NuralInternals` → `NuraljsInternals`.

  **What to do.** Update your dev dependency `@nural/testing` → `@nuraljs/testing` and any `@nural/testing` imports → `@nuraljs/testing`. No behavior changes — the test harness API is unchanged, only the identifiers are rebranded.

### Patch Changes

- Updated dependencies
  - @nuraljs/core@0.5.0
