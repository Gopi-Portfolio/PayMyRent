"""Run a scheduled job from the repo root:  python jobs/runner.py generate_invoices
Inside the API container use:              python -m app.cli generate_invoices
Both use the same job functions and job_runs idempotency as the HTTP trigger."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))

from app.cli import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
