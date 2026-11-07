#!/usr/bin/env bash
# Monthly restore drill: restore the latest automatic Lightsail DB snapshot to a temporary database,
# run the read-only ledger reconciliation query against it, then delete it. Record the result.
set -euo pipefail
REGION=${AWS_REGION:-ap-south-1}; SRC="paymyrent-${ENV:-prod}-pg"; TMP="paymyrent-restore-test-$(date +%Y%m%d)"
aws lightsail create-relational-database-from-snapshot --region "$REGION" --relational-database-name "$TMP" \
  --source-relational-database-name "$SRC" --use-latest-restorable-time --no-publicly-accessible
aws lightsail wait relational-database-available --region "$REGION" --relational-database-name "$TMP" 2>/dev/null || sleep 600
echo "Connect from a Lightsail resource in ${REGION} and run docs/AWS_DEPLOYMENT.md §Restore check, then:"
echo "aws lightsail delete-relational-database --region $REGION --relational-database-name $TMP --skip-final-snapshot"
