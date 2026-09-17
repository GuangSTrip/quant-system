#!/usr/bin/env python3
"""Download and verify the frozen low-frequency ETF research snapshot."""

import argparse
import hashlib
import shutil
import sys
from pathlib import Path
from urllib.error import URLError
from urllib.request import ProxyHandler, Request, build_opener, urlopen

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from quant_system.data import data_quality_report, load_yahoo_wide_csv


SOURCE_URL = (
    "https://cdn.jsdelivr.net/gh/hhhx-lab/-ETF-@"
    "899d6f075577ef50da6954c4a693f040f7001d3c/data/raw/etf_prices_raw.csv"
)
SOURCE_SHA256 = "8fe8d4ccf9d0fa9660b898d88c510ac71505b0907a6cef37989d3c0dc8fed8c5"
DEFAULT_OUTPUT = Path("data/low_frequency_etfs_raw.csv")


def _download(url: str, destination: Path) -> None:
    request = Request(url, headers={"User-Agent": "quant-system-data-prep/0.1"})
    try:
        response = urlopen(request, timeout=60)
    except URLError:
        # A broken optional shell proxy should not prevent an otherwise valid
        # direct HTTPS connection. This second attempt ignores proxy variables.
        response = build_opener(ProxyHandler({})).open(request, timeout=60)
    with response, destination.open("wb") as handle:
        shutil.copyfileobj(response, handle)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--source-url", default=SOURCE_URL)
    parser.add_argument(
        "--refresh", action="store_true", help="download again even when the local hash matches"
    )
    args = parser.parse_args()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(args.output.read_bytes()).hexdigest() if args.output.exists() else ""
    if args.refresh or digest != SOURCE_SHA256:
        temporary = args.output.with_suffix(args.output.suffix + ".part")
        _download(args.source_url, temporary)
        digest = hashlib.sha256(temporary.read_bytes()).hexdigest()
        if digest != SOURCE_SHA256:
            temporary.unlink(missing_ok=True)
            raise ValueError(
                "Downloaded snapshot checksum mismatch: expected %s, got %s"
                % (SOURCE_SHA256, digest)
            )
        temporary.replace(args.output)

    report = data_quality_report(load_yahoo_wide_csv(str(args.output)))
    details = report["symbol_details"]
    starts = {value["start"][:10] for value in details.values()}
    ends = {value["end"][:10] for value in details.values()}
    print("Prepared %s" % args.output.resolve())
    print("  sha256 : %s" % digest)
    print("  symbols: %s" % ", ".join(sorted(details)))
    print("  rows   : %d (%d per symbol)" % (report["rows"], min(v["rows"] for v in details.values())))
    print("  range  : %s to %s" % (min(starts), max(ends)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
