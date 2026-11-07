"""Private file storage. S3 objects are never public; downloads use short-lived presigned URLs."""
from __future__ import annotations

import hashlib
import os
import secrets
from pathlib import Path

from ..core.config import Settings
from ..core.errors import AppError
from ..domain.signatures import sign_token

ALLOWED = {"image/jpeg": b"\xff\xd8\xff", "image/png": b"\x89PNG", "application/pdf": b"%PDF",
           "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": b"PK\x03\x04"}
MAX_BYTES = 10 * 1024 * 1024


def sniff(content_type: str, data: bytes) -> None:
    magic = ALLOWED.get(content_type)
    if magic is None or not data.startswith(magic):
        raise AppError("VALIDATION", "unsupported or mismatched file type")
    if len(data) > MAX_BYTES:
        raise AppError("VALIDATION", "file too large (max 10 MB)")


def put(s: Settings, owner_scope: str, content_type: str, data: bytes) -> tuple[str, str]:
    sniff(content_type, data)
    key = f"{owner_scope}/{secrets.token_hex(16)}"
    sha = hashlib.sha256(data).hexdigest()
    if s.storage_backend == "s3":
        import boto3
        boto3.client("s3", region_name=s.aws_region).put_object(
            Bucket=s.s3_bucket, Key=key, Body=data, ContentType=content_type, ServerSideEncryption="aws:kms")
    else:
        p = Path(s.local_storage_dir) / key
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    return key, sha


def download_url(s: Settings, key: str, ttl: int = 300) -> str:
    if s.storage_backend == "s3":
        import boto3
        return boto3.client("s3", region_name=s.aws_region).generate_presigned_url(
            "get_object", Params={"Bucket": s.s3_bucket, "Key": key}, ExpiresIn=ttl)
    token = sign_token(s.file_signing_secret, {"key": key}, ttl)
    return f"{s.public_base_url}/api/v1/files/local/{token}"


def read_local(s: Settings, key: str) -> bytes:
    p = (Path(s.local_storage_dir) / key).resolve()
    if not str(p).startswith(str(Path(s.local_storage_dir).resolve()) + os.sep):
        raise AppError("NOT_FOUND")
    return p.read_bytes()
