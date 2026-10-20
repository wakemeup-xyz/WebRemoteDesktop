"""Offline synthetic-text review probe. Run from repository root; never captures screen or connects to Host."""
import sys,time,json,statistics,logging
from fractions import Fraction
import av,numpy as np
from PIL import Image,ImageDraw,ImageFont
from pathlib import Path
sys.path.insert(0, str(Path.cwd() / 'python-host'))
from h264_videotoolbox_encoder import H264VideoToolboxEncoder,set_session_gop_size
logging.disable(logging.CRITICAL)
set_session_gop_size(20)
font=ImageFont.truetype('/System/Library/Fonts/Menlo.ttc',15)
import h264_videotoolbox_encoder as hmod
original_options=hmod.libx264_zerolatency_options
results=[]
for variant in ['vbv200ms','superfast']:
 w,h,tb=1728,1080,Fraction(1,90000)
 def options(bitrate,gop):
  opts=original_options(bitrate,gop)
  if variant=='vbv200ms': opts['x264-params']=opts['x264-params'].replace('vbv-bufsize=250','vbv-bufsize=500')
  if variant=='superfast': opts['preset']='superfast'
  return opts
 hmod.libx264_zerolatency_options=options
 im=Image.new('RGB',(w,h),(246,246,246));d=ImageDraw.Draw(im)
 for row,y in enumerate(range(10,h-20,22)):
  d.text((12,y),f'{row:03}  const desktopFrame = captureLatest(); // TURN video 0123456789 abcdefghijklmnopqrstuvwxyz',font=font,fill=(25,40,60))
 base=np.array(im);enc=H264VideoToolboxEncoder();dec=av.CodecContext.create('h264','r');rows=[];last=None
 for i in range(65):
  f=av.VideoFrame.from_ndarray(base,format='rgb24');f.pts=i*4500;f.time_base=tb
  t=time.perf_counter();nals=list(enc._encode_frame(f,False));dt=(time.perf_counter()-t)*1000
  raw=b''.join(b'\x00\x00\x00\x01'+n for n in nals);decoded=dec.decode(av.Packet(raw));out=decoded[-1].to_ndarray(format='rgb24')
  mse=np.mean((out.astype(float)-base)**2);diff=0 if last is None else float(np.mean(np.abs(out.astype(float)-last)))
  rows.append({'i':i,'idr':any(n[0]&31==5 for n in nals),'bytes':len(raw),'encodeMs':round(dt,3),'psnr':round(10*np.log10(255**2/max(mse,1e-9)),3),'changeMAE':round(diff,3) });last=out.astype(float)
 data={'variant':variant,'size':[w,h],'tb':str(tb),'bitrate':enc.target_bitrate,'encodeMsMedian':round(statistics.median(r['encodeMs'] for r in rows[5:]),3),'encodeMsP95':sorted(r['encodeMs'] for r in rows[5:])[56],'keyframeSamples':[r for r in rows if r['i'] in [18,19,20,21,22,38,39,40,41,42,58,59,60,61,62]],'rows':rows}
 results.append(data)
 print(json.dumps({'variant':variant,'medianMs':data['encodeMsMedian'],'p95Ms':data['encodeMsP95'],'frame39':rows[39],'frame40':rows[40],'frame59':rows[59],'frame60':rows[60]}),flush=True)
open(str(Path(__file__).with_name('encoder_variants-full.json')),'w').write(json.dumps(results,indent=2))
