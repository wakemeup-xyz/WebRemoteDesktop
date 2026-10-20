"""Read the actual timestamp method via AST; test encoder without importing/starting Host."""
import ast
import asyncio
from fractions import Fraction
from pathlib import Path
import sys

import av
import numpy as np

sys.path.insert(0, str(Path.cwd() / 'python-host'))
from h264_videotoolbox_encoder import H264VideoToolboxEncoder, set_session_gop_size

root = ast.parse(Path('python-host/host.py').read_text())
track = next(n for n in root.body if isinstance(n, ast.ClassDef) and n.name == 'ScreenCaptureTrack')
method = next(n for n in track.body if isinstance(n, ast.AsyncFunctionDef) and n.name == 'next_timestamp')
ns = {'time': type('Clock', (), {'time': staticmethod(lambda: 10.05)})()}
exec(compile(ast.Module(body=[method], type_ignores=[]), '<actual-host-method>', 'exec'), ns)
print('actual host result:', asyncio.run(ns['next_timestamp'](type('Track', (), {'_start': 10})())))
set_session_gop_size(20)
for timebase in [90000, Fraction(1, 90000)]:
    encoder = H264VideoToolboxEncoder()
    timestamps = []
    for i in range(4):
        frame = av.VideoFrame.from_ndarray(np.full((720, 1152, 4), 128, dtype=np.uint8), format='bgra')
        frame.pts = i * 4500
        frame.time_base = timebase
        payloads, timestamp = encoder.encode(frame)
        timestamps.append(timestamp % (2**32))
    print('timebase:', timebase, 'RTP timestamps (relative origin):', timestamps)
