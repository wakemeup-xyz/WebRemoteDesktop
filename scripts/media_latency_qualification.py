"""Offline joint qualification. Imports only pure policy/validators, never AV.

The JSON summary is produced only after full raw validation. This module is not
imported by Host; no network message can install its output as local authority.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
import importlib.util
import math
from pathlib import Path
import sys

HOST = Path(__file__).resolve().parents[1] / 'python-host'
if str(HOST) not in sys.path:
    sys.path.insert(0, str(HOST))
from h264_encoder_policy import (H264SessionPolicy, INPUT_CONTRACT, SCENE_MIN,
    MediaSessionIntent, QualificationContext, _qualification_tuple,
    validate_policy_qualification, _same_typed_json)
from turn_encoder_peak_headroom_experiments import (
    REQUIRED_SCENARIOS, build_peak_headroom_sliced2_candidate, validate_full_matrix,
)

MATRIX_VERSION = 'latency-joint-v1'
RESOLUTIONS = ((1152, 720), (1280, 720), (1728, 1080), (1920, 1080))
CODECS = ('libx264', 'h264_videotoolbox')


def build_joint_matrix() -> tuple[dict, ...]:
    """Same fixed peak bitrate/VBV/preset at each exact size, FPS and codec.

    These are experiment candidates, never an expansion of production resolver
    coverage. In particular a 15/12 FPS peak tuple is not currently resolvable.
    """
    rows = []
    for fps in (20, 15, 12):
        for width, height in RESOLUTIONS:
            rate, maximum, buffer = ((3_200_000, 4_800_000, 1000) if height == 720
                                     else (5_000_000, 7_200_000, 1300))
            for codec in CODECS:
                policy = H264SessionPolicy('relay-peak-sliced-v1', codec, fps, 0,
                    1000, rate, rate, rate, 100, 'ultrafast', 'Baseline',
                    vbv_maxrate_bps=maximum, vbv_bufsize_kbits=buffer,
                    vbv_init=1.0, force_idr_option=True, slice_threads=2)
                intent = MediaSessionIntent('offline', 0, 'relay', width, height, fps, rate)
                rows.append({'id': f'{MATRIX_VERSION}:{width}x{height}:{fps}:{codec}',
                             'tuple': _qualification_tuple(intent, policy)})
    return tuple(rows)


@dataclass(frozen=True)
class JointConfig:
    """Adapter into the existing full matrix validator and synthetic producer."""
    entry: dict
    joint = True

    @property
    def policy(self):
        return H264SessionPolicy(**self.entry['tuple']['policy'])

    @property
    def resolutions(self):
        return ((self.entry['tuple']['width'], self.entry['tuple']['height']),)

    @property
    def id(self): return self.entry['id']
    @property
    def codec(self): return self.policy.codec_name
    @property
    def preset(self): return self.policy.preset
    @property
    def profile(self): return self.policy.profile
    @property
    def fps(self): return self.policy.target_fps
    @property
    def periodic_idr_frames(self): return self.policy.periodic_idr_frames
    @property
    def vbv_ms(self): return self.policy.vbv_buffer_ms
    @property
    def vbv_init(self): return self.policy.vbv_init
    @property
    def slice_threads(self): return self.policy.slice_threads
    @property
    def force_idr_option(self): return self.policy.force_idr_option
    @property
    def input_contract(self): return dict(INPUT_CONTRACT)

    def _resolution_map(self, value):
        return {f'{w}x{h}': value for w, h in self.resolutions}
    @property
    def bitrate_by_resolution(self): return self._resolution_map(self.policy.target_bitrate_bps)
    @property
    def vbv_maxrate_by_resolution(self): return self._resolution_map(self.policy.vbv_maxrate_bps)
    @property
    def vbv_bufsize_kbits_by_resolution(self): return self._resolution_map(self.policy.vbv_bufsize_kbits)

    def submitted_options(self, resolution):
        if tuple(resolution) not in self.resolutions:
            raise ValueError('uncovered resolution')
        if self.codec != 'libx264':
            return {}
        # Reuse the frozen peak option generator, changing the actual preset;
        # all joint candidates retain this exact peak GOP/VBV/slice contract.
        base = build_peak_headroom_sliced2_candidate()
        equivalent = (1152, 720) if resolution[1] == 720 else (1728, 1080)
        options = base.submitted_options(equivalent)
        options['preset'] = self.preset
        return options

    def to_dict(self):
        return deepcopy(self.entry)


def _finite(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def _p95(values):
    return sorted(values)[math.ceil(len(values) * .95) - 1]


def _resolution_gates(run, fps):
    # Loading this CLI does not load its optional AV probe or start samplers.
    spec = importlib.util.spec_from_file_location('_joint_quality_gates',
        Path(__file__).with_name('eval-turn-encoder-quality.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module._evaluate_resolution_gates(run, on_demand_only=True, fps=fps, joint=True)


def _raw_scenes(evidence, config):
    """Return recomputed summaries, including violations even on failed rows."""
    errors = validate_full_matrix(evidence, joint_config=config)
    runs = evidence.get('runs', [])
    if len(runs) != 1:
        return [], errors + ['joint run count']
    run = runs[0]
    summaries = []
    instances = {}
    for scenario in run.get('scenarios', []):
        name = scenario['scenarioId']
        requests = next(spec[3] for spec in REQUIRED_SCENARIOS if spec[0] == name)
        frames = scenario['frames']
        local = []
        hashes = scenario.get('sourceHashes')
        if (not isinstance(hashes, list) or len(hashes) != len(frames)
                or any(type(h) is not str or len(h) != 64
                       or any(c not in '0123456789abcdef' for c in h) for h in hashes)):
            local.append('input manifest incomplete')
        records = scenario.get('codecCreationRecords', [])
        record = records[0] if len(records) == 1 else {}
        instance = record.get('instanceId')
        owner = 'scroll' if name in {'scrolling-text', 'post-scroll-static'} else name
        required_record = {'creationIndex', 'reopenReason', 'requestedPreset', 'submittedCodecOptions',
            'configuredBitrateBps', 'configuredAverageBitrateBps', 'submittedVbvMaxrateKbps',
            'submittedVbvBufsizeKbits', 'submittedVbvInit', 'configuredRcMaxRateBps',
            'configuredRcBufferSizeBits', 'instanceId', 'codecName', 'configuredFps',
            'configuredProfile', 'resolution', 'configuredGopFrames'}
        if (not required_record.issubset(record) or not isinstance(instance, str) or not instance
                or (owner in instances and instances[owner] != instance)
                or any(key != owner and value == instance for key, value in instances.items())
                or record.get('codecName') != config.codec
                or record.get('configuredFps') != config.fps
                or record.get('configuredProfile') != config.profile
                or record.get('resolution') != list(config.resolutions[0])
                or record.get('configuredGopFrames') != config.periodic_idr_frames):
            local.append('codec instance/configuration drift')
        instances[owner] = instance
        for offset, frame in enumerate(frames):
            required_frame = {'index', 'phaseIndex', 'inputHash', 'pts', 'timeBase', 'idr',
                'idrKind', 'bitstreamIdrKind', 'requestToken', 'bytes', 'idrBytes', 'psnr',
                'changeMAE', 'encodeMs', 'decodeMs', 'codecInstanceId', 'decodeStatus', 'timeout', 'dropped'}
            if not required_frame.issubset(frame):
                local.append('missing frame field')
            expected_token = f'{name}:{frame.get("index")}' if frame.get('index') in requests else None
            if frame.get('requestToken') != expected_token:
                local.append('frame request token drift')
            if (not isinstance(hashes, list) or offset >= len(hashes)
                    or frame.get('inputHash') != hashes[offset]):
                local.append('input hash drift')
            if (type(frame.get('idr')) is not bool
                    or frame.get('codecInstanceId') != instance
                    or frame.get('decodeStatus') != 'decoded'
                    or any(not _finite(frame.get(k)) for k in ('encodeMs', 'decodeMs', 'psnr', 'changeMAE'))
                    or type(frame.get('bytes')) is not int or frame['bytes'] <= 0
                    or type(frame.get('pts')) is not int
                    or type(frame.get('index')) is not int
                    or type(frame.get('phaseIndex')) is not int
                    or type(frame.get('timeout')) is not bool
                    or type(frame.get('dropped')) is not bool):
                local.append('frame contract drift')
            if not frame.get('idr') and (frame.get('idrKind') is not None
                    or frame.get('bitstreamIdrKind') is not None or frame.get('idrBytes') != 0):
                local.append('non-IDR evidence drift')
        idrs = [f for f in frames if f.get('idr')]
        critical = [f for f in idrs if f.get('idrKind') in {'on-demand', 'initial', 'encoder-safety-net'}]
        initial_safety = [f for f in idrs if f.get('idrKind') in {'initial', 'encoder-safety-net'}]
        periodic = [f for f in idrs if f.get('idrKind') == 'periodic']
        early = [f for f in periodic if .8 <= f['index'] / config.fps <= 1.5]
        # Legacy resolution gates apply to the one-request static probe. The
        # full validator above checks all five scene costs, IDRs and options.
        if name == 'static-text':
            projected = deepcopy(scenario)
            projected['resolution'] = list(config.resolutions[0])
            projected['summary'] = {'encodeMsP95': _p95([f['encodeMs'] for f in frames])}
            for frame in projected['frames']:
                if frame.get('idrKind') == 'on-demand':
                    frame['idrKind'] = 'on-demand-probe'
            if any(g['status'] != 'PASS' for g in _resolution_gates(projected, config.fps).values()):
                local.append('resolution quality/cost gate')
        scene_errors = [e for e in errors if name + ':' in e]
        errors.extend(f'{name}: {error}' for error in local)
        summaries.append({'name': name, 'sampleCount': len(frames),
            'validFrameCount': sum(f.get('decodeStatus') == 'decoded' and not f.get('timeout') and not f.get('dropped') for f in frames),
            'timeoutCount': sum(f.get('timeout') is True for f in frames),
            'droppedCount': sum(f.get('dropped') is True for f in frames),
            'encodeP95Ms': _p95([f['encodeMs'] for f in frames]),
            'criticalIdrCount': len(critical),
            'criticalIdrMinPsnr': min((f['psnr'] for f in critical), default=None),
            'initialSafetyIdrCount': len(initial_safety),
            'initialSafetyMaxChangeMae': max((f['changeMAE'] for f in initial_safety), default=None),
            'periodicIdrCount': len(periodic),
            'periodicMaxChangeMae': max((f['changeMAE'] for f in periodic), default=None),
            'earlyPeriodicIdrCount': len(early),
            'contractViolationCount': len(local) + len(scene_errors)})
    return summaries, errors


def _runtime_summary(raw):
    """Recompute complete-window percentiles, preserving actual resource rows."""
    if not isinstance(raw, dict) or raw.get('status') != 'passed':
        raise ValueError('runtime NOT RUN')
    loop, ack = raw['loopMs'], raw['inputAckMs']
    resources = raw['resources']
    samples = resources['samples']
    if (not loop or not ack or not all(_finite(v) for v in loop + ack)
            or not samples or resources.get('samplerComplete') is not True):
        raise ValueError('runtime incomplete')
    # The complete sampler conclusion covers intervals absent from retained
    # rows. Never erase unknown/pressure intervals by normalizing that window
    # to the healthy subset retained in the artifact.
    if (resources.get('condition') != 'normal'
            or type(resources.get('sampleCount')) is not int
            or resources['sampleCount'] != len(samples)
            or any(type(resources.get(key)) is not int or resources[key] != 0
                   for key in ('unknownCount', 'pressureWarningCount'))):
        raise ValueError('resource window unavailable')
    for row in samples:
        if (row.get('condition') != 'normal'
                or any(not _finite(row.get(k)) for k in
                       ('currentRssMiB', 'swapInBytesPerSec', 'swapOutBytesPerSec'))
                or not isinstance(row.get('queues'), dict) or not row['queues']
                or any(not _finite(v) for v in row['queues'].values())):
            raise ValueError('resource sample unavailable')
    return {'status': raw['status'], 'path': raw['path'], 'durationMs': raw['durationMs'],
            'inputSampleCount': len(ack), 'loopSampleCount': len(loop),
            'loopP95Ms': _p95(loop), 'inputAckP95Ms': _p95(ack),
            'resources': {'condition': resources['condition'], 'samplerComplete': resources['samplerComplete'],
                'sampleCount': resources['sampleCount'], 'unknownCount': resources['unknownCount'],
                'pressureWarningCount': resources['pressureWarningCount'],
                'samples': deepcopy(samples)}}


def _evaluate_joint(evidence):
    try:
        if not isinstance(evidence, dict) or evidence.get('matrixVersion') != MATRIX_VERSION:
            return None, ['joint matrix version']
        entry = next((row for row in build_joint_matrix() if _same_typed_json(evidence.get('config'), row)), None)
        if entry is None:
            return None, ['joint immutable config drift']
        config = JointConfig(entry)
        if config.codec != 'libx264':
            return None, ['joint codec producer unsupported']
        scenes, errors = _raw_scenes(evidence, config)
        try:
            runtime = _runtime_summary(evidence.get('runtime'))
        except (KeyError, TypeError, ValueError):
            runtime = {'status': 'NOT RUN'}
        summary = {'schemaVersion': 1, 'status': 'qualified',
            'identity': deepcopy(evidence['identity']), 'tuple': deepcopy(entry['tuple']),
            'inputContract': dict(INPUT_CONTRACT), 'scenes': scenes, 'runtime': runtime}
        identity = evidence['identity']
        context = QualificationContext(identity['codeRevision'],
            tuple(sorted(identity['codecVersions'].items())), identity['machineDigest'], config.policy.policy_id)
        t = entry['tuple']
        intent = MediaSessionIntent('offline', 0, t['path'], t['width'], t['height'], config.fps, t['requestedBitrateBps'])
        errors.extend(validate_policy_qualification(summary, context=context, intent=intent, candidate=config.policy))
        if errors:
            summary['status'] = 'not-qualified'
        return summary, list(dict.fromkeys(errors))
    except (KeyError, TypeError, ValueError, IndexError, OverflowError, AttributeError, StopIteration):
        return None, ['joint malformed raw evidence']


def validate_joint_qualification(evidence) -> list[str]:
    return _evaluate_joint(evidence)[1]


def summarize_joint_qualification(evidence) -> dict:
    summary, errors = _evaluate_joint(evidence)
    if errors:
        raise ValueError('; '.join(errors))
    return summary


def evaluate_joint_matrix(probe, *, identity):
    """Run the fixed matrix only when explicitly invoked by the offline CLI.

    The present probe records full software codec identity. Hardware has no
    independently verified joint producer contract yet, so it is unsupported.
    An offline matrix never invents the required three-hour runtime samples.
    """
    results = []
    source_manifests = {}
    for entry in build_joint_matrix():
        config = JointConfig(entry)
        if config.codec != 'libx264':
            results.append({'config': entry, 'status': 'unsupported', 'eligible': False})
            continue
        try:
            raw = probe.evaluate_preset_scenario_matrix(config)
            raw.update(matrixVersion=MATRIX_VERSION, identity=deepcopy(identity), runtime={'status': 'NOT RUN'})
            for run in raw.get('runs', []):
                for scene in run.get('scenarios', []):
                    key = (tuple(run['resolution']), scene['scenarioId'])
                    hashes = scene.get('sourceHashes')
                    if key in source_manifests and hashes != source_manifests[key]:
                        raise ValueError('cross-candidate input hash drift')
                    source_manifests[key] = deepcopy(hashes)
            summary, errors = _evaluate_joint(raw)
            results.append({'config': entry, 'raw': raw, 'summary': summary,
                            'errors': errors, 'eligible': False})
        except Exception as exc:
            results.append({'config': entry, 'status': 'failed', 'error': type(exc).__name__, 'eligible': False})
    return {'kind': MATRIX_VERSION, 'status': 'NOT QUALIFIED', 'eligible': False,
            'runtime': {'status': 'NOT RUN'}, 'candidates': results}
