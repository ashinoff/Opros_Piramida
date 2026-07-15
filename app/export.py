# -*- coding: utf-8 -*-
"""Выгрузка отчётов в Excel (xlsxwriter, в память) — с диаграммами где уместно."""
import io
import xlsxwriter


def _book():
    buf = io.BytesIO()
    wb = xlsxwriter.Workbook(buf, {"in_memory": True})
    fmt = {
        "h": wb.add_format({"bold": True, "bg_color": "#1F4E79", "font_color": "white",
                            "border": 1, "align": "center", "valign": "vcenter",
                            "text_wrap": True, "font_name": "Arial"}),
        "c": wb.add_format({"border": 1, "font_name": "Arial"}),
        "n": wb.add_format({"border": 1, "num_format": "#,##0", "font_name": "Arial"}),
        "p": wb.add_format({"border": 1, "num_format": "0.00", "font_name": "Arial"}),
        "title": wb.add_format({"bold": True, "font_size": 14, "font_name": "Arial"}),
        "bad": wb.add_format({"border": 1, "bg_color": "#FFC7CE", "font_name": "Arial"}),
    }
    return buf, wb, fmt


def _table(ws, fmt, title, headers, rows, start=0, widths=None):
    ws.write(start, 0, title, fmt["title"])
    r0 = start + 2
    for j, h in enumerate(headers):
        ws.write(r0, j, h, fmt["h"])
    for i, row in enumerate(rows, 1):
        for j, v in enumerate(row):
            f = fmt["n"] if isinstance(v, int) else (fmt["p"] if isinstance(v, float) else fmt["c"])
            ws.write(r0 + i, j, v, f)
    for j, w in enumerate(widths or []):
        ws.set_column(j, j, w)
    return r0, r0 + len(rows)


def export_res_summary(data, hist, title="Опрос ПУ по РЭС"):
    buf, wb, fmt = _book()
    ws = wb.add_worksheet("Сводка по РЭС")
    headers = ["РЭС", "Всего ПУ", "Собирается", "Не собирается", "% опроса",
               "СПОДЭС всего", "СПОДЭС собир.", "% СПОДЭС", "Отключено", "Угасает"]
    rows = [[d["res"], d["total"], d["collected"], d["not_collected"], d["pct"],
             d["spodes_total"], d["spodes_collected"], d["spodes_pct"],
             d["disconnected"], d["fading"]] for d in data]
    h0, h1 = _table(ws, fmt, title, headers, rows,
                    widths=[24, 12, 12, 14, 10, 13, 13, 11, 11, 10])
    # диаграмма: % опроса по РЭС
    if rows:
        ch = wb.add_chart({"type": "column"})
        ch.add_series({"name": "% опроса",
                       "categories": ["Сводка по РЭС", h0 + 1, 0, h1, 0],
                       "values": ["Сводка по РЭС", h0 + 1, 4, h1, 4],
                       "fill": {"color": "#2E86AB"}})
        ch.set_title({"name": "% опроса по РЭС"})
        ch.set_size({"width": 760, "height": 360})
        ws.insert_chart(h1 + 3, 0, ch)

    ws2 = wb.add_worksheet("Динамика")
    headers2 = ["Дата загрузки", "Период", "Всего", "Собирается", "Не собирается", "% опроса"]
    rows2 = [[h["date"], h["period"], h["total"], h["collected"], h["not_collected"], h["pct"]]
             for h in hist]
    g0, g1 = _table(ws2, fmt, "Динамика собираемости по загрузкам", headers2, rows2,
                    widths=[18, 24, 12, 12, 14, 10])
    if rows2:
        ch2 = wb.add_chart({"type": "line"})
        ch2.add_series({"name": "% опроса",
                        "categories": ["Динамика", g0 + 1, 0, g1, 0],
                        "values": ["Динамика", g0 + 1, 5, g1, 5],
                        "line": {"color": "#C0392B", "width": 2.5},
                        "marker": {"type": "circle", "size": 6}})
        ch2.set_title({"name": "Факт % опроса по датам"})
        ch2.set_size({"width": 760, "height": 360})
        ws2.insert_chart(g1 + 3, 0, ch2)
    wb.close()
    buf.seek(0)
    return buf


def export_generic(sheets, title="Отчёт"):
    """sheets = [(имя, заголовки, строки, ширины)]"""
    buf, wb, fmt = _book()
    for name, headers, rows, widths in sheets:
        ws = wb.add_worksheet(name[:31])
        _table(ws, fmt, name, headers, rows, widths=widths)
    wb.close()
    buf.seek(0)
    return buf
