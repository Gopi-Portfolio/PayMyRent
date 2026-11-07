"""Job CLI inside the API image:  python -m app.cli generate_invoices"""
from __future__ import annotations

import argparse
import json

from app.modules.jobs import JOBS, default_run_key, run_job


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("job", choices=sorted(JOBS))
    ap.add_argument("--run-key", default=None)
    a = ap.parse_args()
    out = run_job(a.job, a.run_key or default_run_key(a.job))
    print(json.dumps(out, default=str))
    return 0 if out["status"] in ("succeeded", "already_ran_or_running") else 1


if __name__ == "__main__":
    raise SystemExit(main())
