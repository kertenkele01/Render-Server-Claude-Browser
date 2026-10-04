# Browser safety tool guidance — 4 October 2026

Updated the MCP tool operating guide to match the Android safety fixes:

- Navigation summaries require the phone's read permission; `read=true` requires both navigate and read.
- HTML reading returns sanitized structure with recognized credential values, scripts and inline event handlers excluded.
- Bulk form filling verifies retained values and distinguishes partial completion from a confirmed complete fill.

Authorization remains on the Android device. This relay change updates tool guidance; it does not enforce these Android protections on older installed app versions. The Android app must be updated to receive the device-side fixes.

Only the six corresponding tool-description/best-practice changes are included. Existing relay functionality and operator-curated shortcut destination handling are preserved.

Validation in this relay checkout: `npm test` passed 148 tests with zero failures or skips. See [server test output](server-tests.txt). The main Android project's isolated publication snapshot also passed 190 Android unit tests and 14 real-Chromium script tests; Android build and instrumentation-test compilation succeeded. Android instrumentation tests could not run because the local emulator has no usable hardware acceleration.
