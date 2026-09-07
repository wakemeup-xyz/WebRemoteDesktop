"""Fixture-only UDP echo peer; payload is bounded and never inspects media."""
from __future__ import annotations
import argparse,socket
p=argparse.ArgumentParser();p.add_argument('--host',default='0.0.0.0');p.add_argument('--port',type=int,default=59000);a=p.parse_args()
with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as s:
 s.bind((a.host,a.port))
 while True:
  data,addr=s.recvfrom(256)
  if 0 < len(data) <= 256: s.sendto(data,addr)
