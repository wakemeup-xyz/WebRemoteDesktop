#!/usr/bin/env python3
"""Private one-shot diagnostic supervisor. No helper/protocol modifications."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import resource
import subprocess
import sys
import time
import psutil

BASE=Path('/Users/macstudio1/AI/Claude/WebRemoteDesktop')
HELPER=BASE/'scripts/passive_session_soak.py'
SAMPLER=BASE/'scripts/passive_session_sampler.js'
EXPECTED_HELPER='b0a15095651c9147eb451b27eb815ec4ea4cc984f2d293d3617c4cee89a15426'
EXPECTED_SAMPLER='f862b739cbe7eb543ccab304203c71c62a43014530fa2da9a7655cba293665d3'
PIDFILES=(Path('/tmp/wrd-host.pid'),Path('/tmp/wrd-safe-host.pid'))
ORIGINS={'https://link.stockhub.wiki':'formal','http://127.0.0.1:8080':'loopback'}
POLL=.25
SAMPLE_BYTES=8*1024*1024

class Capacity(RuntimeError): pass

class Registry:
    """Only direct creation or a currently verified owned parent grants ownership."""
    def __init__(self,process=psutil.Process):
        self.process=process; self.entries={}; self.attempts=[]; self.coverage=[]; self.tick=lambda: None
    def add_root(self,p): self._add(p,None)
    def _add(self,p,parent):
        birth=p.create_time()
        if p.pid in self.entries:
            self.entries[p.pid]['lastObservedEpoch']=time.time()
            if self.entries[p.pid]['birth']!=birth: self.note('observed-pid-reuse')
            return
        if len(self.entries)>=128: raise Capacity()
        self.entries[p.pid]={'birth':birth,'parent':parent,'firstObservedEpoch':time.time(),'lastObservedEpoch':time.time(),'object':p}
    def note(self,reason):
        if reason not in self.coverage: self.coverage.append(reason)
    def state(self,pid):
        try:
            p=self.process(pid)
            if p.create_time()!=self.entries[pid]['birth']: return 'reused'
            if p.status()==psutil.STATUS_ZOMBIE: return 'exited'
            return 'alive'
        except psutil.NoSuchProcess: return 'exited'
        except (psutil.AccessDenied,OSError): return 'unknown'
    def scan(self):
        # Direct-child edges avoid inferring authority through a vanished ancestor.
        queue=list(self.entries); seen=set()
        while queue:
            pid=queue.pop(0)
            if pid in seen: continue
            seen.add(pid)
            if self.state(pid)!='alive': continue
            try:
                children=self.process(pid).children(recursive=False)
                for child in children:
                    cb=child.create_time()
                    if self.state(pid)!='alive' or child.ppid()!=pid:
                        self.note('parent-chain-unavailable'); continue
                    parent_birth=self.entries[pid]['birth']
                    # Re-read both ends immediately before storing the edge.
                    if child.create_time()!=cb or self.state(pid)!='alive' or child.ppid()!=pid:
                        self.note('parent-chain-changed'); continue
                    self._add(child,{'pid':pid,'birth':parent_birth})
                    queue.append(child.pid)
            except (psutil.NoSuchProcess,psutil.AccessDenied,OSError): self.note('observation-unavailable')
    def signal(self,kind):
        # Descendants are registered after ancestors; reverse insertion is children first.
        for pid in reversed(list(self.entries)):
            status=self.state(pid)
            if status!='alive':
                if status in ('reused','unknown'): self.note('signal-skipped-'+status)
                continue
            record={'pid':pid,'birth':self.entries[pid]['birth'],'kind':kind,'epoch':time.time()}
            try:
                p=self.process(pid)
                if p.create_time()!=self.entries[pid]['birth']:
                    record['status']='reused'
                else:
                    # psutil's cached Process additionally checks PID reuse on signals.
                    getattr(p,'terminate' if kind=='term' else 'kill')(); record['status']='sent'
            except psutil.NoSuchProcess: record['status']='exited'
            except (psutil.AccessDenied,OSError): record['status']='unknown'
            self.attempts.append(record)
    def observe_for(self,seconds):
        end=time.monotonic()+seconds
        while time.monotonic()<end:
            self.tick()
            try: self.scan()
            except Capacity: self.note('identity-capacity')
            time.sleep(min(POLL,max(0,end-time.monotonic())))
    def cleanup(self,grace=1,term_wait=3,kill_wait=2):
        self.observe_for(grace)
        self.signal('term'); self.observe_for(term_wait)
        self.signal('kill'); self.observe_for(kill_wait)
    def result(self):
        identities=[{k:v for k,v in row.items() if k!='object'}|{'pid':pid,'status':self.state(pid)} for pid,row in self.entries.items()]
        return {'identities':identities,'signals':self.attempts,'allRecordedIdentitiesExited':all(i['status']=='exited' for i in identities),
                'completeProcessTreeExitEstablished':False,'coverage':self.coverage+['polling-may-miss-fast-orphan','macos-check-to-signal-race','no-CDP-no-manager-proxy']}

class Rows:
    def __init__(self,path): self.path=path; self.offset=0; self.pending=b''; self.total=0
    def read(self):
        try:
            with self.path.open('rb') as f:
                f.seek(self.offset); data=f.read(262144); self.offset+=len(data)
        except FileNotFoundError: return []
        self.total+=len(data)
        if self.total>67108864: raise Capacity()
        data=self.pending+data; parts=data.split(b'\n'); self.pending=parts.pop()
        if len(self.pending)>32768: raise Capacity()
        result=[]
        for line in parts:
            if len(line)>32768: raise Capacity()
            try: result.append(json.loads(line))
            except (ValueError,UnicodeError): pass
        return result

class Trigger:
    def __init__(self,host_valid,start,duration=300): self.duration=duration; self.host_valid=host_valid; self.start=start; self.fired=False; self.status='not-triggered'; self.observed=None
    def observe(self,row):
        if self.fired or not isinstance(row,dict): return False
        sample=row.get('sample')
        age=sample.get('frameAgeMs') if isinstance(sample,dict) else None
        if isinstance(age,bool) or not isinstance(age,(int,float)) or not math.isfinite(age) or (age<5000 if self.duration==10800 else age<=2000): return False
        self.fired=True; self.observed={'epoch':time.time(),'frameAgeMs':age,'rowElapsedSeconds':row.get('elapsedSeconds')}
        if not self.host_valid(): self.status='host-changed-or-unreadable'; return False
        self.start(); self.status='started'; return True

def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def exclusive(path,payload):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f: json.dump(payload,f,separators=(',',':'),allow_nan=False)

def host_snapshot(pid):
    # No command lines, environments or discovery of replacement processes.
    files={str(p):p.read_text().strip() for p in PIDFILES}
    if any(value!=str(pid) for value in files.values()): raise ValueError('host-pidfile-mismatch')
    p=psutil.Process(pid)
    if p.status()==psutil.STATUS_ZOMBIE: raise ValueError('host-exited')
    return {'pid':pid,'birth':p.create_time(),'pidfiles':files}

def log_snapshot():
    result={}
    for name in (BASE/'back-debug.log',Path('/tmp/signal-server.log')):
        try:
            st=name.stat(); result[name.name]={'inode':st.st_ino,'offset':st.st_size,'device':st.st_dev}
        except OSError: result[name.name]={'status':'unreadable'}
    return result

def sample_limits():
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_FSIZE,(SAMPLE_BYTES,SAMPLE_BYTES))
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))

class SampleObservation:
    """Observation timestamps are latched; they do not claim kernel exit time."""
    def __init__(self, child, registry, info, epoch=None, monotonic=None):
        self.child=child; self.registry=registry; self.info=info
        self.epoch=epoch or time.time; self.monotonic=monotonic or time.monotonic
        self.prefix=bytearray(); self.finalized=False
        self.info.update(timeoutDetectedEpoch=None,timeoutDetectedMonotonic=None,
                         exitObservedEpoch=None,exitObservedMonotonic=None,exitCode=None,
                         finalizedEpoch=None,diagnosticBytes=0,diagnosticDiscardedBytes=0,
                         diagnosticTruncated=False,diagnosticReadState='open')
    def drain(self):
        if self.finalized or self.info['diagnosticReadState']!='open': return
        remaining=65536
        while remaining:
            try: data=os.read(self.child.stdout.fileno(),remaining)
            except BlockingIOError: break
            except OSError:
                self.info['diagnosticReadState']='read-error'; break
            if not data:
                self.info['diagnosticReadState']='eof'; break
            remaining-=len(data); self.info['diagnosticBytes']+=len(data)
            keep=min(len(data),16384-len(self.prefix)); self.prefix.extend(data[:keep])
            self.info['diagnosticDiscardedBytes']+=len(data)-keep
            self.info['diagnosticTruncated']=self.info['diagnosticDiscardedBytes']>0
    def check(self):
        if self.finalized: return
        # Poll/deadline always precede reads; timeout outcome never masks later exit.
        code=self.child.poll()
        if code is not None:
            if self.info['exitObservedMonotonic'] is None:
                self.info.update(exitCode=code,exitObservedEpoch=self.epoch(),exitObservedMonotonic=self.monotonic())
            if self.info['status']=='running': self.info['status']='finished'
        elif self.info['timeoutDetectedMonotonic'] is None and self.monotonic()-self.info['startedMonotonic']>=10:
            self.info.update(status='timeout',timeoutDetectedEpoch=self.epoch(),timeoutDetectedMonotonic=self.monotonic())
            self.registry.signal('kill')
        self.drain()
    def finalize(self,path):
        if self.finalized: return
        try:
            self.check()  # One finite final drain, even if exit was never observed.
        finally:
            self.child.stdout.close(); self.finalized=True; self.info['finalizedEpoch']=self.epoch()
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'wb') as f: f.write(self.prefix)

def execute(args):
    if not isinstance(args.origin,str) or args.origin not in ORIGINS: raise ValueError('invalid-origin')
    origin_class=ORIGINS[args.origin]
    if args.duration_seconds not in (300,10800) or isinstance(args.duration_seconds,bool): raise ValueError('invalid-duration')
    if isinstance(args.host_pid,bool) or not isinstance(args.host_pid,int) or args.host_pid<=0: raise ValueError('invalid-host-pid')
    kind='turn-continuity' if args.duration_seconds==10800 else 'turn-diagnostic'
    sampling={'thresholdMs':5000 if args.duration_seconds==10800 else 2000,'comparison':'>=' if args.duration_seconds==10800 else '>'}
    hashes={'helper':digest(HELPER),'sampler':digest(SAMPLER)}
    if hashes!={'helper':EXPECTED_HELPER,'sampler':EXPECTED_SAMPLER}: raise ValueError('source-hash-mismatch')
    host=host_snapshot(args.host_pid)
    out=Path(args.output_dir).absolute()
    # The caller must supply a new immediate child of this private workspace.
    private=Path('/tmp/wrd-owned-turn-probe-private').resolve()
    if out.parent.resolve()!=private or out.name in ('.','..'): raise ValueError('private-output-required')
    os.mkdir(out,0o700)
    started=time.monotonic(); worker=None; sample=None; observation=None; reg=Registry(); sample_reg=Registry()
    sample_info={'status':'not-triggered'}; failure=None; deadline=False
    def valid_host():
        try: return host_snapshot(args.host_pid)==host
        except (psutil.Error,OSError,ValueError): return False
    def start_sample():
        nonlocal sample, observation
        # Precreate exclusively; sample is allowed to truncate its own private file.
        raw=out/'host-sample.txt'; fd=os.open(raw,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600); os.close(fd)
        sample_info.update(status='starting',startedEpoch=time.time(),startedMonotonic=time.monotonic(),triggerLagNote='polling <=250ms plus scheduling; helper rows only; no media-start coverage')
        sample=subprocess.Popen(['/usr/bin/sample',str(args.host_pid),'3','10','-file',str(raw)],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True,preexec_fn=sample_limits)
        sample_reg.add_root(psutil.Process(sample.pid)); sample_info['status']='running'
        try: os.set_blocking(sample.stdout.fileno(),False)
        except OSError:
            sample.stdout.close(); sample_info['status']='diagnostic-setup-error'
            raise
        observation=SampleObservation(sample,sample_reg,sample_info)
    def check_sample():
        if observation is not None: observation.check()
        elif sample is not None:
            code=sample.poll()
            if code is None and time.monotonic()-sample_info['startedMonotonic']>=10 and sample_info['status']!='timeout':
                sample_info.update(status='timeout',timeoutDetectedEpoch=time.time(),timeoutDetectedMonotonic=time.monotonic())
                sample_reg.signal('kill')
    reg.tick=check_sample
    trigger=Trigger(valid_host,start_sample,args.duration_seconds); rows=Rows(out/'session/samples.jsonl')
    exclusive(out/'preflight.json',{'kind':kind,'originClass':origin_class,'durationSeconds':args.duration_seconds,'workerDeadlineSeconds':args.duration_seconds+300,'sampling':sampling,'hashes':hashes,'host':host,'logs':log_snapshot(),'startedEpoch':time.time(),'diagnosticPerturbed':True})
    try:
        # DEVNULL bounds output; original helper owns every file under session/.
        worker=subprocess.Popen([sys.executable,str(HELPER),'--origin',args.origin,'--mode','relay','--duration-seconds',str(args.duration_seconds),'--runtime-config',str(BASE/'signal-server/.env'),'--output-dir',str(out/'session')],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
        reg.add_root(psutil.Process(worker.pid))
        next_progress=started+30
        while True:
            reg.scan(); sample_reg.scan()
            for row in rows.read(): trigger.observe(row)
            check_sample()
            if worker.poll() is not None: break
            if time.monotonic()-started>=args.duration_seconds+300: deadline=True; break
            if time.monotonic()>=next_progress:
                print(json.dumps({'stage':'supervising','elapsedSeconds':round(time.monotonic()-started),'ownedIdentities':len(reg.entries),'sample':trigger.status}),flush=True); next_progress+=30
            time.sleep(POLL)
    except BaseException as exc:
        failure=type(exc).__name__  # Never persist arbitrary error messages.
    finally:
        # Independent synchronous cleanup still runs on worker failure/deadline/interrupt.
        try: reg.cleanup()
        finally:
            if sample is not None and sample.poll() is None:
                # Let a running sample use only its original 10s external budget.
                until=sample_info['startedMonotonic']+10
                while sample.poll() is None and time.monotonic()<until:
                    check_sample()
                    time.sleep(min(POLL,max(0,until-time.monotonic())))
                if sample.poll() is None:
                    check_sample()
            sample_reg.tick=check_sample
            sample_reg.cleanup(grace=0,term_wait=.5,kill_wait=.5)
            for child in (worker,sample):
                if child is not None:
                    try: child.wait(timeout=.1)
                    except subprocess.TimeoutExpired: pass
            if sample is not None:
                if observation is not None: observation.finalize(out/'sample-diagnostic-prefix.bin')
                sample_info['outputBytes']=(out/'host-sample.txt').stat().st_size
                sample_info['reportState']='report-empty' if sample_info['outputBytes']==0 else 'report-present-unvalidated'
            if sample_info['status']=='not-triggered': sample_info['status']=trigger.status
            final={'kind':kind,'originClass':origin_class,'durationSeconds':args.duration_seconds,'sampling':sampling,'sampleTriggered':sample is not None,'hashes':hashes,'workerExitCode':worker.poll() if worker else None,'deadline':deadline,'failureType':failure,
                   'intervention':bool(reg.attempts),'worker':reg.result(),'sample':sample_info,'sampleTrigger':trigger.observed,
                   'sampleOwnership':sample_reg.result(),'elapsedSeconds':time.monotonic()-started,'logsAtEnd':log_snapshot(),
                   'helperArtifacts':'unmodified; helper alone writes session directory','completeProcessTreeExitEstablished':False}
            exclusive(out/'supervisor.json',final)
    return 2 if deadline or failure or not final['worker']['allRecordedIdentitiesExited'] else (final['workerExitCode'] if final['workerExitCode'] is not None and final['workerExitCode']>=0 else 1)

def positive_pid(value):
    try: pid=int(value)
    except ValueError: raise argparse.ArgumentTypeError('positive integer required')
    if pid<=0: raise argparse.ArgumentTypeError('positive integer required')
    return pid

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir',required=True)
    parser.add_argument('--host-pid',type=positive_pid,required=True)
    parser.add_argument('--duration-seconds',type=int,choices=(300,10800),default=300)
    parser.add_argument('--origin',choices=ORIGINS,default='https://link.stockhub.wiki')
    parser.add_argument('--mode',choices=('relay',),default='relay')
    args=parser.parse_args(); os.umask(0o077)
    try: return execute(args)
    except (OSError,ValueError,psutil.Error) as exc:
        print(json.dumps({'status':'refused','errorType':type(exc).__name__}),file=sys.stderr); return 2
if __name__=='__main__': raise SystemExit(main())
