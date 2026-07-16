# -*- coding: utf-8 -*-
"""Модели базы данных. SQLite на постоянном диске (/data на Амвере)."""
import os
from datetime import datetime
from sqlalchemy import (create_engine, Column, Integer, String, Boolean,
                        DateTime, Float, ForeignKey, Text, Index)
from sqlalchemy.orm import declarative_base, sessionmaker

DATA_DIR = os.environ.get("DATA_DIR", "/data")
os.makedirs(DATA_DIR, exist_ok=True)

# Подключение к БД:
#   DATABASE_URL задана  -> PostgreSQL (CNPG на Амвере), например:
#     postgresql+psycopg2://user:pass@amvera-ashinoff-cnpg-oprosdb-rw:5432/oprosdb
#   не задана            -> SQLite на постоянном диске (локальная отладка)
DATABASE_URL = os.environ.get("DATABASE_URL", "")

if DATABASE_URL:
    # Амвера иногда даёт URL вида postgresql://... — приводим к драйверу psycopg2
    if DATABASE_URL.startswith("postgresql://"):
        DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+psycopg2://", 1)
    engine = create_engine(
        DATABASE_URL,
        pool_pre_ping=True,     # переживаем обрывы соединения/рестарты БД
        pool_size=5,
        max_overflow=5,
        pool_recycle=1800,
    )
else:
    DB_PATH = os.path.join(DATA_DIR, "pu_survey.db")
    engine = create_engine(
        f"sqlite:///{DB_PATH}",
        connect_args={"check_same_thread": False, "timeout": 60},
    )
SessionLocal = sessionmaker(bind=engine, autoflush=False)
Base = declarative_base()

# Роли:
# admin        — видит всё, может всё (в т.ч. удалить базу, управлять пользователями)
# uploader     — админ-загрузчик: всё, кроме удаления базы и пользователей
# staff        — служба учёта: видит всё, не загружает, выдаёт задания на РЭС
# res          — участок: видит только свой РЭС, может выгружать отчёты, закрывать задания
ROLES = ("admin", "uploader", "staff", "res")


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    login = Column(String, unique=True, nullable=False)
    pass_hash = Column(String, nullable=False)
    name = Column(String, default="")
    role = Column(String, nullable=False, default="res")
    res_name = Column(String, nullable=True)   # для роли res — свой РЭС
    active = Column(Boolean, default=True)


class Upload(Base):
    """Одна загрузка файла из Пирамиды = снимок состояния."""
    __tablename__ = "uploads"
    id = Column(Integer, primary_key=True)
    uploaded_at = Column(DateTime, default=datetime.utcnow)
    filename = Column(String)
    period_from = Column(String, default="")
    period_to = Column(String, default="")
    uploaded_by = Column(Integer, ForeignKey("users.id"))
    status = Column(String, default="processing")  # processing | done | error
    error = Column(Text, default="")
    total = Column(Integer, default=0)
    collected = Column(Integer, default=0)
    disconnected = Column(Integer, default=0)
    fading = Column(Integer, default=0)
    changes_seen = Column(Boolean, default=False)  # загрузчик просмотрел изменения


class Meter(Base):
    """Реестр ПУ — «сухой остаток». Ключ: тип + серийный номер."""
    __tablename__ = "meters"
    id = Column(Integer, primary_key=True)
    meter_key = Column(String, unique=True, nullable=False)  # type||serial
    type_name = Column(String)        # C: Тип ПУ
    serial = Column(String)           # D
    vendor = Column(String)           # производитель (вычислен)
    is_spodes = Column(Boolean, default=False)
    phase = Column(String)            # E
    res = Column(String, index=True)  # J
    feeder = Column(String)           # K
    tp = Column(String, index=True)   # L
    tu_path = Column(Text)            # H: точка учёта (адрес)
    abonent_type = Column(String)     # M
    tu_type = Column(String)          # N
    first_upload_id = Column(Integer)
    last_upload_id = Column(Integer, index=True)  # в какой загрузке видели последний раз
    active = Column(Boolean, default=True)        # присутствует в последней загрузке
    replaced_by = Column(Integer, nullable=True)  # id нового ПУ, если заменён


class MeterState(Base):
    """Состояние ПУ в конкретной загрузке."""
    __tablename__ = "meter_states"
    id = Column(Integer, primary_key=True)
    upload_id = Column(Integer, ForeignKey("uploads.id"), index=True)
    meter_id = Column(Integer, ForeignKey("meters.id"), index=True)
    collected = Column(Boolean, default=False)     # P
    disconnected = Column(Boolean, default=False)  # O
    fading = Column(Boolean, default=False)        # Q
    route_class = Column(String)   # RootRouter | RTR | МКС | Без порта | GSM | Прочее | Нет
    route_raw = Column(String)     # F целиком
    route_device = Column(String)  # идентификатор ведущего устройства (для анализа)
    poll_date = Column(String)     # G
    modulation = Column(String)    # R
    data_type = Column(String)     # S


Index("ix_state_upload_meter", MeterState.upload_id, MeterState.meter_id)


class Change(Base):
    """Изменения между загрузками — вкладка для загрузчика."""
    __tablename__ = "changes"
    id = Column(Integer, primary_key=True)
    upload_id = Column(Integer, ForeignKey("uploads.id"), index=True)
    meter_id = Column(Integer, ForeignKey("meters.id"), nullable=True)
    res = Column(String, index=True)
    change_type = Column(String, index=True)
    # added / removed / repaired / serial_changed / collect_lost / collect_restored / moved
    details = Column(Text, default="")


class Task(Base):
    """Задание на участок (РЭС): наладить опрос."""
    __tablename__ = "tasks"
    id = Column(Integer, primary_key=True)
    res = Column(String, index=True, nullable=False)
    priority = Column(Integer, default=2)          # 1 — высший
    title = Column(String, nullable=False)
    description = Column(Text, default="")
    meter_id = Column(Integer, ForeignKey("meters.id"), nullable=True)
    tp = Column(String, nullable=True)             # задание на всю ТП
    status = Column(String, default="open")        # open | done | auto_closed
    created_by = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=datetime.utcnow)
    closed_at = Column(DateTime, nullable=True)
    closed_comment = Column(Text, default="")


def init_db():
    Base.metadata.create_all(engine)
