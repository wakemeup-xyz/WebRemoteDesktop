from __future__ import annotations
import importlib.util, hashlib, hmac
from pathlib import Path
spec=importlib.util.spec_from_file_location('p',Path(__file__).with_name('turn_udp_probe.py')); p=importlib.util.module_from_spec(spec); assert spec.loader; spec.loader.exec_module(p)
class Sock:
 def __init__(self): self.sent=[]; self.n=0
 def settimeout(self,x): pass
 def sendto(self,b,a): self.sent.append(b)
 def recvfrom(self,_):
  request=self.sent[-1]; tx=request[8:20]; self.n+=1
  if self.n==1:return p._message(0x0113,tx,p._attr(0x0014,b'realm')+p._attr(0x0015,b'nonce')),(None,None)
  return p._message(0x0103,tx,p._attr(0x0016,b'\0\x01\0\x02\x03\x04\x05\x06')),(None,None)
def test_allocate_probe_runs_challenge_then_authenticated_allocate():
 r=p.allocate_probe('127.0.0.1',3478,'user','pass',udp_socket=Sock()); assert r['status']=='READY' and r['realm']=='realm'
def test_allocate_probe_blocks_without_relay_attribute():
 class Bad(Sock):
  def recvfrom(self,_):
   request=self.sent[-1]; return p._message(0x0113 if len(self.sent)==1 else 0x0103,request[8:20],p._attr(0x0014,b'r')+p._attr(0x0015,b'n') if len(self.sent)==1 else b''),(None,None)
 try:p.allocate_probe('127.0.0.1',3478,'u','p',udp_socket=Bad())
 except RuntimeError:pass
 else:assert False
