#!/usr/bin/env python3
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import turn_catalog  # noqa: E402
from host import build_ice_servers, get_host_turn_capability  # noqa: E402


class TurnCatalogTests(unittest.TestCase):
    def setUp(self):
        turn_catalog.reset_turn_catalog_cache()
        self._env_backup = {
            key: os.environ.get(key)
            for key in (
                "TURN_URLS",
                "TURN_USERNAME",
                "TURN_CREDENTIAL",
                "WRD_TURN_JSON",
                "WRD_TURN_SERVER_ID",
                "WRD_MEDIA_POLICY",
                "STUN_URLS",
            )
        }
        for key in self._env_backup:
            os.environ.pop(key, None)

    def tearDown(self):
        turn_catalog.reset_turn_catalog_cache()
        for key, value in self._env_backup.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _write_json(self, payload):
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(payload, handle)
        handle.close()
        return handle.name

    def test_load_turn_catalog_prefers_aliyun(self):
        path = self._write_json(
            {
                "turnServers": [
                    {
                        "host": "8.1.1.1",
                        "port": 3478,
                        "username": "u1",
                        "password": "p1",
                        "realm": "aliyun.example",
                        "transport": "udp",
                        "remark": "阿里云节点",
                    },
                    {
                        "host": "9.2.2.2",
                        "port": 3478,
                        "username": "u2",
                        "password": "p2",
                        "realm": "overseas.example",
                        "transport": "udp",
                        "remark": "海外节点",
                    },
                ]
            }
        )
        catalog = turn_catalog.load_turn_catalog(
            env={
                "WRD_TURN_JSON": path,
                "TURN_URLS": "",
                "TURN_USERNAME": "",
                "TURN_CREDENTIAL": "",
            },
            json_path=path,
        )
        self.assertEqual(len(catalog["servers"]), 2)
        self.assertEqual(catalog["defaultId"], "aliyun")
        self.assertTrue(all(server["configured"] for server in catalog["servers"]))

    def test_build_ice_servers_uses_turn_server_id(self):
        path = self._write_json(
            {
                "turnServers": [
                    {
                        "host": "8.1.1.1",
                        "port": 3478,
                        "username": "u1",
                        "password": "p1",
                        "transport": "udp",
                        "remark": "阿里云节点",
                    },
                    {
                        "host": "9.2.2.2",
                        "port": 3478,
                        "username": "u2",
                        "password": "p2",
                        "transport": "udp",
                        "remark": "海外节点",
                    },
                ]
            }
        )
        os.environ["WRD_TURN_JSON"] = path
        os.environ["WRD_MEDIA_POLICY"] = "strict-stun"
        turn_catalog.reset_turn_catalog_cache()

        ice = build_ice_servers("relay", "overseas")
        self.assertEqual(len(ice), 1)
        self.assertEqual(list(ice[0].urls), ["turn:9.2.2.2:3478?transport=udp"])
        self.assertEqual(ice[0].username, "u2")
        self.assertEqual(ice[0].credential, "p2")

        ice_default = build_ice_servers("relay", "does-not-exist")
        self.assertEqual(list(ice_default[0].urls), ["turn:8.1.1.1:3478?transport=udp"])

    def test_get_host_turn_capability_lists_ids(self):
        path = self._write_json(
            {
                "turnServers": [
                    {
                        "host": "8.1.1.1",
                        "port": 3478,
                        "username": "u1",
                        "password": "p1",
                        "transport": "udp",
                        "remark": "阿里云节点",
                    },
                    {
                        "host": "9.2.2.2",
                        "port": 3478,
                        "username": "u2",
                        "password": "p2",
                        "transport": "udp",
                        "remark": "海外节点",
                    },
                ]
            }
        )
        os.environ["WRD_TURN_JSON"] = path
        turn_catalog.reset_turn_catalog_cache()
        caps = get_host_turn_capability()
        self.assertTrue(caps["turnReady"])
        self.assertTrue(caps["supportsMultiTurn"])
        self.assertEqual(caps["defaultTurnServerId"], "aliyun")
        self.assertIn("aliyun", caps["turnServerIds"])
        self.assertIn("overseas", caps["turnServerIds"])
        self.assertEqual(caps["turnServerId"], "aliyun")


if __name__ == "__main__":
    unittest.main()
