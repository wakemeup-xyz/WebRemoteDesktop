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
   * - relay: forced TURN hairpin; structural RTT is often 80–600ms and must not
   *   thrash into survival or trigger ICE restart by itself.
   *
   * qualityLock (create option, default true):
   * Continuity-first mode. High jitter with fps>0 and structural relay RTT do not
   * step the size ladder; brief/sustained media stalls request keyframe recovery
   * instead of setProfile('survival'). Pair with WebRTC adaptiveResolution off.
   * Pass qualityLock:false to restore the legacy degrade→survival ladder.
   */
  pathPresets: {
    direct: {
      initialProfile: 'high',
      maxProfile: 'high',
      highRttMs: 120,
      veryHighRttMs: 300,
      iceRestartOnVeryHighRtt: true,
      iceRestartOnStall: true,
      startupGraceSamples: 2,
    },
    relay: {
      // Quality Lock: logical start name is informational; size comes from user resolution.
      // Prefer high rate semantics on ~100ms TURN rather than forcing low/900kbps.
      initialProfile: 'high',
      maxProfile: 'high',
      highRttMs: 700,
      veryHighRttMs: 1200,
      iceRestartOnVeryHighRtt: false,
      // Full-relay ICE is already selected; stall is almost always encoder/keyframe
      // warmup or brief decode gaps on 300–600ms RTT — restartIce+offer tears the
      // only working pair and recreates the stall (observed 2026-08-01 logs).
      iceRestartOnStall: false,
      // ~1Hz stats: allow encoder open + VT→x264 fallback + first keyframe on TURN.
      startupGraceSamples: 12,
    },
  },

  create(options = {}) {
    const order = ['high', 'medium', 'low', 'survival'];
    const now = options.now || Date.now;
    const pathName = options.path === 'relay' ? 'relay' : 'direct';
    const preset = LinkQualityController.pathPresets[pathName];

    return {
      path: pathName,
      // Default ON: remote-desktop continuity; unlock only when adaptive size ladder is wanted.
      qualityLock: options.qualityLock != null ? Boolean(options.qualityLock) : true,
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
      startupGraceSamples: Number.isFinite(options.startupGraceSamples)
        ? Math.max(0, Number(options.startupGraceSamples))
        : (Number(preset.startupGraceSamples) || 0),
      degradedCount: 0,
      criticalCount: 0,
      goodCount: 0,
      startupGraceSamplesRemaining: 0,
      lastPacketsLost: null,
      lastFramesDecoded: null,
      lastDecodedDelta: 0,
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
        this.startupGraceSamples = Number(next.startupGraceSamples) || 0;
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
        this.lastDecodedDelta = 0;
        this.iceRestartAttempted = false;
        return { changed: true, path: this.path, profile: this.currentProfile };
      },

      setQualityLock(enabled) {
        this.qualityLock = Boolean(enabled);
        return this.qualityLock;
      },

      beginConnection(graceSamples) {
        const fallback = Number(this.startupGraceSamples);
        const resolved = graceSamples == null
          ? (Number.isFinite(fallback) ? fallback : 2)
          : Number(graceSamples);
        this.startupGraceSamplesRemaining = Math.max(0, Number.isFinite(resolved) ? resolved : 0);
        this.degradedCount = 0;
        this.criticalCount = 0;
        this.goodCount = 0;
        this.lastPacketsLost = null;
        this.lastFramesDecoded = null;
        this.lastDecodedDelta = 0;
        this.iceRestartAttempted = false;
      },

      _bestAllowedIndex() {
        const maxIndex = order.indexOf(this.maxProfile);
        return maxIndex >= 0 ? maxIndex : 0;
      },

      _holdResult(reason, extra = {}) {
        return {
          action: extra.action || 'hold',
          profile: this.currentProfile,
          reason,
          path: this.path,
          profileConfig: null,
          shouldRestartIce: Boolean(extra.shouldRestartIce),
          shouldRequestKeyframe: Boolean(extra.shouldRequestKeyframe),
          decodedDelta: this.lastDecodedDelta,
          changed: false,
        };
      },

      _recoverResult(reason, extra = {}) {
        return this._holdResult(reason, {
          action: extra.action || 'recover',
          shouldRequestKeyframe: extra.shouldRequestKeyframe !== false,
          shouldRestartIce: Boolean(extra.shouldRestartIce),
        });
      },

      observe(stats = {}) {
        const packetsLost = Number(stats.packetsLost || 0);
        const framesDecoded = Number(stats.framesDecoded || 0);
        const hasCanonicalPacketsLostDelta = stats.packetsLostDelta != null;
        const hasCanonicalDecodedDelta = stats.decodedDelta != null;
        const packetsLostDelta = hasCanonicalPacketsLostDelta
          ? Math.max(0, Number(stats.packetsLostDelta) || 0)
          : stats.interval === true
          ? packetsLost
          : this.lastPacketsLost == null
          ? packetsLost
          : Math.max(0, packetsLost - this.lastPacketsLost);
        const decodedDelta = hasCanonicalDecodedDelta
          ? Math.max(0, Number(stats.decodedDelta) || 0)
          : stats.interval === true
          ? Math.max(0, framesDecoded)
          : this.lastFramesDecoded == null
          ? framesDecoded
          : Math.max(0, framesDecoded - this.lastFramesDecoded);

        this.lastPacketsLost = packetsLost;
        this.lastFramesDecoded = framesDecoded;
        this.lastDecodedDelta = decodedDelta;

        const qualityLock = this.qualityLock === true;
        const hasSelectedPair = Boolean(stats.selectedCandidateType);
        const fps = Number(stats.derivedFps ?? stats.fps ?? 0);
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
          return this._holdResult('no-selected-pair');
        }

        if (mediaStalled && this.startupGraceSamplesRemaining > 0) {
          this.startupGraceSamplesRemaining -= 1;
          this.degradedCount = 0;
          this.criticalCount = 0;
          this.goodCount = 0;
          return this._holdResult('media-warmup');
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

        // --- Quality-lock signal reclassification ---
        // Lock: high jitter with frames flowing is observe-only (no size ladder).
        // Lock: relay RTT below veryHigh with fps>0 is structural (no degrade).
        // Lock: media stall uses recover/keyframe, not survival setProfile.
        // Unlock: legacy zeroFps|highRtt|highJitter|highLoss → degrade ladder.
        const structuralRelayRtt = qualityLock
          && this.path === 'relay'
          && fps > 0
          && highRtt
          && !veryHighRtt;
        const jitterWithFrames = qualityLock && highJitter && fps > 0;

        let sampleIsCongested;
        if (qualityLock) {
          sampleIsCongested = highLoss
            || (fps > 0 && veryHighRtt)
            || (fps > 0 && highRtt && !structuralRelayRtt);
          // intentionally exclude: jitterWithFrames, mediaStalled, structuralRelayRtt
        } else {
          sampleIsCongested = zeroFps || highRtt || highJitter || highLoss;
        }

        if (sampleIsCongested) {
          this.degradedCount += 1;
          this.goodCount = 0;
        } else if (fps > 0 && !highRtt && !highJitter && !highLoss) {
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
          return this._holdResult('good');
        } else {
          // observe-only (lock jitter / structural RTT) or lock media-stall path
          this.goodCount = 0;
          if (qualityLock && fps > 0 && (jitterWithFrames || structuralRelayRtt)) {
            // Do not advance degrade streak on observe-only samples.
            return this._holdResult(reason);
          }
        }

        if (this.criticalCount >= 2) {
          // Relay: brief 0-FPS gaps are normal at ~400ms RTT; require sustained
          // stall before survival thrash (each profile apply reopens the encoder).
          const criticalNeeded = (mediaStalled && this.path === 'relay') ? 6 : 2;
          if (this.criticalCount < criticalNeeded) {
            if (qualityLock && mediaStalled) {
              return this._recoverResult(reason || 'media-stalled');
            }
            return this._holdResult(reason);
          }

          const shouldRestartIce = mediaStalled
            ? this.iceRestartOnStall && !this.iceRestartAttempted
            : this.iceRestartOnVeryHighRtt && !this.iceRestartAttempted;

          if (qualityLock) {
            // Continuity: keyframe/diagnostic only — never emit survival size ladder.
            return this._recoverResult(reason, {
              action: 'critical',
              shouldRequestKeyframe: true,
              shouldRestartIce,
            });
          }

          return this.setProfile('survival', reason, {
            action: 'critical',
            shouldRestartIce,
          });
        }

        // Brief media stall under lock: recover before critical threshold.
        if (qualityLock && mediaStalled) {
          return this._recoverResult(reason || 'media-stalled');
        }

        if (this.degradedCount >= 2) {
          const currentIndex = order.indexOf(this.currentProfile);
          const nextProfile = order[Math.min(order.length - 1, currentIndex + 1)];
          if (nextProfile !== this.currentProfile) {
            return this.setProfile(nextProfile, reason, { action: 'degrade' });
          }
        }

        return this._holdResult(reason);
      },

      markIceRestartAttempted() {
        this.iceRestartAttempted = true;
      },

      setProfile(profile, reason, extra = {}) {
        const from = this.currentProfile;
        const changed = from !== profile;
        this.currentProfile = profile;
        if (changed) {
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
          // Only ship config when the profile actually changes — re-applying the
          // same survival/low profile forces Host to reopen the H.264 encoder.
          profileConfig: changed ? LinkQualityController.profiles[profile] : null,
          shouldRestartIce: Boolean(extra.shouldRestartIce),
          shouldRequestKeyframe: Boolean(extra.shouldRequestKeyframe),
          decodedDelta: this.lastDecodedDelta,
          changed,
        };
      },

      snapshot() {
        return {
          enabled: true,
          path: this.path,
          qualityLock: this.qualityLock === true,
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
