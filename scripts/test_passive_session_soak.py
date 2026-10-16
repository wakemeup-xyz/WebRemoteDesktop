import unittest
from scripts.passive_session_soak import ContinuitySummary, private_row


def row(tick, **changes):
    sample = {'socketConnected': True, 'pcState': 'connected', 'pcIdentity': 1,
        'attemptHash': 'a', 'generation': 1, 'buildId':'release-a', 'callbacks': tick*20+1,
        'transport': {'status':'observed', 'localType':'relay', 'remoteType':'host'}}
    sample.update(changes)
    return {'status':'observed', 'elapsedSeconds':tick, 'sample':sample}


class ContinuityTest(unittest.TestCase):
    def test_complete_sequence_passes_only_passive_continuity(self):
        summary = ContinuitySummary(duration_s=10, mode='relay')
        for tick in range(11): summary.observe(row(tick))
        result = summary.result(elapsed_s=10)
        self.assertEqual(result['status'], 'PASS')
        self.assertEqual(result['visibleEffect'], 'NOT_RUN')
        self.assertEqual(result['activeControl'], 'NOT_RUN')

    def test_short_missing_churn_and_wrong_path_cannot_pass(self):
        for change in ('short', 'missing', 'churn', 'path', 'build'):
            summary = ContinuitySummary(duration_s=10, mode='relay')
            for tick in range(5 if change == 'short' else 11):
                item = row(tick)
                if tick == 2:
                    if change == 'missing': item = {'status':'missing', 'elapsedSeconds':tick}
                    if change == 'churn': item['sample']['pcIdentity'] = 2
                    if change == 'path': item['sample']['transport']['localType'] = 'host'
                    if change == 'build': item['sample']['buildId'] = None
                summary.observe(item)
            self.assertNotEqual(summary.result(elapsed_s=10)['status'], 'PASS', change)

    def test_no_render_progress_is_failure_even_if_connected(self):
        summary = ContinuitySummary(duration_s=10, mode='relay')
        for tick in range(11): summary.observe(row(tick, callbacks=1))
        self.assertEqual(summary.result(elapsed_s=10)['status'], 'FAIL')

    def test_private_attempt_is_salted_and_removed(self):
        result = private_row({'attempt':'private-id', 'buildId':'release-a'}, b'one')
        self.assertNotIn('attempt', result)
        self.assertNotIn('private-id', str(result))
        self.assertNotEqual(result['attemptHash'], private_row({'attempt':'private-id'}, b'two')['attemptHash'])


if __name__ == '__main__': unittest.main()
