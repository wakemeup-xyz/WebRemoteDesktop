import time
import unittest


class TestFrameTiming(unittest.TestCase):
    def test_timing_capture_order(self):
        """Verify T0 <= T1 <= T2 <= T3 <= T4"""
        t0 = time.perf_counter()
        t1 = time.perf_counter()
        t2 = time.perf_counter()
        t3 = time.perf_counter()
        t4 = time.perf_counter()

        self.assertLessEqual(t0, t1)
        self.assertLessEqual(t1, t2)
        self.assertLessEqual(t2, t3)
        self.assertLessEqual(t3, t4)


if __name__ == '__main__':
    unittest.main()
