# -*- coding: utf-8 -*-
"""Импорт загрузки: обновляет реестр ПУ, пишет состояния, считает изменения.

Логика изменений между текущей и предыдущей загрузкой:
- added            — ПУ с новым ключом (тип+серийник), которого не было в базе
- removed          — ПУ был в предыдущей загрузке, в текущей отсутствует
- repaired         — на той же точке учёта (H) старый ПУ пропал, появился новый
                     и он собирается → считаем, что отремонтировали (замена ПУ)
- serial_changed   — та же точка учёта, ПУ заменён, но опроса нет
- collect_lost     — был опрос, стал без опроса
- collect_restored — был без опроса, опрос появился (без замены)
- moved            — ПУ тот же, но сменил РЭС/ТП
Также автозакрываются задания: если ПУ задания начал собираться.
"""
from datetime import datetime
from sqlalchemy import func
from .db import SessionLocal, Upload, Meter, MeterState, Change, Task
from .parser import parse_file

BATCH = 2000


def run_import(upload_id: int, file_path: str):
    db = SessionLocal()
    up = db.get(Upload, upload_id)
    try:
        _run(db, up, file_path)
        up.status = "done"
        db.commit()
    except Exception as e:
        db.rollback()
        up = db.get(Upload, upload_id)
        up.status = "error"
        up.error = str(e)[:2000]
        db.commit()
    finally:
        db.close()


def _run(db, up: Upload, file_path: str):
    prev_upload = (db.query(Upload)
                   .filter(Upload.status == "done", Upload.id != up.id)
                   .order_by(Upload.id.desc()).first())
    prev_id = prev_upload.id if prev_upload else None

    # существующий реестр: key -> (id, res, tp, tu_path, active)
    existing = {}
    for m in db.query(Meter.id, Meter.meter_key, Meter.res, Meter.tp, Meter.tu_path).yield_per(5000):
        existing[m.meter_key] = m

    # состояние предыдущей загрузки: meter_id -> collected
    prev_state = {}
    if prev_id:
        for s in db.query(MeterState.meter_id, MeterState.collected)\
                   .filter(MeterState.upload_id == prev_id).yield_per(5000):
            prev_state[s.meter_id] = s.collected

    seen_ids = set()
    new_keys = set()     # ключи ПУ, добавленных в этой загрузке (защита от дублей в файле)
    added_by_tu = {}     # tu_path -> [(meter_id, collected)]
    total = collected_n = disc_n = fading_n = 0
    states_buf, changes_buf = [], []

    gen = parse_file(file_path)
    meta = next(gen)["meta"]
    up.period_from, up.period_to = meta["period_from"], meta["period_to"]
    db.commit()

    for r in gen:
        key = f"{r['type_name']}||{r['serial']}"
        total += 1
        if r["collected"]:
            collected_n += 1
        if r["disconnected"]:
            disc_n += 1
        if r["fading"]:
            fading_n += 1

        if key in new_keys:
            # дубль строки внутри одного файла (в Пирамиде бывает) — берём первую
            total -= 1
            if r["collected"]:
                collected_n -= 1
            if r["disconnected"]:
                disc_n -= 1
            if r["fading"]:
                fading_n -= 1
            continue
        ex = existing.get(key)
        if ex is not None and ex.id in seen_ids:
            continue  # дубль уже существующего ПУ
        if ex is None:
            m = Meter(meter_key=key, type_name=r["type_name"], serial=r["serial"],
                      vendor=r["vendor"], is_spodes=r["is_spodes"], phase=r["phase"],
                      res=r["res"], feeder=r["feeder"], tp=r["tp"], tu_path=r["tu_path"],
                      abonent_type=r["abonent_type"], tu_type=r["tu_type"],
                      first_upload_id=up.id, last_upload_id=up.id, active=True)
            db.add(m)
            db.flush()
            meter_id = m.id
            new_keys.add(key)
            changes_buf.append(Change(upload_id=up.id, meter_id=meter_id, res=r["res"],
                                      change_type="added",
                                      details=f"{r['type_name']} №{r['serial']} | ТП {r['tp']} | {r['tu_path'][:180]}"))
            added_by_tu.setdefault(r["tu_path"], []).append((meter_id, r["collected"], key))
        else:
            meter_id = ex.id
            upd = {"last_upload_id": up.id, "active": True}
            if ex.res != r["res"] or ex.tp != r["tp"]:
                changes_buf.append(Change(upload_id=up.id, meter_id=meter_id, res=r["res"],
                                          change_type="moved",
                                          details=f"№{r['serial']}: {ex.res}/{ex.tp} → {r['res']}/{r['tp']}"))
            upd.update(res=r["res"], feeder=r["feeder"], tp=r["tp"], tu_path=r["tu_path"],
                       abonent_type=r["abonent_type"], phase=r["phase"])
            db.query(Meter).filter(Meter.id == meter_id).update(upd, synchronize_session=False)

            if meter_id in prev_state:
                was = prev_state[meter_id]
                if was and not r["collected"]:
                    changes_buf.append(Change(upload_id=up.id, meter_id=meter_id, res=r["res"],
                                              change_type="collect_lost",
                                              details=f"{r['type_name']} №{r['serial']} | ТП {r['tp']}"))
                elif not was and r["collected"]:
                    changes_buf.append(Change(upload_id=up.id, meter_id=meter_id, res=r["res"],
                                              change_type="collect_restored",
                                              details=f"{r['type_name']} №{r['serial']} | ТП {r['tp']}"))
        seen_ids.add(meter_id)
        states_buf.append(dict(upload_id=up.id, meter_id=meter_id,
                               collected=r["collected"], disconnected=r["disconnected"],
                               fading=r["fading"], route_class=r["route_class"],
                               route_raw=r["route_raw"], route_device=r["route_device"],
                               poll_date=r["poll_date"], modulation=r["modulation"],
                               data_type=r["data_type"]))
        if len(states_buf) >= BATCH:
            db.bulk_insert_mappings(MeterState, states_buf)
            states_buf.clear()
    if states_buf:
        db.bulk_insert_mappings(MeterState, states_buf)

    # --- выбывшие: были активны, в текущей загрузке не встретились ---
    removed = db.query(Meter).filter(Meter.active == True, ~Meter.id.in_(seen_ids)) \
        if len(seen_ids) < 100000 else None
    removed_meters = []
    for m in db.query(Meter).filter(Meter.active == True).yield_per(5000):
        if m.id not in seen_ids:
            removed_meters.append(m)
    removed_by_tu = {}
    for m in removed_meters:
        m.active = False
        removed_by_tu.setdefault(m.tu_path, []).append(m)

    # --- ремонт/замена: тот же адрес (H), старый пропал, новый появился ---
    repaired_pairs = set()
    for tu, new_list in added_by_tu.items():
        olds = removed_by_tu.get(tu)
        if not olds or not tu:
            continue
        for (new_id, new_collected, _k), old in zip(new_list, olds):
            old.replaced_by = new_id
            ctype = "repaired" if new_collected else "serial_changed"
            changes_buf.append(Change(upload_id=up.id, meter_id=new_id, res=old.res,
                                      change_type=ctype,
                                      details=f"Замена: был №{old.serial} → стал новый ПУ"
                                              f"{' , опрос появился — считаем отремонтированным' if new_collected else ', опроса нет'}"
                                              f" | {tu[:160]}"))
            repaired_pairs.add(old.id)
    for m in removed_meters:
        if m.id not in repaired_pairs:
            changes_buf.append(Change(upload_id=up.id, meter_id=m.id, res=m.res,
                                      change_type="removed",
                                      details=f"{m.type_name} №{m.serial} | ТП {m.tp} — отсутствует в новой выгрузке"))

    db.bulk_save_objects(changes_buf)

    # --- автозакрытие заданий: ПУ начал собираться ---
    now = datetime.utcnow()
    open_tasks = db.query(Task).filter(Task.status == "open", Task.meter_id.isnot(None)).all()
    if open_tasks:
        ids = [t.meter_id for t in open_tasks]
        coll = dict(db.query(MeterState.meter_id, MeterState.collected)
                    .filter(MeterState.upload_id == up.id, MeterState.meter_id.in_(ids)).all())
        for t in open_tasks:
            if coll.get(t.meter_id):
                t.status = "auto_closed"
                t.closed_at = now
                t.closed_comment = "Опрос появился в новой загрузке — закрыто автоматически"

    up.total, up.collected = total, collected_n
    up.disconnected, up.fading = disc_n, fading_n
    up.changes_seen = False
    db.commit()
