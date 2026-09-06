const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const css = fs.readFileSync(path.join(__dirname, 'viewer.css'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'viewer.html'), 'utf8');

test('status metrics reserve stable non-wrapping numeric slots', () => {
  assert.match(css, /\.status-metric[\s\S]*white-space:\s*nowrap/);
  assert.match(css, /font-variant-numeric:\s*tabular-nums/);
  assert.match(css, /\.status-metrics[\s\S]*flex-wrap:\s*nowrap/);
  assert.match(css, /overflow:\s*hidden/);
  assert.match(css, /#fpsDisplay\s*\{[\s\S]*min-inline-size:/);
  assert.match(css, /#latencyDisplay\s*\{[\s\S]*inline-size:/);
  assert.match(css, /#candidateDisplay\s*\{[\s\S]*inline-size:/);
});

function getBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Anchor to a line-start rule so prefixed selectors like
  // `body.controls-hidden .network-advisor.visible` cannot steal the block.
  const pattern = new RegExp(`^\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm');
  const match = css.match(pattern);
  assert.ok(match, `missing CSS block for ${selector}`);
  return match[1];
}

function parseDeclarations(block) {
  return Object.fromEntries(block.split(';').map((declaration) => {
    const separator = declaration.indexOf(':');
    if (separator < 0) return null;
    return [declaration.slice(0, separator).trim(), declaration.slice(separator + 1).trim()];
  }).filter(Boolean));
}

function makeViewerHitTestDocument() {
  const chromeDocks = { parent: null, depth: 0, rect: { left: 0, top: 580, width: 390, height: 100 } };
  const mobileKeySurface = {
    id: 'mobileKeySurface', parent: chromeDocks, depth: 1,
    rect: { left: 8, top: 600, width: 374, height: 64 },
  };
  const mobileKeyButton = {
    className: 'mobile-key-btn', parent: mobileKeySurface, depth: 2,
    rect: { left: 14, top: 606, width: 48, height: 44 },
  };
  const remoteVideo = {
    id: 'remoteVideo', parent: null, depth: 0,
    rect: { left: 0, top: 56, width: 390, height: 644 },
  };
  const remoteVideoStyles = parseDeclarations(getBlock('#remoteVideo,\n#relayImage'));
  const styles = new Map([
    [chromeDocks, parseDeclarations(getBlock('.chrome-docks'))],
    [mobileKeySurface, parseDeclarations(getBlock('#mobileKeySurface'))],
    [mobileKeyButton, parseDeclarations(getBlock('#mobileKeySurface .mobile-key-btn'))],
    [remoteVideo, remoteVideoStyles],
  ]);
  const pointerEvents = (element) => styles.get(element)['pointer-events']
    || (element.parent ? pointerEvents(element.parent) : 'auto');
  const stackingOrder = (element) => {
    const declared = Number.parseInt(styles.get(element)['z-index'], 10);
    if (Number.isFinite(declared)) return declared;
    return element.parent ? stackingOrder(element.parent) : 0;
  };
  const containsPoint = (element, x, y) => x >= element.rect.left
    && x <= element.rect.left + element.rect.width
    && y >= element.rect.top
    && y <= element.rect.top + element.rect.height;
  const elements = [remoteVideo, chromeDocks, mobileKeySurface, mobileKeyButton];
  return {
    document: {
      elementFromPoint(x, y) {
        return elements.filter((element) => containsPoint(element, x, y) && pointerEvents(element) !== 'none')
          .sort((left, right) => stackingOrder(right) - stackingOrder(left) || right.depth - left.depth)[0] || null;
      },
    },
    chromeDocks,
  };
}

test('terminal status sits in a named row above the workspace', () => {
  assert.match(css, /grid-template-areas/);
  assert.match(css, /terminal-workspace/);
  const htmlOrder = html.indexOf('id="terminalStatus"');
  const ws = html.indexOf('id="terminalWorkspace"');
  assert.ok(htmlOrder > -1 && ws > htmlOrder);
});

test('terminal composer describes its live submission hint', () => {
  assert.match(html, /id="terminalComposer"[\s\S]*?aria-describedby="terminalComposerHint"/);
  assert.match(html, /id="terminalComposerHint"[^>]*role="status"[^>]*aria-live="polite"/);
});

test('network advisor supports right-edge auto-collapse tab', () => {
  assert.match(html, /id="networkAdvisor"[\s\S]*?id="networkAdvisorHandle"/);
  assert.match(html, /id="networkAdvisorHandleLabel"/);
  assert.match(html, /class="network-advisor__body"/);

  const collapsed = getBlock('.network-advisor.visible.collapsed');
  assert.match(collapsed, /width\s*:\s*44px/, 'collapsed advisor must shrink to a right-edge tab');
  assert.match(collapsed, /right\s*:\s*0/, 'collapsed advisor docks to the right edge');

  const visible = getBlock('.network-advisor.visible');
  assert.match(visible, /pointer-events\s*:\s*auto/, 'visible advisor must accept hover/click');
});

test('status bar groups metrics and actions for operator chrome', () => {
  assert.match(html, /class="status-metrics"/);
  assert.match(html, /class="status-actions"/);
  assert.match(html, /id="keyInputDisplay"[^>]*>键盘：未激活/);
  const metrics = getBlock('.status-metrics');
  assert.match(metrics, /inline-flex/);
});

test('toggle controls is a single status-bar button, not a separate fab', () => {
  assert.match(html, /id="toggleControlsBtn"/);
  assert.doesNotMatch(html, /id="showControlsBtn"/);
  assert.doesNotMatch(html, /id="showControlsFab"/);
  assert.match(css, /#toggleControlsBtn\s*\{/);
  assert.match(css, /body\.(controls-hidden|chrome-idle)\s+#toggleControlsBtn/);
});

test('tokens define chrome geometry and secondary text', () => {
  const tokens = fs.readFileSync(path.join(__dirname, 'tokens.css'), 'utf8');
  assert.match(tokens, /--chrome-top\s*:\s*56px/);
  assert.match(tokens, /--text-secondary\s*:\s*#cbd5e1/i);
  assert.match(tokens, /--touch-min\s*:\s*44px/);
  assert.match(tokens, /--focus-ring/);
});

test('hidden attribute cannot be overridden by flex buttons', () => {
  assert.match(css, /\[hidden\]\s*,\s*\.hidden\s*\{[^}]*display\s*:\s*none\s*!important/);
});

test('viewer css no longer redefines the :root token block', () => {
  assert.doesNotMatch(css, /:root\s*\{[^}]*--bg-primary/);
});

test('viewer layout uses --chrome-top instead of a hardcoded 56px body pad', () => {
  assert.match(css, /padding-top\s*:\s*var\(--chrome-top\)/);
  assert.doesNotMatch(css, /body\s*\{[^}]*padding-top\s*:\s*56px/);
});

test('viewer geometry has a dvh fallback and safe-area-aware dock', () => {
  assert.match(css, /height\s*:\s*calc\(100vh\s*-\s*var\(--chrome-top\)\)/);
  assert.match(css, /height\s*:\s*calc\(100dvh\s*-\s*var\(--chrome-top\)\)/);
  assert.match(css, /bottom:\s*calc\([^;]*env\(safe-area-inset-bottom/);
  assert.match(css, /\.chrome-docks[^}]*flex-direction:\s*column/);
});

test('managed mobile geometry does not compound legacy flow or keyboard padding', () => {
  const managedViewer = getBlock('body.mobile-layout-managed .viewer-container');
  const keySurface = getBlock('#mobileKeySurface');
  assert.doesNotMatch(managedViewer, /100dvh|mobile-dock-height|mobile-keyboard-bottom|text-dock-reserve/);
  assert.doesNotMatch(keySurface, /padding-bottom\s*:/);
  assert.match(css, /body:not\(\.mobile-layout-managed\) \.viewer-container/);
  assert.match(css, /--mobile-keyboard-bottom/);
});

test('managed mobile layout owns one fixed coordinate set and a non-interactive safe-area probe', () => {
  assert.match(html, /id="mobileSafeAreaProbe"[^>]*aria-hidden="true"/);
  const probe = getBlock('#mobileSafeAreaProbe');
  assert.match(probe, /padding-bottom\s*:\s*env\(safe-area-inset-bottom,\s*0px\)/);
  assert.match(probe, /position\s*:\s*fixed/);
  assert.match(probe, /pointer-events\s*:\s*none/);
  assert.match(probe, /visibility\s*:\s*hidden/);
  assert.match(css, /body\.mobile-layout-managed\s*\{[^}]*padding-top\s*:\s*0/);
  assert.match(css, /body\.mobile-layout-managed\s+\.viewer-container\s*\{[^}]*position\s*:\s*fixed/);
  assert.match(css, /body\.mobile-layout-managed\s+\.viewer-container\s*\{[^}]*top\s*:\s*var\(--mobile-viewer-top\)/);
  assert.match(css, /body\.mobile-layout-managed\s+\.viewer-container\s*\{[^}]*height\s*:\s*var\(--mobile-viewer-height\)/);
  assert.match(css, /body\.mobile-layout-managed\s+#statusBar\s*\{[^}]*top\s*:\s*var\(--mobile-visible-top\)/);
  assert.match(css, /body\.mobile-layout-managed\s+\.chrome-docks\s*\{[^}]*bottom\s*:\s*var\(--mobile-dock-bottom\)/);
  assert.match(css, /body\.mobile-layout-managed\.chrome-idle\s+\.chrome-docks\s*\{[^}]*transform\s*:/);
  assert.match(css, /body\.mobile-layout-managed\s+#mobileInputDock\s*\{[^}]*bottom\s*:\s*var\(--mobile-text-bottom\)/);
});

test('compact mobile keys stay a single horizontal 44px strip with both existing role rows', () => {
  const surface = getBlock('body.mobile-layout-managed #mobileKeySurface');
  const row = getBlock('body.mobile-layout-managed #mobileKeySurface .mobile-key-row');
  assert.match(surface, /height\s*:\s*44px/);
  assert.match(surface, /display\s*:\s*flex/);
  assert.match(surface, /flex-wrap\s*:\s*nowrap/);
  assert.match(surface, /overflow-x\s*:\s*auto/);
  assert.match(row, /flex\s*:\s*0\s+0\s+auto/);
  assert.match(row, /flex-wrap\s*:\s*nowrap/);
  assert.match(row, /height\s*:\s*44px/);
  assert.equal((html.match(/class="mobile-key-row"/g) || []).length, 2);
  assert.equal((html.match(/data-mobile-action="right"/g) || []).length, 1);
  assert.equal((html.match(/data-mobile-action="switchInputMethod"/g) || []).length, 1);
});

test('managed compact controls remain an overlay outside the navigation row', () => {
  assert.match(css, /body\.mobile-layout-managed\.mobile-layout-compact[\s\S]*?\.control-bar\s*\{[^}]*display:\s*none/);
  assert.match(css, /body\.mobile-layout-managed #moreActionsMenu \.control-btn\s*\{[^}]*min-height:\s*var\(--touch-min\)/);
  assert.match(css, /body\.mobile-layout-managed \.chrome-docks > \.action-bar\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /body\.mobile-layout-managed \.chrome-docks > \.action-bar\s*\{[^}]*overflow:\s*visible/);
  assert.match(css, /body\.mobile-layout-managed\.mobile-layout-ultra \.chrome-docks > \.action-bar\s*\{[^}]*top:\s*calc\(/);
  assert.match(css, /body\.mobile-layout-managed\.mobile-layout-ultra \.chrome-docks > \.action-bar > \.more-actions-menu\s*\{[^}]*top:\s*0/);
});

test('narrow action row remains one line with stable touch widths', () => {
  assert.match(css, /@media\s*\(max-width:\s*899px\)[\s\S]*?\.action-bar[^{]*\{[^}]*flex-wrap:\s*nowrap/);
  assert.match(css, /@media\s*\(max-width:\s*899px\)[\s\S]*?\.action-bar[^{]*\{[^}]*overflow-x:\s*auto/);
  assert.match(css, /\.action-bar\s+\.action-btn[^}]*min-width:\s*var\(--touch-min\)/);
});

test('mobile input reserves touch targets and keyboard safe area', () => {
  assert.match(html, /id="mobileTextInput"/);
  assert.match(html, /id="mobileTextInput"[^>]*inputmode="text"/);
  assert.match(html, /id="mobileInputDock"/);
  const textInput = getBlock('#mobileTextInput');
  const mobileDock = getBlock('#mobileInputDock');
  const mobileControls = getBlock('#mobileInputDock .control-btn');
  assert.match(textInput, /touch-action\s*:\s*none/);
  assert.match(mobileDock, /env\(safe-area-inset-bottom/);
  assert.match(mobileDock, /env\(keyboard-inset-height/);
  assert.match(mobileControls, /min-height\s*:\s*var\(--touch-min\)/);
});

test('mobile virtual key surface exposes accessible navigation, modifiers, shortcuts, and right click', () => {
  for (const action of ['escape', 'tab', 'backspace', 'enter', 'up', 'down', 'left', 'right', 'shift', 'ctrl', 'alt', 'meta', 'rightClick', 'copy', 'paste', 'cut', 'undo', 'selectAll', 'save', 'find', 'screenshot', 'switchInputMethod']) {
    assert.match(html, new RegExp(`data-mobile-action="${action}"`), `missing mobile ${action} button`);
  }
  assert.match(html, /id="mobileKeySurface"[^>]*aria-label="移动远程控制按键"/);
  assert.match(html, /data-mobile-action="shift"[^>]*aria-pressed="false"[^>]*aria-label="Shift"/);
  assert.match(html, /data-mobile-action="rightClick"[^>]*aria-label="右键点击"/);

  const keySurface = getBlock('#mobileKeySurface');
  const keyRow = getBlock('.mobile-key-row');
  const keyButtons = getBlock('#mobileKeySurface .mobile-key-btn');
  assert.doesNotMatch(keySurface, /padding-bottom\s*:/);
  assert.match(keySurface, /height\s*:\s*44px/);
  assert.match(keySurface, /overflow-x\s*:\s*auto/);
  assert.match(keyRow, /flex\s*:\s*0\s+0\s+auto/);
  assert.match(keyRow, /flex-wrap\s*:\s*nowrap/);
  assert.match(keyRow, /height\s*:\s*44px/);
  assert.match(keyButtons, /min-width\s*:\s*var\(--touch-min\)/);
  assert.match(keyButtons, /min-height\s*:\s*var\(--touch-min\)/);
  assert.match(keyButtons, /touch-action\s*:\s*manipulation/);
  assert.match(keySurface, /pointer-events\s*:\s*auto/);
  assert.match(keyButtons, /pointer-events\s*:\s*auto/);
});

test('mobile virtual key hit testing reaches the surface and button through pointer-disabled docks', () => {
  const browser = makeViewerHitTestDocument();
  assert.equal(parseDeclarations(getBlock('.chrome-docks'))['pointer-events'], 'none');
  assert.equal(browser.document.elementFromPoint(320, 632)?.id, 'mobileKeySurface');
  assert.equal(browser.document.elementFromPoint(32, 628)?.className, 'mobile-key-btn');
});

test('media surfaces suppress browser touch gestures', () => {
  const surfaces = getBlock('#remoteVideo,\n#relayImage');
  assert.match(surfaces, /touch-action\s*:\s*none/);
});

test('docks share one fixed column wrapper', () => {
  assert.match(html, /id="chromeDocks"[\s\S]*class="action-bar"[\s\S]*class="control-bar"/);
  const docks = getBlock('.chrome-docks');
  assert.match(docks, /position\s*:\s*fixed/);
  assert.match(docks, /flex-direction\s*:\s*column/);
  // getBlock() is a first-substring matcher; `.chrome-docks .control-bar {`
  // would steal `.control-bar`. Anchor to a line-start rule instead.
  assert.match(css, /(?:^|\n)\.action-bar\s*\{[^}]*display\s*:\s*flex/);
  assert.doesNotMatch(css, /(?:^|\n)\.action-bar\s*\{[^}]*position\s*:\s*fixed/);
  assert.match(css, /(?:^|\n)\.control-bar\s*\{[^}]*display\s*:\s*flex/);
  assert.doesNotMatch(css, /(?:^|\n)\.control-bar\s*\{[^}]*position\s*:\s*fixed/);
});

test('connected docks no longer use hover-only 0.22 opacity', () => {
  assert.doesNotMatch(css, /body\.stream-connected[^{]*\{[^}]*opacity\s*:\s*0\.22/);
});

test('narrow overflow menu exists', () => {
  assert.match(html, /id="moreActionsBtn"/);
  assert.match(html, /id="moreActionsMenu"/);
  assert.match(css, /min-height\s*:\s*var\(--touch-min\)/);
  assert.match(html, /data-action="enter"[^>]*data-pin="always"/);
  assert.match(html, /id="keyboardModeBtn"[^>]*data-pin="always"/);
  assert.match(html, /id="portSearchBtn"[^>]*class="control-btn"/);
  assert.match(css, /#moreActionsMenu\s+\.action-btn\s*\{[^}]*display\s*:\s*flex/);
  assert.match(css, /@media\s*\(max-width:\s*899px\)/);
});

test('narrow advisor cannot stretch to half the viewport', () => {
  assert.match(css, /max-height\s*:\s*min\(\s*240px,\s*40vh\s*\)/);
  assert.match(css, /align-items\s*:\s*flex-start/);
  const body = getBlock('.network-advisor.visible:not(.collapsed) .network-advisor__body');
  assert.match(body, /max-height\s*:\s*min\(\s*240px,\s*40vh\s*\)/, 'body must have a real max-height so overflow can scroll');
  assert.match(body, /min-height\s*:\s*0/);
  assert.match(body, /overflow-y\s*:\s*auto/);
});

test('placeholder spinner is opt-in via is-connecting', () => {
  assert.match(css, /\.stream-placeholder:not\(\.is-connecting\)\s+\.spinner/);
  assert.match(html, /id="exitFullscreenBtn"/);
});

test('fullscreen owns the document root while the exit control stays in global status chrome', () => {
  assert.doesNotMatch(css, /\.viewer-container:fullscreen/);
  assert.match(css, /html:fullscreen\s+\.viewer-container/);
  assert.match(css, /html:fullscreen\s+\.fullscreen-exit-btn/);
  const fullscreenMedia = css.match(/html:fullscreen\s+\.viewer-container #remoteVideo,[\s\S]*?\}/)?.[0] || '';
  assert.match(fullscreenMedia, /width:\s*100%;/);
  assert.match(fullscreenMedia, /height:\s*100%;/);
  const fullscreenViewer = css.match(/html:fullscreen\s+\.viewer-container\s*\{[^}]*\}/)?.[0] || '';
  assert.match(fullscreenViewer, /height:\s*calc\(100dvh\s*-\s*var\(--chrome-top\)\)/);
  assert.equal((html.match(/id="exitFullscreenBtn"/g) || []).length, 1);
  const statusStart = html.indexOf('class="status-actions"');
  const statusEnd = html.indexOf('</div>', statusStart);
  assert.ok(statusStart >= 0 && statusEnd > statusStart);
  assert.match(html.slice(statusStart, statusEnd), /id="exitFullscreenBtn"/);
  const viewerStart = html.indexOf('<div class="viewer-container">');
  const viewerEnd = html.indexOf('\n    </div>\n\n    <div id="chromeDocks"', viewerStart);
  assert.ok(viewerStart >= 0 && viewerEnd > viewerStart);
  assert.doesNotMatch(html.slice(viewerStart, viewerEnd), /id="exitFullscreenBtn"/);
  assert.match(html, /id="fullscreenStatus"[^>]*role="status"[^>]*aria-live="polite"[^>]*hidden/);
  assert.match(html, /id="fullscreenBtn"[^>]*data-core-control/);
});

test('workspace tabs expose tab semantics', () => {
  assert.match(html, /id="desktopTabBtn"[^>]*role="tab"[^>]*aria-controls="desktopPanel"/);
  assert.match(html, /id="terminalTabBtn"[^>]*role="tab"[^>]*aria-controls="terminalPanel"/);
  assert.match(html, /id="resolutionModal"[^>]*role="dialog"/);
  assert.match(html, /id="networkModal"[^>]*role="dialog"/);
  assert.match(html, /id="diagModal"[^>]*role="dialog"/);
  assert.doesNotMatch(html, /min-width:\s*600px/);
});
