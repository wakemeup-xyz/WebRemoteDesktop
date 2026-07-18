const LinkQualityController = {
  profiles: {
    high: { name: 'high', width: 1280, height: 720, fps: 20, bitrateKbps: 2500 },
    medium: { name: 'medium', width: 960, height: 540, fps: 15, bitrateKbps: 1400 },
    low: { name: 'low', width: 854, height: 480, fps: 12, bitrateKbps: 900 },
    survival: { name: 'survival', width: 640, height: 360, fps: 8, bitrateKbps: 500 },
  },

  create(options = {}) {
    const order = ['high', 'medium', 'low', 'survival'];
    const now = options.now || Date.now;

    return {
      currentProfile: options.initialProfile || 'high',
      degradedCount: 0,
      criticalCount: 0,
      goodCount: 0,
      startupGraceSamplesRemaining: 0,
      lastPacketsLost: null,
      lastFramesDecoded: null,
      iceRestartAttempted: false,
      profileChanges: [],
      lastProfileChangeAt: 0,

      beginConnection(graceSamples = 2) {
        this.startupGraceSamplesRemaining = Math.max(0, Number(graceSamples) || 0);
        this.degradedCount = 0;
        this.criticalCount = 0;
        this.goodCount = 0;
        this.lastPacketsLost = null;
        this.lastFramesDecoded = null;
        this.iceRestartAttempted = false;
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
        const highRtt = rttMs >= 120;
        const veryHighRtt = rttMs >= 300;
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

        if (mediaStalled || veryHighRtt) {
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
          if (currentIndex > 0 && this.goodCount >= 10 && now() - this.lastProfileChangeAt >= 15000) {
            return this.setProfile(order[currentIndex - 1], 'sustained-good', { action: 'upgrade' });
          }
          return { action: 'hold', profile: this.currentProfile, reason: 'good' };
        }

        if (this.criticalCount >= 2) {
          return this.setProfile('survival', reason, {
            action: 'critical',
            shouldRestartIce: !this.iceRestartAttempted,
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
          });
        }
        return {
          action: extra.action || 'degrade',
          profile,
          from,
          reason,
          profileConfig: LinkQualityController.profiles[profile],
          shouldRestartIce: Boolean(extra.shouldRestartIce),
        };
      },

      snapshot() {
        return {
          enabled: true,
          currentProfile: this.currentProfile,
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
