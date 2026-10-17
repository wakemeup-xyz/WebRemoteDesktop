# Independent Viewer auth task review

Result: PASS — no actionable spec-compliance or code-quality findings.

Reviewed commit e9964678e3a9c0fb8d343155fcbcd263a018ee66 against parent 7888667, the Viewer auth blocking spec/plan, routes/auth.js, and the added regression file.

The route now uses the existing SHA-256 digest plus timingSafeEqual helper, comparing fixed-size digests derived from full UTF-8 input. This is appropriate for the existing plaintext configured shared secret; no stored-hash migration is introduced. Missing, empty, and non-string configured values fail closed. Existing missing-input 400 and truthy String coercion are preserved. Both aliases share the same limiter; JWT role, subject, lifetime and verification remain compatible. Admin and Host routes are unchanged. The intentional rejection of unequal suffixes after bcrypt's former 72-byte boundary is explicitly documented, including multibyte cases. The new tests cover those requirements and assert no bcrypt computation calls.

Independently executed with /Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node:
node --test test/auth.test.js test/terminal-auth.test.js test/viewer-admission-api.test.js test/viewer-auth-regression.test.js

Result: 25 tests PASS, 0 failures, 0 skipped. Only temporary loopback test applications were exercised; no production service or native input action was performed. No npm lifecycle/build/install commands were run. No performance benchmark or production/long-session acceptance claim is made. Historical RED evidence was supplied by the implementer and not independently rerun in this review.

No repository source, index, or documentation was modified by this review.
