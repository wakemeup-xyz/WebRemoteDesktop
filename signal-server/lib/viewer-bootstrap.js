'use strict';

const {
  getTurnStatus,
  getPublicEntryConfig,
  getMediaModeCapabilities,
  listPublicTurnServers,
} = require('./config');

function buildViewerBootstrapSnapshot({
  config,
  hostCapabilities = {},
  hostOnline = false,
  turnServerId = '',
  now = () => new Date().toISOString(),
}) {
  const turnState = getTurnStatus(config, { turnServerId });
  const selectedTurnServerId = turnState.selectedTurnServerId
    || config.selectedTurnServerId
    || config.defaultTurnServerId
    || '';
  const defaultTurnServerId = turnState.defaultTurnServerId
    || config.defaultTurnServerId
    || '';
  const iceServers = [];
  if (config.stunUrls.length) iceServers.push({ urls: config.stunUrls });
  if (turnState.turnConfigured) {
    iceServers.push({
      urls: turnState.turnUrls,
      username: turnState.turnUsername,
      credential: turnState.turnCredential,
    });
  }
  return {
    schemaVersion: 1,
    generatedAt: now(),
    host: { online: Boolean(hostOnline), capabilities: { ...hostCapabilities } },
    webrtc: {
      stunUrls: config.stunUrls,
      turnConfigured: turnState.turnConfigured,
      turnMisconfigured: turnState.turnMisconfigured,
      turnStatus: turnState.turnStatus,
      turnSource: turnState.turnSource || config.turnSource || 'none',
      turnFingerprint: turnState.turnConfigured
        ? (turnState.turnFingerprint || config.turnFingerprint || '')
        : '',
      turnUrls: turnState.turnConfigured ? turnState.turnUrls : [],
      turnServers: listPublicTurnServers(config, selectedTurnServerId),
      selectedTurnServerId,
      defaultTurnServerId,
      iceServers,
      ...getMediaModeCapabilities({ ...config, ...turnState }),
      publicEntry: getPublicEntryConfig(config),
    },
  };
}

function projectLegacyWebrtcConfig(snapshot) {
  const host = snapshot.host || { capabilities: {} };
  const capabilities = host.capabilities || {};
  return {
    ...snapshot.webrtc,
    hostTurnReady: Boolean(capabilities.turnReady),
    hostTurnFingerprint: capabilities.turnFingerprint || '',
    hostTurnServerId: capabilities.turnServerId || capabilities.defaultTurnServerId || '',
    hostSupportsSessionTurn: Boolean(capabilities.supportsSessionTurn),
    hostSupportsMultiTurn: Boolean(capabilities.supportsMultiTurn),
    hostTurnServerIds: Array.isArray(capabilities.turnServerIds) ? capabilities.turnServerIds : [],
  };
}

module.exports = { buildViewerBootstrapSnapshot, projectLegacyWebrtcConfig };
