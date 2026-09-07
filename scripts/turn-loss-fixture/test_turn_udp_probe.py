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


def test_long_term_message_integrity_excludes_the_message_integrity_attribute():
 request=p._authenticated(0x0003,b'0123456789ab','user','pass',b'realm',b'nonce',p._attr(0x0019,b'\x11\0\0\0'))
 key=hashlib.md5(b'user:realm:pass').digest()
 assert request[-24:-20] == b'\x00\x08\x00\x14'
 assert hmac.compare_digest(request[-20:], hmac.new(key, request[:20] + request[20:-24], hashlib.sha1).digest())
def test_relay_echo_requires_permission_transport_and_exact_nonce():
 class Echo(Sock):
  def turn_permission_echo(self,h,p,n,t): return n
 r=p.relay_echo_probe('127.0.0.1',3478,'u','p','172.31.0.9',59000,udp_socket=Echo()); assert r['peer'].endswith(':59000') and r['nonce']
 class Bad(Echo):
  def turn_permission_echo(self,h,p,n,t): return b'wrong'
 try:p.relay_echo_probe('127.0.0.1',3478,'u','p','172.31.0.9',59000,udp_socket=Bad())
 except RuntimeError:pass
 else:assert False
