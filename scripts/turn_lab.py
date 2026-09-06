"""Child-scoped controller for loopback-only encoder experiments."""
from __future__ import annotations

import json
import os
import secrets
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

_PRODUCTION_ORIGIN = "http://127.0.0.1:8080"
_INTERNAL_TEST_CAPABILITY = object()
_PROOF_SEAL = object()


def validate_lab_origin(origin: str) -> str:
    """Accept only canonical, bare, non-production loopback origins."""
    try:
        parsed = urlsplit(str(origin)); port = parsed.port
    except ValueError as exc:
        raise ValueError("lab origin must be a bare non-production loopback URL") from exc
    if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1"}
            or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment
            or port is None or not 1 <= port <= 65535 or port in {8080, 5173}):
        raise ValueError("lab origin must be a bare non-production loopback URL")
    canonical = f"http://{'[::1]' if parsed.hostname == '::1' else '127.0.0.1'}:{port}"
    if str(origin) != canonical:
        raise ValueError("lab origin must be canonical")
    return canonical


@dataclass(frozen=True, init=False)
class ProductionProof:
    realm: str; token: str; epoch: int; viewer_count: int

    def __init__(self, realm: str, token: str, epoch: int, viewer_count: int, *, _seal: object | None = None) -> None:
        if _seal is not _PROOF_SEAL:
            raise TypeError("ProductionProof is sealed; use ProductionAdmissionClient")
        if realm != "production" or not token or epoch < 0 or viewer_count != 0:
            raise ValueError("production proof requires a zero-viewer production admission")
        object.__setattr__(self, "realm", realm); object.__setattr__(self, "token", token)
        object.__setattr__(self, "epoch", epoch); object.__setattr__(self, "viewer_count", viewer_count)


def _seal_production_proof(token: str, epoch: int) -> ProductionProof:
    return ProductionProof("production", token, epoch, 0, _seal=_PROOF_SEAL)


class ProductionAdmissionClient:
    """Final client: admits once, then offers read-only status observation."""
    def __init__(self, *, viewer_token: str, origin: str = _PRODUCTION_ORIGIN, _capability: object | None = None) -> None:
        if _capability is _INTERNAL_TEST_CAPABILITY:
            self.origin = validate_lab_origin(origin)
        elif origin == _PRODUCTION_ORIGIN:
            self.origin = _PRODUCTION_ORIGIN
        else:
            raise ValueError("production admission origin must be exactly http://127.0.0.1:8080")
        if not isinstance(viewer_token, str) or not viewer_token:
            raise ValueError("a Viewer access token is required for production admission")
        self._viewer_token = viewer_token
        self._proof: ProductionProof | None = None

    def __init_subclass__(cls, **kwargs: object) -> None:
        raise TypeError("ProductionAdmissionClient is final")

    def _request_json(self, path: str, *, method: str = "GET", headers: Mapping[str, str] | None = None, body: Mapping[str, Any] | None = None) -> tuple[int, Mapping[str, Any]]:
        request = Request(f"{self.origin}{path}", method=method, headers=dict(headers or {}), data=json.dumps(body).encode() if body is not None else None)
        with urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read().decode("utf-8"))

    def admit(self) -> ProductionProof:
        code, status = self._request_json("/api/status")
        epoch, viewers = status.get("viewerEpoch"), status.get("viewerCount")
        if code != 200 or not isinstance(epoch, int) or not isinstance(viewers, int):
            raise RuntimeError("production status did not provide a valid viewer snapshot")
        if viewers != 0:
            raise RuntimeError("human Viewer present; lab refused")
        code, admitted = self._request_json("/api/proof-admission", method="POST", headers={"Authorization": f"Bearer {self._viewer_token}"})
        admission = admitted.get("admission") if isinstance(admitted, Mapping) else None
        if (code != 201 or not isinstance(admission, Mapping) or admission.get("realm") != "production"
                or not isinstance(admission.get("token"), str) or not admission["token"] or admission.get("epoch") != epoch):
            raise RuntimeError("production proof admission was not granted for the observed epoch")
        self._proof = _seal_production_proof(admission["token"], epoch)
        return self._proof

    def status(self) -> tuple[int, int]:
        code, status = self._request_json("/api/status")
        epoch, viewers = status.get("viewerEpoch"), status.get("viewerCount")
        if code != 200 or not isinstance(epoch, int) or not isinstance(viewers, int):
            raise RuntimeError("production status missing viewer epoch/count")
        return epoch, viewers

    def proof_active(self, proof: ProductionProof) -> bool:
        if proof is not self._proof:
            return False
        try:
            code, payload = self._request_json("/api/proof-admission/status", method="POST", headers={"Authorization": f"Bearer {self._viewer_token}", "Content-Type": "application/json"}, body={"token": proof.token, "epoch": proof.epoch, "realm": proof.realm})
            return code == 200 and payload.get("active") is True
        except Exception:
            return False

    def release(self, proof: ProductionProof | None = None) -> bool:
        target = proof or self._proof
        if target is None or target is not self._proof:
            return False
        try:
            code, payload = self._request_json("/api/proof-admission/release", method="POST", headers={"Authorization": f"Bearer {self._viewer_token}", "Content-Type": "application/json"}, body={"token": target.token, "epoch": target.epoch, "realm": target.realm})
            released = code == 200 and payload.get("released") is True
        except Exception:
            released = False
        if released:
            self._proof = None
        return released


@dataclass(frozen=True)
class LabSignal:
    origin: str; realm: str; host_secret: str; viewer_password: str; context_secret: str; stop: Callable[[], None]


@dataclass(frozen=True)
class LabIdentity:
    run_id: str; origin: str; epoch: int; realm: str; _proof_token: str
    def accepts_proof(self, proof: Mapping[str, Any]) -> bool:
        return proof.get("realm") == self.realm and proof.get("epoch") == self.epoch and proof.get("token") == self._proof_token


class LabRun:
    """Public operational controller; it exposes no process/proof injection."""
    def __init__(self, *, viewer_token: str = "", runtime_root: Path | None = None) -> None:
        self._runtime_root = Path(runtime_root) if runtime_root else None
        self._production_client: ProductionAdmissionClient | None = ProductionAdmissionClient(viewer_token=viewer_token) if viewer_token else None
        self._runtime_dir: Path | None = None; self._children: list[subprocess.Popen[Any]] = []; self._handles: list[Any] = []
        self._stop_signal: Callable[[], None] | None = None; self.identity: LabIdentity | None = None; self._context: dict[str, Any] | None = None
        self._host_secret = self._viewer_password = self._context_secret = ""; self._production_epoch: int | None = None
        self._production_proof: ProductionProof | None = None; self._expected_identity: LabIdentity | None = None
        self.closed = True; self._lock = threading.RLock(); self._watch_stop = threading.Event(); self._watch_thread: threading.Thread | None = None; self._last_status = "closed"

    def start(self, mode: str, manifest: Mapping[str, Any] | None = None) -> LabIdentity:
        if mode not in {"legacy", "candidate"}: raise ValueError("lab mode must be legacy or candidate")
        if self._production_client is None: raise RuntimeError("production proof is required before starting a lab")
        if mode == "candidate":
            if manifest is None: raise ValueError("candidate manifest is required")
            from turn_lab_host import verify_candidate_manifest
            verify_candidate_manifest(manifest)
        self.close()
        proof = self._production_client.admit()
        if not isinstance(proof, ProductionProof): raise RuntimeError("production admission did not return a sealed proof")
        parent = self._runtime_root or Path(tempfile.gettempdir()); parent.mkdir(parents=True, exist_ok=True)
        self._runtime_dir = Path(tempfile.mkdtemp(prefix="wrd-turn-lab-", dir=parent)); run_id = secrets.token_hex(12); realm = f"lab-{run_id}"
        with self._lock:
            self.closed = False; self._last_status = "starting"
        try:
            lab = self._spawn_signal(self._runtime_dir, realm)
            if lab.realm != realm or validate_lab_origin(lab.origin) != lab.origin: raise RuntimeError("lab Signal did not publish a canonical isolated identity")
            self._stop_signal = lab.stop
            lab_proof = self._issue_lab_proof(lab)
            if lab_proof.get("realm") != realm or not isinstance(lab_proof.get("epoch"), int) or not lab_proof.get("token"): raise RuntimeError("lab Signal did not issue a realm-bound proof")
            self.identity = LabIdentity(run_id, lab.origin, lab_proof["epoch"], realm, str(lab_proof["token"]))
            import hashlib
            digest = hashlib.sha256(f"legacy:{lab.origin}:{realm}".encode()).hexdigest()
            self._context = {"origin": lab.origin, "realm": realm, "proofToken": self.identity._proof_token, "epoch": self.identity.epoch, "mode": mode, "runId": run_id, "policyId": f"experiment/{digest}"}
            self._context["credential"] = self._issue_host_context(lab, self._context)
            with self._lock:
                self._host_secret, self._viewer_password, self._context_secret = lab.host_secret, lab.viewer_password, lab.context_secret
                self._production_epoch, self._production_proof, self._expected_identity = proof.epoch, proof, self.identity
                self.closed, self._last_status = False, "running"; self._watch_stop.clear()
                self._watch_thread = threading.Thread(target=self._watchdog, name=f"wrd-lab-watch-{run_id}", daemon=True); self._watch_thread.start()
            return self.identity
        except Exception:
            self.close(); raise

    def _spawn_signal(self, runtime_dir: Path, realm: str) -> LabSignal:
        script = Path(__file__).with_name("turn-lab-signal.js"); env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TMPDIR") if key in os.environ}
        stderr_log = (runtime_dir / "signal.stderr.log").open("wb"); self._handles.append(stderr_log)
        proc = subprocess.Popen(["node", str(script), "--json", "--realm", realm, "--runtime-dir", str(runtime_dir)], cwd=script.parent.parent, env=env, stdout=subprocess.PIPE, stderr=stderr_log, start_new_session=True)
        self._children.append(proc)
        if proc.stdout is None: self._terminate_child(proc); raise RuntimeError("lab Signal did not expose stdout")
        try:
            payload = self._read_startup_json(proc, proc.stdout)
            return LabSignal(str(payload["origin"]), str(payload["realm"]), str(payload["hostSecret"]), str(payload["viewerPassword"]), str(payload["contextSecret"]), lambda: self._terminate_child(proc))
        except (KeyError, RuntimeError):
            self._terminate_child(proc); raise

    @staticmethod
    def _read_startup_json(proc: subprocess.Popen[Any], output: Any, *, timeout_seconds: float = 10) -> Mapping[str, Any]:
        selector = selectors.DefaultSelector(); selector.register(output, selectors.EVENT_READ); deadline, data = time.monotonic() + timeout_seconds, bytearray()
        try:
            while time.monotonic() < deadline:
                if proc.poll() is not None: raise RuntimeError("lab Signal exited before startup identity")
                events = selector.select(max(0, deadline - time.monotonic()))
                if not events: break
                chunk = os.read(output.fileno(), 1024)
                if not chunk: raise RuntimeError("lab Signal closed stdout before startup identity")
                data.extend(chunk)
                if len(data) > 8192: raise RuntimeError("lab Signal startup identity exceeded limit")
                if b"\n" in data:
                    try: parsed = json.loads(bytes(data.split(b"\n", 1)[0]).decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError) as exc: raise RuntimeError("lab Signal published malformed identity") from exc
                    if not isinstance(parsed, Mapping): raise RuntimeError("lab Signal published malformed identity")
                    return parsed
            raise RuntimeError("lab Signal startup timed out")
        finally: selector.close()

    def _issue_host_context(self, lab: LabSignal, context: Mapping[str, Any]) -> str:
        keys = ("origin", "realm", "proofToken", "epoch", "mode", "runId", "policyId")
        request = Request(f"{lab.origin}/api/lab-context/issue", method="POST", data=json.dumps({key: context[key] for key in keys}).encode(), headers={"Content-Type": "application/json", "x-wrd-lab-context-secret": lab.context_secret})
        with urlopen(request, timeout=5) as response:
            if response.status != 201: raise RuntimeError("lab Signal refused context issue")
            credential = json.loads(response.read().decode("utf-8")).get("context", {}).get("credential")
        if not isinstance(credential, str) or len(credential) < 16: raise RuntimeError("lab Signal returned invalid context credential")
        return credential

    @staticmethod
    def _issue_lab_proof(lab: LabSignal) -> Mapping[str, Any]:
        login = Request(f"{lab.origin}/api/auth/login", method="POST", data=json.dumps({"password": lab.viewer_password}).encode(), headers={"Content-Type": "application/json"})
        with urlopen(login, timeout=5) as response: token = json.loads(response.read().decode("utf-8"))["token"]
        proof = Request(f"{lab.origin}/api/proof-admission", method="POST", headers={"Authorization": f"Bearer {token}"})
        with urlopen(proof, timeout=5) as response: return json.loads(response.read().decode("utf-8"))["admission"]

    def viewer_credentials(self) -> Mapping[str, str]:
        if self.closed or self.identity is None: raise RuntimeError("lab is not running")
        return {"origin": self.identity.origin, "password": self._viewer_password, "proofToken": self.identity._proof_token, "realm": self.identity.realm}

    def start_host(self) -> subprocess.Popen[Any]:
        # Keep check, spawn, and registration under one lock.  A concurrent
        # close then either rejects this call before spawn or observes and
        # reaps the newly registered child process group.
        with self._lock:
            if self.closed or self.identity is None or self._runtime_dir is None or self._context is None: raise RuntimeError("lab identity is required before starting a Host")
            env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TMPDIR") if key in os.environ}; env.update({"SERVER_URL": self.identity.origin, "HOST_SHARED_SECRET": self._host_secret, "WRD_LAB_HOST_ENTRY": "1", "WRD_LAB_CONTEXT": json.dumps(self._context, separators=(",", ":")), "WRD_DISABLE_OVERLAY": "1"})
            log = (self._runtime_dir / "host.stderr.log").open("wb"); self._handles.append(log)
            proc = subprocess.Popen([sys.executable, str(Path(__file__).with_name("turn_lab_host.py"))], cwd=Path(__file__).resolve().parents[1], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True); self._children.append(proc); return proc

    def monitor(self, *, lab_identity: LabIdentity | None = None) -> str:
        with self._lock:
            mismatch = not self.closed and lab_identity is not None and lab_identity != self._expected_identity
            if mismatch:
                self._last_status = "stopped:lab-identity-changed"
        if mismatch:
            self.close()
        return self._last_status

    def _watchdog(self) -> None:
        while not self._watch_stop.wait(0.2):
            with self._lock:
                if self.closed: return
                epoch, proof, expected, current, children = self._production_epoch, self._production_proof, self._expected_identity, self.identity, tuple(self._children)
            if current != expected:
                self._stop_from_watchdog("stopped:lab-identity-changed"); return
            try: current_epoch, viewers = self._production_client.status() if self._production_client else (-1, 1)
            except Exception: self._stop_from_watchdog("stopped:production-status-failed"); return
            if viewers > 0: self._stop_from_watchdog("stopped:human-viewer"); return
            if current_epoch != epoch: self._stop_from_watchdog("stopped:production-epoch-changed"); return
            if proof is None or not self._production_client.proof_active(proof): self._stop_from_watchdog("stopped:production-proof-lost"); return
            if any(child.poll() is not None for child in children): self._stop_from_watchdog("stopped:lab-child-exited"); return

    def _stop_from_watchdog(self, status: str) -> None:
        with self._lock: self._last_status = status
        self.close()

    @staticmethod
    def _terminate_child(child: subprocess.Popen[Any]) -> None:
        if child.poll() is None:
            try: os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError: pass
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try: os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError: pass
                child.wait(timeout=5)

    def close(self) -> None:
        with self._lock:
            if self.closed: return
            self.closed = True; self._watch_stop.set(); watch, children, stop = self._watch_thread, tuple(self._children), self._stop_signal; handles, runtime_dir = tuple(self._handles), self._runtime_dir
            proof = self._production_proof
            self._children.clear(); self._handles.clear(); self._stop_signal = None; self._runtime_dir = None; self.identity = None; self._expected_identity = None; self._context = None; self._host_secret = self._viewer_password = self._context_secret = ""; self._production_epoch = None; self._production_proof = None
        for child in children:
            self._terminate_child(child)
            for stream in (child.stdout, child.stderr):
                try:
                    if stream is not None: stream.close()
                except Exception: pass
        if stop:
            try: stop()
            except Exception: pass
        for handle in handles:
            try: handle.close()
            except Exception: pass
        if runtime_dir: shutil.rmtree(runtime_dir, ignore_errors=True)
        if proof is not None and self._production_client is not None:
            self._production_client.release(proof)
        if watch is not None and watch is not threading.current_thread(): watch.join(timeout=1)
        with self._lock:
            if self._watch_thread is watch: self._watch_thread = None

    def __enter__(self) -> "LabRun": return self
    def __exit__(self, *_args: object) -> None: self.close()


def _make_test_production_client(*, origin: str, viewer_token: str) -> ProductionAdmissionClient:
    """Private test-only constructor for an isolated loopback proof fixture."""
    return ProductionAdmissionClient(viewer_token=viewer_token, origin=origin, _capability=_INTERNAL_TEST_CAPABILITY)


def _make_test_lab_run(*, runtime_root: Path, production_client: ProductionAdmissionClient) -> LabRun:
    """Private test-only fixture. Operational LabRun has no injection API."""
    if not isinstance(production_client, ProductionAdmissionClient): raise TypeError("test fixture requires a ProductionAdmissionClient")
    run = LabRun(runtime_root=runtime_root); run._production_client = production_client; return run
