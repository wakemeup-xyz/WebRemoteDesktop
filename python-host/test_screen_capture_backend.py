import numpy as np
import pytest

from screen_capture_backend import pack_coregraphics_bgra


def test_coregraphics_rows_are_packed_without_stride_bytes():
    # Two pixels plus four bytes of row padding in each row.
    data = bytes([
        1, 2, 3, 4, 5, 6, 7, 8, 99, 98, 97, 96,
        11, 12, 13, 14, 15, 16, 17, 18, 89, 88, 87, 86,
    ])
    assert pack_coregraphics_bgra(data, row_bytes=12, width=2, height=2) == bytes([
        1, 2, 3, 4, 5, 6, 7, 8,
        11, 12, 13, 14, 15, 16, 17, 18,
    ])


@pytest.mark.parametrize("kwargs", [
    {"row_bytes": 7, "width": 2, "height": 1},
    {"row_bytes": 8, "width": 2, "height": 5},
    {"row_bytes": 8, "width": 0, "height": 1},
])
def test_coregraphics_packing_rejects_invalid_layout(kwargs):
    with pytest.raises(ValueError):
        pack_coregraphics_bgra(np.zeros(32, dtype=np.uint8).tobytes(), **kwargs)

