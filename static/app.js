/* Опрос ПУ — фронтенд. Ролевая модель:
   admin    — всё (включая удаление базы, пользователей)
   uploader — всё, кроме удаления базы и пользователей
   staff    — видит всё, задания выдаёт, не загружает
   res      — только свой РЭС, выгрузка отчётов, закрытие заданий            */

let USER = null, RES = "", CHARTS = [];

/* — приём токена от оболочки Платформы (SUE_system): задел на Keycloak — */
window.addEventListener("message", (e) => {
  if (e.data && e.data.type === "platform-auth" && e.data.token) {
    window.PLATFORM_TOKEN = e.data.token; // TODO: обмен на сессию, когда подключим Keycloak
  }
});

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(url, opts = {}) {
  const r = await fetch(url, { credentials: "same-origin", ...opts });
  if (r.status === 401) { showLogin(); throw new Error("unauthorized"); }
  if (!r.ok) {
    let msg = "Ошибка " + r.status;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}
const post = (url, body) => api(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function pctClass(p) { return p >= 96 ? "good" : p >= 90 ? "mid" : "low"; }
function pctCell(p) { return `<span class="pct ${pctClass(p)}">${p.toFixed(2)}%</span>`; }
function destroyCharts() { CHARTS.forEach(c => c.destroy()); CHARTS = []; }

/* ---------------- Авторизация ---------------- */
function showLogin() { $("login").classList.remove("hidden"); $("app").classList.add("hidden"); }
async function doLogin() {
  $("l_err").textContent = "";
  try {
    const d = await post("/api/login", { login: $("l_login").value, password: $("l_pass").value });
    USER = d.user; boot();
  } catch (e) { $("l_err").textContent = e.message; }
}
async function doLogout() { await post("/api/logout", {}); location.reload(); }
$("l_pass") && ($("l_pass").onkeydown = (e) => e.key === "Enter" && doLogin());

/* ---------------- Каркас ---------------- */
const TABS = [
  { id: "dashboard", label: "Сводка", roles: ["admin", "uploader", "staff", "res"] },
  { id: "spodes", label: "СПОДЭС", roles: ["admin", "uploader", "staff", "res"] },
  { id: "routes", label: "Маршруты и устройства", roles: ["admin", "uploader", "staff", "res"] },
  { id: "deadtp", label: "Неисправные ТП", roles: ["admin", "uploader", "staff", "res"] },
  { id: "priorities", label: "Приоритеты", roles: ["admin", "uploader", "staff", "res"] },
  { id: "meters", label: "Реестр ПУ", roles: ["admin", "uploader", "staff", "res"] },
  { id: "changes", label: "Изменения", roles: ["admin", "uploader", "staff"] },
  { id: "tasks", label: "Задания", roles: ["admin", "uploader", "staff", "res"] },
  { id: "upload", label: "Загрузка", roles: ["admin", "uploader"] },
  { id: "users", label: "Пользователи", roles: ["admin"] },
];

async function boot() {
  $("login").classList.add("hidden"); $("app").classList.remove("hidden");
  $("userName").textContent = `${USER.name || USER.login} (${roleName(USER.role)}${USER.res ? ", " + USER.res : ""})`;
  const resSel = $("resFilter");
  const resList = await api("/api/res_list").catch(() => []);
  if (USER.role === "res") {
    RES = USER.res || ""; resSel.innerHTML = `<option>${esc(RES)}</option>`; resSel.disabled = true;
  } else {
    resSel.innerHTML = `<option value="">Все РЭС</option>` + resList.map(r => `<option>${esc(r)}</option>`).join("");
  }
  renderTabs(); openTab("dashboard");
  markChangesDot();
}
function roleName(r) { return { admin: "администратор", uploader: "загрузчик", staff: "служба учёта", res: "участок" }[r] || r; }
function onResChange() { RES = $("resFilter").value; openTab(currentTab); }
let currentTab = "dashboard";

function renderTabs() {
  $("tabs").innerHTML = TABS.filter(t => t.roles.includes(USER.role))
    .map(t => `<a id="tab_${t.id}" onclick="openTab('${t.id}')">${t.label}</a>`).join("");
}
async function markChangesDot() {
  if (!["admin", "uploader", "staff"].includes(USER.role)) return;
  try {
    const c = await api("/api/report/changes" + q());
    if (!c.changes_seen && Object.keys(c.summary).length && $("tab_changes"))
      $("tab_changes").innerHTML = 'Изменения<span class="dot"></span>';
  } catch {}
}
function q(extra = "") { return "?" + (RES ? "res=" + encodeURIComponent(RES) + "&" : "") + extra; }

async function openTab(id) {
  currentTab = id; destroyCharts();
  document.querySelectorAll("nav a").forEach(a => a.classList.toggle("active", a.id === "tab_" + id));
  $("content").innerHTML = `<div class="card muted">Загрузка…</div>`;
  try { await VIEWS[id](); }
  catch (e) { $("content").innerHTML = `<div class="card"><b>Нет данных.</b> ${esc(e.message)}</div>`; }
}

const exportBtn = (kind, label = "⬇ Excel") =>
  `<a class="btn small" href="/api/export/report${q("kind=" + kind)}" target="_blank">${label}</a>`;

/* ---------------- Вкладки ---------------- */
const VIEWS = {

  async dashboard() {
    const d = await api("/api/report/summary" + q());
    const tot = d.rows.reduce((s, r) => s + r.total, 0);
    const col = d.rows.reduce((s, r) => s + r.collected, 0);
    const fad = d.rows.reduce((s, r) => s + r.fading, 0);
    const dis = d.rows.reduce((s, r) => s + r.disconnected, 0);
    const p = tot ? (col * 100 / tot) : 0;
    $("content").innerHTML = `
      <div class="kpis">
        <div class="kpi"><div class="v">${tot.toLocaleString("ru")}</div><div class="l">Всего ПУ</div></div>
        <div class="kpi ok"><div class="v">${col.toLocaleString("ru")}</div><div class="l">Собирается</div></div>
        <div class="kpi bad"><div class="v">${(tot - col).toLocaleString("ru")}</div><div class="l">Не собирается</div></div>
        <div class="kpi ${pctClass(p) === 'good' ? 'ok' : pctClass(p) === 'low' ? 'bad' : 'warn'}"><div class="v">${p.toFixed(2)}%</div><div class="l">Опрос</div></div>
        <div class="kpi warn"><div class="v">${fad.toLocaleString("ru")}</div><div class="l">Угасает сбор</div></div>
        <div class="kpi"><div class="v">${dis.toLocaleString("ru")}</div><div class="l">Отключено</div></div>
      </div>
      <div class="card"><div class="toolbar"><h2 style="margin:0">Собираемость по РЭС</h2>
        <span class="muted">Загрузка от ${esc(d.upload.date)}, период ${esc(d.upload.period)}</span>
        <a class="btn small primary" href="/api/export/summary${q()}" target="_blank">⬇ Выгрузить в Excel (с диаграммами)</a></div>
        <table><thead><tr><th>РЭС</th><th>Всего</th><th>Собирается</th><th>Не собирается</th><th>% опроса</th>
        <th>СПОДЭС</th><th>% СПОДЭС</th><th>Угасает</th><th>Отключено</th></tr></thead><tbody>
        ${d.rows.map(r => `<tr><td><b>${esc(r.res)}</b></td><td>${r.total.toLocaleString("ru")}</td>
          <td>${r.collected.toLocaleString("ru")}</td><td>${r.not_collected.toLocaleString("ru")}</td>
          <td>${pctCell(r.pct)}</td><td>${r.spodes_collected}/${r.spodes_total}</td>
          <td>${pctCell(r.spodes_pct)}</td><td>${r.fading}</td><td>${r.disconnected}</td></tr>`).join("")}
        </tbody></table></div>
      <div class="row">
        <div class="card"><h2>% опроса по РЭС</h2><div class="chart-box"><canvas id="chResPct"></canvas></div></div>
        <div class="card"><h2>Факт по датам загрузок</h2><div class="chart-box"><canvas id="chHist"></canvas></div></div>
      </div>
      <div class="card"><h2>История загрузок (факт)</h2>
        <table><thead><tr><th>Дата загрузки</th><th>Период выгрузки</th><th>Всего</th><th>Собирается</th><th>Не собирается</th><th>%</th></tr></thead>
        <tbody>${d.history.slice().reverse().map(h => `<tr><td>${esc(h.date)}</td><td>${esc(h.period)}</td>
          <td>${h.total.toLocaleString("ru")}</td><td>${h.collected.toLocaleString("ru")}</td>
          <td>${h.not_collected.toLocaleString("ru")}</td><td>${pctCell(h.pct)}</td></tr>`).join("")}</tbody></table></div>`;
    CHARTS.push(new Chart($("chResPct"), {
      type: "bar",
      data: { labels: d.rows.map(r => r.res), datasets: [{ label: "% опроса", data: d.rows.map(r => r.pct), backgroundColor: "#1f6feb" }] },
      options: { maintainAspectRatio: false, scales: { y: { min: Math.max(0, Math.min(...d.rows.map(r => r.pct)) - 3), max: 100 } } }
    }));
    CHARTS.push(new Chart($("chHist"), {
      type: "line",
      data: { labels: d.history.map(h => h.date.split(" ")[0]), datasets: [{ label: "% опроса", data: d.history.map(h => h.pct), borderColor: "#d73027", tension: .25, pointRadius: 5 }] },
      options: { maintainAspectRatio: false }
    }));
  },

  async spodes() {
    const rows = await api("/api/report/spodes" + q());
    const byRes = {};
    rows.forEach(r => { byRes[r.res] = byRes[r.res] || { t: 0, c: 0 }; byRes[r.res].t += r.total; byRes[r.res].c += r.collected; });
    const agg = Object.entries(byRes).map(([res, v]) => ({ res, ...v, pct: v.t ? v.c * 100 / v.t : 0 }));
    $("content").innerHTML = `
      <div class="card"><div class="toolbar"><h2 style="margin:0">СПОДЭС — собираемость</h2>${exportBtn("spodes")}</div>
        <div class="chart-box"><canvas id="chSp"></canvas></div></div>
      <div class="card"><h2>Детально по типам</h2><div class="scroll"><table>
        <thead><tr><th>РЭС</th><th>Тип ПУ</th><th>Всего</th><th>Собирается</th><th>Не собирается</th><th>%</th></tr></thead>
        <tbody>${rows.map(r => `<tr><td>${esc(r.res)}</td><td>${esc(r.type)}</td><td>${r.total}</td>
          <td>${r.collected}</td><td>${r.not_collected}</td><td>${pctCell(r.pct)}</td></tr>`).join("")}</tbody></table></div></div>`;
    CHARTS.push(new Chart($("chSp"), {
      type: "bar",
      data: { labels: agg.map(a => a.res), datasets: [
        { label: "Собирается", data: agg.map(a => a.c), backgroundColor: "#1a9850" },
        { label: "Не собирается", data: agg.map(a => a.t - a.c), backgroundColor: "#d73027" }] },
      options: { maintainAspectRatio: false, scales: { x: { stacked: true }, y: { stacked: true } } }
    }));
  },

  async routes() {
    const [route, vendor, devices] = await Promise.all([
      api("/api/report/group" + q("field=route")),
      api("/api/report/group" + q("field=vendor")),
      api("/api/report/devices" + q())]);
    const broken = devices.filter(d => d.status !== "OK");
    $("content").innerHTML = `
      <div class="row">
        <div class="card"><div class="toolbar"><h2 style="margin:0">Через что опрашивается</h2>${exportBtn("route")}</div>
          <div class="chart-box"><canvas id="chRoute"></canvas></div>
          <table><thead><tr><th>Маршрут</th><th>ПУ</th><th>Собирается</th><th>%</th></tr></thead><tbody>
          ${route.map(r => `<tr><td>${esc(r.group)}</td><td>${r.total.toLocaleString("ru")}</td><td>${r.collected.toLocaleString("ru")}</td><td>${pctCell(r.pct)}</td></tr>`).join("")}</tbody></table></div>
        <div class="card"><div class="toolbar"><h2 style="margin:0">По производителям</h2>${exportBtn("vendor")}</div>
          <div class="chart-box"><canvas id="chVendor"></canvas></div></div>
      </div>
      <div class="card"><div class="toolbar"><h2 style="margin:0">Работоспособность ведущих устройств (МКС / RootRouter / RTR)</h2>
        ${exportBtn("devices")}<span class="muted">Показаны проблемные и худшие — до 500 строк</span></div>
        <div class="scroll"><table><thead><tr><th>Статус</th><th>Класс</th><th>Устройство</th><th>РЭС</th><th>ПУ</th><th>Собирается</th><th>%</th></tr></thead>
        <tbody>${devices.map(d => `<tr><td><span class="badge ${d.status === 'OK' ? 'ok' : d.status === 'Деградация' ? 'warn' : 'bad'}">${d.status}</span></td>
          <td>${esc(d.route_class)}</td><td>${esc(d.device)}</td><td>${esc(d.res)}</td>
          <td>${d.total}</td><td>${d.collected}</td><td>${pctCell(d.pct)}</td></tr>`).join("")}</tbody></table></div>
        <p class="muted">Не работает: ${broken.filter(b => b.status === "НЕ РАБОТАЕТ").length} устройств, деградация: ${broken.filter(b => b.status === "Деградация").length}.</p></div>`;
    CHARTS.push(new Chart($("chRoute"), {
      type: "doughnut",
      data: { labels: route.map(r => r.group), datasets: [{ data: route.map(r => r.total), backgroundColor: ["#1f6feb", "#1a9850", "#e08a00", "#d73027", "#7b61c4", "#5aa9e6", "#999"] }] },
      options: { maintainAspectRatio: false }
    }));
    CHARTS.push(new Chart($("chVendor"), {
      type: "bar",
      data: { labels: vendor.map(v => v.group), datasets: [
        { label: "Собирается", data: vendor.map(v => v.collected), backgroundColor: "#1a9850" },
        { label: "Не собирается", data: vendor.map(v => v.not_collected), backgroundColor: "#d73027" }] },
      options: { indexAxis: "y", maintainAspectRatio: false, scales: { x: { stacked: true }, y: { stacked: true } } }
    }));
  },

  async deadtp() {
    const rows = await api("/api/report/dead_tp" + q());
    const canTask = ["admin", "uploader", "staff"].includes(USER.role);
    $("content").innerHTML = `
      <div class="card"><div class="toolbar"><h2 style="margin:0">ТП, где не опрашивается ни один ПУ</h2>
        ${exportBtn("dead_tp")}
        ${canTask && RES ? `<button class="btn primary small" onclick="tasksFromPrio()">Создать задания на «${esc(RES)}»</button>` : ""}
        <span class="muted">Если на ТП 0 из N — почти наверняка не работает ведущее устройство (УСПД/роутер)</span></div>
        <div class="scroll"><table><thead><tr><th>РЭС</th><th>ТП</th><th>ПУ на ТП</th><th>Класс маршрута</th><th>Ведущее устройство</th><th>Вывод</th></tr></thead>
        <tbody>${rows.map(r => `<tr><td>${esc(r.res)}</td><td><b>${esc(r.tp)}</b></td><td>${r.total}</td>
          <td>${esc(r.route_class)}</td><td>${esc(r.device)}</td><td><span class="badge bad">${esc(r.verdict)}</span></td></tr>`).join("")}
        </tbody></table></div>
        <p class="muted">Всего проблемных ТП: <b>${rows.length}</b>, ПУ на них: <b>${rows.reduce((s, r) => s + r.total, 0)}</b></p></div>`;
  },

  async priorities() {
    if (!RES) {
      $("content").innerHTML = `<div class="card">Выберите РЭС в фильтре сверху — приоритеты формируются по участку.</div>`;
      return;
    }
    const p = await api("/api/report/priorities" + q());
    const sec = (cls, title, rows, cols, render) => `
      <div class="card ${cls}"><h2>${title} <span class="muted">(${rows.length})</span></h2>
        <div class="scroll"><table><thead><tr>${cols.map(c => `<th>${c}</th>`).join("")}</tr></thead>
        <tbody>${rows.map(render).join("")}</tbody></table></div></div>`;
    $("content").innerHTML = `
      <div class="toolbar"><h2 style="margin:0">Очерёдность работ — ${esc(RES)}</h2>${exportBtn("priorities")}</div>
      ${sec("prio-1", "1 очередь — восстановить ведущие устройства (ТП целиком без опроса)", p.p1_dead_tp,
        ["ТП", "ПУ", "Маршрут", "Устройство"],
        r => `<tr><td><b>${esc(r.tp)}</b></td><td>${r.total}</td><td>${esc(r.route_class)}</td><td>${esc(r.device)}</td></tr>`)}
      ${sec("prio-2", "2 очередь — угасает сбор (скоро потеряем опрос)", p.p2_fading,
        ["Тип ПУ", "Серийный", "ТП", "Точка учёта"],
        r => `<tr><td>${esc(r.type)}</td><td>${esc(r.serial)}</td><td>${esc(r.tp)}</td><td class="muted">${esc(r.tu)}</td></tr>`)}
      ${sec("prio-3", "3 очередь — одиночные ПУ без опроса", p.p3_no_poll,
        ["Тип ПУ", "Серийный", "ТП", "Точка учёта"],
        r => `<tr><td>${esc(r.type)}</td><td>${esc(r.serial)}</td><td>${esc(r.tp)}</td><td class="muted">${esc(r.tu)}</td></tr>`)}`;
  },

  async meters() {
    $("content").innerHTML = `
      <div class="card"><div class="toolbar">
        <input type="text" id="mSearch" placeholder="Поиск: серийник / ТП / адрес" style="width:280px">
        <label><input type="checkbox" id="mNc"> только без опроса</label>
        <button class="btn primary small" onclick="loadMeters(0)">Найти</button>
        ${exportBtn("not_collected", "⬇ Все без опроса (Excel)")}</div>
        <div id="mResult" class="muted">Задайте фильтр и нажмите «Найти».</div></div>`;
    loadMeters(0);
  },

  async changes() {
    const d = await api("/api/report/changes" + q());
    const names = { added: "Добавлены", removed: "Выбыли", repaired: "Отремонтированы (замена + опрос)", serial_changed: "Замена ПУ (опроса нет)", collect_lost: "Потеряли опрос", collect_restored: "Опрос восстановился", moved: "Сменили РЭС/ТП" };
    const badge = { added: "info", removed: "bad", repaired: "ok", serial_changed: "warn", collect_lost: "bad", collect_restored: "ok", moved: "info" };
    const canAck = ["admin", "uploader"].includes(USER.role);
    $("content").innerHTML = `
      <div class="kpis">${Object.entries(d.summary).map(([k, v]) =>
        `<div class="kpi"><div class="v">${v.toLocaleString("ru")}</div><div class="l">${names[k] || k}</div></div>`).join("") || '<div class="card">Изменений нет (первая загрузка или всё без изменений).</div>'}</div>
      <div class="card"><div class="toolbar"><h2 style="margin:0">Что изменилось с прошлой загрузки</h2>
        ${exportBtn("changes")}
        ${canAck && !d.changes_seen ? `<button class="btn primary small" onclick="ackChanges(${d.upload_id})">✓ Просмотрено</button>` : d.changes_seen ? '<span class="badge ok">Просмотрено</span>' : ""}</div>
        <div class="scroll"><table><thead><tr><th>Тип</th><th>РЭС</th><th>Детали</th></tr></thead>
        <tbody>${d.items.map(i => `<tr><td><span class="badge ${badge[i.type] || 'info'}">${names[i.type] || i.type}</span></td>
          <td>${esc(i.res)}</td><td class="muted">${esc(i.details)}</td></tr>`).join("")}</tbody></table></div></div>`;
  },

  async tasks() {
    const rows = await api("/api/tasks" + (RES ? "?res=" + encodeURIComponent(RES) : ""));
    const canCreate = ["admin", "uploader", "staff"].includes(USER.role);
    const stName = { open: "В работе", done: "Выполнено", auto_closed: "Закрыто автоматически" };
    const stBadge = { open: "warn", done: "ok", auto_closed: "info" };
    $("content").innerHTML = `
      <div class="card"><div class="toolbar"><h2 style="margin:0">Задания на участки</h2>
        ${canCreate ? `<button class="btn primary small" onclick="taskModal()">+ Новое задание</button>` : ""}
        ${exportBtn("tasks")}</div>
        <div class="scroll"><table><thead><tr><th>№</th><th>РЭС</th><th>Приор.</th><th>Задание</th><th>Описание</th><th>ТП / ПУ</th><th>Статус</th><th>Создано</th><th></th></tr></thead>
        <tbody>${rows.map(t => `<tr class="prio-${t.priority}"><td>${t.id}</td><td>${esc(t.res)}</td><td>${t.priority}</td>
          <td><b>${esc(t.title)}</b></td><td class="muted">${esc(t.description)}</td>
          <td>${esc(t.tp || "")} ${esc(t.meter || "")}</td>
          <td><span class="badge ${stBadge[t.status]}">${stName[t.status]}</span>${t.closed_comment ? `<div class="muted">${esc(t.closed_comment)}</div>` : ""}</td>
          <td>${t.created}</td>
          <td>${t.status === "open" ? `<button class="btn small" onclick="closeTask(${t.id})">Закрыть</button>` : t.closed}</td></tr>`).join("")}
        </tbody></table></div></div>`;
  },

  async upload() {
    const ups = await api("/api/uploads");
    $("content").innerHTML = `
      <div class="card"><h2>Загрузка выгрузки из Пирамиды</h2>
        <div class="dropzone" id="dz" onclick="$('fileInput').click()">
          Перетащите сюда файл «Опрос ПУ…xlsx» (до 50 МБ) или нажмите для выбора.<br>
          <span class="muted">Обработка 130 тыс. строк занимает 1–2 минуты, идёт в фоне.</span></div>
        <input type="file" id="fileInput" accept=".xlsx" class="hidden">
        <div id="upStatus" class="muted" style="margin-top:10px"></div></div>
      <div class="card"><h2>История загрузок</h2>
        <table><thead><tr><th>№</th><th>Дата</th><th>Файл</th><th>Период</th><th>Всего</th><th>Собирается</th><th>%</th><th>Статус</th><th></th></tr></thead>
        <tbody>${ups.map(u => `<tr><td>${u.id}</td><td>${esc(u.date)}</td><td>${esc(u.filename)}</td><td>${esc(u.period)}</td>
          <td>${u.total.toLocaleString("ru")}</td><td>${u.collected.toLocaleString("ru")}</td><td>${pctCell(u.pct)}</td>
          <td><span class="badge ${u.status === 'done' ? 'ok' : u.status === 'error' ? 'bad' : 'warn'}">${u.status}</span>
            ${u.error ? `<div class="muted">${esc(u.error)}</div>` : ""}</td>
          <td>${USER.role === "admin" ? `<button class="btn small danger" onclick="delUpload(${u.id})">✕</button>` : ""}</td></tr>`).join("")}
        </tbody></table>
        ${USER.role === "admin" ? `<p><button class="btn danger" onclick="wipeDb()">⚠ Полностью очистить базу</button></p>` : ""}</div>`;
    const dz = $("dz"), fi = $("fileInput");
    fi.onchange = () => fi.files[0] && sendFile(fi.files[0]);
    dz.ondragover = (e) => { e.preventDefault(); dz.classList.add("drag"); };
    dz.ondragleave = () => dz.classList.remove("drag");
    dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove("drag"); e.dataTransfer.files[0] && sendFile(e.dataTransfer.files[0]); };
  },

  async users() {
    const users = await api("/api/users");
    const resList = await api("/api/res_list");
    $("content").innerHTML = `
      <div class="card"><div class="toolbar"><h2 style="margin:0">Пользователи</h2>
        <button class="btn primary small" onclick="userModal(null)">+ Добавить</button></div>
        <table><thead><tr><th>Логин</th><th>Имя</th><th>Роль</th><th>РЭС</th><th>Активен</th><th></th></tr></thead>
        <tbody>${users.map(u => `<tr><td><b>${esc(u.login)}</b></td><td>${esc(u.name)}</td><td>${roleName(u.role)}</td>
          <td>${esc(u.res || "—")}</td><td>${u.active ? "✓" : "✕"}</td>
          <td><button class="btn small" onclick='userModal(${JSON.stringify(u)})'>Изменить</button></td></tr>`).join("")}
        </tbody></table></div>`;
    window._resList = resList;
  },
};

/* ---------------- Действия ---------------- */
async function loadMeters(offset) {
  const nc = $("mNc")?.checked, s = $("mSearch")?.value || "";
  const d = await api("/api/meters" + q(`not_collected=${nc}&search=${encodeURIComponent(s)}&limit=200&offset=${offset}`));
  $("mResult").innerHTML = `
    <p>Найдено: <b>${d.total.toLocaleString("ru")}</b> (показано ${offset + 1}–${offset + d.items.length})
      ${offset > 0 ? `<button class="btn small" onclick="loadMeters(${offset - 200})">← Назад</button>` : ""}
      ${offset + 200 < d.total ? `<button class="btn small" onclick="loadMeters(${offset + 200})">Далее →</button>` : ""}</p>
    <div class="scroll"><table><thead><tr><th>Тип ПУ</th><th>Серийный</th><th>РЭС</th><th>Фидер</th><th>ТП</th>
      <th>Маршрут</th><th>Опрос</th><th>Дата опроса</th><th>Точка учёта</th></tr></thead>
    <tbody>${d.items.map(m => `<tr><td>${esc(m.type)}${m.spodes ? ' <span class="badge info">СПОДЭС</span>' : ""}</td>
      <td>${esc(m.serial)}</td><td>${esc(m.res)}</td><td>${esc(m.feeder)}</td><td>${esc(m.tp)}</td>
      <td>${esc(m.route_class)}</td>
      <td>${m.disconnected ? '<span class="badge">Отключен</span>' : m.collected ? '<span class="badge ok">Собирается</span>' : '<span class="badge bad">Нет опроса</span>'}${m.fading ? ' <span class="badge warn">Угасает</span>' : ""}</td>
      <td>${esc(m.poll_date)}</td><td class="muted">${esc(m.tu)}</td></tr>`).join("")}</tbody></table></div>`;
}

async function sendFile(f) {
  $("upStatus").textContent = "Отправка файла…";
  const fd = new FormData(); fd.append("file", f);
  try {
    const r = await fetch("/api/upload", { method: "POST", body: fd, credentials: "same-origin" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || "Ошибка");
    $("upStatus").textContent = d.message;
    const timer = setInterval(async () => {
      const ups = await api("/api/uploads");
      const u = ups.find(x => x.id === d.upload_id);
      if (u && u.status !== "processing") {
        clearInterval(timer);
        $("upStatus").textContent = u.status === "done"
          ? `Готово: ${u.total.toLocaleString("ru")} ПУ, опрос ${u.pct}%. Смотрите вкладку «Изменения».`
          : "Ошибка: " + u.error;
        openTab("upload"); markChangesDot();
      } else { $("upStatus").textContent = "Обработка… (страницу можно не обновлять)"; }
    }, 4000);
  } catch (e) { $("upStatus").textContent = "Ошибка: " + e.message; }
}

async function delUpload(id) { if (confirm("Удалить загрузку №" + id + "?")) { await api("/api/uploads/" + id, { method: "DELETE" }); openTab("upload"); } }
async function wipeDb() { if (prompt('Введите "УДАЛИТЬ" для полной очистки базы') === "УДАЛИТЬ") { await api("/api/database", { method: "DELETE" }); openTab("upload"); } }
async function ackChanges(id) { await post("/api/report/changes/seen", { upload_id: id }); openTab("changes"); if ($("tab_changes")) $("tab_changes").textContent = "Изменения"; }
async function closeTask(id) { const c = prompt("Комментарий к закрытию (необязательно):") || ""; await post(`/api/tasks/${id}/close`, { comment: c }); openTab("tasks"); }
async function tasksFromPrio() { const r = await post("/api/tasks/from_priorities", { res: RES }); alert("Создано заданий: " + r.created); openTab("tasks"); }

function modal(html) {
  const bg = document.createElement("div"); bg.className = "modal-bg";
  bg.innerHTML = `<div class="modal">${html}</div>`;
  bg.onclick = (e) => e.target === bg && bg.remove();
  document.body.appendChild(bg); return bg;
}

function taskModal() {
  const resOpts = [...$("resFilter").options].map(o => o.value).filter(Boolean);
  const bg = modal(`<h3>Новое задание</h3>
    <label>РЭС</label><select id="t_res">${resOpts.map(r => `<option ${r === RES ? "selected" : ""}>${esc(r)}</option>`).join("")}</select>
    <label>Приоритет</label><select id="t_prio"><option value="1">1 — срочно</option><option value="2" selected>2 — обычный</option><option value="3">3 — низкий</option></select>
    <label>Задание</label><input id="t_title" placeholder="Например: восстановить опрос ТП-А216">
    <label>ТП (необязательно)</label><input id="t_tp">
    <label>Описание</label><textarea id="t_desc" rows="3"></textarea>
    <div class="actions"><button class="btn" onclick="this.closest('.modal-bg').remove()">Отмена</button>
    <button class="btn primary" id="t_save">Создать</button></div>`);
  bg.querySelector("#t_save").onclick = async () => {
    try {
      await post("/api/tasks", { res: $("t_res").value, priority: $("t_prio").value, title: $("t_title").value, tp: $("t_tp").value, description: $("t_desc").value });
      bg.remove(); openTab("tasks");
    } catch (e) { alert(e.message); }
  };
}

function userModal(u) {
  const resList = window._resList || [];
  const bg = modal(`<h3>${u ? "Изменить" : "Новый"} пользователь</h3>
    <label>Логин</label><input id="u_login" value="${u ? esc(u.login) : ""}" ${u ? "disabled" : ""}>
    <label>Имя</label><input id="u_name" value="${u ? esc(u.name) : ""}">
    <label>Роль</label><select id="u_role">
      <option value="admin">Администратор</option><option value="uploader">Админ-загрузчик</option>
      <option value="staff">Служба учёта</option><option value="res">Участок (РЭС)</option></select>
    <label>РЭС (для роли «участок»)</label><select id="u_res"><option value="">—</option>${resList.map(r => `<option>${esc(r)}</option>`).join("")}</select>
    <label>Пароль ${u ? "(пусто — не менять)" : ""}</label><input id="u_pass" type="password">
    ${u ? `<label><input type="checkbox" id="u_active" ${u.active ? "checked" : ""}> Активен</label>` : ""}
    <div class="actions"><button class="btn" onclick="this.closest('.modal-bg').remove()">Отмена</button>
    <button class="btn primary" id="u_save">Сохранить</button></div>`);
  if (u) { bg.querySelector("#u_role").value = u.role; bg.querySelector("#u_res").value = u.res || ""; }
  bg.querySelector("#u_save").onclick = async () => {
    const body = { name: $("u_name").value, role: $("u_role").value, res: $("u_res").value || null, password: $("u_pass").value };
    if (u) body.active = $("u_active").checked;
    try {
      if (u) await post("/api/users/" + u.id, body);
      else await post("/api/users", { ...body, login: $("u_login").value });
      bg.remove(); openTab("users");
    } catch (e) { alert(e.message); }
  };
}

/* ---------------- Старт ---------------- */
(async () => {
  try { USER = await api("/api/me"); boot(); }
  catch { showLogin(); }
})();
