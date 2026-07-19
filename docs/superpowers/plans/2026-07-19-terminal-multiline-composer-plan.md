# Terminal Multiline Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-session multiline command editor where `Shift+Enter` inserts a real newline and `Enter` submits the complete command safely to the Shared Terminal.

**Architecture:** Keep composer rules in a small browser-only `TerminalComposer` module: it owns draft storage, LF normalization, keyboard decision rules, and payload encoding. `TerminalPanel` remains the integration adapter: it mounts the textarea, supplies current session/socket state, tracks DEC `?2004h/l` bracketed-paste mode from PTY output, and emits the existing `terminal:input` contract. The Signal Server continues to receive one string and write it unchanged to the PTY.

**Tech Stack:** Vanilla JavaScript, xterm.js, Socket.IO client, Node built-in test runner, HTML/CSS.

**Spec Coverage:** Full coverage of `docs/superpowers/specs/2026-07-19-terminal-multiline-composer-design.md`.

**Truth Source:** `web-client/js/terminal-composer.js` is authoritative for composer drafts, newline normalization, submit eligibility, and payload construction. `web-client/js/terminal.js` is authoritative for the live per-session bracketed-paste capability inferred from PTY output.

**Compatibility Notes:** Raw xterm input remains byte-for-byte compatible. Composer sends `\x1b[200~…\x1b[201~\r` only after the active session has emitted DEC `?2004h`; otherwise it sends the normalized text plus `\r`, preserving every embedded `\n` without inventing a PTY protocol.

**Impact Map:**
- **Truth Source:** `TerminalComposer` owns drafts and serialization; `TerminalPanel` owns observed terminal paste-mode state.
- **Backend:** Not applicable. Existing `terminal:input` accepts string `data` and must remain unchanged.
- **Frontend:** Adds composer markup/styles, a reusable pure module, and `TerminalPanel` integration.
- **Runtime Proof:** Focused Node tests prove keyboard/serialization/mode boundaries; browser acceptance proves real textarea and shell behavior.
- **Docs/Skills:** The approved design spec and this plan are the active documentation; no runbook or skill changes are required.
- **Commit Boundary:** One focused frontend commit containing only the seven implementation/test/UI files and these two docs. Do not commit until the user explicitly asks for a commit.

## File Structure

- Create `web-client/js/terminal-composer.js`: pure browser/CommonJS-compatible composer helpers and draft store.
- Create `web-client/js/terminal-composer.test.js`: unit tests for the pure helper contract.
- Modify `web-client/js/terminal.js`: load the helper, mount composer behavior, preserve drafts by `sessionId`, track `?2004h/l`, and centralize input emission.
- Modify `web-client/js/terminal.test.js`: extend the existing VM harness and prove panel integration.
- Modify `web-client/viewer.html`: add textarea, submit button, hint/status text, and script loading order.
- Modify `web-client/css/viewer.css`: make the terminal workspace shrink safely and style an accessible composer row.

## Task 1: Create the pure composer contract with test-first coverage

**Files:**
- Create: `web-client/js/terminal-composer.test.js`
- Create: `web-client/js/terminal-composer.js`

- [ ] **Step 1: Write the failing composer tests**

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createTerminalDraftStore,
  normalizeTerminalComposerText,
  shouldSubmitTerminalComposerKey,
  serializeTerminalComposerInput,
} = require('./terminal-composer');

test('normalizes pasted CRLF text while preserving real LF newlines', () => {
  assert.equal(normalizeTerminalComposerText('first\r\nsecond\rthird'), 'first\nsecond\nthird');
});

test('does not submit Shift+Enter or an IME composition Enter', () => {
  assert.equal(shouldSubmitTerminalComposerKey({ key: 'Enter', shiftKey: true, isComposing: false }), false);
  assert.equal(shouldSubmitTerminalComposerKey({ key: 'Enter', shiftKey: false, isComposing: true }), false);
  assert.equal(shouldSubmitTerminalComposerKey({ key: 'Enter', shiftKey: false, isComposing: false }), true);
});

test('serializes a multiline draft with bracketed paste only when enabled', () => {
  const text = 'echo one\necho two';
  assert.equal(serializeTerminalComposerInput(text, { bracketedPasteEnabled: true }), '\x1b[200~echo one\necho two\x1b[201~\r');
  assert.equal(serializeTerminalComposerInput(text, { bracketedPasteEnabled: false }), 'echo one\necho two\r');
  assert.equal(serializeTerminalComposerInput('', { bracketedPasteEnabled: true }), '\r');
});

test('keeps unsent drafts isolated by terminal session and deletes closed drafts', () => {
  const drafts = createTerminalDraftStore();
  drafts.set('term-a', 'first\nsecond');
  drafts.set('term-b', 'other');
  drafts.delete('term-a');
  assert.equal(drafts.get('term-a'), '');
  assert.equal(drafts.get('term-b'), 'other');
});
```

- [ ] **Step 2: Verify the new tests fail for the missing module**

Run:

```bash
node --test web-client/js/terminal-composer.test.js
```

Expected: FAIL with `Cannot find module './terminal-composer'`.

- [ ] **Step 3: Implement the minimal pure module**

Create `web-client/js/terminal-composer.js` with this complete public contract:

```js
(function registerTerminalComposer(globalObject) {
  function normalizeTerminalComposerText(value) {
    return String(value ?? '').replace(/\r\n?/g, '\n');
  }

  function shouldSubmitTerminalComposerKey(event = {}) {
    return event.key === 'Enter' && !event.shiftKey && !event.isComposing;
  }

  function serializeTerminalComposerInput(value, options = {}) {
    const text = normalizeTerminalComposerText(value);
    if (!text) return '\r';
    if (options.bracketedPasteEnabled) {
      return `\x1b[200~${text}\x1b[201~\r`;
    }
    return `${text}\r`;
  }

  function createTerminalDraftStore() {
    const drafts = new Map();
    return {
      get(sessionId) { return drafts.get(sessionId) || ''; },
      set(sessionId, value) { drafts.set(sessionId, normalizeTerminalComposerText(value)); },
      delete(sessionId) { drafts.delete(sessionId); },
      clear() { drafts.clear(); },
    };
  }

  const api = {
    createTerminalDraftStore,
    normalizeTerminalComposerText,
    shouldSubmitTerminalComposerKey,
    serializeTerminalComposerInput,
  };
  globalObject.TerminalComposer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: Verify the composer unit tests pass**

Run:

```bash
node --test web-client/js/terminal-composer.test.js
```

Expected: PASS with 4 passing subtests.

## Task 2: Add failing panel integration tests

**Files:**
- Modify: `web-client/js/terminal.test.js`
- Modify: `web-client/js/terminal.js` (only after Step 2 passes)

- [ ] **Step 1: Extend the VM harness to load the composer module and expose composer elements**

In `loadTerminal()`, execute `web-client/js/terminal-composer.js` in the same VM context before executing `terminal.js`. Add `terminalComposer`, `terminalComposerSubmit`, and `terminalComposerHint` to the element map created by `makeElement()` so `TerminalPanel.cacheElements()` sees the same IDs that the browser will render.

- [ ] **Step 2: Add failing integration tests**

Add tests with the existing fake socket/terminal harness:

```js
test('TerminalPanel keeps Shift+Enter local but submits a real multiline draft once', () => {
  const { TerminalPanel, emitted, elements } = loadTerminal();
  TerminalPanel.cacheElements();
  TerminalPanel.socketState = 'connected';
  TerminalPanel.socket = { connected: true, emit(event, payload) { emitted.push([event, payload]); } };
  TerminalPanel.ensureSession({ sessionId: 'term-a', status: 'attached' }, { activate: true });
  TerminalPanel.bracketedPasteSessionIds.add('term-a');
  elements.get('terminalComposer').value = 'echo one\necho two';

  const shiftEnter = { key: 'Enter', shiftKey: true, isComposing: false, preventDefault() { throw new Error('must not prevent'); } };
  TerminalPanel.handleComposerKeydown(shiftEnter);
  assert.equal(emitted.length, 0);

  let prevented = false;
  TerminalPanel.handleComposerKeydown({ key: 'Enter', shiftKey: false, isComposing: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(emitted.at(-1), ['terminal:input', {
    sessionId: 'term-a',
    data: '\x1b[200~echo one\necho two\x1b[201~\r',
    inputId: assert.match,
  }]);
  assert.equal(elements.get('terminalComposer').value, '');
});

test('TerminalPanel tracks bracketed paste mode across split output chunks', () => {
  const { TerminalPanel } = loadTerminal();
  TerminalPanel.trackTerminalModes('term-a', '\x1b[?20');
  TerminalPanel.trackTerminalModes('term-a', '04h');
  assert.equal(TerminalPanel.bracketedPasteSessionIds.has('term-a'), true);
  TerminalPanel.trackTerminalModes('term-a', '\x1b[?2004');
  TerminalPanel.trackTerminalModes('term-a', 'l');
  assert.equal(TerminalPanel.bracketedPasteSessionIds.has('term-a'), false);
});
```

Use concrete assertions for `inputId` and `clientSentAt` that match the existing raw-input tests (assert their types rather than using `assert.match` as a value). Also add a session-switch test that proves `term-a` and `term-b` restore separate drafts and a close-session assertion that deletes the closed draft.

- [ ] **Step 3: Verify the integration tests fail for missing composer behavior**

Run:

```bash
node --test web-client/js/terminal.test.js
```

Expected: FAIL because `TerminalPanel.handleComposerKeydown`, `bracketedPasteSessionIds`, and `trackTerminalModes` do not yet exist.

## Task 3: Implement markup, styles, mode tracking, and panel wiring

**Files:**
- Modify: `web-client/viewer.html`
- Modify: `web-client/css/viewer.css`
- Modify: `web-client/css/viewer-layout.test.js`
- Modify: `web-client/js/terminal.js`

- [ ] **Step 1: Add the composer DOM and script dependency**

Place this after `#terminalWorkspace` in `web-client/viewer.html` and load `js/terminal-composer.js` immediately before `js/terminal.js`:

```html
<div class="terminal-composer" aria-label="多行终端命令编辑器">
  <textarea id="terminalComposer" rows="3" spellcheck="false" autocomplete="off"
    placeholder="输入命令；Shift+Enter 换行，Enter 发送" aria-label="Terminal command editor" disabled></textarea>
  <div class="terminal-composer-actions">
    <span id="terminalComposerHint" class="terminal-composer-hint">Shift+Enter 换行 · Enter 发送</span>
    <button id="terminalComposerSubmit" class="terminal-primary-btn" type="button" disabled>发送</button>
  </div>
</div>
<script src="js/terminal-echo-controller.js"></script>
<script src="js/terminal-composer.js"></script>
<script src="js/terminal.js"></script>
```

- [ ] **Step 2: Add layout and focus styles without changing terminal visual semantics**

Update the terminal panel grid to reserve a final `auto` row for the composer and ensure the terminal workspace can shrink. Add styles equivalent to:

```css
.terminal-panel { grid-template-rows: auto auto auto auto minmax(0, 1fr) auto; }
.terminal-workspace { min-height: 0; }
.terminal-composer { display: grid; gap: 8px; }
.terminal-composer textarea { min-height: 72px; resize: vertical; font: 13px/1.45 'JetBrains Mono', monospace; }
.terminal-composer-actions { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.terminal-composer-hint { color: var(--text-secondary); font: 12px 'JetBrains Mono', monospace; }
.terminal-composer textarea:focus { border-color: var(--border-active); box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.14); outline: none; }
```

Keep the existing `.hidden` behavior and use the project’s current spacing, colors, and responsive conventions for the remaining textarea border/background/disabled rules.

- [ ] **Step 3: Centralize socket input emission and mount the composer**

In `TerminalPanel`:

1. Add `bracketedPasteSessionIds`, `terminalModeTailsBySession`, and `composerDrafts = TerminalComposer.createTerminalDraftStore()` alongside existing per-session maps/sets.
2. Add composer elements in `cacheElements()` and bind `input`, `keydown`, and submit-button `click` listeners in `bindEvents()`.
3. Extract existing raw `term.onData` socket logic into `emitTerminalInput(sessionId, data, { optimisticEcho })`. Preserve `inputId` and `clientSentAt` creation exactly as today. Call it from raw xterm with `{ optimisticEcho: true }`; composer calls it with `{ optimisticEcho: false }` so local echo never writes protocol wrappers.
4. Add `trackTerminalModes(sessionId, data)`. Concatenate the previous per-session tail with current output, apply the last matching `/\x1b\[\?2004([hl])/g` state, and retain the final 16 characters as the next tail. Call it before `trackAlternateScreen()` from `writeOutput()`.
5. Add `refreshComposer()` to restore the active session draft, set disabled state from socket/auth/attached-session readiness, and set the hint to either normal mode or `当前程序未启用 bracketed paste，多行将按原始换行提交`.
6. Add `handleComposerInput()`, `handleComposerKeydown(event)`, and `submitComposer()`. `Shift+Enter` returns without `preventDefault`; ordinary non-IME Enter prevents default and submits. `submitComposer()` serializes through `TerminalComposer.serializeTerminalComposerInput()`, registers the composer submission as pending, clears the unchanged draft only after a matching `terminal:input_ack`, and preserves drafts on disconnected/rejected input.
7. Call `refreshComposer()` after all lifecycle transitions that can change active session or connection readiness: `render()`, `activateSession()`, `handleSessionClosed()`, `destroySocket()`, and terminal auth/connect handlers. Delete drafts/mode tails/paste state in `destroyTerm()`.

- [ ] **Step 4: Verify focused frontend tests pass**

Run:

```bash
node --test web-client/js/terminal-composer.test.js web-client/js/terminal.test.js
```

Expected: PASS with all existing terminal tests plus the new composer and mode-tracking tests.

## Task 4: Run regressions and browser acceptance

**Files:**
- Modify only if a verified defect is found within the planned six implementation files.

- [ ] **Step 1: Run all existing web-client JavaScript tests**

Run:

```bash
node --test web-client/js/*.test.js web-client/css/*.test.js
```

Expected: PASS with no test failures or unhandled-rejection warnings.

- [ ] **Step 2: Perform browser acceptance without restarting services**

Use the already running local viewer. Do not restart Host, Signal Server, or tunnel for this feature. Verify:

1. Open the Terminal tab and authorize normally.
2. Enter `printf 'one'`, press `Shift+Enter`, then enter `printf 'two'`; confirm the textarea visibly contains a newline and no command has been sent yet.
3. Press ordinary `Enter`; confirm one `terminal:input` is emitted and the textarea clears only after it is queued.
4. With a shell that emits `?2004h`, verify the outgoing payload uses bracketed paste boundaries and contains the literal embedded LF; with mode disabled, verify it sends raw text plus `\r`.
5. Create a second session, type different drafts in both, switch tabs, and confirm each draft returns; close one session and confirm its draft does not reappear.
6. Run a raw xterm command and, separately, a full-screen TUI if available; confirm the existing raw-input and alternate-screen behavior remains intact.
7. Check browser console for errors and confirm no diagnostic or application log includes command text.

- [ ] **Step 3: Review the final focused diff**

Run:

```bash
git diff --check
git status --short
git diff -- web-client/js/terminal-composer.js web-client/js/terminal-composer.test.js web-client/js/terminal.js web-client/js/terminal.test.js web-client/viewer.html web-client/css/viewer.css docs/superpowers/specs/2026-07-19-terminal-multiline-composer-design.md docs/superpowers/plans/2026-07-19-terminal-multiline-composer-plan.md
```

Expected: no whitespace errors; no files outside the stated commit boundary except pre-existing user changes.

## Definition of Done

- [ ] `Shift+Enter` inserts a real local `\n` and never emits input by itself.
- [ ] A normal `Enter` sends one complete multiline payload with the exact required LF preservation and safe bracketed-paste boundary when available; the unchanged draft clears only after matching acknowledgement.
- [ ] Drafts are session-local, never persisted, and removed on close/destroy.
- [ ] Existing raw xterm input, alternate-screen protection, Socket.IO schema, and Signal Server behavior remain unchanged.
- [ ] Focused and full web-client Node tests pass; browser acceptance passes without restarting or rebuilding the quick tunnel.
