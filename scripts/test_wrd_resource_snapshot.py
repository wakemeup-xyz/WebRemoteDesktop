import importlib.util
import unittest
from pathlib import Path


class ResourceSnapshotTest(unittest.TestCase):
    def test_import_is_passive_and_pid_is_mandatory(self):
        path = Path(__file__).with_name('wrd_resource_snapshot.py')
        spec = importlib.util.spec_from_file_location('resource_snapshot_cli', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with self.assertRaises(ValueError):
            module.validate_pid(None, {1})
        with self.assertRaises(ValueError):
            module.validate_pid(2, {1})
        self.assertEqual(module.validate_pid(1, {1}), 1)

    def test_parse_macos_counters_and_current_rss(self):
        from scripts.wrd_resource_snapshot import parse_vm_stat, parse_ps_rss
        parsed = parse_vm_stat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nSwapins: 12.\nSwapouts: 34.\n')
        self.assertEqual(parsed, {'pageSize': 16384, 'swapIns': 12, 'swapOuts': 34})
        self.assertEqual(parse_ps_rss('102400\n'), 100.0)
        self.assertIsNone(parse_ps_rss('unavailable'))
