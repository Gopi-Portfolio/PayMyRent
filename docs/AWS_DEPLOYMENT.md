# AWS deployment (ap-south-1, Mumbai)

**Infrastructure as code: Terraform** (`infra/terraform`). It was chosen over CDK because the stack is small, mostly declarative, and readable without a build step.

## What gets created

| Piece | Service | Notes |
|---|---|---|
| API | Lightsail **container service** (`micro` × 1) | Managed TLS endpoint, health check on `/api/v1/health`, rolling deployments. Migrations run at container start (`alembic upgrade head`). |
| Database | Lightsail **managed PostgreSQL 16** | Private (not publicly accessible), encrypted at rest, TLS required, daily automatic backups with point-in-time restore, final snapshot on delete. |
| Files | S3 bucket | Public access blocked, bucket-owner enforced, SSE-KMS with key rotation, versioning, TLS-only bucket policy. Downloads use 5-minute presigned URLs. |
| Email | SES v2 domain identity | Publish the DKIM CNAMEs, add SPF/DMARC, and request production access for ap-south-1. |
| Jobs | EventBridge rules → API destinations | Connection sends `X-Job-Key`. 5 retries over 1 hour, then an SQS dead-letter queue. Run keys make duplicates harmless. |
| Alerts | CloudWatch alarms → SNS email | DLQ not empty, failed invocations per job, SES bounce rate, AWS budget forecast. |
| Audit | CloudTrail (multi-region, log-file validation) | |
| CI/CD auth | GitHub OIDC → `paymyrent-<env>-github-deploy` role | No AWS keys in GitHub. Deploys need the protected GitHub environment. |
| Secrets | SSM Parameter Store (SecureString) under `/paymyrent/<env>/` | Terraform writes `RG_DATABASE_URL` and `RG_JOB_TRIGGER_SECRET`. You add the rest (list below). |

### Lightsail limitations and how they're handled

The prompt says to choose a secure alternative rather than drop a control. Here is how each gap is covered.

- **No IAM roles for Lightsail containers.** The app uses a dedicated IAM user with a minimal policy (S3 put/get on one bucket, KMS for that key, SES on one identity, Bedrock invoke). Its key sits only in SSM and is rotated every 90 days. Moving to ECS removes this.
- **Container logs stay in Lightsail, not CloudWatch Logs.** Logs are redacted at source. Job failures, email reputation and cost are already alarmed in CloudWatch. If you need centralised log retention or search before the ECS move, add a CloudWatch Logs handler (for example watchtower) using the same IAM user scoped to one log group.
- **Lightsail database sizing and HA.** Single-AZ. Fine for launch. Use RDS Multi-AZ when downtime tolerance tightens.

## First-time setup

```bash
# 0. Create an encrypted+versioned S3 state bucket and a DynamoDB lock table; put their names in main.tf.
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # domain, api_hostname, github_repo, alert_email
terraform init && terraform apply

# 1. Secrets you provide (SecureString):
for k in RG_FIREBASE_PROJECT_ID RG_OTP_HASH_SECRET RG_DEV_JWT_SECRET \
         RG_SUBSCRIPTION_KEY_ID RG_SUBSCRIPTION_KEY_SECRET RG_SUBSCRIPTION_WEBHOOK_SECRET \
         RG_RENT_KEY_ID RG_RENT_KEY_SECRET RG_RENT_WEBHOOK_SECRET \
         AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY RG_S3_BUCKET RG_PUBLIC_BASE_URL; do
  aws ssm put-parameter --region ap-south-1 --type SecureString --name /paymyrent/prod/$k --value '…'
done
# (the app IAM user key: aws iam create-access-key --user-name paymyrent-prod-app)

# 2. TLS for api.<domain>: create a Lightsail certificate, add its CNAME to DNS, attach it to the
#    container service (public_domain_names), and point api.<domain> at the service URL.

# 3. Deploy: GitHub → Actions → deploy → env=prod  (or ENV=prod infra/scripts/deploy_lightsail.sh)

# 4. Point the PSP webhooks at:
#    https://api.<domain>/api/v1/webhooks/payments/subscription   (platform merchant account)
#    https://api.<domain>/api/v1/webhooks/payments/rent           (rent account / route — see D-03)
```

Production refuses to start if dev auth is on, a dev secret is still in place, the sandbox PSP is configured, or the mock AI is enabled (`Settings._production_guards`).

## Backups and restores

- Automatic daily snapshots with point-in-time restore (Lightsail default retention of 7 days), plus a manual monthly snapshot kept for 12 months.
- Monthly restore drill (`infra/scripts/backup_restore_test.sh`). Restore to a temporary database, then run the reconciliation check below; it must return zero rows.

```sql
-- Restore check: every tenancy's bill view reconciles with the ledger
SELECT t.id FROM tenancies t JOIN v_tenancy_balance b ON b.tenancy_id = t.id
WHERE (SELECT COALESCE(sum(open_paise),0) FROM v_invoice_status v WHERE v.tenancy_id = t.id)
    - (SELECT COALESCE(sum(remaining_paise),0) FROM v_payment_remaining p WHERE p.tenancy_id = t.id)
    - (SELECT COALESCE(sum(remaining_paise),0) FROM v_credit_remaining c WHERE c.tenancy_id = t.id) <> b.balance_paise;
```

## Rough monthly cost at launch (verify current ap-south-1 pricing)

Lightsail container `micro` plus the smallest Lightsail PostgreSQL, a few dollars of S3 and SES, EventBridge rules, CloudWatch alarms and CloudTrail data events if enabled. That is typically tens of US dollars a month. A budget alarm at `monthly_budget_usd` is included. Bedrock and the payment provider are billed per use. AI usage is capped by plan allowance and spend ceiling.

## Scale-up path (when needed)

1. **ECS Fargate** service behind an ALB with an ACM certificate. Task role replaces the IAM user. awslogs driver sends to CloudWatch Logs.
2. **RDS PostgreSQL 16** (Multi-AZ, Performance Insights) with **RDS Proxy**. Migrate with `pg_dump`/`pg_restore` or DMS during a short write freeze.
3. Change the in-process rate limiter to a Postgres-backed or ElastiCache limiter once you run more than one task.
4. Keep EventBridge pointed at the ALB. The job endpoints and `job_runs` idempotency stay the same.
