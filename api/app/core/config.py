from __future__ import annotations

from functools import lru_cache

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="RG_", extra="ignore")

    app_env: str = Field("local", pattern="^(local|test|staging|production)$")
    database_url: str = "postgresql+psycopg://paymyrent:paymyrent@localhost:5432/paymyrent"   # system: migrations, jobs, webhooks, admin (owns the tables)
    # What signed-in requests use: the limited role pmr_app, restricted by row-level security. Empty = fall back to database_url
    # (row-level security then does NOT apply; production refuses to start that way).
    app_database_url: str = ""
    public_base_url: str = "http://localhost:8000"
    cors_origins: list[str] = []

    # Auth
    firebase_project_id: str = ""
    dev_auth_enabled: bool = True              # local identity simulator; forbidden in production
    dev_jwt_secret: str = "dev-only-not-a-secret"
    otp_hash_secret: str = "dev-otp-hash-key"
    otp_ttl_seconds: int = 300
    otp_max_attempts: int = 5
    otp_max_per_hour: int = 5
    max_owner_numbers: int = 2          # people who can act as owners of one account (the subscriber + this many minus one)

    # Subscription
    grace_days: int = 7
    subscription_provider: str = "sandbox"       # sandbox | razorpay
    subscription_key_id: str = ""
    subscription_key_secret: str = ""
    subscription_webhook_secret: str = "sandbox-sub-webhook-secret"

    # Rent collection (tenant → owner). Separate merchant config by design.
    rent_provider: str = "sandbox"
    rent_key_id: str = ""
    rent_key_secret: str = ""
    rent_webhook_secret: str = "sandbox-rent-webhook-secret"
    rent_online_enabled: bool = True             # still requires a verified owner payout account

    # Identity verification (eKYC). 'sandbox' simulates results; any real provider is an adapter in providers/kyc.py.
    kyc_provider: str = "sandbox"                # sandbox | none (| a licensed provider once connected)
    kyc_webhook_secret: str = "sandbox-kyc-webhook-secret"
    kyc_validity_days: int = 365
    kyc_notice_version: str = "kyc-v1"
    admin_token: str = ""                        # reviewer API is disabled while empty

    # Messaging
    sms_provider: str = "console"
    whatsapp_provider: str = "console"
    email_provider: str = "console"              # console | ses
    push_provider: str = "console"               # console | fcm
    fcm_service_account_json: str = ""           # the Firebase service account key (the whole JSON); only with push_provider=fcm. Never in git.
    ses_from_address: str = "no-reply@example.in"

    # AI
    ai_provider: str = "mock"                    # mock | bedrock
    ai_default_model: str = "mock-small"
    ai_bedrock_model_map: dict[str, str] = {"bedrock-small": "apac.amazon.nova-micro-v1:0"}
    ai_paise_per_1k_tokens: int = 3              # conservative estimate used for reservations
    ai_enabled: bool = True

    # Storage
    storage_backend: str = "local"               # local | s3
    s3_bucket: str = ""
    aws_region: str = "ap-south-1"
    local_storage_dir: str = "./.storage"

    # Jobs
    job_trigger_secret: str = "dev-job-secret"
    file_signing_secret: str = "dev-file-signing-key"      # signs local file download links (separate from the job secret)
    pan_encryption_key: str = "dev-pan-encryption-key"     # encrypts owner PAN at rest; also keys the PAN lookup hash

    # Hardening
    max_body_bytes: int = 8 * 1024 * 1024          # reject larger request bodies before reading them (Excel import is the biggest)
    allowed_hosts: list[str] = []                  # Host header allow-list (production: your API domain)
    db_pool_size: int = 10
    db_max_overflow: int = 5

    @model_validator(mode="after")
    def _production_guards(self) -> "Settings":
        if self.app_env == "production":
            problems = []
            if self.dev_auth_enabled:
                problems.append("RG_DEV_AUTH_ENABLED must be false")
            if not self.firebase_project_id:
                problems.append("RG_FIREBASE_PROJECT_ID required")
            for name in ("dev_jwt_secret", "otp_hash_secret", "job_trigger_secret", "file_signing_secret", "pan_encryption_key"):
                v = getattr(self, name)
                if v.startswith("dev") or len(v) < 24:
                    problems.append(f"RG_{name.upper()} must be a real secret of at least 24 characters")
            for name in ("subscription_webhook_secret", "rent_webhook_secret", "kyc_webhook_secret"):
                if getattr(self, name).startswith("sandbox"):
                    problems.append(f"RG_{name.upper()} must be set")
            if not self.public_base_url.startswith("https://"):
                problems.append("RG_PUBLIC_BASE_URL must be https")
            if "paymyrent:paymyrent@" in self.database_url:
                problems.append("RG_DATABASE_URL still uses the default development password")
            if not self.app_database_url or "pmr_app:pmr_app@" in self.app_database_url or self.app_database_url == self.database_url:
                problems.append("RG_APP_DATABASE_URL must use the limited pmr_app role with its own non-default password")
            if not self.allowed_hosts:
                problems.append("RG_ALLOWED_HOSTS must list the API host name(s)")
            if "*" in self.cors_origins or any(o.startswith("http://") for o in self.cors_origins):
                problems.append("RG_CORS_ORIGINS must be explicit https origins")
            if self.subscription_provider == "sandbox" or self.rent_provider == "sandbox":
                problems.append("sandbox payment providers are not allowed in production")
            if self.push_provider == "fcm" and not self.fcm_service_account_json:
                problems.append("RG_FCM_SERVICE_ACCOUNT_JSON required when RG_PUSH_PROVIDER=fcm")
            if self.ai_provider == "mock" and self.ai_enabled:
                problems.append("configure a real AI provider or set RG_AI_ENABLED=false")
            if problems:
                raise ValueError("Unsafe production configuration: " + "; ".join(problems))
        return self

    @property
    def is_demo(self) -> bool:
        return self.app_env in ("local", "test")


@lru_cache
def get_settings() -> Settings:
    return Settings()
