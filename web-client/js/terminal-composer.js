(function registerTerminalComposer(globalObject) {
  function normalizeTerminalComposerText(value) {
    return String(value ?? '').replace(/\r\n?/g, '\n');
  }

  function shouldSubmitTerminalComposerKey(event = {}) {
    return (
      event.key === 'Enter'
      && event.key !== 'Process'
      && event.keyCode !== 229
      && !event.shiftKey
      && !event.ctrlKey
      && !event.altKey
      && !event.metaKey
      && !event.isComposing
    );
  }

  function serializeTerminalComposerInput(value, options = {}) {
    const text = normalizeTerminalComposerText(value);
    if (!text) {
      return '\r';
    }
    if (options.bracketedPasteEnabled) {
      return `\x1b[200~${text}\x1b[201~\r`;
    }
    return `${text}\r`;
  }

  function getTerminalComposerUtf8ByteLength(value) {
    const text = String(value ?? '');
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(text).byteLength;
    }
    let byteLength = 0;
    for (let index = 0; index < text.length; index += 1) {
      const codePoint = text.codePointAt(index);
      if (codePoint <= 0x7f) {
        byteLength += 1;
      } else if (codePoint <= 0x7ff) {
        byteLength += 2;
      } else if (codePoint <= 0xffff) {
        byteLength += 3;
      } else {
        byteLength += 4;
        index += 1;
      }
    }
    return byteLength;
  }

  function createTerminalDraftStore() {
    const drafts = new Map();
    return {
      get(sessionId) {
        return drafts.get(sessionId) || '';
      },
      set(sessionId, value) {
        drafts.set(sessionId, normalizeTerminalComposerText(value));
      },
      delete(sessionId) {
        drafts.delete(sessionId);
      },
      clear() {
        drafts.clear();
      },
    };
  }

  const api = {
    createTerminalDraftStore,
    getTerminalComposerUtf8ByteLength,
    normalizeTerminalComposerText,
    shouldSubmitTerminalComposerKey,
    serializeTerminalComposerInput,
  };

  globalObject.TerminalComposer = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
