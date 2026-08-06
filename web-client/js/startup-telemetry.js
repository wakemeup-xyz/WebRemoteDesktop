function createStartupTelemetry({ now = () => performance.now(), origin = (typeof location !== 'undefined' ? location.origin : '') } = {}) {
  const marks = [];
  let resources = [];

  function hasMark(name) {
    return marks.some((entry) => entry.name === name);
  }

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
    /**
     * Import pre-core marks with their original performance timestamps.
     * Never rewrites an existing mark name; never invents times with `now()`.
     */
    importMarks(entries = []) {
      let imported = 0;
      for (const entry of entries || []) {
        if (!entry || !entry.name || hasMark(entry.name)) continue;
        if (marks.length >= 64) break;
        const atRaw = entry.atMs != null ? entry.atMs : entry.at;
        marks.push({
          name: String(entry.name).slice(0, 64),
          atMs: Math.round(Number(atRaw || 0) * 100) / 100,
          detail: entry.detail == null ? null : entry.detail,
        });
        imported += 1;
      }
      // Keep chronological order by original performance time.
      marks.sort((a, b) => a.atMs - b.atMs);
      return imported;
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
      const shellMarks = (typeof globalThis !== 'undefined'
        && globalThis.__WRD_SHELL__
        && typeof globalThis.__WRD_SHELL__.snapshot === 'function')
        ? (globalThis.__WRD_SHELL__.snapshot().marks || [])
        : [];
      // Merge shell marks by name without changing their original atMs.
      const byName = new Map();
      for (const entry of shellMarks) {
        if (!entry?.name || byName.has(entry.name)) continue;
        const atRaw = entry.atMs != null ? entry.atMs : entry.at;
        byName.set(entry.name, {
          name: String(entry.name).slice(0, 64),
          atMs: Math.round(Number(atRaw || 0) * 100) / 100,
          detail: entry.detail == null ? null : entry.detail,
        });
      }
      for (const entry of marks) {
        if (!byName.has(entry.name)) byName.set(entry.name, entry);
      }
      const merged = [...byName.values()].sort((a, b) => a.atMs - b.atMs);
      return {
        schemaVersion: 1,
        marks: merged,
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
