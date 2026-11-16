"""A save must be committed BEFORE its reply is sent, or the next screen (which reads straight away) can miss what was just saved.
FastAPI 0.118+ runs a dependency's exit code after the reply unless it is declared with scope="function". This fails if any route takes the database
the old way, so the mistake cannot come back unnoticed."""
from __future__ import annotations

import pathlib
import re

APP = pathlib.Path(__file__).resolve().parents[2] / "app"


def test_every_use_of_the_database_dependency_commits_before_the_reply():
    bad = []
    for path in APP.rglob("*.py"):
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            for m in re.finditer(r"Depends\(\s*get_db\s*([,)])", line):
                if m.group(1) == ")" or 'scope="function"' not in line[m.start():]:
                    bad.append(f"{path.relative_to(APP)}:{n}")
    assert bad == [], f'use Depends(get_db, scope="function") here: {bad}'
