# Late72h v2 legacy metadata interpretation

Bind to original v2 JSON SHA1710c686df8e48813f1541dc5b75d20d0c9697035c493a862d5f3527b01d8aa4 and Approved scoped review /tmp/wrd-rolling72h-refresh-late-v2-fix-review-20261018.md. Preserve the original artifact bytes and numerical results.

The inherited files[].timestampedLines, files[].unparsedLines and files[].inWindowLines are v1 physical-line snapshot metadata, not the v2 complete-record population. coverageAssessment.timestampFreeLinesNotAttributed=true is likewise legacy v1 wording, not the v2 framing rule. V2 explicitly attributes fields/continuations within a closed known object to its authoritative top-level event timestamp. Only genuine orphan/unknown/truncated fragments remain unattributed.

Use framing and aggregates (with their representation classes and finite selectors) for corrected record results; never interpret the legacy fields as denial of multiline record attribution or add physical lines to event counts. All missing raw coverage, mixed ownership, R5 failed qualification and six null/NOT_RUN input dimensions remain. This note fixes interpretation only, adds no scan, result, event, validation credit or runtime authority. Copy it with the v2 report/JSON/review in the terminal repository archive after source hold release.
