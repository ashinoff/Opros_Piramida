# -*- coding: utf-8 -*-
"""Опрос ПУ — сервис аналитики собираемости приборов учёта (выгрузка из Пирамиды).

Роли: admin / uploader / staff / res (участок видит только свой РЭС).
"""
import os
import shutil
import threading
import urllib.parse
from datetime import datetime
from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Request, Body
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .db import init_db, SessionLocal, User, Upload, Meter, MeterState, Change, Task, DATA_DIR
from . import auth, analytics, export, config
from .importer import run_import

MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "50"))

app = FastAPI(title="Опрос ПУ", docs_url=None, redoc_url=None)
init_db()
auth.ensure_admin_exists()


@app.middleware("http")
async def _frame_ancestors(request: Request, call_next):
    """Разрешаем встраивание приложения в iframe Платформы (только её origin).
    Только заголовок ответа — авторизацию не трогает."""
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = \
        f"frame-ancestors 'self' {config.PLATFORM_ORIGIN}"
    if "x-frame-options" in response.headers:
        del response.headers["x-frame-options"]
    return response


def db_session():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def me(request: Request) -> User:
    return auth.get_current_user(request)


# ---------------- Авторизация ----------------
@app.post("/api/login")
def login(payload: dict = Body(...)):
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.login == (payload.get("login") or "").strip()).first()
        if not user or not user.active or not auth.check_pw(payload.get("password") or "", user.pass_hash):
            raise HTTPException(401, "Неверный логин или пароль")
        token = auth.create_session(user.id)
        resp = JSONResponse({"token": token, "user": _user_dict(user)})
        resp.set_cookie("session", token, httponly=True, samesite="lax", max_age=12 * 3600)
        return resp
    finally:
        db.close()


@app.post("/api/logout")
def logout(request: Request):
    auth.drop_session(request.cookies.get("session") or "")
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("session")
    return resp


@app.post("/api/auth/platform")
def platform_login(request: Request):
    """Обмен Keycloak-токена Платформы на свою сессию (SSO, фича за флагом).

    Токен проверяется по JWKS, доступ гейтит роль opros-user, личность —
    по email/keycloak_id. Роль/РЭС берём из своей БД. Отдаём тот же формат,
    что и обычный /api/login (token + user), и ставим cookie сессии."""
    user = auth.resolve_platform_user(request)  # бросает 401/403 сам
    token = auth.create_session(user.id)
    resp = JSONResponse({"token": token, "user": _user_dict(user)})
    resp.set_cookie("session", token, httponly=True, samesite="lax", max_age=12 * 3600)
    return resp


def _user_dict(u: User):
    return {"id": u.id, "login": u.login, "name": u.name, "role": u.role,
            "res": u.res_name, "email": u.email}


@app.get("/api/me")
def whoami(user: User = Depends(me)):
    return _user_dict(user)


# ---------------- Пользователи (admin) ----------------
@app.get("/api/users")
def users_list(user: User = Depends(me), db=Depends(db_session)):
    auth.require_roles(user, "admin", "uploader", "staff")
    users = db.query(User).all()
    # Сортировка по алфавиту: по имени (или логину, если имя пусто), регистр не важен.
    users.sort(key=lambda u: (u.name or u.login or "").casefold())
    return [dict(_user_dict(u), active=u.active) for u in users]


@app.post("/api/users")
def users_create(payload: dict = Body(...), user: User = Depends(me), db=Depends(db_session)):
    auth.require_roles(user, "admin")
    login_ = (payload.get("login") or "").strip()
    if not login_ or not payload.get("password"):
        raise HTTPException(400, "Логин и пароль обязательны")
    if db.query(User).filter(User.login == login_).first():
        raise HTTPException(400, "Такой логин уже существует")
    role = payload.get("role", "res")
    u = User(login=login_, pass_hash=auth.hash_pw(payload["password"]),
             name=payload.get("name", ""), role=role,
             res_name=payload.get("res") if role == "res" else None,
             email=(payload.get("email") or "").strip() or None)
    db.add(u)
    db.commit()
    return _user_dict(u)


@app.post("/api/users/{uid}")
def users_update(uid: int, payload: dict = Body(...), user: User = Depends(me), db=Depends(db_session)):
    auth.require_roles(user, "admin")
    u = db.get(User, uid)
    if not u:
        raise HTTPException(404, "Нет такого пользователя")
    if "password" in payload and payload["password"]:
        u.pass_hash = auth.hash_pw(payload["password"])
    for f in ("name", "role", "res_name"):
        if f in payload:
            setattr(u, f, payload[f])
    if "res" in payload:
        u.res_name = payload["res"]
    if "email" in payload:
        u.email = (payload.get("email") or "").strip() or None
    if "active" in payload:
        u.active = bool(payload["active"])
    db.commit()
    return _user_dict(u)


# ---------------- Загрузка файла ----------------
@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...), user: User = Depends(me), db=Depends(db_session)):
    auth.require_roles(user, "admin", "uploader")
    if db.query(Upload).filter(Upload.status == "processing").count():
        raise HTTPException(409, "Уже идёт обработка предыдущей загрузки — дождитесь окончания")
    if not file.filename.lower().endswith((".xlsx", ".xlsm")):
        raise HTTPException(400, "Ожидается файл .xlsx (выгрузка «Опрос ПУ» из Пирамиды)")
    os.makedirs(os.path.join(DATA_DIR, "uploads"), exist_ok=True)
    up = Upload(filename=file.filename, uploaded_by=user.id, status="processing")
    db.add(up)
    db.commit()
    dest = os.path.join(DATA_DIR, "uploads", f"{up.id}.xlsx")
    size = 0
    with open(dest, "wb") as f:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD_MB * 1024 * 1024:
                f.close()
                os.remove(dest)
                up.status = "error"
                up.error = f"Файл больше {MAX_UPLOAD_MB} МБ"
                db.commit()
                raise HTTPException(413, f"Файл больше {MAX_UPLOAD_MB} МБ")
            f.write(chunk)
    threading.Thread(target=run_import, args=(up.id, dest), daemon=True).start()
    return {"upload_id": up.id, "status": "processing",
            "message": "Файл принят, идёт обработка (~1–2 минуты). Обновите статус."}


@app.get("/api/uploads")
def uploads_list(user: User = Depends(me), db=Depends(db_session)):
    ups = db.query(Upload).order_by(Upload.id.desc()).limit(60).all()
    return [{"id": u.id, "date": u.uploaded_at.strftime("%d.%m.%Y %H:%M"),
             "filename": u.filename, "status": u.status, "error": u.error,
             "period": f"{u.period_from}–{u.period_to}",
             "total": u.total, "collected": u.collected,
             "pct": analytics.pct(u.collected, u.total),
             "changes_seen": u.changes_seen} for u in ups]


@app.delete("/api/uploads/{uid}")
def upload_delete(uid: int, user: User = Depends(me), db=Depends(db_session)):
    auth.require_roles(user, "admin")  # удалять может только админ
    up = db.get(Upload, uid)
    if not up:
        raise HTTPException(404, "Нет такой загрузки")
    db.query(MeterState).filter(MeterState.upload_id == uid).delete()
    db.query(Change).filter(Change.upload_id == uid).delete()
    db.delete(up)
    db.commit()
    return {"ok": True}


@app.delete("/api/database")
def wipe_database(user: User = Depends(me), db=Depends(db_session)):
    """Полная очистка базы — ТОЛЬКО админ."""
    auth.require_roles(user, "admin")
    for t in (MeterState, Change, Task, Meter, Upload):
        db.query(t).delete()
    db.commit()
    shutil.rmtree(os.path.join(DATA_DIR, "uploads"), ignore_errors=True)
    return {"ok": True}


# ---------------- Отчёты ----------------
def _resolve(db, user, upload_id=None, res=None):
    up = db.get(Upload, upload_id) if upload_id else analytics.last_upload(db)
    if not up or up.status != "done":
        raise HTTPException(404, "Нет обработанных загрузок")
    forced = auth.visible_res(user)
    return up, (forced or res or None)


@app.get("/api/report/summary")
def r_summary(upload_id: int = None, res: str = None, user: User = Depends(me), db=Depends(db_session)):
    up, res = _resolve(db, user, upload_id, res)
    return {"upload": {"id": up.id, "date": up.uploaded_at.strftime("%d.%m.%Y %H:%M"),
                       "period": f"{up.period_from}–{up.period_to}"},
            "rows": analytics.res_summary(db, up.id, res),
            "history": analytics.history(db, res)}


@app.get("/api/report/group")
def r_group(field: str, upload_id: int = None, res: str = None,
            user: User = Depends(me), db=Depends(db_session)):
    if field not in ("vendor", "type", "route", "phase", "modulation", "abonent"):
        raise HTTPException(400, "Неверный разрез")
    up, res = _resolve(db, user, upload_id, res)
    return analytics.group_report(db, up.id, field, res)


@app.get("/api/report/spodes")
def r_spodes(upload_id: int = None, res: str = None, user: User = Depends(me), db=Depends(db_session)):
    up, res = _resolve(db, user, upload_id, res)
    return analytics.spodes_report(db, up.id, res)


@app.get("/api/report/dead_tp")
def r_dead_tp(upload_id: int = None, res: str = None, min_meters: int = 2,
              user: User = Depends(me), db=Depends(db_session)):
    up, res = _resolve(db, user, upload_id, res)
    return analytics.dead_tp(db, up.id, res, min_meters)


@app.get("/api/report/devices")
def r_devices(upload_id: int = None, res: str = None, user: User = Depends(me), db=Depends(db_session)):
    up, res = _resolve(db, user, upload_id, res)
    return analytics.device_report(db, up.id, res)


@app.get("/api/report/priorities")
def r_priorities(res: str = None, upload_id: int = None, user: User = Depends(me), db=Depends(db_session)):
    up, res_ = _resolve(db, user, upload_id, res)
    if not res_:
        raise HTTPException(400, "Укажите РЭС")
    return analytics.priorities(db, up.id, res_)


@app.get("/api/report/changes")
def r_changes(upload_id: int = None, res: str = None, user: User = Depends(me), db=Depends(db_session)):
    up, res = _resolve(db, user, upload_id, res)
    return dict(analytics.changes_report(db, up.id, res),
                upload_id=up.id, changes_seen=up.changes_seen)


@app.post("/api/report/changes/seen")
def changes_seen(upload_id: int = Body(..., embed=True), user: User = Depends(me), db=Depends(db_session)):
    auth.require_roles(user, "admin", "uploader")
    up = db.get(Upload, upload_id)
    if up:
        up.changes_seen = True
        db.commit()
    return {"ok": True}


@app.get("/api/meters")
def meters(upload_id: int = None, res: str = None, not_collected: bool = False,
           tp: str = None, search: str = None, limit: int = 200, offset: int = 0,
           user: User = Depends(me), db=Depends(db_session)):
    up, res = _resolve(db, user, upload_id, res)
    return analytics.meters_list(db, up.id, res, not_collected, tp,
                                 min(limit, 1000), offset, search)


@app.get("/api/res_list")
def res_list(user: User = Depends(me), db=Depends(db_session)):
    forced = auth.visible_res(user)
    if forced:
        return [forced]
    return [r[0] for r in db.query(Meter.res).distinct().order_by(Meter.res)]


# ---------------- Задания ----------------
@app.get("/api/tasks")
def tasks_list(res: str = None, status: str = None, user: User = Depends(me), db=Depends(db_session)):
    q = db.query(Task)
    forced = auth.visible_res(user)
    if forced:
        q = q.filter(Task.res == forced)
    elif res:
        q = q.filter(Task.res == res)
    if status:
        q = q.filter(Task.status == status)
    out = []
    for t in q.order_by(Task.status, Task.priority, Task.id.desc()).limit(2000):
        m = db.get(Meter, t.meter_id) if t.meter_id else None
        out.append({"id": t.id, "res": t.res, "priority": t.priority, "title": t.title,
                    "description": t.description, "tp": t.tp, "status": t.status,
                    "created": t.created_at.strftime("%d.%m.%Y"),
                    "closed": t.closed_at.strftime("%d.%m.%Y") if t.closed_at else "",
                    "closed_comment": t.closed_comment,
                    "meter": f"{m.type_name} №{m.serial}" if m else ""})
    return out


@app.post("/api/tasks")
def task_create(payload: dict = Body(...), user: User = Depends(me), db=Depends(db_session)):
    auth.require_roles(user, "admin", "uploader", "staff")
    if not payload.get("res") or not payload.get("title"):
        raise HTTPException(400, "РЭС и название обязательны")
    t = Task(res=payload["res"], priority=int(payload.get("priority", 2)),
             title=payload["title"], description=payload.get("description", ""),
             meter_id=payload.get("meter_id"), tp=payload.get("tp"),
             created_by=user.id)
    db.add(t)
    db.commit()
    return {"id": t.id}


@app.post("/api/tasks/{tid}/close")
def task_close(tid: int, payload: dict = Body(default={}), user: User = Depends(me), db=Depends(db_session)):
    t = db.get(Task, tid)
    if not t:
        raise HTTPException(404, "Нет такого задания")
    forced = auth.visible_res(user)
    if forced and t.res != forced:
        raise HTTPException(403, "Чужой РЭС")
    t.status = "done"
    t.closed_at = datetime.utcnow()
    t.closed_comment = payload.get("comment", "")
    db.commit()
    return {"ok": True}


@app.post("/api/tasks/from_priorities")
def tasks_from_priorities(payload: dict = Body(...), user: User = Depends(me), db=Depends(db_session)):
    """Создать задания пачкой из «мёртвых ТП» для РЭС."""
    auth.require_roles(user, "admin", "uploader", "staff")
    res = payload.get("res")
    up = analytics.last_upload(db)
    if not res or not up:
        raise HTTPException(400, "Нет данных")
    created = 0
    for d in analytics.dead_tp(db, up.id, res=res):
        exists = db.query(Task).filter(Task.res == res, Task.tp == d["tp"],
                                       Task.status == "open").first()
        if exists:
            continue
        db.add(Task(res=res, priority=1, tp=d["tp"],
                    title=f"Восстановить опрос ТП {d['tp']}",
                    description=f"{d['verdict']}. Маршрут: {d['route_class']}, устройство: {d['device']}",
                    created_by=user.id))
        created += 1
    db.commit()
    return {"created": created}


# ---------------- Экспорт в Excel ----------------
def _xlsx_response(buf, name):
    quoted = urllib.parse.quote(name)
    return StreamingResponse(
        buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quoted}"})


@app.get("/api/export/summary")
def e_summary(upload_id: int = None, res: str = None, user: User = Depends(me), db=Depends(db_session)):
    up, res = _resolve(db, user, upload_id, res)
    data = analytics.res_summary(db, up.id, res)
    hist = analytics.history(db, res)
    buf = export.export_res_summary(data, hist,
                                    title=f"Опрос ПУ ({up.period_from}–{up.period_to})" + (f", {res}" if res else ""))
    return _xlsx_response(buf, f"Сводка_опроса_{up.uploaded_at.strftime('%d.%m.%Y')}.xlsx")


@app.get("/api/export/report")
def e_report(kind: str, upload_id: int = None, res: str = None,
             user: User = Depends(me), db=Depends(db_session)):
    up, res = _resolve(db, user, upload_id, res)
    if kind == "spodes":
        rows = analytics.spodes_report(db, up.id, res)
        sheets = [("СПОДЭС", ["РЭС", "Тип ПУ", "Всего", "Собирается", "Не собирается", "%"],
                   [[r["res"], r["type"], r["total"], r["collected"], r["not_collected"], r["pct"]] for r in rows],
                   [22, 34, 10, 12, 14, 9])]
    elif kind == "dead_tp":
        rows = analytics.dead_tp(db, up.id, res)
        sheets = [("Неисправные ТП", ["РЭС", "ТП", "ПУ на ТП", "Класс маршрута", "Ведущее устройство", "Вывод"],
                   [[r["res"], r["tp"], r["total"], r["route_class"], r["device"], r["verdict"]] for r in rows],
                   [22, 16, 10, 15, 45, 55])]
    elif kind == "devices":
        rows = analytics.device_report(db, up.id, res)
        sheets = [("Устройства", ["Класс", "Устройство", "РЭС", "ПУ", "Собирается", "%", "Статус"],
                   [[r["route_class"], r["device"], r["res"], r["total"], r["collected"], r["pct"], r["status"]] for r in rows],
                   [12, 48, 22, 8, 11, 9, 14])]
    elif kind in ("vendor", "type", "route", "phase", "modulation", "abonent"):
        rows = analytics.group_report(db, up.id, kind, res)
        sheets = [("Разрез", ["Группа", "Всего", "Собирается", "Не собирается", "%"],
                   [[r["group"], r["total"], r["collected"], r["not_collected"], r["pct"]] for r in rows],
                   [40, 10, 12, 14, 9])]
    elif kind == "changes":
        rep = analytics.changes_report(db, up.id, res)
        sheets = [("Изменения", ["Тип изменения", "РЭС", "Детали"],
                   [[i["type"], i["res"], i["details"]] for i in rep["items"]],
                   [18, 22, 110])]
    elif kind == "not_collected":
        lst = analytics.meters_list(db, up.id, res, only_not_collected=True, limit=100000)
        sheets = [("Без опроса", ["Тип ПУ", "Серийный", "РЭС", "Фидер", "ТП", "Маршрут", "Точка учёта"],
                   [[i["type"], i["serial"], i["res"], i["feeder"], i["tp"], i["route_class"], i["tu"]] for i in lst["items"]],
                   [30, 14, 20, 12, 14, 13, 90])]
    elif kind == "priorities":
        if not res:
            raise HTTPException(400, "Укажите РЭС")
        p = analytics.priorities(db, up.id, res)
        sheets = [
            ("1 очередь — ТП", ["ТП", "ПУ на ТП", "Маршрут", "Устройство", "Вывод"],
             [[r["tp"], r["total"], r["route_class"], r["device"], r["verdict"]] for r in p["p1_dead_tp"]],
             [16, 10, 14, 45, 55]),
            ("2 очередь — угасает", ["Тип ПУ", "Серийный", "ТП", "Точка учёта"],
             [[r["type"], r["serial"], r["tp"], r["tu"]] for r in p["p2_fading"]],
             [30, 14, 14, 90]),
            ("3 очередь — без опроса", ["Тип ПУ", "Серийный", "ТП", "Точка учёта"],
             [[r["type"], r["serial"], r["tp"], r["tu"]] for r in p["p3_no_poll"]],
             [30, 14, 14, 90]),
        ]
    elif kind == "tasks":
        q = db.query(Task)
        forced = auth.visible_res(user)
        if forced:
            q = q.filter(Task.res == forced)
        elif res:
            q = q.filter(Task.res == res)
        sheets = [("Задания", ["РЭС", "Приоритет", "Задание", "Описание", "ТП", "Статус", "Создано", "Закрыто"],
                   [[t.res, t.priority, t.title, t.description, t.tp or "", t.status,
                     t.created_at.strftime("%d.%m.%Y"),
                     t.closed_at.strftime("%d.%m.%Y") if t.closed_at else ""] for t in q.order_by(Task.priority)],
                   [20, 10, 40, 55, 14, 12, 11, 11])]
    else:
        raise HTTPException(400, "Неизвестный отчёт")
    buf = export.export_generic(sheets)
    return _xlsx_response(buf, f"Отчет_{kind}_{up.uploaded_at.strftime('%d.%m.%Y')}.xlsx")


# ---------------- Статика ----------------
STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
