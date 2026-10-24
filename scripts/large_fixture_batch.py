"""100 unique PDF byte variants per call; two original layouts, not 500 banks."""
from pathlib import Path
import argparse, json, hashlib

parser = argparse.ArgumentParser()
parser.add_argument('--start', type=int, required=True)
parser.add_argument('--count', type=int, default=100)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
out = root/'work/large-fixtures'
out.mkdir(parents=True, exist_ok=True)
for index in range(args.start, args.start+args.count):
    name = 'synthetic-ruled.pdf' if index % 2 == 0 else 'synthetic-borderless.pdf'
    # A permitted PDF trailing comment makes each input byte-distinct. Every
    # input still goes through the actual extractor, not a reused parse result.
    raw = (root/'public/samples'/name).read_bytes() + f'\n% PDF Statement Batch synthetic queue input {index:04d}\n'.encode()
    (out/f'batch-{index:04d}.pdf').write_bytes(raw)
print(json.dumps({'start': args.start, 'created': args.count,
                 'scope': 'unique PDF bytes using two original synthetic text layouts'}))
