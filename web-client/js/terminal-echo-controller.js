const TerminalEchoController = (() => {
  function readLeadingControlSequence(data) {
    const text = String(data || '');
    if (!text.startsWith('\u001b') || text.length < 2) return '';
    const marker = text[1];
    if (marker === '[') {
      for (let index = 2; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        if (code >= 0x40 && code <= 0x7e) return text.slice(0, index + 1);
      }
      return '';
    }
    if (marker === ']') {
      for (let index = 2; index < text.length; index += 1) {
        if (text[index] === '\u0007') return text.slice(0, index + 1);
        if (text[index] === '\u001b' && text[index + 1] === '\\') return text.slice(0, index + 2);
      }
      return '';
    }
    if (marker === 'P' || marker === 'X' || marker === '^' || marker === '_') {
      for (let index = 2; index < text.length; index += 1) {
        if (text[index] === '\u001b' && text[index + 1] === '\\') return text.slice(0, index + 2);
      }
      return '';
    }
    return text.slice(0, 2);
  }

  function printableInput(data) {
    const text = String(data || '');
    return Boolean(text && text.length <= 64 && /^[\x20-\x7e\u00a0-\uffff]+$/.test(text));
  }

  function create(options = {}) {
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const expiryMs = Number(options.expiryMs || 3000);
    const maxPendingBytes = Number(options.maxPendingBytes || 512);
    let confident = false;
    let alternateScreen = false;
    let probe = '';
    let probeCreatedAt = 0;
    let pendingEcho = '';
    let pendingCreatedAt = 0;

    function reset() {
      confident = false;
      probe = '';
      probeCreatedAt = 0;
      pendingEcho = '';
      pendingCreatedAt = 0;
    }

    function expireStaleState() {
      const current = now();
      if (probe && current - probeCreatedAt > expiryMs) {
        probe = '';
        probeCreatedAt = 0;
      }
      if (pendingEcho && current - pendingCreatedAt > expiryMs) {
        pendingEcho = '';
        pendingCreatedAt = 0;
        confident = false;
      }
    }

    function onInput(data) {
      expireStaleState();
      const text = String(data || '');
      if (alternateScreen || !printableInput(text)) {
        if (text) reset('control-input');
        return { localEcho: '', probe: '' };
      }
      if (!confident) {
        if (!probe) {
          probe = text;
          probeCreatedAt = now();
          return { localEcho: '', probe: text };
        }
        return { localEcho: '', probe: '' };
      }
      pendingEcho = (pendingEcho + text).slice(-maxPendingBytes);
      pendingCreatedAt = now();
      return { localEcho: text, probe: '' };
    }

    function splitLeadingControls(data) {
      let remaining = String(data || '');
      let prefix = '';
      while (remaining) {
        const control = readLeadingControlSequence(remaining);
        if (!control) break;
        prefix += control;
        remaining = remaining.slice(control.length);
      }
      return { prefix, remaining };
    }

    function onRemoteOutput(data) {
      expireStaleState();
      const original = String(data || '');
      if (!original) return '';

      if (probe) {
        const { remaining } = splitLeadingControls(original);
        if (!remaining) return original;
        if (remaining.startsWith(probe)) {
          confident = true;
          probe = '';
          probeCreatedAt = 0;
          return original;
        }
        if (probe.startsWith(remaining)) {
          probe = probe.slice(remaining.length);
          probeCreatedAt = now();
          if (!probe) confident = true;
          return original;
        }
        probe = '';
        probeCreatedAt = 0;
        confident = false;
        return original;
      }

      if (!pendingEcho) return original;
      let output = original;
      let expected = pendingEcho;
      let passthrough = '';
      while (output && expected) {
        const control = readLeadingControlSequence(output);
        if (control) {
          passthrough += control;
          output = output.slice(control.length);
          continue;
        }
        if (output[0] !== expected[0]) {
          pendingEcho = '';
          pendingCreatedAt = 0;
          confident = false;
          return passthrough + output;
        }
        output = output.slice(1);
        expected = expected.slice(1);
      }
      pendingEcho = expected;
      if (!pendingEcho) pendingCreatedAt = 0;
      return passthrough + output;
    }

    function setAlternateScreen(active) {
      alternateScreen = Boolean(active);
      reset(alternateScreen ? 'alternate-screen' : 'primary-screen');
    }

    function snapshot() {
      expireStaleState();
      return {
        confident,
        awaitingProbe: Boolean(probe),
        pendingEchoBytes: pendingEcho.length,
        alternateScreen,
      };
    }

    return {
      onInput,
      onRemoteOutput,
      reset,
      setAlternateScreen,
      snapshot,
    };
  }

  return { create };
})();

if (typeof module !== 'undefined') {
  module.exports = { TerminalEchoController };
}
