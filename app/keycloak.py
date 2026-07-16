# -*- coding: utf-8 -*-
"""Проверка Keycloak access-токена по JWKS realm-а (Платформа SUE_system).

Проверяем подпись, iss, exp и azp (у public-клиента aud обычно "account",
поэтому aud не требуем — сверяем azp). JWKS кэшируется в процессе и
перезапрашивается при промахе по kid или по TTL. Сам токен не логируем и не
храним — только причину отказа.
"""
import json
import time
import urllib.request
from typing import Optional

from jose import JWTError, jwt

from . import config

_JWKS_TTL_SECONDS = 3600
_jwks_cache = {"keys": None, "fetched_at": 0.0}


class TokenError(Exception):
    """Токен не прошёл проверку. Текст безопасно логировать (без данных токена)."""


def _fetch_jwks() -> dict:
    req = urllib.request.Request(
        config.KEYCLOAK_JWKS_URL, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as resp:  # noqa: S310 (доверенный URL из конфига)
        return json.loads(resp.read().decode("utf-8"))


def _get_jwks(force: bool = False) -> dict:
    now = time.time()
    stale = (now - _jwks_cache["fetched_at"]) > _JWKS_TTL_SECONDS
    if force or _jwks_cache["keys"] is None or stale:
        _jwks_cache["keys"] = _fetch_jwks()
        _jwks_cache["fetched_at"] = now
    return _jwks_cache["keys"]


def _find_key(kid: str, jwks: dict) -> Optional[dict]:
    for key in jwks.get("keys", []):
        if key.get("kid") == kid:
            return key
    return None


def verify_token(token: str) -> dict:
    """Вернуть проверенные claims либо бросить TokenError с безопасной причиной."""
    try:
        header = jwt.get_unverified_header(token)
    except JWTError as exc:
        raise TokenError(f"malformed token header ({exc.__class__.__name__})")

    kid = header.get("kid")
    if not kid:
        raise TokenError("no kid in token header")

    key = _find_key(kid, _get_jwks())
    if key is None:
        # Ключи могли ротироваться — перезапросим один раз.
        key = _find_key(kid, _get_jwks(force=True))
    if key is None:
        raise TokenError("signing key not found in JWKS")

    try:
        claims = jwt.decode(
            token, key,
            algorithms=[header.get("alg", "RS256")],
            issuer=config.KEYCLOAK_ISSUER,
            options={"verify_aud": False},  # public-клиент: aud обычно "account"
        )
    except JWTError as exc:
        raise TokenError(f"invalid token ({exc.__class__.__name__})")

    azp = claims.get("azp")
    if azp != config.KEYCLOAK_AZP:
        raise TokenError(f"unexpected azp: {azp!r}")

    return claims


def identity_from_claims(claims: dict) -> dict:
    return {
        "keycloak_id": claims.get("sub"),
        "email": claims.get("email"),
        "roles": (claims.get("realm_access") or {}).get("roles", []),
    }


def has_access(roles) -> bool:
    """True, если в токене есть realm-роль доступа к «Опрос ПУ» (opros-user)."""
    return config.OPROS_ACCESS_ROLE in (roles or [])
