#!/usr/bin/env python3
import json
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import turn_catalog  # noqa: E402

FIXTURE = REPO / "fixtures" / "turn" / "catalog-priority.json"


class TurnPriorityParityTests(unittest.TestCase):
    def setUp(self):
        turn_catalog.reset_turn_catalog_cache()

    def tearDown(self):
        turn_catalog.reset_turn_catalog_cache()

    def test_priority_is_integer_only_and_default_matches_fixture(self):
        catalog = turn_catalog.load_turn_catalog(
            env={
                "WRD_TURN_JSON": str(FIXTURE),
                "TURN_URLS": "",
                "TURN_USERNAME": "",
                "TURN_CREDENTIAL": "",
            },
            json_path=str(FIXTURE),
        )
        by_id = {server["id"]: server for server in catalog["servers"]}
        self.assertEqual(by_id["low"]["priority"], 1)
        self.assertEqual(by_id["high"]["priority"], 10)
        self.assertEqual(by_id["bad"]["priority"], 0)
        self.assertEqual(catalog["defaultId"], "high")
        self.assertTrue(by_id["high"]["fingerprint"])
        self.assertNotEqual(by_id["high"]["fingerprint"], by_id["low"]["fingerprint"])


if __name__ == "__main__":
    unittest.main()
