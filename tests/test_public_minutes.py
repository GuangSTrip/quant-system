import sys, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from fetch_public_classroom_minutes import merge_bars

def chunk(times,closes):
    return {'timestamp':times,'indicators':{'quote':[{'open':[1]*len(times),'high':[2]*len(times),'low':[1]*len(times),'close':closes,'volume':[10]*len(times)}]}}
class PublicMinutesTests(unittest.TestCase):
    def test_sort_deduplicate_and_drop_missing_without_fill(self):
        bars=merge_bars([chunk([120,60],[1.5,1.5]),chunk([120,180,240],[1.5,None,1.5])])
        self.assertEqual([b['t'][-6:] for b in bars],['01:00Z','02:00Z','04:00Z'])
    def test_conflicting_overlap_rejected(self):
        with self.assertRaises(ValueError):merge_bars([chunk([60],[1.5]),chunk([60],[1.6])])
