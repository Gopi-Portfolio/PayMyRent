#!/usr/bin/env bash
# Recreate a throwaway database, apply the SQL migrations and run the invariant tests.
set -euo pipefail
DB=${TEST_DB:-rg_test}
HERE="$(cd "$(dirname "$0")/.." && pwd)"
psql -v ON_ERROR_STOP=1 -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
for f in "$HERE"/app/db/sql/0*.sql; do psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$f"; done
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/tests/sql/test_invariants.sql"
