# -*- coding: utf-8 -*-
"""Конфигурация интеграции с Платформой (SUE_system, Keycloak SSO).

Всё читается из окружения. По умолчанию SSO ВЫКЛЮЧЕНО — обычный вход
логин/пароль работает без изменений. Включается флагом PLATFORM_SSO=true.
"""
import os


def _flag(name: str, default: bool = False) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


# Обмен Keycloak-токена Платформы на свою сессию (эндпоинт /api/auth/platform).
PLATFORM_SSO = _flag("PLATFORM_SSO", False)

# Keycloak realm «platform», public-клиент web-desktop (у токена azp==web-desktop,
# aud обычно "account" — поэтому aud не проверяем, проверяем azp).
KEYCLOAK_ISSUER = os.environ.get(
    "KEYCLOAK_ISSUER", "https://keycloak-ashinoff.amvera.io/realms/platform")
KEYCLOAK_JWKS_URL = os.environ.get(
    "KEYCLOAK_JWKS_URL",
    "https://keycloak-ashinoff.amvera.io/realms/platform/protocol/openid-connect/certs")
KEYCLOAK_AZP = os.environ.get("KEYCLOAK_AZP", "web-desktop")

# Единственная realm-роль доступа к приложению «Опрос ПУ».
OPROS_ACCESS_ROLE = os.environ.get("OPROS_ACCESS_ROLE", "opros-user")

# Origin Платформы, которой разрешено встраивать приложение в iframe
# (CSP frame-ancestors) и от которой принимаем postMessage с токеном.
PLATFORM_ORIGIN = os.environ.get("PLATFORM_ORIGIN", "https://sue-system-ashinoff.amvera.io")
