const LinkQualityController = {
  profiles: {
    high: { name: 'high', width: 1280, height: 720, fps: 20, bitrateKbps: 2500 },
    medium: { name: 'medium', width: 960, height: 540, fps: 15, bitrateKbps: 1400 },
    low: { name: 'low', width: 854, height: 480, fps: 12, bitrateKbps: 900 },
    survival: { name: 'survival', width: 640, height: 360, fps: 8, bitrateKbps: 500 },
  },

  /**
   * Path presets:
   * - direct: LAN / STUN / auto short paths (default)
   * - relay: forced TURN hairpin; structural RTT is often 300–600ms and must not
   *   thrash into survival or trigger ICE restart by itself.
   */
  pathPresets: {
    direct: {
      initialProfile: 'high',
      maxProfile: 'high',
      highRttMs: 120,
      veryHighRttMs: 300,
      iceRestartOnVeryHighRtt: true,
      iceRestartOnStall: true,
    },
    relay: {
      initialProfile: 'low',
      maxProfile: 'medium',
      highRttMs: 700,
      veryHighRttMs: 1200,
      iceRestartOnVeryHighRtt: false,
      iceRestartOnStall: true,
    },
  },

  create(options = {}) {
    const order = ['high', 'medium', 'low', 'survival'];
    const now = options.now || Date.now;
    const pathName = options.path === 'relay' ? 'relay' : 'direct';
    const preset = LinkQualityController.pathPresets[pathName];

    return {
      path: pathName,
      currentProfile: options.initialProfile || preset.initialProfile,
      maxProfile: options.maxProfile || preset.maxProfile,
      highRttMs: Number.isFinite(options.highRttMs) ? options.highRttMs : preset.highRttMs,
      veryHighRttMs: Number.isFinite(options.veryHighRttMs) ? options.veryHighRttMs : preset.veryHighRttMs,
      iceRestartOnVeryHighRtt: options.iceRestartOnVeryHighRtt != null
        ? Boolean(options.iceRestartOnVeryHighRtt)
        : preset.iceRestartOnVeryHighRtt,
      iceRestartOnStall: options.iceRestartOnStall != null
        ? Boolean(options.iceRestartOnStall)
        : preset.iceRestartOnStall,
      degradedCount: 0,
      criticalCount: 0,
      goodCount: 0,
      startupGraceSamplesRemaining: 0,
      lastPacketsLost: null,
      lastFramesDecoded: null,
      iceRestartAttempted: false,
      profileChanges: [],
      lastProfileChangeAt: 0,

      _applyPathPreset(path, { resetProfile = true } = {}) {
        const nextPath = path === 'relay' ? 'relay' : 'direct';
        const next = LinkQualityController.pathPresets[nextPath];
        this.path = nextPath;
        this.maxProfile = next.maxProfile;
        this.highRttMs = next.highRttMs;
        this.veryHighRttMs = next.veryHighRttMs;
        this.iceRestartOnVeryHighRtt = next.iceRestartOnVeryHighRtt;
        this.iceRestartOnStall = next.iceRestartOnStall;
        if (resetProfile) {
          this.currentProfile = next.initialProfile;
        } else {
          // Keep quality from getting above the new path ceiling.
          const maxIndex = order.indexOf(this.maxProfile);
          const currentIndex = order.indexOf(this.currentProfile);
          if (currentIndex >= 0 && maxIndex >= 0 && currentIndex < maxIndex) {
            this.currentProfile = this.maxProfile;
          }
        }
      },

      setPath(path, { resetProfile = true } = {}) {
        const nextPath = path === 'relay' ? 'relay' : 'direct';
        if (nextPath === this.path) return { changed: false, path: this.path, profile: this.currentProfile };
        this._applyPathPreset(nextPath, { resetProfile });
        this.degradedCount = 0;
        this.criticalCount = 0;
        this.goodCount = 0;
        this.lastPacketsLost = null;
        this.lastFramesDecoded = null;
        this.iceRestartAttempted = false;
        return { changed: true, path: this.path, profile: this.currentProfile };
      },

      beginConnection(graceSamples = 2) {
        this.startupGraceSamplesRemaining = Math.max(0, Number(graceSamples) || 0);
        this.degradedCount = 0;
        this.criticalCount = 0;
        this.goodCount = 0;
        this.lastPacketsLost = null;
        this.lastFramesDecoded = null;
        this.iceRestartAttempted = false;
      },

      _bestAllowedIndex() {
        const maxIndex = order.indexOf(this.maxProfile);
        return maxIndex >= 0 ? maxIndex : 0;
      },

      observe(stats = {}) {
        const packetsLost = Number(stats.packetsLost || 0);
        const framesDecoded = Number(stats.framesDecoded || 0);
        const packetsLostDelta = stats.interval === true
          ? packetsLost
          : this.lastPacketsLost == null
          ? packetsLost
          : Math.max(0, packetsLost - this.lastPacketsLost);
        const decodedDelta = this.lastFramesDecoded == null
          ? framesDecoded
          : Math.max(0, framesDecoded - this.lastFramesDecoded);

        this.lastPacketsLost = packetsLost;
        this.lastFramesDecoded = framesDecoded;

        const hasSelectedPair = Boolean(stats.selectedCandidateType);
        const fps = Number(stats.fps || 0);
        const rttMs = Number(stats.rttMs || 0);
        const jitterBufferMs = Number(stats.jitterBufferMs || 0);
        const zeroFps = fps === 0;
        const highRtt = rttMs >= this.highRttMs;
        const veryHighRtt = rttMs >= this.veryHighRttMs;
        const highJitter = jitterBufferMs >= 150;
        const highLoss = packetsLostDelta >= 20;
        const mediaStalled = hasSelectedPair && zeroFps;

        const reason = highLoss ? 'packet-loss'
          : veryHighRtt || highRtt ? 'high-rtt'
          : highJitter ? 'jitter'
          : mediaStalled ? 'media-stalled'
          : 'quality';

        if (!hasSelectedPair) {
          this.degradedCount = 0;
          this.criticalCount = 0;
          this.goodCount = 0;
          return { action: 'hold', profile: this.currentProfile, reason: 'no-selected-pair' };
        }

        if (mediaStalled && this.startupGraceSamplesRemaining > 0) {
          this.startupGraceSamplesRemaining -= 1;
          this.degradedCount = 0;
          this.criticalCount = 0;
          this.goodCount = 0;
          return { action: 'hold', profile: this.currentProfile, reason: 'media-warmup' };
        }
        if (!zeroFps) {
          this.startupGraceSamplesRemaining = 0;
        }

        // Structural high RTT on relay must not alone enter critical/ICE restart.
        const criticalSignal = mediaStalled
          || (veryHighRtt && this.iceRestartOnVeryHighRtt);
        if (criticalSignal) {
          this.criticalCount += 1;
        } else {
          this.criticalCount = 0;
        }

        if (zeroFps || highRtt || highJitter || highLoss) {
          this.degradedCount += 1;
          this.goodCount = 0;
        } else {
          this.degradedCount = 0;
          this.criticalCount = 0;
          this.goodCount += 1;
          const currentIndex = order.indexOf(this.currentProfile);
          const bestIndex = this._bestAllowedIndex();
          if (
            currentIndex > bestIndex
            && this.goodCount >= 10
            && now() - this.lastProfileChangeAt >= 15000
          ) {
            return this.setProfile(order[currentIndex - 1], 'sustained-good', { action: 'upgrade' });
          }
          return { action: 'hold', profile: this.currentProfile, reason: 'good' };
        }

        if (this.criticalCount >= 2) {
          const shouldRestartIce = mediaStalled
            ? this.iceRestartOnStall && !this.iceRestartAttempted
            : this.iceRestartOnVeryHighRtt && !this.iceRestartAttempted;
          return this.setProfile('survival', reason, {
            action: 'critical',
            shouldRestartIce,
          });
        }

        if (this.degradedCount >= 2) {
          const currentIndex = order.indexOf(this.currentProfile);
          const nextProfile = order[Math.min(order.length - 1, currentIndex + 1)];
          if (nextProfile !== this.currentProfile) {
            return this.setProfile(nextProfile, reason, { action: 'degrade' });
          }
        }

        return { action: 'hold', profile: this.currentProfile, reason };
      },

      markIceRestartAttempted() {
        this.iceRestartAttempted = true;
      },

      setProfile(profile, reason, extra = {}) {
        const from = this.currentProfile;
        this.currentProfile = profile;
        if (from !== profile) {
          this.lastProfileChangeAt = now();
          this.degradedCount = 0;
          this.criticalCount = 0;
          this.goodCount = 0;
          this.profileChanges.push({
            at: Date.now(),
            from,
            to: profile,
            reason,
            path: this.path,
          });
        }
        return {
          action: extra.action || 'degrade',
          profile,
          from,
          reason,
          path: this.path,
          profileConfig: LinkQualityController.profiles[profile],
          shouldRestartIce: Boolean(extra.shouldRestartIce),
        };
      },

      snapshot() {
        return {
          enabled: true,
          path: this.path,
          currentProfile: this.currentProfile,
          maxProfile: this.maxProfile,
          highRttMs: this.highRttMs,
          veryHighRttMs: this.veryHighRttMs,
          profileChanges: this.profileChanges.slice(-10),
          iceRestart: {
            proactiveAttempted: this.iceRestartAttempted,
            attempts: this.iceRestartAttempted ? 1 : 0,
          },
        };
      },
    };
  },
};

if (typeof module !== 'undefined') {
  module.exports = { LinkQualityController };
}
