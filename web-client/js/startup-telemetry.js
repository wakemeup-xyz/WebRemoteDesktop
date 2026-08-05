function createStartupTelemetry({ now = () => performance.now(), origin = (typeof location !== 'undefined' ? location.origin : '') } = {}) {
  const marks = [];
  let resources = [];
  return {
    mark(name, detail = null) {
      if (marks.length >= 64) return false;
      marks.push({
        name: String(name).slice(0, 64),
        atMs: Math.round(now() * 100) / 100,
        detail: detail == null ? null : detail,
      });
      return true;
    },
    recordResources(entries = []) {
      resources = entries.flatMap((entry) => {
        try {
          const url = new URL(entry.name, origin);
          if (url.origin !== origin) return [];
          return [{
            path: url.pathname,
            durationMs: Math.round(Number(entry.duration) * 100) / 100,
          }];
        } catch (_error) {
          return [];
        }
      }).sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
    },
    snapshot() {
      return {
        schemaVersion: 1,
        marks: marks.slice(),
        resources: resources.slice(),
      };
    },
  };
}

if (typeof globalThis !== 'undefined') {
  globalThis.createStartupTelemetry = createStartupTelemetry;
  if (!globalThis.StartupTelemetry) {
    globalThis.StartupTelemetry = createStartupTelemetry();
  }
  globalThis.__WRD_STARTUP_SNAPSHOT__ = () => globalThis.StartupTelemetry.snapshot();
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createStartupTelemetry };
}
