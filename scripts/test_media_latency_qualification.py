"""Complete raw fixtures only: never import AV or encode/capture anything."""
from copy import deepcopy
import hashlib
import unittest
from media_latency_qualification import (
    JointConfig, build_joint_matrix, validate_joint_qualification,
    summarize_joint_qualification, evaluate_joint_matrix, _evaluate_joint,
)
from turn_encoder_peak_headroom_experiments import REQUIRED_SCENARIOS


def raw_fixture(entry=None):
    entry = deepcopy(entry or build_joint_matrix()[0])
    config = JointConfig(entry)
    width, height = config.resolutions[0]
    key = f'{width}x{height}'
    scenarios = []
    for name, start, count, requests in REQUIRED_SCENARIOS:
        owner = 'scroll' if name in {'scrolling-text', 'post-scroll-static'} else name
        instance = f'fixture:{owner}'
        frames = []
        for offset in range(count):
            index = start + offset
            kind = 'initial' if index == start and name != 'post-scroll-static' else None
            if index in requests:
                kind = 'on-demand'
            if name == 'safety-net' and index == 1201:
                kind = 'encoder-safety-net'
            source = f'scroll:{offset % 220}' if name == 'scrolling-text' else 'static'
            frames.append({'index': index, 'phaseIndex': offset,
                'inputHash': hashlib.sha256(source.encode()).hexdigest(),
                'pts': index * (90000 // config.fps), 'timeBase': '1/90000',
                'idr': kind is not None, 'idrKind': kind, 'bitstreamIdrKind': kind,
                'requestToken': f'{name}:{index}' if index in requests else None,
                'bytes': 100, 'idrBytes': 100 if kind else 0,
                'psnr': 30.0, 'changeMAE': 0.0, 'encodeMs': 1.0, 'decodeMs': 1.0,
                'codecInstanceId': instance, 'decodeStatus': 'decoded',
                'timeout': False, 'dropped': False})
        hardware = config.codec != 'libx264'
        record = {'creationIndex': 1, 'reopenReason': 'initial', 'requestedPreset': config.preset,
            'submittedCodecOptions': config.submitted_options((width, height)),
            'configuredBitrateBps': config.bitrate_by_resolution[key],
            'configuredAverageBitrateBps': config.bitrate_by_resolution[key],
            'submittedVbvMaxrateKbps': '' if hardware else str(config.vbv_maxrate_by_resolution[key] // 1000),
            'submittedVbvBufsizeKbits': '' if hardware else str(config.vbv_bufsize_kbits_by_resolution[key]),
            'submittedVbvInit': '' if hardware else '1',
            'configuredRcMaxRateBps': None, 'configuredRcBufferSizeBits': None,
            'instanceId': instance, 'codecName': config.codec, 'configuredFps': config.fps,
            'configuredProfile': config.profile, 'resolution': [width, height], 'configuredGopFrames': 0}
        scenarios.append({'scenarioId': name, 'frames': frames,
            'sourceHashes': [f['inputHash'] for f in frames],
            'requestTokens': [f'{name}:{index}' for index in requests],
            'configuredOptions': config.submitted_options((width, height)),
            'codecCreationRecords': [record], 'cost': {'encodeMsP95': 1.0},
            'burst': {'idrBytes': [100 for f in frames if f['idr']]}})
    return {'matrixVersion': 'latency-joint-v1', 'config': entry,
        'input': {'contract': config.input_contract},
        'identity': {'codeRevision': 'fixture-rev', 'machineDigest': 'fixture-machine',
                     'codecVersions': {'codec': 'fixture-v1'}},
        'runs': [{'resolution': [width, height], 'scenarios': scenarios}],
        'runtime': {'status': 'passed', 'path': 'relay', 'durationMs': 10_800_000,
            'loopMs': [5.0] * 100, 'inputAckMs': [10.0] * 100,
            'resources': {'samplerComplete': True, 'condition': 'normal', 'sampleCount': 1,
                'unknownCount': 0, 'pressureWarningCount': 0, 'samples': [{'condition': 'normal',
                'currentRssMiB': 100.0, 'swapInBytesPerSec': 0.0,
                'swapOutBytesPerSec': 0.0, 'queues': {'inputDepth': 0, 'relayDepth': 0}}]}}}


class JointQualificationTest(unittest.TestCase):
    def test_matrix_exact_width_height_fps_and_codec(self):
        matrix = build_joint_matrix()
        self.assertEqual(len(matrix), 24)
        expected = {(fps, w, h, codec) for fps in (20, 15, 12)
                    for w, h in ((1152, 720), (1280, 720), (1728, 1080), (1920, 1080))
                    for codec in ('libx264', 'h264_videotoolbox')}
        self.assertEqual({(r['tuple']['policy']['target_fps'], r['tuple']['width'],
            r['tuple']['height'], r['tuple']['policy']['codec_name']) for r in matrix}, expected)

    def test_raw_validator_passes_at_each_fps_and_summary_recomputes(self):
        for fps in (20, 15, 12):
            entry = next(e for e in build_joint_matrix() if e['tuple']['policy']['target_fps'] == fps)
            raw = raw_fixture(entry)
            self.assertEqual(validate_joint_qualification(raw), [])
            summary = summarize_joint_qualification(raw)
            self.assertEqual(summary['scenes'][0]['criticalIdrCount'], 2)
            self.assertEqual(summary['scenes'][0]['initialSafetyIdrCount'], 1)
            self.assertIsNone(summary['scenes'][0]['periodicMaxChangeMae'])
            self.assertEqual(summary['scenes'][1]['sampleCount'], 1201)

    def test_single_frame_contract_tampering_is_rejected_and_counted(self):
        base = raw_fixture()
        mutations = [
            lambda s: s['frames'][1].update(pts=4501),
            lambda s: s['frames'][1].update(inputHash='f' * 64),
            lambda s: s['frames'][1].update(idr=True, bitstreamIdrKind='periodic', idrKind='periodic'),
            lambda s: s['frames'][1].update(codecInstanceId='other'),
            lambda s: s['codecCreationRecords'][0]['submittedCodecOptions'].update(preset='veryfast'),
            lambda s: s['frames'][5].update(psnr=27.9),
            lambda s: s['frames'][0].update(changeMAE=3.1),
            lambda s: s['frames'][1].update(timeout=True),
            lambda s: s['frames'][1].update(dropped=True),
            lambda s: s['codecCreationRecords'][0].update(configuredFps=12),
            lambda s: s['codecCreationRecords'].append(deepcopy(s['codecCreationRecords'][0])),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                raw = deepcopy(base)
                mutate(raw['runs'][0]['scenarios'][0])
                summary, errors = _evaluate_joint(raw)
                self.assertTrue(errors)
                self.assertNotEqual(summary['status'], 'qualified')
                # Timeouts/drops use dedicated counters; all contract drifts
                # (including raw IDR, PTS, quality and options) count violations.
                scene = summary['scenes'][0]
                self.assertGreater(scene['contractViolationCount'] + scene['timeoutCount'] + scene['droppedCount'], 0)
                with self.assertRaises(ValueError):
                    summarize_joint_qualification(raw)

    def test_raw_missing_and_nonfinite_fields_fail_closed(self):
        base = raw_fixture()
        for key in list(base):
            raw = deepcopy(base); del raw[key]
            self.assertTrue(validate_joint_qualification(raw), key)
        for key in ('psnr', 'encodeMs', 'changeMAE', 'decodeMs', 'pts'):
            for value in (float('nan'), True, None):
                raw = deepcopy(base)
                raw['runs'][0]['scenarios'][0]['frames'][0][key] = value
                self.assertTrue(validate_joint_qualification(raw), (key, value))

    def test_complete_window_resource_failures_cannot_be_erased_by_normal_rows(self):
        base = raw_fixture()
        for change in ({'condition': 'pressure'}, {'unknownCount': 1},
                       {'pressureWarningCount': 1}, {'sampleCount': 2},
                       {'unknownCount': False}, {'pressureWarningCount': float('nan')}):
            raw = deepcopy(base)
            raw['runtime']['resources'].update(change)
            self.assertTrue(validate_joint_qualification(raw), change)
            with self.assertRaises(ValueError):
                summarize_joint_qualification(raw)
        for field in ('condition', 'sampleCount', 'unknownCount', 'pressureWarningCount'):
            raw = deepcopy(base)
            del raw['runtime']['resources'][field]
            self.assertTrue(validate_joint_qualification(raw), field)

    def test_unsupported_hardware_cannot_be_promoted_by_raw_fixture(self):
        raw = raw_fixture(build_joint_matrix()[1])
        self.assertEqual(validate_joint_qualification(raw), ['joint codec producer unsupported'])
        with self.assertRaises(ValueError):
            summarize_joint_qualification(raw)

    def test_runtime_and_resources_remain_required_and_on_demand_mae_is_excluded(self):
        raw = raw_fixture()
        raw['runs'][0]['scenarios'][0]['frames'][5]['changeMAE'] = 99.0
        self.assertEqual(validate_joint_qualification(raw), [])
        for mutate in (
            lambda e: e['runtime'].update(status='NOT RUN'),
            lambda e: e['runtime'].update(inputAckMs=[151.0] * 100),
            lambda e: e['runtime']['resources'].update(samplerComplete=False),
            lambda e: e['runtime']['resources']['samples'][0].update(condition='unknown'),
            lambda e: e['runtime']['resources']['samples'][0].update(swapInBytesPerSec=None),
        ):
            evidence = deepcopy(raw); mutate(evidence)
            self.assertTrue(validate_joint_qualification(evidence))

    def test_pulse_uses_seconds_and_still_reuses_resolution_gate(self):
        from media_latency_qualification import _resolution_gates
        for fps, index in ((12, 10), (15, 12), (20, 16)):
            run = {'resolution': [1280, 720], 'summary': {'encodeMsP95': 1},
                   'frames': [{'index': 5, 'idrKind': 'on-demand-probe', 'psnr': 30},
                              {'index': index, 'idrKind': 'periodic', 'changeMAE': 0}]}
            self.assertEqual(_resolution_gates(run, fps)['qualityPulse']['status'], 'FAIL')
        run['summary']['encodeMsP95'] = 26
        self.assertEqual(_resolution_gates(run, 20)['encodeBudget']['status'], 'FAIL')

    def test_fake_producer_gets_exact_configuration_and_cannot_fake_runtime(self):
        calls = []
        class Probe:
            def evaluate_preset_scenario_matrix(self, config):
                calls.append((config.fps, config.resolutions, config.codec, config.periodic_idr_frames))
                return raw_fixture(config.to_dict())
        result = evaluate_joint_matrix(Probe(), identity=raw_fixture()['identity'])
        self.assertEqual(len(calls), 12)
        self.assertEqual({c[0] for c in calls}, {20, 15, 12})
        self.assertTrue(all(c[2:] == ('libx264', 0) for c in calls))
        self.assertEqual(sum(r.get('status') == 'unsupported' for r in result['candidates']), 12)
        self.assertTrue(all(not r['eligible'] for r in result['candidates']))
        for row in result['candidates']:
            if 'raw' in row:
                self.assertEqual(row['raw']['runtime']['status'], 'NOT RUN')
                self.assertIn('qualification-runtime-incomplete', row['errors'])


if __name__ == '__main__':
    unittest.main()
