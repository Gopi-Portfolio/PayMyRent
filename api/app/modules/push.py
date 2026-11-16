"""Phone push: the app registers the device's Firebase Cloud Messaging token after sign-in and removes it on sign-out.
A token is only ever stored for the person who is signed in on that phone."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..core.auth import CurrentUser, current_user
from ..core.db import Db, get_db
from ..core.http import limiter

router = APIRouter(prefix="/api/v1", tags=["push"])


class PushTokenIn(BaseModel):
    token: str = Field(min_length=20, max_length=4096)
    platform: Literal["ios", "android"]


@router.post("/me/push-token")
def register_push_token(body: PushTokenIn, user: CurrentUser = Depends(current_user), db: Db = Depends(get_db, scope="function")) -> dict:
    limiter.check(f"pushtok:{user.id}", 30, 600)
    db.scalar("SELECT rg_register_push_token(:u, :t, :p)", u=user.id, t=body.token.strip(), p=body.platform)
    return {"registered": True}


class PushTokenOut(BaseModel):
    token: str = Field(min_length=20, max_length=4096)


@router.post("/me/push-token/remove")
def remove_push_token(body: PushTokenOut, user: CurrentUser = Depends(current_user), db: Db = Depends(get_db, scope="function")) -> dict:
    """Sign-out on this phone: stop sending this person's alerts to it. Only the person's own token can be removed."""
    db.exec("DELETE FROM push_tokens WHERE token = :t AND user_id = :u", t=body.token.strip(), u=user.id)
    return {"removed": True}
