# -*- coding: utf-8 -*-
"""Авторизация: логин/пароль + сессионный токен (cookie/Bearer).

Позже сюда же подключается Keycloak-токен от оболочки Платформы
(postMessage {type:'platform-auth', token}) — фронт уже слушает это сообщение.
"""
import os
import hashlib
import hmac
import secrets
import time
from fastapi import Request, HTTPException
from .db import SessionLocal, User

SECRET = os.environ.get("APP_SECRET", "change-me-in-env")
SESSION_TTL = 12 * 3600
_sessions = {}  # token -> (user_id, expires)


def hash_pw(pw: str) -> str:
    salt = secrets.token_hex(8)
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), 100_000).hex()
    return f"{salt}${h}"


def check_pw(pw: str, stored: str) -> bool:
    try:
        salt, h = stored.split("$")
    except ValueError:
        return False
    calc = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), 100_000).hex()
    return hmac.compare_digest(calc, h)


def create_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    _sessions[token] = (user_id, time.time() + SESSION_TTL)
    return token


def drop_session(token: str):
    _sessions.pop(token, None)


def get_current_user(request: Request) -> User:
    token = request.cookies.get("session") or ""
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        token = auth[7:]
    data = _sessions.get(token)
    if not data or data[1] < time.time():
        raise HTTPException(401, "Не авторизован")
    db = SessionLocal()
    try:
        user = db.get(User, data[0])
        if not user or not user.active:
            raise HTTPException(401, "Пользователь отключён")
        return user
    finally:
        db.close()


def require_roles(user: User, *roles):
    if user.role not in roles:
        raise HTTPException(403, "Недостаточно прав")


def visible_res(user: User):
    """None = видит все РЭС; строка = только свой."""
    return user.res_name if user.role == "res" else None


def ensure_admin_exists():
    db = SessionLocal()
    try:
        if not db.query(User).count():
            db.add(User(login="admin",
                        pass_hash=hash_pw(os.environ.get("ADMIN_PASSWORD", "admin")),
                        name="Администратор", role="admin"))
            db.commit()
    finally:
        db.close()
