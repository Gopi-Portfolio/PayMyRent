"""Field-level encryption for sensitive identifiers (owner PAN). AES-256-GCM with a key derived from RG_PAN_ENCRYPTION_KEY.
A separate keyed hash gives a stable lookup/uniqueness value without storing the PAN itself."""
from __future__ import annotations

import base64
import hashlib
import hmac
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .config import get_settings


def _key(label: str) -> bytes:
    return hashlib.sha256(f"{label}:{get_settings().pan_encryption_key}".encode()).digest()


def encrypt(plain: str, aad: str = "pan") -> str:
    nonce = os.urandom(12)
    ct = AESGCM(_key("enc")).encrypt(nonce, plain.encode(), aad.encode())
    return base64.urlsafe_b64encode(nonce + ct).decode()


def decrypt(token: str, aad: str = "pan") -> str:
    raw = base64.urlsafe_b64decode(token.encode())
    return AESGCM(_key("enc")).decrypt(raw[:12], raw[12:], aad.encode()).decode()


def encrypt_bytes(plain: bytes, aad: str = "doc") -> bytes:
    """Encrypts a whole file (an uploaded photo). nonce (12 bytes) + ciphertext + tag."""
    nonce = os.urandom(12)
    return nonce + AESGCM(_key("enc")).encrypt(nonce, plain, aad.encode())


def decrypt_bytes(blob: bytes, aad: str = "doc") -> bytes:
    blob = bytes(blob)
    return AESGCM(_key("enc")).decrypt(blob[:12], blob[12:], aad.encode())


def lookup_hash(plain: str) -> str:
    return hmac.new(_key("hash"), plain.encode(), hashlib.sha256).hexdigest()


def mask_pan(pan: str) -> str:
    return f"{pan[:2]}••••••{pan[-2:]}"
