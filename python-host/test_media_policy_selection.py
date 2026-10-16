"""Pure qualification selection tests; no device, codec, or Host startup."""
import unittest
from dataclasses import replace
from h264_encoder_policy import (
    MediaSessionIntent, QualificationContext, resolve_h264_policy,
    select_measured_media_policy,
)

class TestMeasuredPolicy(unittest.TestCase):
    def test_missing_qualification_keeps_current_codec_and_resolution(self):
        intent = MediaSessionIntent('test-a', 1, 'relay', 1280, 720, 20, 3_200_000)
        current = resolve_h264_policy(intent, 'relay-peak-sliced-v1')
        ctx = QualificationContext('fixture-rev', (('codec', 'fixture-v1'),),
                                   'fixture-machine', 'relay-peak-sliced-v1')
        for fps in (15, 12):
            decision = select_measured_media_policy(
                current, replace(intent, target_fps=fps), {}, context=ctx)
            self.assertFalse(decision.changed)
            self.assertEqual(decision.policy, current)
            self.assertEqual(decision.reason, 'qualification-missing')
            self.assertEqual(intent.target_fps, 20)

from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import ast
import sys
SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
from media_latency_qualification import build_joint_matrix, summarize_joint_qualification
from test_media_latency_qualification import raw_fixture
from media_apply_coordinator import MediaApplyCoordinator, MediaApplyIdentity


def qualified_fixture(intent, candidate, context):
    entry = next(e for e in build_joint_matrix()
                 if e['tuple']['width'] == intent.width and e['tuple']['height'] == intent.height
                 and e['tuple']['policy']['codec_name'] == candidate.codec_name
                 and e['tuple']['policy']['target_fps'] == candidate.target_fps)
    raw = raw_fixture(entry)
    raw['identity'] = {'codeRevision': context.code_revision, 'codecVersions': dict(context.codec_versions),
                       'machineDigest': context.machine_digest}
    return summarize_joint_qualification(raw)


class CompleteQualificationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.intent = MediaSessionIntent('test-a', 1, 'relay', 1280, 720, 20, 3_200_000)
        cls.context = QualificationContext('fixture-rev', (('codec', 'fixture-v1'),),
                                          'fixture-machine', 'relay-peak-sliced-v1')
        with patch.dict('os.environ', {'WRD_RELAY_PEAK_CODEC': 'libx264'}):
            cls.candidate = resolve_h264_policy(cls.intent, cls.context.policy_version)
        cls.current = replace(cls.candidate, codec_name='h264_videotoolbox')
        cls.base = qualified_fixture(cls.intent, cls.candidate, cls.context)

    def select(self, evidence, *, context=None, current=None):
        with patch.dict('os.environ', {'WRD_RELAY_PEAK_CODEC': 'libx264'}):
            return select_measured_media_policy(current or self.current, self.intent, evidence,
                                                context=context or self.context)

    def test_mutating_each_gate_keeps_current(self):
        cases = (
            (lambda e: e['identity'].update(codeRevision='other'), 'qualification-identity-mismatch'),
            (lambda e: e['tuple']['policy'].update(slice_threads=4), 'qualification-tuple-mismatch'),
            (lambda e: e['scenes'][0].update(sampleCount=1), 'qualification-scene-samples'),
            (lambda e: e['scenes'][0].update(encodeP95Ms=26), 'qualification-encode-budget'),
            (lambda e: e['scenes'][0].update(criticalIdrMinPsnr=27.9), 'qualification-idr-psnr'),
            (lambda e: e['scenes'][0].update(periodicIdrCount=1, periodicMaxChangeMae=3.1), 'qualification-idr-change'),
            (lambda e: e['runtime']['resources'].update(condition='unknown'), 'qualification-resources-unavailable'),
            (lambda e: e['runtime'].update(status='NOT RUN'), 'qualification-runtime-incomplete'),
            (lambda e: e['scenes'][0].update(timeoutCount=1), 'qualification-scene-samples'),
            (lambda e: e['scenes'][0].update(droppedCount=1), 'qualification-scene-samples'),
            (lambda e: e['runtime'].update(loopP95Ms=50.01), 'qualification-runtime-budget'),
            (lambda e: e['runtime'].update(inputAckP95Ms=150.01), 'qualification-runtime-budget'),
            (lambda e: e['scenes'].__setitem__(1, deepcopy(e['scenes'][0])), 'qualification-scenes-incomplete'),
        )
        for mutate, reason in cases:
            evidence = deepcopy(self.base); mutate(evidence)
            d = self.select(evidence)
            self.assertFalse(d.changed)
            self.assertEqual(d.policy, self.current)
            self.assertEqual(d.reason, reason)

    def test_missing_each_schema_field_is_rejected(self):
        paths = [(k,) for k in self.base]
        paths += [(parent, k) for parent in ('identity', 'tuple', 'runtime') for k in self.base[parent]]
        paths += [('tuple', 'policy', k) for k in self.base['tuple']['policy']]
        paths += [('inputContract', k) for k in self.base['inputContract']]
        paths += [('scenes', i, k) for i, scene in enumerate(self.base['scenes']) for k in scene]
        paths += [('runtime', 'resources', k) for k in self.base['runtime']['resources']]
        for path in paths:
            evidence = deepcopy(self.base)
            parent = evidence
            for key in path[:-1]: parent = parent[key]
            del parent[path[-1]]
            self.assertFalse(self.select(evidence).changed, path)

    def test_nan_bool_false_counts_and_unhashable_scene_fail_closed(self):
        for key in ('encodeP95Ms', 'criticalIdrMinPsnr', 'sampleCount', 'validFrameCount', 'criticalIdrCount'):
            for value in (float('nan'), True, False, None):
                evidence = deepcopy(self.base); evidence['scenes'][0][key] = value
                self.assertFalse(self.select(evidence).changed, (key, value))
        evidence = deepcopy(self.base); evidence['scenes'][0]['name'] = []
        self.assertFalse(self.select(evidence).changed)
        evidence = deepcopy(self.base); evidence['tuple']['policy']['vbv_init'] = True
        self.assertFalse(self.select(evidence).changed)

    def test_quality_lock_valid_and_already_current(self):
        self.assertEqual(self.select(self.base, context=replace(self.context, quality_locked=True)).reason, 'quality-locked')
        decision = self.select(self.base)
        self.assertTrue(decision.changed)
        self.assertEqual(decision.policy, self.candidate)
        self.assertEqual(self.select(self.base, current=self.candidate).reason, 'already-current')
        self.assertEqual(self.intent.target_fps, 20)


class HostAdaptiveAdapterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        CompleteQualificationTest.setUpClass()
        for key in ('intent', 'context', 'candidate', 'current', 'base'):
            setattr(cls, key, getattr(CompleteQualificationTest, key))
        # Compile the exact method without importing AV/capture/input integrations.
        source = ast.parse(Path(__file__).with_name('host.py').read_text())
        host = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == 'WebRemoteHost')
        method = next(n for n in host.body if isinstance(n, ast.FunctionDef) and n.name == '_request_measured_media_policy')
        ns = {'select_measured_media_policy': select_measured_media_policy}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[])), 'host-adapter', 'exec'), ns)
        cls.adapter = staticmethod(ns['_request_measured_media_policy'])

    def fake_host(self, evidence, *, stale=False):
        coordinator = MediaApplyCoordinator()
        coordinator.bind_attempt('stale' if stale else self.intent.connection_attempt_id)
        calls = []
        def apply(bitrate, policy):
            calls.append(policy)
            result = coordinator.admit(MediaApplyIdentity(policy.connection_attempt_id,
                policy.generation, 0, policy.fingerprint()))
            return {'applied': False, 'applyMode': result.decision}
        state = SimpleNamespace(_h264_policy_provider=SimpleNamespace(current=lambda:
            SimpleNamespace(policy=self.current, intent=self.intent)),
            _adaptive_qualification_context=self.context, _adaptive_local_qualification=evidence,
            _media_session_intent=self.intent, capture=SimpleNamespace(width=1280, height=720, fps=20),
            _apply_encoder_bitrate_kbps=apply)
        return state, coordinator, calls

    def test_rejection_never_requests_apply_or_changes_capture_intent(self):
        host, coordinator, calls = self.fake_host({})
        result = self.adapter(host, replace(self.intent, target_fps=15))
        self.assertFalse(result['applied'])
        self.assertEqual(calls, [])
        self.assertIs(host._media_session_intent, self.intent)
        self.assertEqual(vars(host.capture), {'width': 1280, 'height': 720, 'fps': 20})
        self.assertIsNone(coordinator.pending)

    def test_valid_requests_coordinator_once_and_rejected_is_not_applied(self):
        for stale in (False, True):
            host, coordinator, calls = self.fake_host(self.base, stale=stale)
            with patch.dict('os.environ', {'WRD_RELAY_PEAK_CODEC': 'libx264'}):
                result = self.adapter(host, self.intent)
            self.assertEqual(len(calls), 1)
            self.assertFalse(result['applied'])
            self.assertEqual(result['applyMode'], 'reject' if stale else 'stage')
            self.assertIs(host._media_session_intent, self.intent)
            self.assertIsNone(coordinator.current)

    def test_disabled_local_context_and_resolution_or_network_change(self):
        host, _, calls = self.fake_host(self.base)
        host._adaptive_qualification_context = None
        self.assertFalse(self.adapter(host, self.intent)['applied'])
        host._adaptive_qualification_context = self.context
        for intent in (replace(self.intent, width=1920), replace(self.intent, path='direct')):
            self.assertEqual(self.adapter(host, intent)['reason'], 'adaptive-scope-change')
        self.assertEqual(calls, [])
