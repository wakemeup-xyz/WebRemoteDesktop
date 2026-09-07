"""Child-scoped controller for loopback-only encoder experiments."""
from __future__ import annotations

import json
import hashlib
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
from urllib.error import HTTPError
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


@dataclass(frozen=True)
class LabTurnBootstrap:
    """One selected production TURN path, kept only until Signal reads stdin."""
    selected_turn_server_id: str
    turn_fingerprint: str
    turn_urls: tuple[str, ...]
    turn_username: str
    turn_credential: str

    def signal_payload(self) -> Mapping[str, Any]:
        # Deliberately do not retain this mapping on LabRun or serialize it to
        # a path.  It is written exactly once to the Signal child's stdin.
        return {
            "schemaVersion": 1,
            "selectedTurnServerId": self.selected_turn_server_id,
            "defaultTurnServerId": self.selected_turn_server_id,
            "turnFingerprint": self.turn_fingerprint,
            "turnUrls": list(self.turn_urls),
            "turnUsername": self.turn_username,
            "turnCredential": self.turn_credential,
        }

    def applied_digest(self) -> str:
        """Stable, secret-free proof of the one selected Host/Viewer path."""
        body = {"schemaVersion": 1, "selectedTurnServerId": self.selected_turn_server_id,
                "turnFingerprint": self.turn_fingerprint, "turnUrls": list(self.turn_urls),
                "turnUsername": self.turn_username}
        return hashlib.sha256(json.dumps(body, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()


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
        # A lease is an ownership record, rather than a best-effort cache.  All
        # reads and transitions are serialised so a temporary status failure
        # cannot turn one local owner into two remote admissions.
        self._lock = threading.RLock()

    def __init_subclass__(cls, **kwargs: object) -> None:
        raise TypeError("ProductionAdmissionClient is final")

    def _request_json(self, path: str, *, method: str = "GET", headers: Mapping[str, str] | None = None, body: Mapping[str, Any] | None = None) -> tuple[int, Mapping[str, Any]]:
        request = Request(f"{self.origin}{path}", method=method, headers=dict(headers or {}), data=json.dumps(body).encode() if body is not None else None)
        with urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read().decode("utf-8"))

    def admit(self) -> ProductionProof:
        with self._lock:
            if self._proof is not None:
                # Only an explicit authenticated `active: false` releases our
                # local ownership.  A transport, HTTP, or schema error is
                # UNKNOWN and deliberately blocks a second admission.
                if self._proof_active_locked(self._proof):
                    raise RuntimeError("active proof lease must be released before another admission")
                self._proof = None
            code, status = self._request_json("/api/status")
            epoch, viewers = status.get("viewerEpoch"), status.get("viewerCount")
            if code != 200 or not isinstance(epoch, int) or not isinstance(viewers, int):
                raise RuntimeError("production status did not provide a valid viewer snapshot")
            if viewers != 0:
                raise RuntimeError("human Viewer present; lab refused")
            code, admitted = self._request_json("/api/proof-admission", method="POST", headers={"Authorization": f"Bearer {self._viewer_token}"})
            admission = admitted.get("admission") if isinstance(admitted, Mapping) else None
            fields = set(admission) if isinstance(admission, Mapping) else set()
            realm = admission.get("realm") if isinstance(admission, Mapping) else None
            # The deployed production endpoint's original contract is the
            # compact {token, epoch} pair.  Its origin is fixed in the public
            # constructor, so only that exact production origin may restore
            # the implicit production realm.  Lab/test origins must provide
            # their realm explicitly and cannot inherit this compatibility.
            if realm is None and self.origin == _PRODUCTION_ORIGIN and fields == {"token", "epoch"}:
                realm = "production"
            if (code != 201 or not isinstance(admission, Mapping) or fields not in ({"token", "epoch"}, {"token", "epoch", "realm"})
                    or realm != "production" or not isinstance(admission.get("token"), str) or not admission["token"]
                    or admission.get("epoch") != epoch):
                raise RuntimeError("production proof admission was not granted for the observed epoch")
            self._proof = _seal_production_proof(admission["token"], epoch)
            return self._proof

    def status(self) -> tuple[int, int]:
        with self._lock:
            code, status = self._request_json("/api/status")
            epoch, viewers = status.get("viewerEpoch"), status.get("viewerCount")
            if code != 200 or not isinstance(epoch, int) or not isinstance(viewers, int):
                raise RuntimeError("production status missing viewer epoch/count")
            return epoch, viewers

    def proof_active(self, proof: ProductionProof) -> bool:
        with self._lock:
            return self._proof_active_locked(proof)

    def _proof_active_locked(self, proof: ProductionProof) -> bool:
        if proof is not self._proof:
            return False
        try:
            code, payload = self._request_json("/api/proof-admission/status", method="POST", headers={"Authorization": f"Bearer {self._viewer_token}", "Content-Type": "application/json"}, body={"token": proof.token, "epoch": proof.epoch, "realm": proof.realm})
        except HTTPError as error:
            # Older production deployments issue the legitimate compact
            # admission but do not expose a lease-status route.  Their only
            # available proof is a fresh unchanged zero-Viewer snapshot.
            # This fallback is never enabled for arbitrary or Lab origins.
            if error.code == 404 and self.origin == _PRODUCTION_ORIGIN:
                current_epoch, viewers = self.status()
                return current_epoch == proof.epoch and viewers == 0
            raise RuntimeError("production proof status is unknown") from error
        except Exception as exc:
            raise RuntimeError("production proof status is unknown") from exc
        if code != 200 or not isinstance(payload, Mapping) or not isinstance(payload.get("active"), bool):
            raise RuntimeError("production proof status is unknown")
        return payload["active"]

    def release(self, proof: ProductionProof | None = None) -> bool:
        with self._lock:
            target = proof or self._proof
            if target is None or target is not self._proof:
                return False
            try:
                code, payload = self._request_json("/api/proof-admission/release", method="POST", headers={"Authorization": f"Bearer {self._viewer_token}", "Content-Type": "application/json"}, body={"token": target.token, "epoch": target.epoch, "realm": target.realm})
                released = code == 200 and isinstance(payload, Mapping) and payload.get("released") is True
            except HTTPError as error:
                # The same legacy endpoint family has no server-side release
                # contract.  Local ownership may still close after a fresh
                # zero-Viewer/unchanged-epoch read; any other response stays
                # fail-closed.
                if error.code == 404 and self.origin == _PRODUCTION_ORIGIN:
                    epoch, viewers = self.status()
                    released = epoch == target.epoch and viewers == 0
                else:
                    released = False
            except Exception:
                released = False
            if released:
                self._proof = None
            return released

    def lab_turn_bootstrap(self, proof: ProductionProof) -> LabTurnBootstrap:
        """Fetch and validate the exact authenticated production TURN path.

        The returned secret-bearing object belongs to the caller's stack only.
        It must be delivered to the disposable Signal process through its
        stdin and must never be retained in ``LabRun`` or an artifact.
        """
        with self._lock:
            if proof is not self._proof:
                raise RuntimeError("production TURN bootstrap requires the active proof")
            try:
                code, payload = self._request_json(
                    "/api/webrtc-config",
                    headers={"Authorization": f"Bearer {self._viewer_token}"},
                )
            except Exception as exc:
                raise RuntimeError("production TURN bootstrap is unavailable") from exc
        if code != 200 or not isinstance(payload, Mapping):
            raise RuntimeError("production TURN bootstrap is unavailable")
        selected = payload.get("selectedTurnServerId")
        fingerprint = payload.get("turnFingerprint")
        host_id = payload.get("hostTurnServerId")
        host_fingerprint = payload.get("hostTurnFingerprint")
        if (payload.get("turnConfigured") is not True or payload.get("hostTurnReady") is not True
                or not isinstance(selected, str) or not selected
                or not isinstance(fingerprint, str) or not fingerprint
                or host_id != selected or host_fingerprint != fingerprint):
            raise RuntimeError("production TURN path is not shared by Host and Viewer")
        ice_servers = payload.get("iceServers")
        if not isinstance(ice_servers, list):
            raise RuntimeError("production TURN bootstrap has no ICE catalog")
        turn_entries = []
        for entry in ice_servers:
            if not isinstance(entry, Mapping):
                continue
            urls = entry.get("urls")
            if not isinstance(urls, list) or not urls or not all(isinstance(url, str) and url.startswith(("turn:", "turns:")) for url in urls):
                continue
            turn_entries.append(entry)
        if len(turn_entries) != 1:
            raise RuntimeError("production TURN bootstrap has an ambiguous ICE catalog")
        entry = turn_entries[0]
        urls, username, credential = entry.get("urls"), entry.get("username"), entry.get("credential")
        if (not isinstance(urls, list) or not all(isinstance(url, str) and url for url in urls)
                or not isinstance(username, str) or not username
                or not isinstance(credential, str) or not credential):
            raise RuntimeError("production TURN bootstrap is incomplete")
        advertised_urls = payload.get("turnUrls")
        if advertised_urls != urls:
            raise RuntimeError("production TURN bootstrap catalog disagrees with selected ICE path")
        return LabTurnBootstrap(selected, fingerprint, tuple(urls), username, credential)


@dataclass(frozen=True)
class LabSignal:
    origin: str; realm: str; host_secret: str; viewer_password: str; context_secret: str; transcript_secret: str; stop: Callable[[], None]


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
        self._transcript_secret = ""
        self._production_proof: ProductionProof | None = None; self._expected_identity: LabIdentity | None = None
        self._expected_turn_applied_digest = ""; self._selected_turn_identity: dict[str, str] | None = None
        self.closed = True; self._lock = threading.RLock(); self._state_changed = threading.Condition(self._lock)
        self._watch_stop: threading.Event | None = None
        self._watch_thread: threading.Thread | None = None; self._last_status = "closed"
        self._generation = 0; self._run_token: object | None = None
        self._admission_token: object | None = None
        # Spawn and close are linearized separately from the lifecycle state.
        # Always acquire this lock before _lock; no path takes the reverse.
        self._spawn_lock = threading.Lock()

    def _owns_locked(self, token: object, generation: int) -> bool:
        return not self.closed and self._run_token is token and self._generation == generation

    def _require_owner(self, token: object, generation: int) -> None:
        with self._lock:
            if not self._owns_locked(token, generation):
                raise RuntimeError("lab run was closed or replaced during startup")

    def _production_preflight(self, proof: ProductionProof, epoch: int) -> None:
        """Read the production guard without the LabRun lock held."""
        if self._production_client is None:
            raise RuntimeError("production proof client is unavailable")
        current_epoch, viewers = self._production_client.status()
        if viewers != 0:
            raise RuntimeError("production preflight refused: human Viewer present")
        if current_epoch != epoch:
            raise RuntimeError("production preflight refused: Viewer epoch changed")
        if not self._production_client.proof_active(proof):
            raise RuntimeError("production preflight refused: proof lease inactive")

    def start(self, mode: str, manifest: Mapping[str, Any] | None = None) -> LabIdentity:
        if mode not in {"legacy", "candidate"}: raise ValueError("lab mode must be legacy or candidate")
        if self._production_client is None: raise RuntimeError("production proof is required before starting a lab")
        if mode == "candidate":
            if manifest is None: raise ValueError("candidate manifest is required")
            from turn_lab_host import verify_candidate_manifest
            verify_candidate_manifest(manifest)
        self.close()
        with self._lock:
            self._generation += 1
            generation, token, cancel = self._generation, object(), threading.Event()
            self._run_token, self._watch_stop = token, cancel
            self._admission_token = token
            # Own the lease before any filesystem, child or handshake work.
            self.closed = False; self._last_status = "starting"
        try:
            proof = self._production_client.admit()
        except Exception:
            with self._state_changed:
                if self._admission_token is token:
                    self._admission_token = None
                    self._state_changed.notify_all()
            self._close_generation(token, generation)
            raise
        if not isinstance(proof, ProductionProof):
            with self._state_changed:
                if self._admission_token is token:
                    self._admission_token = None
                    self._state_changed.notify_all()
            self._close_generation(token, generation)
            raise RuntimeError("production admission did not return a sealed proof")
        with self._state_changed:
            owns_admission = self._owns_locked(token, generation)
            if owns_admission:
                self._production_proof = proof; self._production_epoch = proof.epoch
                self._admission_token = None
                self._state_changed.notify_all()
            else:
                # Hold the lifecycle condition until release completes so a
                # concurrent close cannot return while a late admission lease
                # is briefly live remotely.
                self._production_client.release(proof)
                if self._admission_token is token:
                    self._admission_token = None
                    self._state_changed.notify_all()
        if not owns_admission:
            raise RuntimeError("lab run was closed or replaced during production admission")
        try:
            # This authenticated read is intentionally before any child is
            # launched.  ``turn_bootstrap`` remains a local until its one
            # write to the Signal stdin pipe below.
            turn_bootstrap = self._production_client.lab_turn_bootstrap(proof)
            expected_turn_applied_digest = turn_bootstrap.applied_digest()
            self._require_owner(token, generation)
            parent = self._runtime_root or Path(tempfile.gettempdir()); parent.mkdir(parents=True, exist_ok=True)
            runtime_dir = Path(tempfile.mkdtemp(prefix="wrd-turn-lab-", dir=parent)); run_id = secrets.token_hex(12); realm = f"lab-{run_id}"
            with self._lock:
                owns_runtime = self._owns_locked(token, generation)
                if owns_runtime: self._runtime_dir = runtime_dir
            if not owns_runtime:
                shutil.rmtree(runtime_dir, ignore_errors=True)
                raise RuntimeError("lab run was closed or replaced during runtime setup")
            self._require_owner(token, generation)
            lab = self._spawn_signal(runtime_dir, realm, token, generation, turn_bootstrap)
            if lab.realm != realm or validate_lab_origin(lab.origin) != lab.origin:
                raise RuntimeError("lab Signal did not publish a canonical isolated identity")
            lab_proof = self._issue_lab_proof(lab)
            self._require_owner(token, generation)
            if lab_proof.get("realm") != realm or not isinstance(lab_proof.get("epoch"), int) or not lab_proof.get("token"): raise RuntimeError("lab Signal did not issue a realm-bound proof")
            identity = LabIdentity(run_id, lab.origin, lab_proof["epoch"], realm, str(lab_proof["token"]))
            import hashlib
            digest = hashlib.sha256(f"legacy:{lab.origin}:{realm}".encode()).hexdigest()
            context = {"origin": lab.origin, "realm": realm, "proofToken": identity._proof_token, "epoch": identity.epoch, "mode": mode, "runId": run_id, "policyId": f"experiment/{digest}"}
            context["credential"] = self._issue_host_context(lab, context)
            self._require_owner(token, generation)
            # This is deliberately after every lab-side network operation and
            # immediately before publishing running/starting the watchdog.
            self._production_preflight(proof, proof.epoch)
            with self._lock:
                if not self._owns_locked(token, generation):
                    raise RuntimeError("lab run was closed or replaced during production preflight")
                self.identity, self._context = identity, context
                self._host_secret, self._viewer_password, self._context_secret, self._transcript_secret = lab.host_secret, lab.viewer_password, lab.context_secret, lab.transcript_secret
                self._production_epoch, self._production_proof, self._expected_identity = proof.epoch, proof, identity
                self._expected_turn_applied_digest = expected_turn_applied_digest
                self._selected_turn_identity = {"id": turn_bootstrap.selected_turn_server_id,
                                                "fingerprint": turn_bootstrap.turn_fingerprint,
                                                "digest": expected_turn_applied_digest,
                                                "urls": list(turn_bootstrap.turn_urls)}
                self._last_status = "running"
                watch = threading.Thread(target=self._watchdog, args=(token, generation, cancel, identity, proof.epoch, proof), name=f"wrd-lab-watch-{run_id}", daemon=True)
                self._watch_thread = watch
                watch.start()
            return identity
        except Exception:
            self._close_generation(token, generation); raise

    def _spawn_signal(self, runtime_dir: Path, realm: str, token: object, generation: int,
                      turn_bootstrap: LabTurnBootstrap) -> LabSignal:
        script = Path(__file__).with_name("turn-lab-signal.js"); env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TMPDIR") if key in os.environ}
        with self._spawn_lock:
            with self._lock:
                if not self._owns_locked(token, generation):
                    raise RuntimeError("lab run was closed or replaced during Signal startup")
            stderr_log = (runtime_dir / "signal.stderr.log").open("wb")
            try:
                proc = subprocess.Popen(["node", str(script), "--json", "--realm", realm, "--runtime-dir", str(runtime_dir)], cwd=script.parent.parent, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr_log, start_new_session=True)
            except Exception:
                stderr_log.close()
                raise
            if proc.stdout is None or proc.stdin is None:
                self._terminate_child(proc); stderr_log.close(); raise RuntimeError("lab Signal did not expose stdout")
            try:
                # No argv, environment, runtime file, log, or artifact ever
                # carries TURN credentials.  Closing stdin guarantees Signal
                # receives one bounded bootstrap document only.
                proc.stdin.write(json.dumps(turn_bootstrap.signal_payload(), separators=(",", ":")).encode("utf-8") + b"\n")
                proc.stdin.flush()
                proc.stdin.close()
            except Exception as exc:
                self._terminate_child(proc); stderr_log.close()
                raise RuntimeError("lab Signal TURN bootstrap pipe failed") from exc
            with self._lock:
                # close is blocked on _spawn_lock until this attachment is
                # complete, then sees and reaps this exact child.
                if not self._owns_locked(token, generation):
                    self._terminate_child(proc); stderr_log.close()
                    raise RuntimeError("lab run was closed or replaced during Signal startup")
                self._children.append(proc)
                self._handles.append(stderr_log)
                self._stop_signal = lambda: self._terminate_child(proc)
        try:
            payload = self._read_startup_json(proc, proc.stdout)
            self._require_owner(token, generation)
            return LabSignal(str(payload["origin"]), str(payload["realm"]), str(payload["hostSecret"]), str(payload["viewerPassword"]), str(payload["contextSecret"]), str(payload["transcriptSecret"]), lambda: self._terminate_child(proc))
        except Exception:
            # If attached, the generation's one cleanup path owns the child
            # and descriptor.  If close won the race, it has already reaped
            # them; if this startup error won, start() invokes that same path.
            raise

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

    def viewer_credentials(self) -> Mapping[str, Any]:
        if self.closed or self.identity is None: raise RuntimeError("lab is not running")
        proof_admission = {"token": self.identity._proof_token, "epoch": self.identity.epoch, "realm": self.identity.realm}
        return {"origin": self.identity.origin, "password": self._viewer_password, "proofAdmission": proof_admission, "proofToken": self.identity._proof_token, "realm": self.identity.realm}

    def transcript_verifier(self) -> bytes:
        """Return the in-memory per-run HMAC verifier; never persist it in artifacts."""
        with self._lock:
            if self.closed or not self._transcript_secret:
                raise RuntimeError("running lab transcript verifier is required")
            return self._transcript_secret.encode("utf-8")

    def selected_turn_identity(self) -> dict[str, Any]:
        """Read the already production-preflighted TURN identity without credentials."""
        with self._lock:
            if self.closed or self._selected_turn_identity is None:
                raise RuntimeError("running Lab selected TURN identity is required")
            return dict(self._selected_turn_identity)

    def runtime_dir(self) -> Path:
        """Expose the current Lab-owned log directory for read-only collectors."""
        with self._lock:
            if self.closed or self._runtime_dir is None:
                raise RuntimeError("running lab runtime directory is required")
            return self._runtime_dir

    def bind_controlled_input(self, *, input_id: str, lease_id: str, lease_epoch: int, fixture_id: str,
                               action: Mapping[str, Any]) -> None:
        """Reserve one existing Viewer inputId for the isolated Lab Host.

        This is a proof-and-host-secret authenticated loopback control call;
        it neither opens a listener nor sends an input event.
        """
        with self._lock:
            identity, secret = self.identity, self._host_secret
            if self.closed or identity is None or not secret:
                raise RuntimeError("running lab identity is required")
        if (not all(isinstance(value, str) and value for value in (input_id, lease_id, fixture_id))
                or not isinstance(lease_epoch, int) or isinstance(lease_epoch, bool) or lease_epoch < 0
                or not isinstance(action, Mapping) or set(action) != {"type", "action", "payload"}):
            raise ValueError("controlled binding requires input, lease and fixture identities")
        digest = hashlib.sha256(json.dumps(dict(action), sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()
        body = {"realm": identity.realm, "runId": identity.run_id, "epoch": identity.epoch, "inputId": input_id,
                "leaseId": lease_id, "leaseEpoch": lease_epoch, "fixtureId": fixture_id, "actionDigest": digest}
        request = Request(
            f"{identity.origin}/api/lab-controlled-input/bind", method="POST",
            data=json.dumps(body, separators=(",", ":")).encode(),
            headers={"Content-Type": "application/json", "x-wrd-lab-host-secret": secret,
                     "x-wrd-lab-proof-token": identity._proof_token},
        )
        try:
            with urlopen(request, timeout=3) as response:
                payload = json.loads(response.read().decode())
        except Exception as error:
            raise RuntimeError("lab controlled input binding was refused") from error
        if not isinstance(payload, Mapping) or payload.get("binding", {}).get("inputId") != input_id:
            raise RuntimeError("lab controlled input binding response was invalid")

    def _controlled_request(self, path: str, body: Mapping[str, Any]) -> tuple[int, Mapping[str, Any]]:
        with self._lock:
            identity, secret = self.identity, self._host_secret
            if self.closed or identity is None or not secret:
                raise RuntimeError("running lab identity is required")
        request = Request(f"{identity.origin}{path}", method="POST", data=json.dumps(dict(body), separators=(",", ":")).encode(),
                          headers={"Content-Type": "application/json", "x-wrd-lab-host-secret": secret,
                                   "x-wrd-lab-proof-token": identity._proof_token})
        try:
            with urlopen(request, timeout=3) as response:
                payload = json.loads(response.read().decode())
                return response.status, payload if isinstance(payload, Mapping) else {}
        except HTTPError as error:
            try:
                payload = json.loads(error.read().decode())
            except Exception:
                payload = {}
            return error.code, payload if isinstance(payload, Mapping) else {}

    def wait_host_turn_applied(self, *, timeout_seconds: float = 10) -> str:
        with self._lock:
            identity, expected = self.identity, self._expected_turn_applied_digest
            if self.closed or identity is None or not expected:
                raise RuntimeError("running lab TURN identity is required")
            body = {"realm": identity.realm, "runId": identity.run_id, "epoch": identity.epoch}
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            code, payload = self._controlled_request("/api/lab-host-turn-status", body)
            digest = payload.get("turnAppliedDigest") if isinstance(payload, Mapping) else None
            if code == 200 and isinstance(digest, str) and hmac.compare_digest(digest, expected):
                return digest
            time.sleep(.1)
        raise RuntimeError("Lab Host did not apply the injected TURN path")

    def arm_controlled_input(self, *, lease_id: str, lease_epoch: int, fixture_id: str) -> Mapping[str, Any]:
        with self._lock:
            identity, expected = self.identity, self._expected_turn_applied_digest
            if self.closed or identity is None or not expected:
                raise RuntimeError("running lab guard identity is required")
            body = {"realm": identity.realm, "runId": identity.run_id, "epoch": identity.epoch,
                    "leaseId": lease_id, "leaseEpoch": lease_epoch, "fixtureId": fixture_id}
        if (not isinstance(lease_id, str) or not lease_id or not isinstance(lease_epoch, int)
                or isinstance(lease_epoch, bool) or lease_epoch < 0 or not isinstance(fixture_id, str) or not fixture_id):
            raise ValueError("controlled guard arm requires a current lease and fixture")
        code, payload = self._controlled_request("/api/lab-controlled-input/arm", body)
        arm_id = payload.get("armId") if isinstance(payload, Mapping) else None
        if code != 202 or not isinstance(arm_id, str) or not arm_id:
            raise RuntimeError("Lab Host guard arm was refused")
        status_body = {"realm": identity.realm, "runId": identity.run_id, "epoch": identity.epoch, "armId": arm_id}
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            code, status = self._controlled_request("/api/lab-controlled-input/arm-status", status_body)
            arm = status.get("arm") if isinstance(status, Mapping) else None
            if (code == 200 and isinstance(arm, Mapping) and arm.get("status") == "armed"
                    and isinstance(arm.get("turnAppliedDigest"), str)
                    and hmac.compare_digest(arm["turnAppliedDigest"], expected)):
                return {"armId": arm_id, "status": "armed", "turnAppliedDigest": expected}
            if code == 200 and isinstance(arm, Mapping) and arm.get("status") == "rejected":
                break
            time.sleep(.1)
        raise RuntimeError("Lab Host guard arm was not acknowledged")

    def wait_for_controlled_claim(self, input_id: str, *, timeout_seconds: float = 10) -> Mapping[str, Any] | None:
        with self._lock:
            identity = self.identity
            if self.closed or identity is None:
                raise RuntimeError("running lab identity is required")
            body = {"realm": identity.realm, "runId": identity.run_id, "epoch": identity.epoch, "inputId": input_id}
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            code, payload = self._controlled_request("/api/lab-controlled-input/claim-receipt", body)
            claim = payload.get("claim") if isinstance(payload, Mapping) else None
            if code == 200 and isinstance(claim, Mapping) and claim.get("inputId") == input_id and claim.get("status") == "claimed":
                return dict(claim)
            time.sleep(.05)
        return None

    def start_host(self) -> subprocess.Popen[Any]:
        # Snapshot under lock, make all HTTP calls without it, then claim the
        # exact generation again.  A close racing Popen leaves at most a child
        # which this method immediately reaps before returning.
        with self._lock:
            if self.closed or self.identity is None or self._runtime_dir is None or self._context is None: raise RuntimeError("lab identity is required before starting a Host")
            token, generation, identity, proof, runtime_dir, context = self._run_token, self._generation, self.identity, self._production_proof, self._runtime_dir, dict(self._context)
            host_secret = self._host_secret
        if token is None or proof is None: raise RuntimeError("lab identity is required before starting a Host")
        try:
            self._production_preflight(proof, proof.epoch)
            env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TMPDIR") if key in os.environ}; env.update({"SERVER_URL": identity.origin, "HOST_SHARED_SECRET": host_secret, "WRD_LAB_HOST_ENTRY": "1", "WRD_LAB_CONTEXT": json.dumps(context, separators=(",", ":")), "WRD_DISABLE_OVERLAY": "1", "WRD_FRAME_TRACE_DETAIL": "1", "WRD_LAB_LOSS_TRACE": "1"})
            with self._spawn_lock:
                with self._lock:
                    if not self._owns_locked(token, generation):
                        raise RuntimeError("lab run was closed or replaced during startup")
                log = (runtime_dir / "host.stderr.log").open("wb")
                try:
                    proc = subprocess.Popen([sys.executable, str(Path(__file__).with_name("turn_lab_host.py"))], cwd=Path(__file__).resolve().parents[1], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                except Exception:
                    log.close(); raise
                with self._lock:
                    if not self._owns_locked(token, generation):
                        self._terminate_child(proc); log.close()
                        raise RuntimeError("lab run was closed or replaced during Host startup")
                    self._children.append(proc); self._handles.append(log)
            return proc
        except Exception:
            self._close_generation(token, generation)
            raise

    def monitor(self, *, lab_identity: LabIdentity | None = None) -> str:
        with self._lock:
            mismatch = not self.closed and lab_identity is not None and lab_identity != self._expected_identity
            if mismatch:
                self._last_status = "stopped:lab-identity-changed"
                token, generation = self._run_token, self._generation
        if mismatch:
            if token is not None: self._close_generation(token, generation)
        return self._last_status

    def _watchdog(self, token: object, generation: int, cancel: threading.Event, expected: LabIdentity, epoch: int, proof: ProductionProof) -> None:
        """Observe only the run captured at construction.

        Every request can block.  Therefore ownership is checked again after
        it returns, before changing status or invoking cleanup.
        """
        while not cancel.wait(0.2):
            with self._lock:
                if not self._owns_locked(token, generation) or self._watch_stop is not cancel:
                    return
                current, children = self.identity, tuple(self._children)
            if current != expected:
                self._stop_from_watchdog(token, generation, cancel, "stopped:lab-identity-changed"); return
            try:
                current_epoch, viewers = self._production_client.status() if self._production_client else (-1, 1)
            except Exception:
                self._stop_from_watchdog(token, generation, cancel, "stopped:production-status-failed"); return
            with self._lock:
                if not self._owns_locked(token, generation) or self._watch_stop is not cancel:
                    return
            if viewers > 0:
                self._stop_from_watchdog(token, generation, cancel, "stopped:human-viewer"); return
            if current_epoch != epoch:
                self._stop_from_watchdog(token, generation, cancel, "stopped:production-epoch-changed"); return
            try:
                active = self._production_client.proof_active(proof) if self._production_client else False
            except Exception:
                self._stop_from_watchdog(token, generation, cancel, "stopped:production-status-failed"); return
            with self._lock:
                if not self._owns_locked(token, generation) or self._watch_stop is not cancel:
                    return
            if not active:
                self._stop_from_watchdog(token, generation, cancel, "stopped:production-proof-lost"); return
            if any(child.poll() is not None for child in children):
                self._stop_from_watchdog(token, generation, cancel, "stopped:lab-child-exited"); return

    def _stop_from_watchdog(self, token: object, generation: int, cancel: threading.Event, status: str) -> None:
        with self._lock:
            if not self._owns_locked(token, generation) or self._watch_stop is not cancel:
                return
            self._last_status = status
        self._close_generation(token, generation)

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

    def _close_generation(self, token: object, generation: int) -> None:
        with self._spawn_lock:
            with self._lock:
                if not self._owns_locked(token, generation): return
                self.closed = True
                cancel = self._watch_stop
                if cancel is not None: cancel.set()
                watch, children, stop = self._watch_thread, tuple(self._children), self._stop_signal; handles, runtime_dir = tuple(self._handles), self._runtime_dir
                if not self._last_status.startswith("stopped:"):
                    self._last_status = "closed"
                proof = self._production_proof
                admission_pending = self._admission_token is token
                self._children.clear(); self._handles.clear(); self._stop_signal = None; self._runtime_dir = None; self.identity = None; self._expected_identity = None; self._context = None; self._host_secret = self._viewer_password = self._context_secret = self._transcript_secret = ""; self._expected_turn_applied_digest = ""; self._selected_turn_identity = None; self._production_epoch = None; self._production_proof = None
                self._run_token = None; self._watch_stop = None; self._watch_thread = None
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
        if admission_pending:
            # Admission has a bounded HTTP timeout.  Waiting here makes close
            # linearizable with respect to a late successful admission: its
            # starter releases the lease before signalling this condition.
            with self._state_changed:
                while self._admission_token is token:
                    self._state_changed.wait()
        if watch is not None and watch is not threading.current_thread(): watch.join(timeout=1)

    def close(self) -> None:
        with self._lock:
            token, generation = self._run_token, self._generation
        if token is not None:
            self._close_generation(token, generation)

    def __enter__(self) -> "LabRun": return self
    def __exit__(self, *_args: object) -> None: self.close()


def _make_test_production_client(*, origin: str, viewer_token: str) -> ProductionAdmissionClient:
    """Private test-only constructor for an isolated loopback proof fixture."""
    return ProductionAdmissionClient(viewer_token=viewer_token, origin=origin, _capability=_INTERNAL_TEST_CAPABILITY)


def _make_test_lab_run(*, runtime_root: Path, production_client: ProductionAdmissionClient) -> LabRun:
    """Private test-only fixture. Operational LabRun has no injection API."""
    if not isinstance(production_client, ProductionAdmissionClient): raise TypeError("test fixture requires a ProductionAdmissionClient")
    run = LabRun(runtime_root=runtime_root); run._production_client = production_client; return run
