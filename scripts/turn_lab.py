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
import select
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping



_PROOF_SEAL = object()


@dataclass(frozen=True, init=False)
class ProductionProof:
    realm: str
    token: str
    epoch: int
    viewer_count: int

    def __init__(self, realm: str, token: str, epoch: int, viewer_count: int, *, _seal: object | None = None) -> None:
        if _seal is not _PROOF_SEAL:
            raise TypeError("ProductionProof is sealed; use ProductionAdmissionClient")
        if realm != "production" or not token or epoch < 0 or viewer_count != 0:
            raise ValueError("production proof requires a zero-viewer production admission")
        object.__setattr__(self, "realm", realm)
        object.__setattr__(self, "token", token)
        object.__setattr__(self, "epoch", epoch)
        object.__setattr__(self, "viewer_count", viewer_count)

    @classmethod
    def _sealed(cls, realm: str, token: str, epoch: int, viewer_count: int) -> "ProductionProof":
        return cls(realm, token, epoch, viewer_count, _seal=_PROOF_SEAL)


def validate_lab_origin(origin: str) -> str:
    parsed = urlsplit(str(origin))
    if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1"}
        or parsed.username or parsed.password or parsed.path not in {"", "/"}
        or parsed.query or parsed.fragment or parsed.port is None
        or parsed.port < 1 or parsed.port > 65535 or parsed.port in {8080, 5173}):
        raise ValueError("lab origin must be a bare non-production loopback URL")
    return f"http://{'[::1]' if parsed.hostname == '::1' else '127.0.0.1'}:{parsed.port}"


class ProductionAdmissionClient:
    """Read-only production admission client; credentials stay caller-owned."""
    def __init__(self, *, origin: str, viewer_token: str) -> None:
        if str(origin) != "http://127.0.0.1:8080":
            raise ValueError("production admission origin must be exactly http://127.0.0.1:8080")
        self.origin = origin
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
        if admission.get("realm") != "production":
            raise RuntimeError("production proof realm mismatch")
        return ProductionProof._sealed("production", str(admission["token"]), int(admission["epoch"]), 0)

    def status(self) -> tuple[int, int]:
        with urlopen(Request(f"{self.origin}/api/status"), timeout=5) as response:
            status = json.loads(response.read().decode("utf-8"))
        epoch = status.get("viewerEpoch")
        if not isinstance(epoch, int):
            raise RuntimeError("production status missing viewerEpoch")
        return epoch, int(status.get("viewerCount") or 0)


@dataclass(frozen=True)
class LabSignal:
    origin: str
    realm: str
    host_secret: str
    viewer_password: str
    context_secret: str
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
    def __init__(self, *, runtime_root: Path | None = None, signal_launcher: Callable[..., LabSignal] | None = None, production_client: ProductionAdmissionClient | None = None, lab_proof_issuer: Callable[[LabSignal], Mapping[str, Any]] | None = None, lab_context_issuer: Callable[[LabSignal, Mapping[str, Any]], str] | None = None) -> None:
        self._runtime_root = Path(runtime_root) if runtime_root else None
        self._signal_launcher = signal_launcher
        if production_client is not None and not isinstance(production_client, ProductionAdmissionClient):
            raise TypeError("production_client must be a ProductionAdmissionClient")
        self._production_client = production_client
        self._lab_proof_issuer = lab_proof_issuer or self._issue_lab_proof
        self._lab_context_issuer = lab_context_issuer or self._issue_host_context
        self._runtime_dir: Path | None = None
        self._stop_signal: Callable[[], None] | None = None
        self._children: list[subprocess.Popen[Any]] = []
        self.identity: LabIdentity | None = None
        self._context: dict[str, Any] | None = None
        self._lab_host_secret = ""
        self._lab_viewer_password = ""
        self._signal_context_secret = ""
        self._production_epoch = -1
        self.closed = True

    def start(self, mode: str, manifest: Mapping[str, Any] | None = None) -> LabIdentity:
        if mode not in {"legacy", "candidate"}:
            raise ValueError("lab mode must be legacy or candidate")
        if self._production_client is None:
            raise RuntimeError("production proof is required before starting a lab")
        production_proof = self._production_client.admit()
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
            if validate_lab_origin(origin) != origin:
                raise RuntimeError("lab signal returned a non-canonical origin")
            lab_proof = self._lab_proof_issuer(signal_runtime)
            self._stop_signal = signal_runtime.stop
            self.identity = LabIdentity(run_id, origin, int(lab_proof["epoch"]), realm, str(lab_proof["token"]))
            self._lab_host_secret = signal_runtime.host_secret
            self._lab_viewer_password = signal_runtime.viewer_password
            self._signal_context_secret = signal_runtime.context_secret
            self._production_epoch = production_proof.epoch
            import hashlib
            policy_id = f"experiment/{hashlib.sha256(f'legacy:{origin}:{realm}'.encode()).hexdigest()}"
            self._context = {"origin": origin, "realm": realm, "proofToken": self.identity._proof_token, "epoch": self.identity.epoch, "mode": mode, "runId": run_id, "policyId": policy_id}
            self._context["credential"] = self._lab_context_issuer(signal_runtime, self._context)
            self.closed = False
            return self.identity
        except Exception:
            self.close()
            raise

    def _spawn_signal(self, runtime_dir: Path, realm: str) -> LabSignal:
        # The executable is an independent child and returns its random port on
        # stdout. It never receives production credentials or a production URL.
        script = Path(__file__).with_name("turn-lab-signal.js")
        environment = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TMPDIR") if key in os.environ}
        stderr_log = (runtime_dir / "signal.stderr.log").open("w", encoding="utf-8")
        proc = subprocess.Popen(["node", str(script), "--json", "--realm", realm, "--runtime-dir", str(runtime_dir)], cwd=script.parent.parent, env=environment, stdout=subprocess.PIPE, stderr=stderr_log, text=True, start_new_session=True)
        self._children.append(proc)
        ready, _, _ = select.select([proc.stdout], [], [], 10) if proc.stdout else ([], [], [])
        line = proc.stdout.readline().strip() if ready and proc.stdout else ""
        if not line.startswith("{"):
            self.close()
            raise RuntimeError("lab signal did not publish a loopback identity")
        payload = json.loads(line)
        def stop() -> None:
            if proc.poll() is None:
                proc.terminate()
                try: proc.wait(timeout=5)
                except subprocess.TimeoutExpired: proc.kill(); proc.wait(timeout=5)
        return LabSignal(str(payload["origin"]), str(payload["realm"]), str(payload["hostSecret"]), str(payload["viewerPassword"]), str(payload["contextSecret"]), stop)

    def _issue_host_context(self, signal_runtime: LabSignal, context: Mapping[str, Any]) -> str:
        body = json.dumps({key: context[key] for key in ("origin", "realm", "epoch", "mode", "runId", "policyId")}).encode()
        request = Request(f"{signal_runtime.origin}/api/lab-context/issue", method="POST", data=body, headers={"Content-Type": "application/json", "x-wrd-lab-context-secret": signal_runtime.context_secret})
        with urlopen(request, timeout=5) as response:
            credential = json.loads(response.read().decode())["context"]["credential"]
        return str(credential)

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
        environment["WRD_LAB_CONTEXT_SECRET"] = self._signal_context_secret
        environment["WRD_DISABLE_OVERLAY"] = "1"
        proc = subprocess.Popen([sys.executable, str(Path(__file__).with_name("turn_lab_host.py"))], cwd=Path(__file__).resolve().parents[1], env=environment, start_new_session=True)
        self._children.append(proc)
        return proc

    def monitor(self, *, lab_identity: LabIdentity | None = None) -> str:
        if self.closed or self.identity is None:
            return "closed"
        try:
            epoch, viewer_count = self._production_client.status() if self._production_client else (-1, 1)
        except Exception:
            self.close(); return "stopped:production-proof-lost"
        if viewer_count > 0:
            self.close(); return "stopped:human-viewer"
        if epoch != self._production_epoch:
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
        self._signal_context_secret = ""
        self._production_epoch = -1
        self.closed = True

    def __enter__(self) -> "LabRun": return self
    def __exit__(self, *_args: object) -> None: self.close()
