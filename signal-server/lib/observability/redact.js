const REDACTED = '[redacted]';
const SECRET_KEY_PATTERN = /(token|secret|password|authorization|cookie|credential)/i;

function isSecretKey(key) {
  return SECRET_KEY_PATTERN.test(String(key || ''));
}

function redactUrl(value) {
  try {
    const parsed = new URL(String(value));
    for (const key of parsed.searchParams.keys()) {
      if (isSecretKey(key)) {
        parsed.searchParams.set(key, REDACTED);
      }
    }
    return parsed.toString();
  } catch (_err) {
    return value;
  }
}

function redactValue(value, key = '') {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactValue(entryValue, entryKey),
      ]),
    );
  }

  if (isSecretKey(key)) {
    return REDACTED;
  }

  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    return redactUrl(value);
  }

  return value;
}

module.exports = {
  REDACTED,
  isSecretKey,
  redactUrl,
  redactValue,
};
