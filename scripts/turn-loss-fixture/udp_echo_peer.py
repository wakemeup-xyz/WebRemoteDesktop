"""Fixture-only UDP echo peer; payload is bounded and never inspects media."""
from __future__ import annotations
import argparse,selectors,socket
p=argparse.ArgumentParser();p.add_argument('--host',default='0.0.0.0');p.add_argument('--port',type=int,action='append');a=p.parse_args()
ports=a.port or [59000]; selector=selectors.DefaultSelector(); sockets=[]
try:
 for port in ports:
  s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.bind((a.host,port)); selector.register(s,selectors.EVENT_READ); sockets.append(s)
 while True:
  for key,_ in selector.select():
   data,addr=key.fileobj.recvfrom(256)
   if 0 < len(data) <= 256: key.fileobj.sendto(data,addr)
finally:
 for s in sockets: s.close()
