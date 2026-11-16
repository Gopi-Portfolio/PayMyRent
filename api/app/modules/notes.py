"""Notes (typed or reviewed voice transcript, ≤250 graphemes) and disputes. Notes never change money."""
from __future__ import annotations

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, File, UploadFile, Header
from pydantic import BaseModel, Field

from ..core.auth import CurrentUser, OwnerScope, complete_user, owner_scope, tenancy_party
from ..core.config import get_settings
from ..core.db import Db, get_db
from ..core.errors import AppError
from ..core.idempotency import fingerprint, idempotent
from ..domain.validation import validate_note
from ..providers import storage
from . import notify

router = APIRouter(prefix="/api/v1", tags=["notes"])
Target = Literal["tenancy", "invoice", "invoice_line", "payment", "deposit_txn", "dispute", "charge_submission"]

_TARGET_SQL = {
    "tenancy": "SELECT 1 WHERE CAST(:id AS uuid) = :t",
    "invoice": "SELECT 1 FROM monthly_invoices WHERE id = :id AND tenancy_id = :t",
    "invoice_line": "SELECT 1 FROM invoice_lines l JOIN monthly_invoices i ON i.id = l.invoice_id WHERE l.id = :id AND i.tenancy_id = :t",
    "payment": "SELECT 1 FROM payments WHERE id = :id AND tenancy_id = :t",
    "deposit_txn": "SELECT 1 FROM deposit_transactions WHERE id = :id AND tenancy_id = :t",
    "dispute": "SELECT 1 FROM disputes WHERE id = :id AND tenancy_id = :t",
    "charge_submission": "SELECT 1 FROM charge_submissions WHERE id = :id AND tenancy_id = :t",
}


class NoteIn(BaseModel):
    target_type: Target
    target_id: UUID
    body: str = Field(max_length=2000)
    input_method: Literal["typed", "voice"] = "typed"   # 'voice' = transcript the user reviewed and submitted
    visibility: Literal["shared", "owner_private"] = "shared"


@router.post("/tenancies/{tenancy_id}/notes")
def add_note(tenancy_id: UUID, body: NoteIn, user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db), idempotency_key: str | None = Header(default=None, alias="Idempotency-Key")) -> dict:
    def work() -> dict:
        t, role, _ = tenancy_party(db, user, tenancy_id)
        if body.visibility == "owner_private" and role != "owner":
            raise AppError("FORBIDDEN", "only owners can keep private notes")
        if not db.scalar(_TARGET_SQL[body.target_type], id=body.target_id, t=tenancy_id):
            raise AppError("NOT_FOUND", "note target not found")
        text = validate_note(body.body)
        nid = db.scalar("""INSERT INTO notes(owner_account_id, tenancy_id, target_type, target_id, author_user_id, author_role, body,
                                             input_method, visibility)
                           VALUES (:o, :t, :tt, :ti, :u, :r, :b, :m, :v) RETURNING id""", o=t["owner_account_id"], t=tenancy_id,
                        tt=body.target_type, ti=body.target_id, u=user.id, r=role, b=text, m=body.input_method, v=body.visibility)
        return dict(db.one("SELECT * FROM notes WHERE id = :n", n=nid))
    return idempotent(db, user.id, idempotency_key, fingerprint("POST", f"/tenancies/{tenancy_id}/notes", body.model_dump(mode="json")), work)


@router.get("/tenancies/{tenancy_id}/notes")
def list_notes(tenancy_id: UUID, target_type: Target | None = None, target_id: UUID | None = None,
               user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db)) -> dict:
    _, role, _ = tenancy_party(db, user, tenancy_id)
    rows = db.all("""SELECT n.id, n.target_type, n.target_id, n.author_role, n.body, n.input_method, n.visibility, n.created_at, n.edited_at,
                            (n.author_user_id = :u) AS mine
                     FROM notes n WHERE n.tenancy_id = :t AND (:role = 'owner' OR n.visibility = 'shared')
                       AND (CAST(:tt AS text) IS NULL OR n.target_type = :tt) AND (CAST(:ti AS uuid) IS NULL OR n.target_id = :ti)
                     ORDER BY n.created_at DESC LIMIT 200""", t=tenancy_id, role=role, tt=target_type, ti=target_id, u=user.id)
    return {"items": [dict(r) for r in rows]}


class NoteEdit(BaseModel):
    body: str = Field(max_length=2000)


@router.patch("/notes/{note_id}")
def edit_note(note_id: UUID, body: NoteEdit, user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db)) -> dict:
    n = db.must("SELECT * FROM notes WHERE id = :n AND author_user_id = :u FOR UPDATE", "note", n=note_id, u=user.id)
    db.exec("INSERT INTO note_revisions(note_id, body) VALUES (:n, :b)", n=note_id, b=n["body"])
    db.exec("UPDATE notes SET body = :b, edited_at = now() WHERE id = :n", b=validate_note(body.body), n=note_id)
    return dict(db.one("SELECT * FROM notes WHERE id = :n", n=note_id))


# ───────────────────────── disputes ─────────────────────────
class DisputeIn(BaseModel):
    target_type: Literal["payment", "invoice_line", "deposit_txn", "charge_submission"]
    target_id: UUID
    reason: str = Field(max_length=2000)


@router.post("/tenancies/{tenancy_id}/disputes")
def raise_dispute(tenancy_id: UUID, body: DisputeIn, user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db)) -> dict:
    t, role, _ = tenancy_party(db, user, tenancy_id)
    if role != "tenant":
        raise AppError("FORBIDDEN", "disputes are raised by the tenant")
    if not db.scalar(_TARGET_SQL[body.target_type], id=body.target_id, t=tenancy_id):
        raise AppError("NOT_FOUND", "dispute target not found")
    did = db.scalar("""INSERT INTO disputes(owner_account_id, tenancy_id, target_type, target_id, raised_by, reason)
                       VALUES (:o, :t, :tt, :ti, :u, :r) RETURNING id""", o=t["owner_account_id"], t=tenancy_id, tt=body.target_type,
                    ti=body.target_id, u=user.id, r=validate_note(body.reason, "reason"))
    return dict(db.one("SELECT * FROM disputes WHERE id = :d", d=did))


@router.get("/tenancies/{tenancy_id}/disputes")
def list_disputes(tenancy_id: UUID, user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db)) -> dict:
    tenancy_party(db, user, tenancy_id)
    return {"items": [dict(r) for r in db.all("SELECT * FROM disputes WHERE tenancy_id = :t ORDER BY created_at DESC", t=tenancy_id)]}


class ResolveIn(BaseModel):
    status: Literal["resolved", "rejected"]
    resolution: str = Field(min_length=3, max_length=250)


@router.post("/owner/disputes/{dispute_id}/resolve")
def resolve_dispute(dispute_id: UUID, body: ResolveIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    """Resolving records the outcome only. Any money correction is a separate, audited reversal or adjustment."""
    d = db.must("SELECT * FROM disputes WHERE id = :d AND owner_account_id = :o AND status = 'open' FOR UPDATE", "dispute",
                d=dispute_id, o=scope.owner_account_id)
    db.exec("UPDATE disputes SET status = :s, resolution = :r, resolved_by = :u, resolved_at = now() WHERE id = :d",
            s=body.status, r=body.resolution, u=scope.user.id, d=dispute_id)
    db.audit(scope.user.id, scope.owner_account_id, "dispute.resolved", "dispute", dispute_id, after=body.model_dump())
    unit = db.scalar("SELECT u.identifier FROM tenancies t JOIN units u ON u.id = t.unit_id WHERE t.id = :t", t=d["tenancy_id"])
    notify.enqueue(db, d["raised_by"], "dispute_update", {"unit": unit, "decision": body.status}, f"dispute:{dispute_id}",
                   scope.owner_account_id, channels=("push",))
    return dict(db.one("SELECT * FROM disputes WHERE id = :d", d=dispute_id))


# ───────────────────────── attachments (bill photos, proofs) ─────────────────────────
@router.post("/attachments")
async def upload_attachment(file: UploadFile = File(...), user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db)) -> dict:
    data = await file.read(storage.MAX_BYTES + 1)
    key, sha = storage.put(get_settings(), str(user.id), file.content_type or "", data)
    aid = db.scalar("""INSERT INTO file_attachments(uploaded_by, storage_key, content_type, size_bytes, sha256)
                       VALUES (:u, :k, :c, :s, :h) RETURNING id""", u=user.id, k=key, c=file.content_type, s=len(data), h=sha)
    return {"attachment_id": str(aid)}


@router.get("/owner/disputes")
def owner_disputes(scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    return {"items": [dict(r) for r in db.all("""SELECT d.*, u.identifier FROM disputes d JOIN tenancies t ON t.id = d.tenancy_id
                                                 JOIN units u ON u.id = t.unit_id WHERE d.owner_account_id = :o AND d.status = 'open'
                                                 ORDER BY d.created_at""", o=scope.owner_account_id)]}
