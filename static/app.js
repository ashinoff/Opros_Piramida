/* Опрос ПУ — фронтенд. Ролевая модель:
   admin    — всё (включая удаление базы, пользователей)
   uploader — всё, кроме удаления базы и пользователей
   staff    — видит всё, задания выдаёт, не загружает
   res      — только свой РЭС, выгрузка отчётов, закрытие заданий            */

let USER = null, RES = "", CHARTS = [];
let TOKEN = localStorage.getItem("opros_token") || "";

/* — Интеграция с Платформой (SUE_system, Keycloak SSO) — */
const PLATFORM_ORIGIN = "https://sue-system-ashinoff.amvera.io";
const EMBEDDED = window.parent !== window;

// Диагностика SSO — чтобы на экране входа была видна конкретная причина, а не
// просто «выкинуло на форму». Пишется и в консоль, и в подпись под формой.
let SSO_DIAG = "";
function setDiag(msg) {
  SSO_DIAG = msg;
  try { console.log("[SSO]", msg); } catch {}
  const el = document.getElementById("ssoDiag");
  if (el) el.textContent = msg;
}

// Обмен Keycloak-токена (пришёл postMessage от Платформы) на свою сессию.
async function exchangePlatformToken(kcToken) {
  setDiag("Платформа: токен получен, выполняю вход…");
  try {
    const r = await fetch("/api/auth/platform", {
      method: "POST", headers: { Authorization: "Bearer " + kcToken },
    });
    if (!r.ok) {
      let detail = ""; try { detail = (await r.json()).detail || ""; } catch {}
      setDiag(`Платформа: вход отклонён (${r.status}). ${detail}`);
      return false;
    }
    const d = await r.json();
    TOKEN = d.token || ""; localStorage.setItem("opros_token", TOKEN);
    USER = d.user; boot();
    return true;
  } catch (e) { setDiag("Платформа: сетевая ошибка при обмене токена"); return false; }
}

window.addEventListener("message", (e) => {
  if (!e.data || e.data.type !== "platform-auth") return;
  if (e.origin !== PLATFORM_ORIGIN) {                  // доверяем только Платформе
    setDiag(`Платформа: токен пришёл с origin «${e.origin}», а ожидается «${PLATFORM_ORIGIN}» — не совпадает.`);
    return;
  }
  if (e.data.token) exchangePlatformToken(e.data.token);
});
// Сообщаем оболочке, что готовы принять токен (закрывает гонку с onLoad iframe).
if (EMBEDDED) { try { window.parent.postMessage({ type: "app-ready" }, PLATFORM_ORIGIN); } catch {} }

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------------- SVG-иконки (lucide-style, наследуют currentColor) ------- */
const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  chart: '<rect x="3" y="12" width="4" height="8" rx="1"/><rect x="10" y="8" width="4" height="12" rx="1"/><rect x="17" y="4" width="4" height="16" rx="1"/>',
  route: '<circle cx="6" cy="19" r="2.4"/><circle cx="18" cy="5" r="2.4"/><path d="M8.4 19H14a3.5 3.5 0 0 0 0-7H10a3.5 3.5 0 0 1 0-7h5.6"/>',
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  changes: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
  clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M9 14l2 2 4-4"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',
  users: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><circle cx="12" cy="10" r="2.2"/><path d="M8.5 16a3.5 3.5 0 0 1 7 0"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  cleft: '<path d="M15 18l-6-6 6-6"/>',
  cright: '<path d="M9 18l6-6-6-6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>',
  warn: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
};
function ic(name, size = 18, cls = "") {
  return `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}

/* Логотип «Опрос ПУ» — ступенчатая пирамида (белая для сайдбара). */
const BRAND_PYRAMID = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 20.5 20.5 3.5 20.5Z"/><path d="M7.6 12.2H16.4"/><path d="M5.1 16.4H18.9"/></svg>';
/* Плитка-логотип для входа — фиолетово-чёрный градиент. */
const BRAND_TILE = '<svg viewBox="0 0 512 512"><defs><linearGradient id="oprosG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#0b0a12"/></linearGradient></defs><rect width="512" height="512" rx="112" fill="url(#oprosG)"/><g transform="translate(88 88) scale(14)" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 20.5 20.5 3.5 20.5Z"/><path d="M7.6 12.2H16.4"/><path d="M5.1 16.4H18.9"/></g></svg>';

/* Боковое меню: разделы, иконки, роли, признак «неон»/«точка уведомления». */
const NAV = [
  { section: "Обзор", items: [
    { id: "dashboard", label: "Сводка", icon: "dashboard", roles: ["admin", "uploader", "staff", "res", "chief"] },
  ]},
  { section: "Аналитика", items: [
    { id: "spodes", label: "СПОДЭС", icon: "chart", roles: ["admin", "uploader", "staff", "res", "chief"] },
    { id: "routes", label: "Маршруты и устройства", icon: "route", roles: ["admin", "uploader", "staff", "res", "chief"] },
    { id: "deadtp", label: "Неисправные ТП", icon: "alert", neon: true, roles: ["admin", "uploader", "staff", "res", "chief"] },
    { id: "priorities", label: "Приоритеты", icon: "flag", roles: ["admin", "uploader", "staff", "res", "chief"] },
  ]},
  { section: "Реестр", items: [
    { id: "meters", label: "Реестр ПУ", icon: "database", roles: ["admin", "uploader", "staff", "res", "chief"] },
    { id: "changes", label: "Изменения", icon: "changes", dot: true, roles: ["admin", "uploader", "staff", "chief"] },
    { id: "tasks", label: "Задания", icon: "clipboard", roles: ["admin", "uploader", "staff", "res", "chief"] },
  ]},
  { section: "Администрирование", items: [
    { id: "upload", label: "Загрузка", icon: "upload", roles: ["admin", "uploader"] },
    { id: "users", label: "Пользователи", icon: "users", roles: ["admin"] },
  ]},
];
const TAB_TITLE = Object.fromEntries(NAV.flatMap(s => s.items.map(i => [i.id, i.label])));
const TAB_ICON = Object.fromEntries(NAV.flatMap(s => s.items.map(i => [i.id, i.icon])));

// Заголовок карточки с подсвеченной SVG-иконкой (свечение как в СИЗ-контроль).
function cardTitle(icon, text, inToolbar = true) {
  return `<h2 class="card-title${inToolbar ? " m0" : ""}">${ic(icon, 18, "hdr-ic")}<span>${esc(text)}</span></h2>`;
}

// Bearer-токен (localStorage) — чтобы работать и во встроенном iframe, где
// SameSite=Lax cookie не отправляется на XHR из стороннего контекста.
function authHeaders(h = {}) { return TOKEN ? { ...h, Authorization: "Bearer " + TOKEN } : h; }

async function api(url, opts = {}) {
  const r = await fetch(url, { credentials: "same-origin", ...opts, headers: authHeaders(opts.headers) });
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
function hideLoader() { const l = $("loading"); if (l) l.classList.add("hidden"); }
function showLogin() {
  hideLoader();
  const ll = $("loginLogo"); if (ll && !ll.innerHTML) ll.innerHTML = BRAND_TILE;
  const dg = $("ssoDiag"); if (dg && SSO_DIAG) dg.textContent = SSO_DIAG;
  $("login").classList.remove("hidden"); $("app").classList.add("hidden");
}
async function doLogin() {
  $("l_err").textContent = "";
  try {
    const d = await post("/api/login", { login: $("l_login").value, password: $("l_pass").value });
    TOKEN = d.token || ""; localStorage.setItem("opros_token", TOKEN);
    USER = d.user; boot();
  } catch (e) { $("l_err").textContent = e.message; }
}
async function doLogout() {
  try { await post("/api/logout", {}); } catch {}
  TOKEN = ""; localStorage.removeItem("opros_token"); location.reload();
}
// ВАЖНО: не возвращать false из onkeydown — иначе ввод символов отменяется
// (preventDefault) и в поле пароля нельзя печатать. Реагируем только на Enter.
$("l_pass") && ($("l_pass").onkeydown = (e) => { if (e.key === "Enter") doLogin(); });

/* ---------------- Каркас ---------------- */
async function boot() {
  hideLoader();
  $("login").classList.add("hidden"); $("app").classList.remove("hidden");
  $("brand").innerHTML =
    `<div class="brand-logo">${BRAND_PYRAMID}</div>
     <div class="brand-txt"><div class="t">Опрос ПУ</div><div class="s">Аналитика собираемости</div></div>`;
  $("userName").textContent = `${USER.name || USER.login} · ${roleName(USER.role)}${USER.res ? " · " + USER.res : ""}`;
  $("logoutBtn").innerHTML = `${ic("logout", 15)}<span>Выйти</span>`;
  const resSel = $("resFilter");
  const resList = await api("/api/res_list").catch(() => []);
  if (USER.role === "res") {
    RES = USER.res || ""; resSel.innerHTML = `<option>${esc(RES)}</option>`; resSel.disabled = true;
  } else {
    resSel.innerHTML = `<option value="">Все РЭС</option>` + resList.map(r => `<option>${esc(r)}</option>`).join("");
  }
  renderNav(); openTab("dashboard");
  markChangesDot();
}
function roleName(r) { return { admin: "администратор", uploader: "загрузчик", staff: "служба учёта", res: "участок", chief: "начальник" }[r] || r; }
function onResChange() { RES = $("resFilter").value; openTab(currentTab); }
let currentTab = "dashboard";

function renderNav() {
  $("nav").innerHTML = NAV.map(sec => {
    const items = sec.items.filter(i => i.roles.includes(USER.role));
    if (!items.length) return "";
    return `<div class="nav-section">${sec.section}</div>` + items.map(i =>
      `<div class="nav-item${i.neon ? " neon" : ""}" id="nav_${i.id}" onclick="openTab('${i.id}')">
         ${ic(i.icon, 18)}<span>${i.label}</span></div>`).join("");
  }).join("");
}
async function markChangesDot() {
  if (!["admin", "uploader", "staff"].includes(USER.role)) return;
  try {
    const c = await api("/api/report/changes" + q());
    const el = $("nav_changes");
    if (!c.changes_seen && Object.keys(c.summary).length && el && !el.querySelector(".dot"))
      el.insertAdjacentHTML("beforeend", '<span class="dot"></span>');
  } catch {}
}
function q(extra = "") { return "?" + (RES ? "res=" + encodeURIComponent(RES) + "&" : "") + extra; }

async function openTab(id) {
  currentTab = id; destroyCharts();
  document.querySelectorAll(".nav-item").forEach(a => a.classList.toggle("active", a.id === "nav_" + id));
  $("pageTitle").innerHTML = `${ic(TAB_ICON[id] || "dashboard", 20, "hdr-ic")}<span>${esc(TAB_TITLE[id] || "")}</span>`;
  $("content").innerHTML = `<div class="card muted">Загрузка…</div>`;
  try { await VIEWS[id](); }
  catch (e) { $("content").innerHTML = `<div class="card"><b>Нет данных.</b> ${esc(e.message)}</div>`; }
}

const exportBtn = (kind, label = "Excel") =>
  `<a class="btn small" href="/api/export/report${q("kind=" + kind)}" target="_blank">${ic("download", 15)}${label}</a>`;

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
      <div class="card"><div class="toolbar">${cardTitle("chart", "Собираемость по РЭС")}
        <span class="muted">Загрузка от ${esc(d.upload.date)}, период ${esc(d.upload.period)}</span>
        <a class="btn small primary" href="/api/export/summary${q()}" target="_blank">${ic("download", 15)}Выгрузить в Excel (с диаграммами)</a></div>
        <table><thead><tr><th>РЭС</th><th>Всего</th><th>Собирается</th><th>Не собирается</th><th>% опроса</th>
        <th>СПОДЭС</th><th>% СПОДЭС</th><th>Угасает</th><th>Отключено</th></tr></thead><tbody>
        ${d.rows.map(r => `<tr><td><b>${esc(r.res)}</b></td><td>${r.total.toLocaleString("ru")}</td>
          <td>${r.collected.toLocaleString("ru")}</td><td>${r.not_collected.toLocaleString("ru")}</td>
          <td>${pctCell(r.pct)}</td><td>${r.spodes_collected}/${r.spodes_total}</td>
          <td>${pctCell(r.spodes_pct)}</td><td>${r.fading}</td><td>${r.disconnected}</td></tr>`).join("")}
        <tr class="total-row"><td>Итого по всем РЭС</td><td>${tot.toLocaleString("ru")}</td>
          <td>${col.toLocaleString("ru")}</td><td>${(tot - col).toLocaleString("ru")}</td>
          <td>${pctCell(p)}</td>
          <td>${d.rows.reduce((s, r) => s + r.spodes_collected, 0)}/${d.rows.reduce((s, r) => s + r.spodes_total, 0)}</td>
          <td>${pctCell(d.rows.reduce((s, r) => s + r.spodes_total, 0) ? d.rows.reduce((s, r) => s + r.spodes_collected, 0) * 100 / d.rows.reduce((s, r) => s + r.spodes_total, 0) : 0)}</td>
          <td>${fad}</td><td>${dis}</td></tr>
        </tbody></table></div>
      <div class="row">
        <div class="card">${cardTitle("chart", "% опроса по РЭС", false)}<div class="chart-box"><canvas id="chResPct"></canvas></div></div>
        <div class="card">${cardTitle("changes", "Факт по датам загрузок", false)}<div class="chart-box"><canvas id="chHist"></canvas></div></div>
      </div>
      <div class="card">${cardTitle("database", "История загрузок (факт)", false)}
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
    // агрегируем по РЭС
    const byRes = {};
    rows.forEach(r => { byRes[r.res] = byRes[r.res] || { t: 0, c: 0 }; byRes[r.res].t += r.total; byRes[r.res].c += r.collected; });
    const agg = Object.entries(byRes).map(([res, v]) => ({ res, t: v.t, c: v.c, pct: v.t ? v.c * 100 / v.t : 0 }))
      .sort((a, b) => a.res.localeCompare(b.res, "ru"));
    const totT = agg.reduce((s, a) => s + a.t, 0), totC = agg.reduce((s, a) => s + a.c, 0);
    const totPct = totT ? totC * 100 / totT : 0;

    // данные для детализации (сортировка/фильтр) — в глобалах
    SP_ROWS = rows; SP_TYPE = ""; SP_SORT = { k: "res", dir: 1 };
    const types = [...new Set(rows.map(r => r.type))].sort((a, b) => a.localeCompare(b, "ru"));

    $("content").innerHTML = `
      <div class="card"><div class="toolbar">${cardTitle("chart", "СПОДЭС — собираемость")}${exportBtn("spodes")}</div>
        <div class="kpis" style="margin-bottom:14px">
          <div class="kpi"><div class="v">${totT.toLocaleString("ru")}</div><div class="l">Всего СПОДЭС</div></div>
          <div class="kpi ok"><div class="v">${totC.toLocaleString("ru")}</div><div class="l">Собирается</div></div>
          <div class="kpi bad"><div class="v">${(totT - totC).toLocaleString("ru")}</div><div class="l">Не собирается</div></div>
          <div class="kpi ${pctClass(totPct) === 'good' ? 'ok' : pctClass(totPct) === 'low' ? 'bad' : 'warn'}"><div class="v">${totPct.toFixed(2)}%</div><div class="l">Опрос СПОДЭС</div></div>
        </div>
        <table><thead><tr><th>РЭС</th><th>Всего</th><th>Собирается</th><th>Не собирается</th><th>% опроса</th></tr></thead><tbody>
        ${agg.map(a => `<tr><td><b>${esc(a.res)}</b></td><td>${a.t.toLocaleString("ru")}</td>
          <td>${a.c.toLocaleString("ru")}</td><td>${(a.t - a.c).toLocaleString("ru")}</td><td>${pctCell(a.pct)}</td></tr>`).join("")}
        <tr class="total-row"><td>Итого по всем РЭС</td><td>${totT.toLocaleString("ru")}</td>
          <td>${totC.toLocaleString("ru")}</td><td>${(totT - totC).toLocaleString("ru")}</td><td>${pctCell(totPct)}</td></tr>
        </tbody></table></div>
      <div class="card">${cardTitle("list", "Детально по типам", false)}
        <div class="toolbar">
          <label class="muted">Тип ПУ:</label>
          <select id="spTypeF" onchange="spSetType(this.value)">
            <option value="">Все типы (${types.length})</option>
            ${types.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join("")}
          </select>
          <span class="muted">Клик по заголовку — сортировка</span>
        </div>
        <div class="scroll"><table class="data" id="spTypes"></table></div></div>`;
    renderSpTypes();
  },

  async routes() {
    const [route, vendor, devices] = await Promise.all([
      api("/api/report/group" + q("field=route")),
      api("/api/report/group" + q("field=vendor")),
      api("/api/report/devices" + q())]);
    const broken = devices.filter(d => d.status !== "OK");
    $("content").innerHTML = `
      <div class="row">
        <div class="card"><div class="toolbar">${cardTitle("route", "Через что опрашивается")}${exportBtn("route")}</div>
          <div class="chart-box"><canvas id="chRoute"></canvas></div>
          <table><thead><tr><th>Маршрут</th><th>ПУ</th><th>Собирается</th><th>%</th></tr></thead><tbody>
          ${route.map(r => `<tr><td>${esc(r.group)}</td><td>${r.total.toLocaleString("ru")}</td><td>${r.collected.toLocaleString("ru")}</td><td>${pctCell(r.pct)}</td></tr>`).join("")}</tbody></table></div>
        <div class="card"><div class="toolbar">${cardTitle("chart", "По производителям")}${exportBtn("vendor")}</div>
          <div class="chart-box"><canvas id="chVendor"></canvas></div></div>
      </div>
      <div class="card"><div class="toolbar">${cardTitle("route", "Работоспособность ведущих устройств (МКС / RootRouter / RTR)")}
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
      <div class="card"><div class="toolbar">${cardTitle("alert", "ТП, где не опрашивается ни один ПУ")}
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
      <div class="toolbar">${cardTitle("flag", "Очерёдность работ — " + RES)}${exportBtn("priorities")}</div>
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
        ${exportBtn("not_collected", "Все без опроса (Excel)")}</div>
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
      <div class="card"><div class="toolbar">${cardTitle("changes", "Что изменилось с прошлой загрузки")}
        ${exportBtn("changes")}
        ${canAck && !d.changes_seen ? `<button class="btn primary small" onclick="ackChanges(${d.upload_id})">${ic("check", 14)}Просмотрено</button>` : d.changes_seen ? '<span class="badge ok">Просмотрено</span>' : ""}</div>
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
      <div class="card"><div class="toolbar">${cardTitle("clipboard", "Задания на участки")}
        ${canCreate ? `<button class="btn primary small" onclick="taskModal()">${ic("plus", 15)}Новое задание</button>` : ""}
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
      <div class="card">${cardTitle("upload", "Загрузка выгрузки из Пирамиды", false)}
        <div class="dropzone" id="dz" onclick="$('fileInput').click()">
          Перетащите сюда файл «Опрос ПУ…xlsx» (до 50 МБ) или нажмите для выбора.<br>
          <span class="muted">Файл грузится частями (обход лимита прокси), обработка 130 тыс. строк — 1–2 минуты, идёт в фоне.</span></div>
        <input type="file" id="fileInput" accept=".xlsx" class="hidden">
        <div id="upProgress" class="up-progress hidden">
          <div class="up-bar"><div id="upBar" class="up-bar-fill"></div></div>
          <div id="upStatus" class="up-status"></div>
        </div></div>
      <div class="card">${cardTitle("database", "История загрузок", false)}
        <table><thead><tr><th>№</th><th>Дата</th><th>Файл</th><th>Период</th><th>Всего</th><th>Собирается</th><th>%</th><th>Статус</th><th></th></tr></thead>
        <tbody>${ups.map(u => `<tr><td>${u.id}</td><td>${esc(u.date)}</td><td>${esc(u.filename)}</td><td>${esc(u.period)}</td>
          <td>${u.total.toLocaleString("ru")}</td><td>${u.collected.toLocaleString("ru")}</td><td>${pctCell(u.pct)}</td>
          <td><span class="badge ${u.status === 'done' ? 'ok' : u.status === 'error' ? 'bad' : 'warn'}">${u.status}</span>
            ${u.error ? `<div class="muted">${esc(u.error)}</div>` : ""}</td>
          <td>${USER.role === "admin" ? `<button class="btn small danger" onclick="delUpload(${u.id})" title="Удалить">${ic("trash", 14)}</button>` : ""}</td></tr>`).join("")}
        </tbody></table>
        ${USER.role === "admin" ? `<p><button class="btn danger" onclick="wipeDb()">${ic("warn", 15)}Полностью очистить базу</button></p>` : ""}</div>`;
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
      <div class="card"><div class="toolbar">${cardTitle("users", "Пользователи")}
        <button class="btn primary small" onclick="userModal(null)">${ic("plus", 15)}Добавить</button></div>
        <table><thead><tr><th>Логин</th><th>Имя</th><th>Email</th><th>Роль</th><th>РЭС</th><th>Активен</th><th></th></tr></thead>
        <tbody>${users.map(u => `<tr><td><b>${esc(u.login)}</b></td><td>${esc(u.name)}</td>
          <td>${u.email ? esc(u.email) : '<span class="muted">—</span>'}</td><td>${roleName(u.role)}</td>
          <td>${esc(u.res || "—")}</td><td>${u.active ? '<span class="badge ok">Активен</span>' : '<span class="badge bad">Отключён</span>'}</td>
          <td><button class="btn small" onclick='userModal(${JSON.stringify(u)})'>Изменить</button></td></tr>`).join("")}
        </tbody></table></div>`;
    window._resList = resList;
  },
};

/* ---------------- СПОДЭС: детализация с сортировкой/фильтром ---------------- */
let SP_ROWS = [], SP_TYPE = "", SP_SORT = { k: "res", dir: 1 };
function spSetType(v) { SP_TYPE = v; renderSpTypes(); }
function spSort(k) { if (SP_SORT.k === k) SP_SORT.dir *= -1; else { SP_SORT.k = k; SP_SORT.dir = 1; } renderSpTypes(); }
function renderSpTypes() {
  const el = $("spTypes"); if (!el) return;
  const cols = [["res", "РЭС"], ["type", "Тип ПУ"], ["total", "Всего"], ["collected", "Собирается"], ["not_collected", "Не собирается"], ["pct", "%"]];
  let rows = SP_ROWS.filter(r => !SP_TYPE || r.type === SP_TYPE);
  const { k, dir } = SP_SORT;
  rows = rows.slice().sort((a, b) => {
    const x = a[k], y = b[k];
    if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
    return String(x).localeCompare(String(y), "ru") * dir;
  });
  const arr = (key) => SP_SORT.k === key ? `<span class="arr">${SP_SORT.dir > 0 ? "▲" : "▼"}</span>` : "";
  const th = cols.map(([key, lbl]) => `<th class="sortable" onclick="spSort('${key}')">${lbl} ${arr(key)}</th>`).join("");
  const body = rows.map(r => `<tr><td>${esc(r.res)}</td><td>${esc(r.type)}</td><td>${r.total}</td>
    <td>${r.collected}</td><td>${r.not_collected}</td><td>${pctCell(r.pct)}</td></tr>`).join("");
  el.innerHTML = `<thead><tr>${th}</tr></thead><tbody>${body || '<tr><td colspan="6" class="muted">Нет данных</td></tr>'}</tbody>`;
}

/* ---------------- Действия ---------------- */
async function loadMeters(offset) {
  const nc = $("mNc")?.checked, s = $("mSearch")?.value || "";
  const d = await api("/api/meters" + q(`not_collected=${nc}&search=${encodeURIComponent(s)}&limit=200&offset=${offset}`));
  $("mResult").innerHTML = `
    <p>Найдено: <b>${d.total.toLocaleString("ru")}</b> (показано ${offset + 1}–${offset + d.items.length})
      ${offset > 0 ? `<button class="btn small" onclick="loadMeters(${offset - 200})">${ic("cleft", 14)}Назад</button>` : ""}
      ${offset + 200 < d.total ? `<button class="btn small" onclick="loadMeters(${offset + 200})">Далее${ic("cright", 14)}</button>` : ""}</p>
    <div class="scroll"><table><thead><tr><th>Тип ПУ</th><th>Серийный</th><th>РЭС</th><th>Фидер</th><th>ТП</th>
      <th>Маршрут</th><th>Опрос</th><th>Дата опроса</th><th>Точка учёта</th></tr></thead>
    <tbody>${d.items.map(m => `<tr><td>${esc(m.type)}${m.spodes ? ' <span class="badge info">СПОДЭС</span>' : ""}</td>
      <td>${esc(m.serial)}</td><td>${esc(m.res)}</td><td>${esc(m.feeder)}</td><td>${esc(m.tp)}</td>
      <td>${esc(m.route_class)}</td>
      <td>${m.disconnected ? '<span class="badge">Отключен</span>' : m.collected ? '<span class="badge ok">Собирается</span>' : '<span class="badge bad">Нет опроса</span>'}${m.fading ? ' <span class="badge warn">Угасает</span>' : ""}</td>
      <td>${esc(m.poll_date)}</td><td class="muted">${esc(m.tu)}</td></tr>`).join("")}</tbody></table></div>`;
}

// Прогресс-бар загрузки: pct 0..100; kind = ""|"busy"(индикатор обработки)|"ok"|"err".
function showUp(pct, text, kind = "") {
  const wrap = $("upProgress"); if (!wrap) return;
  wrap.classList.remove("hidden");
  const bar = $("upBar");
  bar.className = "up-bar-fill" + (kind === "busy" ? " busy" : "") + (kind === "ok" ? " ok" : "") + (kind === "err" ? " err" : "");
  bar.style.width = (kind === "busy" ? 100 : Math.max(0, Math.min(100, pct))) + "%";
  const st = $("upStatus");
  st.className = "up-status" + (kind === "err" ? " err" : "") + (kind === "ok" ? " ok" : "");
  st.textContent = text;
}

async function sendFile(f) {
  const CHUNK = 512 * 1024;            // 512 КБ — заведомо ниже лимита прокси
  showUp(0, `Отправка «${f.name}» (${(f.size / 1048576).toFixed(1)} МБ)…`);
  try {
    // 1) начинаем сессию
    const { token } = await post("/api/upload/begin", { filename: f.name });
    // 2) шлём куски
    let sent = 0;
    for (let start = 0; start < f.size; start += CHUNK) {
      const blob = f.slice(start, start + CHUNK);
      const r = await fetch(`/api/upload/chunk/${token}`, {
        method: "POST", credentials: "same-origin",
        headers: authHeaders({ "Content-Type": "application/octet-stream" }),
        body: blob,
      });
      if (!r.ok) { let d = ""; try { d = (await r.json()).detail; } catch {} throw new Error(d || ("Ошибка отправки " + r.status)); }
      sent += blob.size;
      const p = Math.round(sent / f.size * 100);
      showUp(Math.round(p * 0.95), `Отправка файла… ${p}%`);
    }
    // 3) завершаем — запускается импорт
    const d = await post(`/api/upload/complete/${token}`, { filename: f.name });
    showUp(100, "Файл принят, идёт обработка (~1–2 мин). Страницу можно не обновлять.", "busy");
    pollUpload(d.upload_id);
  } catch (e) {
    showUp(0, "Ошибка: " + e.message, "err");
  }
}

function pollUpload(id) {
  const timer = setInterval(async () => {
    let ups;
    try { ups = await api("/api/uploads"); } catch { return; }
    const u = ups.find(x => x.id === id);
    if (!u || u.status === "processing") { showUp(100, "Обработка… (страницу можно не обновлять)", "busy"); return; }
    clearInterval(timer);
    if (u.status === "done") {
      showUp(100, `Готово: ${u.total.toLocaleString("ru")} ПУ, опрос ${u.pct}%. Смотрите вкладку «Изменения».`, "ok");
      markChangesDot();
      setTimeout(() => openTab("upload"), 1800);
    } else {
      showUp(0, "Ошибка обработки: " + (u.error || "неизвестно"), "err");
    }
  }, 3000);
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
    <label>Email (для входа через Платформу / Keycloak)</label><input id="u_email" type="email" value="${u ? esc(u.email || "") : ""}" placeholder="user@example.ru">
    <label>Роль</label><select id="u_role">
      <option value="admin">Администратор</option><option value="uploader">Админ-загрузчик</option>
      <option value="staff">Служба учёта</option><option value="chief">Начальник (просмотр)</option>
      <option value="res">Участок (РЭС)</option></select>
    <label>РЭС (для роли «участок»)</label><select id="u_res"><option value="">—</option>${resList.map(r => `<option>${esc(r)}</option>`).join("")}</select>
    <label>Пароль ${u ? "(пусто — не менять)" : ""}</label><input id="u_pass" type="password">
    ${u ? `<label><input type="checkbox" id="u_active" ${u.active ? "checked" : ""}> Активен</label>` : ""}
    <div class="actions"><button class="btn" onclick="this.closest('.modal-bg').remove()">Отмена</button>
    <button class="btn primary" id="u_save">Сохранить</button></div>`);
  if (u) { bg.querySelector("#u_role").value = u.role; bg.querySelector("#u_res").value = u.res || ""; }
  bg.querySelector("#u_save").onclick = async () => {
    const body = { name: $("u_name").value, email: $("u_email").value, role: $("u_role").value, res: $("u_res").value || null, password: $("u_pass").value };
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
  // Прямой fetch (не api()), чтобы 401 не дёргал форму входа раньше времени.
  try {
    const r = await fetch("/api/me", { credentials: "same-origin", headers: authHeaders() });
    if (r.ok) { USER = await r.json(); boot(); return; }
  } catch {}
  // Во встроенном режиме ждём токен от Платформы; если не пришёл — показываем
  // обычную форму входа как запасной вариант.
  if (EMBEDDED) setTimeout(() => {
    if (!USER) {
      if (!SSO_DIAG) setDiag("Платформа: токен так и не пришёл (открыто ли приложение из оболочки? совпадает ли origin?)");
      showLogin();
    }
  }, 5000);
  else showLogin();
})();
