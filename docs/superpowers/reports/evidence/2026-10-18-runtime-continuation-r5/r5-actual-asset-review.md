# Independent review of actual R5 private asset template

**Approved — no actionable findings in the exact fresh R5 actual asset template.** This is an independent review of the actual new R5 endpoint outputs, not a substitution of the R4 approval or an operational approval receipt. Root alone controls publication and must still satisfy the fresh exact14-identity quiescence, copy, fixed-window startup, exact actual output, and subsequent readiness gates.

Reviewed 2026-10-18 at approximately 15:04–15:05 UTC. The immutable new window is 1792335582238–1792336172238 ms; the upper deadline is 2026-10-18 15:09:32.238 UTC. This review does not extend that window.

## Exact fresh identities

- R5 package: `/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-frontend-move-context-operations-private-r5-wive_sjb`.
- Package `SHA256SUMS.json`: `3983cba582cb5d972149739621cc5cd13f2b6f3f458713d2db4e8e181b73ab7f`, 45 manifested files.
- Independent R5 fix1 package review: `/tmp/wrd-frontend-move-context-operations-r5-fix1-review-20261018.md`, verified SHA256 `96264a6cd0d0af58fed7d4fb7b1fe8f134caddc756f5574f72af921e79c520ba`.
- Fresh frozen directory: `/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-frontend-move-context-operations-private-r5-wive_sjb/deployment-162d7df633095f8bae0362447412f168`.
- Fresh `frozen.json`: `7f200fbc7c1b274fc6f5f211d4342a4109779296be41a3ed37a06ebbd61a134c`.
- Fresh `build-result.json`: `4aad28cd255606a50c6d46b94e3d367c12a905eecb5c97474f193bc0a3066518`.
- Fresh template relative path: `two-time-template-30yw59h3`.
- Fresh `template.json`: `1e6bfc9c4634c3425cc8d3a33dfa3f16d7839f5ec4aa2c5c1615af521ba195b7`.
- Root deployment decision SHA256: `2d42fc08b71dd61e8a10653c7db5c8c9d4fd8d74ec47714757eba09eff9736e6`; actual referenced file verified and deployment ID/package/window fields agree.
- Source-review receipt SHA256: `1a3531258a8232f0425497d66dc557d2f1e228b6e16a310f281ba6b66a86a7a1`; referenced original and R5 package copy verified byte-identical.
- Source F2: `c802a68362459b46b84593c7e8921575e0783394`; Signal/Host/product: `dfb15434e79da90b803b763c533836e16c080c71`; runner tools: `59bca14209eed299b0e94da58decb8b85e5ce70c`; diagnostic-module receipt pin remains `35c6f972d30b8c225c2d9feac2773ddb21b43cd0`.
- Actual new R5 build ID: `bb581651b422e400`.

All new frozen/build/template file SHA256s were independently computed. Their cross-references match exactly. New endpoints, new window, new deployment ID, and the full R5 code closure were independently checked; old context hashes were not accepted as new-context evidence.

## Input and code closure

All 96 new frozen input files were independently hashed and compared byte-for-byte in identity and mode to the independently hashed/Git-verified R4 inputs. The R4 reference was revalidated against frozen SHA256 `ca362b229d9dce405c324ee97a67339825f0badc0282dc644798558d2ce3703a` and my previous review SHA256 `4475c189144c558c2907f161ebf873256788e74a06f2413f870228699138e3e8`. The full R5 frozen input path set and manifest exactly equal that approved 96-input closure: complete F2 web-client source plus five Signal builder/package inputs, with no dist input. This preserves the earlier direct F2 Git-blob verification and product-builder equality without repeating an unrelated source review. Both actual new endpoint fixture copies independently match all 96 frozen input hashes and modes. The fresh candidate webrtc.js hash matches the frozen input/source hash `3e74b71536ff1bdbe52cc7e0447a887ac4a1e333ab9eb9e574306c62688fcbd9`, with private mode0600.

The entire new frozen `codeHashes` exactly equals the template closure and every Python/JS entry selected from the actual R5 package manifest: 28 entries, including the added `test_mixed_capture_namespace.py`. Every actual code file hash matches. Compared with R4, only bindings.py, mixed-native-integration.py, and the added regression are different. Their exact new hashes are:

- bindings.py: `5e0b1b036d042b1c0333f94fcdff261b323a8e2f1fe8c10d784fd37901f00d36`.
- mixed-native-integration.py: `5d04326be8f94a38f20944a98041a4d743c86af3363a39c44ab7ec58f2e0b5f6`.
- test_mixed_capture_namespace.py: `99d8f360cbc00b720554832f1cadc4fef334a9fe1ce547673f0e077c8be26efa`.

Actual private-builder-entry.js, build_primitives.py, asset_template.py, build-frontend-template.py, freeze-frontend-context.py, and deployment.py are byte-identical to the previously inspected versions. The checker-only corrections do not alter the asset builder or frozen product inputs. The old-dist seed is unchanged: the entire new seed exact map, hashes, file modes, and byte sizes equal both the new frozen oldDistMap and the approved R4 seed.

## Actual new endpoint outputs

Fresh endpoint roots are `lower-xdau10u1` and `upper-vtqd7urx`. I inspected and hashed every actual output file. Each contains exactly the 14 template paths with no extra file, symlink, or unexpected directory. Each manifest's stamp is its own new window endpoint; its build ID, six current assets, and both retained release records equal the fresh R5 template.

Every current and retained asset has a content SHA256 prefix equal to its filename. Each of the three build identities was independently recomputed from sorted compact JSON asset maps. The union of those assets plus asset-manifest.json, index.html, viewer.html, both fixed CSS files, and THIRD_PARTY_LICENSES.txt exhausts the exact 14-file graph.

Only three current timestamp fields normalize at each endpoint: the top-level asset-manifest.json builtAt and the single inline window.__WRD_BUILD__.builtAt in index.html and viewer.html. Exactly one token exists in each normalized file; all retained timestamps, IDs, asset names, and other bytes remain unchanged. Every endpoint byte hash equals its fresh template endpoint hash. Every independently normalized new output exactly equals the new private expected bytes and full template SHA256, and also equals the prior reviewed normalized bytes. All eleven other files are byte-identical across both new endpoints.

The new exact endpoint map identities (SHA256 of compact sorted-key JSON mapping each path to sha256/filesystemMode/bytes) are:

- Lower: `f823f1f4726129ecdb6f05cf7a6e7bcaf079144a9eb4ec4565bc469fcffabf95`.
- Upper: `1739d08d716138c68889a6a216dac81445b79d5b961724e22ad3ce7fc05a885a`.

Fresh differing timestamp-file byte hashes:

| File | Lower SHA256 | Upper SHA256 |
| --- | --- | --- |
| `asset-manifest.json` | `10a21de9c0df2fb3fc199a2ba950dc2da205c15dc49a708a89d03281596c34c7` | `f3a0b69d46a30c71d48a960d4dc470a93b3f4accefed8f02adcadb0ec9a0d2c2` |
| `index.html` | `296d3c42268743db010514a39ff8d4223a84828a0ff33b0b80c337e52dc8d2ca` | `c4145d348d6f0acb721920abf12108d8053cb1679a9b65b163b76dcd88f790af` |
| `viewer.html` | `597793e8d97e8b50e9bd38ab97a5a3b32c5986c864c59ce10260621613045aef` | `ec591fb0c128c84c9dab2708f5ae5f500a57565e2b6f61c0e0c50edb0ab3ee7e` |

The actual HTML eager graph resolves only to present local files. Index references css/tokens.css, css/login.css, and the current login script. Viewer references the current core script and viewer stylesheet, with exactly the expected preload/style/script tags. Its lazy JSON exactly names current terminal JS/CSS and desktop deferred JS. The current map is:

| Key | Path |
| --- | --- |
| loginJs | `assets/login.a41c71f9960c3ac7.js` |
| desktopJs | `assets/desktop-core.6910769b4fc68e56.js` |
| viewerCss | `assets/viewer.47a1f5e1301264d3.css` |
| terminalJs | `assets/terminal.4f94c01b7bb6c365.js` |
| terminalCss | `assets/terminal.854a7c0fb70e8b1a.css` |
| desktopDeferredJs | `assets/desktop-deferred.f2e69b29163ddf2c.js` |

Full 14-file normalized identity:

| Path | Template SHA256 |
| --- | --- |
| `THIRD_PARTY_LICENSES.txt` | `22d4385b199a68d9f79a0f0431f1ab32de10f12a5973070c0dcdac47958b973a` |
| `asset-manifest.json` | `fb9c05b4db2073ee4047338517dad47df2fb2f4500b188f1b9b039be6ccc2b95` |
| `assets/desktop-core.6910769b4fc68e56.js` | `6910769b4fc68e56f0520c329c6e7a725f363e004e16e5a6eed8c349d9570ed9` |
| `assets/desktop-core.aa4f7d67b87d81bf.js` | `aa4f7d67b87d81bf18370a7918064dd67aa1cc1916ccf135f1f88fe6922cc73e` |
| `assets/desktop-core.b673f8050beafdbf.js` | `b673f8050beafdbf94367f0fc8a1485447493e0283a1d44b4fb13b51aaa78dfa` |
| `assets/desktop-deferred.f2e69b29163ddf2c.js` | `f2e69b29163ddf2c70c0c7daefd4e308f21c2adb12d09da67c876ad20e81f77f` |
| `assets/login.a41c71f9960c3ac7.js` | `a41c71f9960c3ac76d500aeba8a8646d6bed58219de2f6ae4e0a24fb4011e017` |
| `assets/terminal.4f94c01b7bb6c365.js` | `4f94c01b7bb6c365ef2ec10fbefced8b4c7c215d92b16da9cc49edd6f707f2d5` |
| `assets/terminal.854a7c0fb70e8b1a.css` | `854a7c0fb70e8b1a083c16797ab827299fb18744f5ad34f227b48337e33293c6` |
| `assets/viewer.47a1f5e1301264d3.css` | `47a1f5e1301264d356e74cfda6a388c1fd5c53660de3a9ba5623bbba7e917499` |
| `css/login.css` | `9c7a65725ed6e765e1b2b1f1cf2909746ad67ee3bcfafe71d3ab18dbabceadef` |
| `css/tokens.css` | `46080bf96e2ad5564b79512d32f98079c80fcdc7f8d9d0f02875f74563b6ddab` |
| `index.html` | `c608bc392c4fbef2b95755f6bbd6a74f8ce30bec1476363c50bb419b15c6c4e7` |
| `viewer.html` | `860811f1224e3562b8879f4129fd5c01b2b723beec230bec9d5bd2cceea6a5e4` |

## Retention, semantics, modes, and recorded lifecycle

The exact old current release de4ac13287760f3b and nearest retained release79bf9a5afea0458e are retained unchanged. The third old release6b2ad956f6a6cdd8 and otherwise-unused desktop-core.e48e2eb2518903c3.js are pruned. Shared old files preserve the seed bytes. Retention remains within three releases, three days, and the67108864-byte bound; unique assets total2143226 bytes. Neither retained release crosses an age threshold in the new fixed window.

New core SHA256 is `6910769b4fc68e56f0520c329c6e7a725f363e004e16e5a6eed8c349d9570ed9`, exactly equal to the independently inspected R4 core. That byte equality preserves the selected-channel quarantine guard (after selecting move or reliable fallback) and explicit `_firstFrameTimer:null`/clear-to-null semantics. This is artifact evidence only.

Every actual new output file is0644. Each output has exactly root/assets/css directories0755. Every private expected file is0600. Package/deployment/template/fixture/expected/input/candidate/seed parent directories checked are0700; receipt files checked are plain owner-owned0600. Both fixture dependency symlinks point to the same primary signal-server/node_modules, whose directory mode is0755. The installed dependency policy remains trusted-existing-installation with directory metadata only; dependency payload byte provenance is not claimed. Actual startup must still match every byte/path/mode inside the fixed window; no mode repair fallback is approved.

Both new child-result files exactly equal their corresponding build-result entries. Each records helper exit0, no timeout, no error/cleanup/ownership error, no signals/intervention, no unexpected coverage, and two recorded Node/esbuild identities exited. allRecordedIdentitiesExited=true remains distinct from completeProcessTreeExitEstablished=false. Original INHERENT coverage is exactly polling-may-miss-fast-orphan, macos-check-to-signal-race, and no-CDP-no-manager-proxy. Full process-tree exit remains **unknown**. This is a check of actual recorded evidence; no new process observation was performed.

## Fresh checker identity correlation and review limits

I read the actual root R5 offline execution record `r5-mixed-native-integration-execution.json`, SHA256 `7c0bb06660d049fcab3eb5d5ff5e6da67b77f1d5379e8be4e006015488ddb8e5`. Its actual result/log bytes both have SHA256 `5267d5384f73aa078278e7f2cf9e3f66a5fe55873f8f282bc9aa8169cac88793`, match the nested recorded result, and bind this exact R5 checker hash, F2 source, component pins, and **actual fresh R5 template build ID bb581651b422e400**. The record reports exit0/no timeout/no error in5.690913898171857seconds, four methods, two accepted, ten rejected,1262rows, passed-offline-only. I did not execute the checker. This correlation satisfies the fresh-template build-equality question and does not upgrade fake-only evidence to runtime/native acceptance.

Only read-only file/hash/JSON/HTML inspection and comparison to my prior independently verified input baseline were used. No operational modules were imported; no tests, rebuild, runtime/process/health/network/browser/native/service action, package/source write, or subagent was used. This report is the sole reviewer write. No operational asset approval receipt was created.

The prior R4 checker failure and expired R4 window remain unchanged. This approval is solely for the exact new R5 context and outputs identified above. Source copy/reload, real startup rebuild/modes, same Host reconnection, quiescence, readiness, browser/native/session qualification, and missing physical/visible/business evidence remain unperformed by this reviewer and are not inferred from static artifact equality.
