# -*- coding: utf-8 -*-
"""Авторизация: логин/пароль + сессионный токен (cookie/Bearer).

Позже сюда же подключается Keycloak-токен от оболочки Платформы
(postMessage {type:'platform-auth', token}) — фронт уже слушает это сообщение.
"""
import logging
import os
import hashlib
import hmac
import secrets
import time
from fastapi import Request, HTTPException
from sqlalchemy import func
from .db import SessionLocal, User
from . import config, keycloak

logger = logging.getLogger("opros")

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


def resolve_platform_user(request: Request) -> User:
    """Определить пользователя по Keycloak-токену Платформы (фича за флагом).

    1) Проверить Bearer-токен по JWKS Keycloak.
    2) Пустить только при наличии realm-роли opros-user (иначе 403).
    3) Привязать к локальной учётке — сперва по keycloak_id, при первом входе
       разово по email (проставив keycloak_id). Учётки не создаём.
    Роль/РЭС берём из СВОЕЙ БД, а не из токена: Keycloak — «кто ты», приложение —
    «что тебе можно». Работает только при PLATFORM_SSO=true.
    """
    unauthorized = HTTPException(401, "Не удалось проверить токен платформы")
    if not config.PLATFORM_SSO:
        logger.info("Platform SSO 401: feature disabled")
        raise unauthorized

    header = request.headers.get("Authorization", "")
    if not header.lower().startswith("bearer "):
        logger.info("Platform SSO 401: missing or malformed Authorization header")
        raise unauthorized
    token = header.split(" ", 1)[1].strip()

    try:
        claims = keycloak.verify_token(token)
    except keycloak.TokenError as exc:
        logger.info("Platform SSO 401: %s", exc)
        raise unauthorized

    identity = keycloak.identity_from_claims(claims)
    kc_id, email, roles = identity["keycloak_id"], identity["email"], identity["roles"]
    if not kc_id:
        logger.info("Platform SSO 401: token has no sub")
        raise unauthorized
    if not keycloak.has_access(roles):
        logger.info("Platform SSO 403: token has no opros-user role")
        raise HTTPException(403, "Нет доступа к приложению «Опрос ПУ»")

    db = SessionLocal()
    try:
        user = db.query(User).filter(User.keycloak_id == kc_id).first()
        if user is None and email:
            user = db.query(User).filter(func.lower(User.email) == email.lower()).first()
            if user is not None and not user.keycloak_id:
                user.keycloak_id = kc_id
                db.commit()
                logger.info("Platform SSO: linked local user id=%s to keycloak identity", user.id)
        if user is None:
            logger.info("Platform SSO 401: no local user matched by keycloak_id or email")
            raise unauthorized
        if not user.active:
            raise HTTPException(403, "Учётная запись отключена")
        db.expunge(user)
        return user
    finally:
        db.close()


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
