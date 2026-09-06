"""Child-scoped controller for loopback-only encoder experiments."""

from __future__ import annotations

import secrets
import shutil
import signal
import subprocess
import tempfile
import json
import os
import sys
from urllib.request import Request, urlopen
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping



@dataclass(frozen=True)
class ProductionProof:
    realm: str
    token: str
    epoch: int
    viewer_count: int

    def __post_init__(self) -> None:
        if self.realm != "production" or not self.token or self.epoch < 0 or self.viewer_count != 0:
            raise ValueError("production proof requires a zero-viewer production admission")


class ProductionAdmissionClient:
    """Read-only production admission client; credentials stay caller-owned."""
    def __init__(self, *, origin: str, viewer_token: str) -> None:
        self.origin = origin.rstrip("/")
        self.viewer_token = viewer_token

    def admit(self) -> ProductionProof:
        headers = {"Authorization": f"Bearer {self.viewer_token}"}
        with urlopen(Request(f"{self.origin}/api/status"), timeout=5) as response:
            status = json.loads(response.read().decode("utf-8"))
        if int(status.get("viewerCount") or 0) != 0:
            raise RuntimeError("human Viewer present; lab refused")
        with urlopen(Request(f"{self.origin}/api/proof-admission", method="POST", headers=headers), timeout=5) as response:
            admitted = json.loads(response.read().decode("utf-8"))
        admission = admitted.get("admission") or {}
        if response.status != 201 or not admission.get("token") or admission.get("epoch") != status.get("viewerEpoch"):
            raise RuntimeError("production proof admission was not granted")
        return ProductionProof("production", str(admission["token"]), int(admission["epoch"]), 0)

    def status(self) -> tuple[int, int]:
        with urlopen(Request(f"{self.origin}/api/status"), timeout=5) as response:
            status = json.loads(response.read().decode("utf-8"))
        return int(status.get("viewerEpoch") or -1), int(status.get("viewerCount") or 0)


@dataclass(frozen=True)
class LabSignal:
    origin: str
    realm: str
    host_secret: str
    viewer_password: str
    stop: Callable[[], None]


@dataclass(frozen=True)
class LabIdentity:
    run_id: str
    origin: str
    epoch: int
    realm: str
    _proof_token: str

    def accepts_proof(self, proof: Mapping[str, Any]) -> bool:
        return proof.get("realm") == self.realm and proof.get("epoch") == self.epoch and proof.get("token") == self._proof_token


class LabRun:
    def __init__(self, *, runtime_root: Path | None = None, signal_launcher: Callable[..., LabSignal] | None = None, production_probe: Callable[[], ProductionProof] | None = None, lab_proof_issuer: Callable[[LabSignal], Mapping[str, Any]] | None = None) -> None:
        self._runtime_root = Path(runtime_root) if runtime_root else None
        self._signal_launcher = signal_launcher
        self._production_probe = production_probe
        self._lab_proof_issuer = lab_proof_issuer or self._issue_lab_proof
        self._runtime_dir: Path | None = None
        self._stop_signal: Callable[[], None] | None = None
        self._children: list[subprocess.Popen[Any]] = []
        self.identity: LabIdentity | None = None
        self._context: dict[str, Any] | None = None
        self._lab_host_secret = ""
        self._lab_viewer_password = ""
        self._production_epoch = -1
        self.closed = True

    def start(self, mode: str, manifest: Mapping[str, Any] | None = None) -> LabIdentity:
        if mode not in {"legacy", "candidate"}:
            raise ValueError("lab mode must be legacy or candidate")
        if self._production_probe is None:
            raise RuntimeError("production proof is required before starting a lab")
        production_proof = self._production_probe.admit() if isinstance(self._production_probe, ProductionAdmissionClient) else self._production_probe()
        if not isinstance(production_proof, ProductionProof):
            raise RuntimeError("production probe returned no verified proof")
        if production_proof.viewer_count:
            raise RuntimeError("human Viewer present; lab refused")
        if mode == "candidate":
            if manifest is None:
                raise ValueError("candidate manifest is required")
            # Importing the Host module is deliberately deferred.  A real lab
            # Host receives SERVER_URL in its child environment before that
            # module (and therefore host.py) can be imported.
            from turn_lab_host import verify_candidate_manifest
            verify_candidate_manifest(manifest)
        self.close()
        parent = self._runtime_root or Path(tempfile.gettempdir())
        parent.mkdir(parents=True, exist_ok=True)
        self._runtime_dir = Path(tempfile.mkdtemp(prefix="wrd-turn-lab-", dir=parent))
        run_id = secrets.token_hex(12)
        realm = f"lab-{run_id}"
        try:
            signal_runtime = (self._signal_launcher or self._spawn_signal)(self._runtime_dir, realm)
            if signal_runtime.realm != realm or not signal_runtime.host_secret:
                raise RuntimeError("lab signal realm or temporary credential mismatch")
            origin = signal_runtime.origin
            if not origin.startswith("http://127.0.0.1:") or origin.endswith(":8080"):
                raise RuntimeError("lab signal returned an unsafe origin")
            lab_proof = self._lab_proof_issuer(signal_runtime)
            self._stop_signal = signal_runtime.stop
            self.identity = LabIdentity(run_id, origin, int(lab_proof["epoch"]), realm, str(lab_proof["token"]))
            self._lab_host_secret = signal_runtime.host_secret
            self._lab_viewer_password = signal_runtime.viewer_password
            self._production_epoch = production_proof.epoch
            self._context = {"origin": origin, "realm": realm, "proofToken": self.identity._proof_token, "epoch": self.identity.epoch, "mode": mode}
            self.closed = False
            return self.identity
        except Exception:
            self.close()
            raise

    def _spawn_signal(self, runtime_dir: Path, realm: str) -> LabSignal:
        # The executable is an independent child and returns its random port on
        # stdout. It never receives production credentials or a production URL.
        script = Path(__file__).with_name("turn-lab-signal.js")
        proc = subprocess.Popen(["node", str(script), "--json", "--realm", realm], cwd=script.parent.parent, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        self._children.append(proc)
        line = proc.stdout.readline().strip() if proc.stdout else ""
        if not line.startswith("{"):
            raise RuntimeError("lab signal did not publish a loopback identity")
        payload = json.loads(line)
        def stop() -> None:
            if proc.poll() is None:
                proc.terminate()
                try: proc.wait(timeout=5)
                except subprocess.TimeoutExpired: proc.kill(); proc.wait(timeout=5)
        return LabSignal(str(payload["origin"]), str(payload["realm"]), str(payload["hostSecret"]), str(payload["viewerPassword"]), stop)

    def _issue_lab_proof(self, signal_runtime: LabSignal) -> Mapping[str, Any]:
        login = Request(f"{signal_runtime.origin}/api/auth/login", method="POST", data=json.dumps({"password": signal_runtime.viewer_password}).encode(), headers={"Content-Type": "application/json"})
        with urlopen(login, timeout=5) as response:
            token = json.loads(response.read().decode())["token"]
        proof = Request(f"{signal_runtime.origin}/api/proof-admission", method="POST", headers={"Authorization": f"Bearer {token}"})
        with urlopen(proof, timeout=5) as response:
            admission = json.loads(response.read().decode())["admission"]
        if admission.get("realm") != signal_runtime.realm:
            raise RuntimeError("lab proof realm mismatch")
        return admission

    def viewer_credentials(self) -> Mapping[str, str]:
        if self.closed or self.identity is None:
            raise RuntimeError("lab is not running")
        return {"origin": self.identity.origin, "password": self._lab_viewer_password, "proofToken": self.identity._proof_token, "realm": self.identity.realm}

    def start_host(self) -> subprocess.Popen[Any]:
        """Start an explicitly requested lab Host with import-time loopback URL.

        No default Host is launched: callers must still arrange a dedicated
        desktop/fixture and the command remains a child of this LabRun.
        """
        if self.closed or self.identity is None:
            raise RuntimeError("lab identity is required before starting a Host")
        environment = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TMPDIR") if key in os.environ}
        environment["SERVER_URL"] = self.identity.origin
        environment["HOST_SHARED_SECRET"] = self._lab_host_secret
        environment["WRD_LAB_HOST_ENTRY"] = "1"
        environment["WRD_LAB_CONTEXT"] = json.dumps(self._context, separators=(",", ":"))
        environment["WRD_DISABLE_OVERLAY"] = "1"
        proc = subprocess.Popen([sys.executable, str(Path(__file__).with_name("turn_lab_host.py"))], cwd=Path(__file__).resolve().parents[1], env=environment, start_new_session=True)
        self._children.append(proc)
        return proc

    def monitor(self, *, lab_identity: LabIdentity | None = None) -> str:
        if self.closed or self.identity is None:
            return "closed"
        try:
            if isinstance(self._production_probe, ProductionAdmissionClient):
                epoch, viewer_count = self._production_probe.status()
                production = ProductionProof("production", "status-only", epoch, viewer_count)
            else:
                production = self._production_probe() if self._production_probe else None
        except Exception:
            self.close(); return "stopped:production-proof-lost"
        if not isinstance(production, ProductionProof) or production.viewer_count > 0:
            self.close(); return "stopped:human-viewer"
        if production.epoch != self._production_epoch:
            self.close(); return "stopped:production-epoch-changed"
        if lab_identity is not None and lab_identity != self.identity:
            self.close(); return "stopped:lab-identity-changed"
        if any(child.poll() is not None for child in self._children):
            self.close(); return "stopped:lab-child-exited"
        return "running"

    def close(self) -> None:
        for child in self._children:
            if child.poll() is None:
                try: os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError: pass
                try: child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try: os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError: pass
                    child.wait(timeout=5)
        self._children.clear()
        if self._stop_signal:
            try: self._stop_signal()
            except Exception: pass
        self._stop_signal = None
        if self._runtime_dir:
            shutil.rmtree(self._runtime_dir, ignore_errors=True)
        self._runtime_dir = None
        self.identity = None
        self._context = None
        self._lab_host_secret = ""
        self._lab_viewer_password = ""
        self._production_epoch = -1
        self.closed = True

    def __enter__(self) -> "LabRun": return self
    def __exit__(self, *_args: object) -> None: self.close()
