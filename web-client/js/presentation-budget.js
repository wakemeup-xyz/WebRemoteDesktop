'use strict';

(function (root) {
  const PRESENTATION_RUNGS = Object.freeze([
    Object.freeze({ width: 960, height: 540, label: '960x540' }),
    Object.freeze({ width: 1280, height: 720, label: '1280x720' }),
    Object.freeze({ width: 1600, height: 900, label: '1600x900' }),
    Object.freeze({ width: 1920, height: 1080, label: '1920x1080' }),
  ]);

  function nearestPresentationRung(width, height) {
    const pixels = Math.max(1, Number(width) * Number(height) || 1);
    let best = PRESENTATION_RUNGS[1];
    let bestDelta = Infinity;
    for (const rung of PRESENTATION_RUNGS) {
      const delta = Math.abs(rung.width * rung.height - pixels);
      if (delta < bestDelta) {
        best = rung;
        bestDelta = delta;
      }
    }
    return { ...best };
  }

  function pathCapForMode(networkMode, lastCandidateType) {
    const relay = networkMode === 'relay' || lastCandidateType === 'relay';
    return relay
      ? { width: 1280, height: 720, label: '1280x720' }
      : { width: 1920, height: 1080, label: '1920x1080' };
  }

  function computeSessionPresentation({
    userPreference,
    networkMode,
    lastCandidateType,
    explicitOverride1080 = false,
  } = {}) {
    const pref = nearestPresentationRung(
      Number(userPreference?.width) || 1280,
      Number(userPreference?.height) || 720,
    );
    const cap = pathCapForMode(networkMode, lastCandidateType);
    const override = explicitOverride1080 === true && pref.width >= 1920;
    if (override || pref.width * pref.height <= cap.width * cap.height) {
      return {
        ...pref,
        capped: false,
        pathCap: cap,
        userPreference: pref,
        explicitOverride1080: override,
      };
    }
    return {
      ...cap,
      capped: true,
      pathCap: cap,
      userPreference: pref,
      explicitOverride1080: false,
    };
  }

  const api = { PRESENTATION_RUNGS, nearestPresentationRung, pathCapForMode, computeSessionPresentation };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PresentationBudget = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
