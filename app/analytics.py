# -*- coding: utf-8 -*-
"""Отчёты и аналитика по последней (или выбранной) загрузке."""
from sqlalchemy import func, case, and_
from .db import Meter, MeterState, Upload, Change


def pct(c, t):
    return round(c * 100.0 / t, 2) if t else 0.0


def last_upload(db):
    return db.query(Upload).filter(Upload.status == "done").order_by(Upload.id.desc()).first()


def _base(db, upload_id, res=None):
    q = (db.query(Meter, MeterState)
         .join(MeterState, and_(MeterState.meter_id == Meter.id,
                                MeterState.upload_id == upload_id)))
    if res:
        q = q.filter(Meter.res == res)
    return q


def res_summary(db, upload_id, res=None):
    """Базовый отчёт: по каждому РЭС — всего / собирается / не собирается / %."""
    coll = func.sum(case((MeterState.collected == True, 1), else_=0))
    spod = func.sum(case((Meter.is_spodes == True, 1), else_=0))
    spod_coll = func.sum(case((and_(Meter.is_spodes == True, MeterState.collected == True), 1), else_=0))
    disc = func.sum(case((MeterState.disconnected == True, 1), else_=0))
    fad = func.sum(case((MeterState.fading == True, 1), else_=0))
    q = (db.query(Meter.res, func.count().label("total"), coll.label("coll"),
                  spod.label("spod"), spod_coll.label("spod_coll"),
                  disc.label("disc"), fad.label("fad"))
         .join(MeterState, and_(MeterState.meter_id == Meter.id,
                                MeterState.upload_id == upload_id)))
    if res:
        q = q.filter(Meter.res == res)
    rows = q.group_by(Meter.res).order_by(func.count().desc()).all()
    out = []
    for r in rows:
        out.append({
            "res": r.res, "total": r.total, "collected": int(r.coll or 0),
            "not_collected": r.total - int(r.coll or 0),
            "pct": pct(int(r.coll or 0), r.total),
            "spodes_total": int(r.spod or 0), "spodes_collected": int(r.spod_coll or 0),
            "spodes_pct": pct(int(r.spod_coll or 0), int(r.spod or 0)),
            "disconnected": int(r.disc or 0), "fading": int(r.fad or 0),
        })
    return out


def history(db, res=None):
    """Динамика по датам загрузок: факт собираемости."""
    ups = db.query(Upload).filter(Upload.status == "done").order_by(Upload.id).all()
    out = []
    for u in ups:
        if res:
            row = (db.query(func.count(),
                            func.sum(case((MeterState.collected == True, 1), else_=0)))
                   .select_from(MeterState)
                   .join(Meter, Meter.id == MeterState.meter_id)
                   .filter(MeterState.upload_id == u.id, Meter.res == res).first())
            total, coll = row[0] or 0, int(row[1] or 0)
        else:
            total, coll = u.total, u.collected
        out.append({"upload_id": u.id,
                    "date": u.uploaded_at.strftime("%d.%m.%Y %H:%M"),
                    "period": f"{u.period_from}–{u.period_to}",
                    "total": total, "collected": coll,
                    "not_collected": total - coll, "pct": pct(coll, total)})
    return out


def group_report(db, upload_id, field, res=None):
    """Разрез по производителю / типу ПУ / классу маршрута / фазности / модуляции."""
    col = {"vendor": Meter.vendor, "type": Meter.type_name,
           "route": MeterState.route_class, "phase": Meter.phase,
           "modulation": MeterState.modulation, "abonent": Meter.abonent_type}[field]
    coll = func.sum(case((MeterState.collected == True, 1), else_=0))
    q = (db.query(col.label("g"), func.count().label("total"), coll.label("coll"))
         .select_from(Meter)
         .join(MeterState, and_(MeterState.meter_id == Meter.id,
                                MeterState.upload_id == upload_id)))
    if res:
        q = q.filter(Meter.res == res)
    rows = q.group_by(col).order_by(func.count().desc()).all()
    return [{"group": r.g or "—", "total": r.total, "collected": int(r.coll or 0),
             "not_collected": r.total - int(r.coll or 0),
             "pct": pct(int(r.coll or 0), r.total)} for r in rows]


def spodes_report(db, upload_id, res=None):
    """СПОДЭС отдельно: по РЭС и по типам."""
    coll = func.sum(case((MeterState.collected == True, 1), else_=0))
    q = (db.query(Meter.res, Meter.type_name, func.count().label("total"), coll.label("coll"))
         .join(MeterState, and_(MeterState.meter_id == Meter.id,
                                MeterState.upload_id == upload_id))
         .filter(Meter.is_spodes == True))
    if res:
        q = q.filter(Meter.res == res)
    rows = q.group_by(Meter.res, Meter.type_name).order_by(Meter.res, func.count().desc()).all()
    return [{"res": r.res, "type": r.type_name, "total": r.total,
             "collected": int(r.coll or 0), "not_collected": r.total - int(r.coll or 0),
             "pct": pct(int(r.coll or 0), r.total)} for r in rows]


def dead_tp(db, upload_id, res=None, min_meters=2):
    """ТП, где НИ ОДИН ПУ не опрашивается → вероятно, не работает ведущее устройство."""
    coll = func.sum(case((MeterState.collected == True, 1), else_=0))
    q = (db.query(Meter.res, Meter.tp, func.count().label("total"), coll.label("coll"),
                  func.max(MeterState.route_device).label("dev"),
                  func.max(MeterState.route_class).label("rc"))
         .join(MeterState, and_(MeterState.meter_id == Meter.id,
                                MeterState.upload_id == upload_id))
         .filter(Meter.tp != "", Meter.tp.isnot(None)))
    if res:
        q = q.filter(Meter.res == res)
    rows = (q.group_by(Meter.res, Meter.tp)
             .having(and_(coll == 0, func.count() >= min_meters))
             .order_by(func.count().desc()).all())
    return [{"res": r.res, "tp": r.tp, "total": r.total,
             "route_class": r.rc or "—", "device": r.dev or "—",
             "verdict": "Не работает ведущее устройство (0 из %d опрашивается)" % r.total}
            for r in rows]


def device_report(db, upload_id, res=None):
    """Работоспособность ведущих устройств (RootRouter / RTR / МКС): сколько ПУ висит и % опроса."""
    coll = func.sum(case((MeterState.collected == True, 1), else_=0))
    q = (db.query(MeterState.route_class, MeterState.route_device, Meter.res,
                  func.count().label("total"), coll.label("coll"))
         .select_from(MeterState)
         .join(Meter, Meter.id == MeterState.meter_id)
         .filter(MeterState.upload_id == upload_id,
                 MeterState.route_class.in_(["RootRouter", "RTR", "МКС", "GSM", "Прочее"]),
                 MeterState.route_device != ""))
    if res:
        q = q.filter(Meter.res == res)
    rows = (q.group_by(MeterState.route_class, MeterState.route_device, Meter.res)
             .order_by((coll * 1.0 / func.count()).asc(), func.count().desc())
             .limit(500).all())
    return [{"route_class": r.route_class, "device": r.route_device, "res": r.res,
             "total": r.total, "collected": int(r.coll or 0),
             "pct": pct(int(r.coll or 0), r.total),
             "status": "НЕ РАБОТАЕТ" if int(r.coll or 0) == 0 and r.total >= 2
             else ("Деградация" if pct(int(r.coll or 0), r.total) < 50 else "OK")}
            for r in rows]


def priorities(db, upload_id, res):
    """Что участку делать в первую/вторую/третью очередь.
    1 — мёртвые ТП (ведущее устройство), 2 — угасает сбор, 3 — одиночные без опроса."""
    p1 = dead_tp(db, upload_id, res=res)
    q2 = (_base(db, upload_id, res)
          .filter(MeterState.fading == True)
          .order_by(Meter.tp).limit(2000).all())
    p2 = [{"type": m.type_name, "serial": m.serial, "tp": m.tp,
           "tu": m.tu_path[:160], "note": "Угасает сбор"} for m, s in q2]
    # без опроса, но не отключён и не на мёртвой ТП
    dead_set = {(d["res"], d["tp"]) for d in p1}
    q3 = (_base(db, upload_id, res)
          .filter(MeterState.collected == False, MeterState.disconnected == False)
          .order_by(Meter.tp).limit(5000).all())
    p3 = [{"type": m.type_name, "serial": m.serial, "tp": m.tp,
           "tu": m.tu_path[:160], "note": "Нет опроса"}
          for m, s in q3 if (m.res, m.tp) not in dead_set]
    return {"p1_dead_tp": p1, "p2_fading": p2, "p3_no_poll": p3}


def changes_report(db, upload_id, res=None):
    q = db.query(Change).filter(Change.upload_id == upload_id)
    if res:
        q = q.filter(Change.res == res)
    rows = q.order_by(Change.change_type, Change.id).limit(20000).all()
    summary = {}
    for c in rows:
        summary[c.change_type] = summary.get(c.change_type, 0) + 1
    return {"summary": summary,
            "items": [{"type": c.change_type, "res": c.res, "details": c.details} for c in rows]}


def meters_list(db, upload_id, res=None, only_not_collected=False, tp=None, limit=1000, offset=0, search=None):
    q = _base(db, upload_id, res)
    if only_not_collected:
        q = q.filter(MeterState.collected == False)
    if tp:
        q = q.filter(Meter.tp == tp)
    if search:
        like = f"%{search}%"
        q = q.filter((Meter.serial.like(like)) | (Meter.tu_path.like(like)) | (Meter.tp.like(like)))
    total = q.count()
    rows = q.order_by(Meter.res, Meter.tp).offset(offset).limit(limit).all()
    items = [{"id": m.id, "type": m.type_name, "serial": m.serial, "vendor": m.vendor,
              "spodes": m.is_spodes, "res": m.res, "feeder": m.feeder, "tp": m.tp,
              "tu": m.tu_path, "collected": s.collected, "disconnected": s.disconnected,
              "fading": s.fading, "route_class": s.route_class, "device": s.route_device,
              "poll_date": s.poll_date} for m, s in rows]
    return {"total": total, "items": items}
