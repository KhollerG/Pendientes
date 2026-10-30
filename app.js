import { firebaseConfig } from "./firebase-config.js";

const FB = "https://www.gstatic.com/firebasejs/10.12.2/";
const COLS = [
  { id: "hacer", name: "Por hacer" },
  { id: "curso", name: "En curso" },
  { id: "espera", name: "Esperando respuesta" },
  { id: "hecho", name: "Hecho" },
];
const PRIO = { 3: "Alta", 2: "Media", 1: "Baja" };
const LS_KEY = "pendientes-v1";
const LS_BACKUP = "pendientes-ultima-copia";
const LS_SKIP = "pendientes-sin-cuenta";
const LS_MIGR = "pendientes-migrado-";

let tasks = [];
let activeTab = "hacer";
let quick = "";
let showAllDone = false;
let editingId = null;

// Sincronización
let mode = "local";        // "local" | "cloud"
let fb = null;             // funciones y objetos de Firebase
let user = null;
let unsub = null;
let syncState = "";        // "ok" | "pending" | "offline"

const $ = s => document.querySelector(s);
const pad = n => String(n).padStart(2, "0");
const dstr = d => d.getFullYear() + "-" + pad(d.getMonth()+1) + "-" + pad(d.getDate());
const todayStr = () => dstr(new Date());
const addDays = (s, n) => { const d = new Date(s + "T12:00:00"); d.setDate(d.getDate()+n); return dstr(d); };
const MES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
const MESL = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
const DIAS = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];
const fmtDate = s => { const [y,m,d] = s.split("-"); return +d + " " + MES[+m-1]; };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const newId = () => "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

function dueState(t) {
  if (!t.vence || t.estado === "hecho") return "";
  const td = todayStr();
  if (t.vence < td) return "overdue";
  if (t.vence === td) return "today";
  return "";
}
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2800);
}

/* ---------- Guardado local ---------- */
function loadLocal() {
  try { const v = JSON.parse(lsGet(LS_KEY) || "[]"); return Array.isArray(v) ? v : []; }
  catch (e) { return []; }
}
function saveLocal() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(tasks)); }
  catch (e) { toast("No se pudo guardar en este equipo. Exporta una copia."); }
}

/* ---------- Guardado (local o nube) ---------- */
function cloudRef(id) { return fb.doc(fb.db, "users", user.uid, "tareas", id); }

const REPITE = { diaria: "Diaria", semanal: "Semanal", quincenal: "Cada 15 días", mensual: "Mensual" };
const ESPERA_ALERTA = 3; // días en espera antes de sugerir seguimiento

function nextDate(fecha, repite) {
  const d = new Date((fecha || todayStr()) + "T12:00:00");
  const step = () => {
    if (repite === "diaria") d.setDate(d.getDate() + 1);
    else if (repite === "semanal") d.setDate(d.getDate() + 7);
    else if (repite === "quincenal") d.setDate(d.getDate() + 14);
    else if (repite === "mensual") {
      const day = +((fecha || todayStr()).slice(8, 10));
      d.setDate(1); d.setMonth(d.getMonth() + 1);
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, last));
    }
  };
  step();
  const td = todayStr();
  while (dstr(d) <= td && repite !== "mensual") step();      // salta fechas ya pasadas
  while (dstr(d) < td && repite === "mensual") step();
  return dstr(d);
}

function writeTask(t) {
  const old = tasks.find(x => x.id === t.id);
  // Desde cuándo está esperando respuesta
  if (t.estado === "espera") { if (!old || old.estado !== "espera" || !t.esperaDesde) t.esperaDesde = (old && old.estado === "espera" && old.esperaDesde) || Date.now(); }
  else delete t.esperaDesde;
  // Tarea que se repite: al terminarla se crea la siguiente
  let siguiente = null;
  if (t.repite && t.estado === "hecho" && (!old || old.estado !== "hecho")) {
    const vence = nextDate(t.vence, t.repite);
    siguiente = { ...t, id: newId(), creado: Date.now(), estado: "hacer", vence, top3: false,
      checklist: (t.checklist || []).map(c => ({ t: c.t, ok: false })) };
    delete siguiente.esperaDesde;
  }
  t.actualizado = Date.now();
  saveOne(t);
  if (siguiente) {
    saveOne(siguiente);
    setTimeout(() => toast("↻ Próxima creada para el " + fmtDate(siguiente.vence)), 900);
  }
}
function saveOne(t) {
  if (mode === "cloud") {
    const { id, ...body } = t;
    fb.setDoc(cloudRef(id), body).catch(e => toast(errMsg(e)));
    // La pantalla se actualiza sola con el cambio (también sin conexión).
  } else {
    const i = tasks.findIndex(x => x.id === t.id);
    if (i >= 0) tasks[i] = t; else tasks.push(t);
    saveLocal(); render();
  }
}
function removeTask(id) {
  if (mode === "cloud") fb.deleteDoc(cloudRef(id)).catch(e => toast(errMsg(e)));
  else { tasks = tasks.filter(t => t.id !== id); saveLocal(); render(); }
}

/* ---------- Firebase ---------- */
async function initFirebase() {
  if (!firebaseConfig || !firebaseConfig.apiKey) return false;
  try {
    const [appM, authM, fsM] = await Promise.all([
      import(FB + "firebase-app.js"),
      import(FB + "firebase-auth.js"),
      import(FB + "firebase-firestore.js"),
    ]);
    const app = appM.initializeApp(firebaseConfig);
    const auth = authM.getAuth(app);
    await authM.setPersistence(auth, authM.browserLocalPersistence).catch(() => {});
    let db;
    try {
      db = fsM.initializeFirestore(app, { localCache: fsM.persistentLocalCache({ tabManager: fsM.persistentMultipleTabManager() }) });
    } catch (e) { db = fsM.getFirestore(app); }
    fb = { auth, db, ...authM, ...fsM };
    authM.onAuthStateChanged(auth, onUser);
    return true;
  } catch (e) {
    console.warn("Firebase no disponible", e);
    return false;
  }
}

async function onUser(u) {
  if (unsub) { unsub(); unsub = null; }
  user = u;
  if (!u) {
    mode = "local"; tasks = loadLocal(); syncState = "";
    $("#authBox").hidden = lsGet(LS_SKIP) === "1";
    render(); return;
  }
  mode = "cloud";
  $("#authBox").hidden = true;
  await migrateLocal(u);
  const col = fb.collection(fb.db, "users", u.uid, "tareas");
  unsub = fb.onSnapshot(col, { includeMetadataChanges: true }, snap => {
    tasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    syncState = snap.metadata.hasPendingWrites ? "pending" : snap.metadata.fromCache ? "offline" : "ok";
    render();
  }, e => toast(errMsg(e)));
  render();
}

// Al iniciar sesión por primera vez en un equipo, sube las tareas que había en él.
async function migrateLocal(u) {
  if (lsGet(LS_MIGR + u.uid) === "1") return;
  const local = loadLocal();
  if (local.length) {
    try {
      const batch = fb.writeBatch(fb.db);
      for (const t of local.slice(0, 450)) {
        const { id, ...body } = t;
        if (id) batch.set(cloudRef(id), body, { merge: true });
      }
      await batch.commit();
      toast(local.length === 1 ? "La tarea de este equipo se subió a tu cuenta" : local.length + " tareas de este equipo se subieron a tu cuenta");
    } catch (e) { toast("No se pudieron subir las tareas de este equipo: " + errMsg(e)); return; }
  }
  lsSet(LS_MIGR + u.uid, "1");
}

function errMsg(e) {
  const c = (e && e.code) || "";
  const m = {
    "auth/invalid-credential": "Correo o contraseña incorrectos.",
    "auth/wrong-password": "Correo o contraseña incorrectos.",
    "auth/user-not-found": "No hay una cuenta con ese correo.",
    "auth/invalid-email": "El correo no es válido.",
    "auth/email-already-in-use": "Ya existe una cuenta con ese correo. Usa Entrar.",
    "auth/weak-password": "La contraseña debe tener al menos 6 caracteres.",
    "auth/missing-password": "Escribe tu contraseña.",
    "auth/too-many-requests": "Demasiados intentos. Espera unos minutos.",
    "auth/network-request-failed": "Sin conexión. Inténtalo cuando tengas internet.",
    "auth/admin-restricted-operation": "La creación de cuentas está desactivada.",
    "auth/operation-not-allowed": "Falta activar Correo/contraseña en Firebase (ver LEEME).",
    "permission-denied": "Firebase rechazó el acceso. Revisa las reglas de Firestore (ver LEEME).",
  };
  return m[c] || "Ocurrió un error (" + (c || "desconocido") + ").";
}

async function doAuth(kind) {
  const email = $("#a_email").value.trim(), pass = $("#a_pass").value;
  const msg = $("#authMsg"); msg.textContent = "";
  if (!fb) return;
  try {
    if (kind === "reset") {
      if (!email) { msg.textContent = "Escribe tu correo primero."; return; }
      await fb.sendPasswordResetEmail(fb.auth, email);
      msg.textContent = "Te enviamos un correo para cambiar tu contraseña."; return;
    }
    if (kind === "new") await fb.createUserWithEmailAndPassword(fb.auth, email, pass);
    else await fb.signInWithEmailAndPassword(fb.auth, email, pass);
    $("#a_pass").value = "";
    toast("Sesión iniciada. Tus tareas se sincronizan.");
  } catch (e) { msg.textContent = errMsg(e); }
}

/* ---------- Copia de seguridad ---------- */
function exportar() {
  const data = JSON.stringify({ app: "pendientes", version: 1, exportado: new Date().toISOString(), tareas: tasks }, null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "pendientes-" + todayStr() + ".json";
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  lsSet(LS_BACKUP, String(Date.now()));
  render(); toast("Copia descargada");
}
function importar(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const obj = JSON.parse(r.result);
      const list = Array.isArray(obj) ? obj : obj.tareas;
      if (!Array.isArray(list)) throw new Error();
      let nuevos = 0, act = 0;
      for (const t of list) {
        if (!t || typeof t !== "object" || !t.id || !t.titulo) continue;
        const cur = tasks.find(x => x.id === t.id);
        if (!cur) { nuevos++; } else if ((t.actualizado || 0) > (cur.actualizado || 0)) { act++; } else continue;
        if (mode === "cloud") { const { id, ...body } = t; fb.setDoc(cloudRef(id), body).catch(() => {}); }
        else { const i = tasks.findIndex(x => x.id === t.id); if (i >= 0) tasks[i] = t; else tasks.push(t); }
      }
      if (mode === "local") { saveLocal(); render(); }
      toast("Importadas: " + nuevos + " nuevas, " + act + " actualizadas");
    } catch (e) { toast("Ese archivo no es una copia de Pendientes."); }
  };
  r.readAsText(file);
}

/* ---------- Render ---------- */
function filtered() {
  const q = $("#q").value.trim().toLowerCase();
  const p = $("#fProj").value;
  const td = todayStr(), wk = addDays(td, 7);
  return tasks.filter(t => {
    if (p && (t.proyecto || "") !== p) return false;
    if (q) {
      const hay = [t.titulo, t.proyecto, t.solicitante, t.esperaDe, t.siguiente].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (quick === "overdue" && dueState(t) !== "overdue") return false;
    if (quick === "today" && dueState(t) !== "today") return false;
    if (quick === "week" && !(t.estado !== "hecho" && t.vence && t.vence >= td && t.vence <= wk)) return false;
    return true;
  });
}
function sortCol(list, c) {
  if (c === "hecho") return list.sort((a,b) => (b.actualizado||0) - (a.actualizado||0));
  return list.sort((a,b) => (!!b.top3 - !!a.top3)
    || ((a.vence||"9999") < (b.vence||"9999") ? -1 : (a.vence||"9999") > (b.vence||"9999") ? 1 : 0)
    || ((+b.prioridad||2) - (+a.prioridad||2)));
}

function renderSync() {
  const bar = $("#syncBar");
  if (mode === "cloud" && user) {
    bar.hidden = false;
    const st = $("#syncState");
    st.className = "dot " + (syncState || "pending");
    $("#syncText").textContent = syncState === "ok" ? "Sincronizado" : syncState === "offline" ? "Sin conexión · se sincroniza al volver" : "Sincronizando…";
    $("#syncEmail").textContent = user.email || "";
  } else bar.hidden = true;
  $("#syncBtn").hidden = !(fb && mode === "local" && $("#authBox").hidden);
}

function render() {
  const td = todayStr(), d = new Date();
  $("#today").textContent = DIAS[d.getDay()].replace(/^./, c => c.toUpperCase()) + " " + d.getDate() + " de " + MESL[d.getMonth()];
  const h = d.getHours();
  $("#greet").textContent = h < 12 ? "Buenos días 👋" : h < 19 ? "Buenas tardes 👋" : "Buenas noches 👋";
  renderSync();

  // Aviso de copia (solo sin cuenta)
  const last = +lsGet(LS_BACKUP) || 0;
  const days = last ? Math.floor((Date.now() - last) / 864e5) : null;
  $("#backupNote").hidden = !(mode === "local" && tasks.length >= 3 && (days === null || days >= 7));
  $("#backupMsg").textContent = days === null ? "Aún no has guardado una copia de tus tareas." : "Tu última copia es de hace " + days + " días.";

  // Proyectos
  const projs = [...new Set(tasks.map(t => (t.proyecto||"").trim()).filter(Boolean))].sort((a,b) => a.localeCompare(b, "es"));
  const sel = $("#fProj"), cur = sel.value;
  sel.replaceChildren(new Option("Todos los proyectos", ""), ...projs.map(p => new Option(p, p)));
  sel.value = projs.includes(cur) ? cur : "";
  $("#projList").replaceChildren(...projs.map(p => { const o = document.createElement("option"); o.value = p; return o; }));

  // Resumen
  const open = tasks.filter(t => t.estado !== "hecho");
  const wk = addDays(td, 7), wkAgo = Date.now() - 7*864e5;
  const stats = [
    { k: "overdue", n: open.filter(t => dueState(t) === "overdue").length, l: "Vencidas", c: "danger" },
    { k: "today", n: open.filter(t => dueState(t) === "today").length, l: "Vencen hoy", c: "warn" },
    { k: "week", n: open.filter(t => t.vence && t.vence >= td && t.vence <= wk).length, l: "Próx. 7 días", c: "" },
    { k: "", n: tasks.filter(t => t.estado === "espera").length, l: "Esperando", c: "" },
    { k: "", n: tasks.filter(t => t.estado === "hecho" && (t.actualizado||0) >= wkAgo).length, l: "Hechas (7 días)", c: "ok" },
  ];
  $("#stats").replaceChildren(...stats.map(s => {
    const b = el(s.k ? "button" : "div", "stat " + s.c);
    if (s.k) { b.type = "button"; b.setAttribute("aria-pressed", String(quick === s.k)); b.title = "Filtrar";
      b.onclick = () => { quick = quick === s.k ? "" : s.k; render(); }; }
    b.append(el("b", "", s.n), el("span", "", s.l));
    return b;
  }));

  // Top 3
  const t3 = sortCol(open.filter(t => t.top3), "x").slice(0, 3);
  const ol = $("#top3");
  if (!t3.length) ol.replaceChildren(el("p", "hint", "Marca con ☆ hasta 3 tareas que sí o sí deben salir hoy."));
  else ol.replaceChildren(...t3.map((t, i) => {
    const li = el("li"); const b = el("button", "", t.titulo); b.type = "button"; b.onclick = () => openDlg(t);
    li.append(el("span", "n", String(i+1)), b); return li;
  }));

  // Seguimientos pendientes
  const late = tasks.filter(t => t.estado === "espera" && diasEsperando(t) >= ESPERA_ALERTA)
    .sort((x, y) => diasEsperando(y) - diasEsperando(x));
  $("#followBox").hidden = !late.length;
  $("#followList").replaceChildren(...late.map(t => {
    const li = el("li"); const who = el("button", "who link0"); who.type = "button"; who.onclick = () => openDlg(t);
    who.append(t.titulo); const d = diasEsperando(t);
    who.append(el("small", "", (t.esperaDe ? t.esperaDe + " · " : "") + "hace " + d + " días"));
    const b = el("button", "follow", "Copiar seguimiento"); b.type = "button"; b.onclick = () => copyFollow(t);
    li.append(who, b); return li;
  }));

  // Columnas
  const list = filtered();
  const tabs = $("#tabs"); tabs.replaceChildren();
  const board = $("#board"); board.replaceChildren();
  for (const c of COLS) {
    const items = sortCol(list.filter(t => (t.estado || "hacer") === c.id), c.id);
    const tb = el("button"); tb.type = "button"; tb.setAttribute("role", "tab");
    tb.setAttribute("aria-selected", String(activeTab === c.id));
    tb.append(c.id === "espera" ? "Esperando" : c.name, el("span", "c", String(items.length)));
    tb.onclick = () => { activeTab = c.id; render(); };
    tabs.append(tb);

    const sec = el("section", "col" + (activeTab === c.id ? " active" : ""));
    const head = el("div", "col-head"); head.append(el("h2", "", c.name), el("span", "c", String(items.length)));
    const ul = el("div", "list");
    let shown = items;
    if (c.id === "hecho" && !showAllDone && items.length > 8) shown = items.slice(0, 8);
    if (!items.length) ul.append(el("div", "empty", c.id === "hacer" && !tasks.length ? "Aún no hay tareas. Toca “+ Nueva tarea” para agregar la primera." : "Nada aquí."));
    shown.forEach(t => ul.append(card(t)));
    if (shown.length < items.length) {
      const m = el("button", "more", "Ver las " + items.length + " tareas hechas"); m.type = "button";
      m.onclick = () => { showAllDone = true; render(); }; ul.append(m);
    }
    sec.append(head, ul); board.append(sec);
  }
}

function card(t) {
  const ds = dueState(t);
  const c = el("article", "card s-" + (t.estado || "hacer") + " " + ds + (t.estado === "hecho" ? " done" : ""));
  const title = el("button", "t", t.titulo || "(sin título)"); title.type = "button"; title.onclick = () => openDlg(t);
  c.append(title);

  const meta = el("div", "meta");
  const p = +t.prioridad || 2;
  const bars = el("span", "bars p" + p); bars.title = "Prioridad " + PRIO[p]; bars.setAttribute("aria-label", "Prioridad " + PRIO[p]);
  bars.append(el("i"), el("i"), el("i")); meta.append(bars);
  if (t.proyecto) meta.append(el("span", "chip proj", t.proyecto));
  if (t.vence) meta.append(el("span", "chip date " + ds, (ds === "overdue" ? "Venció " : ds === "today" ? "Hoy · " : "") + fmtDate(t.vence)));
  if (t.repite && REPITE[t.repite]) meta.append(el("span", "chip rep", "↻ " + REPITE[t.repite]));
  if (t.solicitante) meta.append(el("span", "chip", "Pidió: " + t.solicitante));
  c.append(meta);

  // Pasos
  const cl = Array.isArray(t.checklist) ? t.checklist : [];
  if (cl.length) {
    const done = cl.filter(x => x.ok).length;
    const box = el("div", "steps");
    const head = el("button", "steps-head"); head.type = "button";
    head.setAttribute("aria-expanded", String(openSteps.has(t.id)));
    const bar = el("span", "prog"); const fill = el("i"); fill.style.width = Math.round(done / cl.length * 100) + "%"; bar.append(fill);
    head.append(el("span", "steps-n", done + "/" + cl.length + " pasos"), bar, el("span", "chev", openSteps.has(t.id) ? "▴" : "▾"));
    head.onclick = () => { openSteps.has(t.id) ? openSteps.delete(t.id) : openSteps.add(t.id); render(); };
    box.append(head);
    if (openSteps.has(t.id)) {
      const ul = el("ul", "steps-list");
      cl.forEach((s, k) => {
        const li = el("li", s.ok ? "ok" : "");
        const lb = el("label"); const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!s.ok;
        cb.onchange = () => {
          const checklist = cl.map((x, j) => j === k ? { ...x, ok: cb.checked } : x);
          writeTask({ ...t, checklist });
          if (checklist.every(x => x.ok) && t.estado !== "hecho") toast("¡Todos los pasos listos! Ya puedes marcarla como Hecho.");
        };
        lb.append(cb, el("span", "", s.t)); li.append(lb); ul.append(li);
      });
      box.append(ul);
    }
    c.append(box);
  }

  // Esperando respuesta: días y seguimiento
  if (t.estado === "espera") {
    const dias = diasEsperando(t);
    const late = dias >= ESPERA_ALERTA;
    const w = el("div", "wait" + (late ? " late" : ""));
    const txt = el("span", "", (t.esperaDe ? "Esperando a " + t.esperaDe : "Esperando respuesta") + " · " + (dias === 0 ? "desde hoy" : "hace " + dias + " día" + (dias > 1 ? "s" : "")));
    w.append(txt);
    if (late) {
      const fb2 = el("button", "follow", "Copiar mensaje de seguimiento"); fb2.type = "button";
      fb2.onclick = () => copyFollow(t);
      w.append(fb2);
    }
    c.append(w);
  }
  if (t.siguiente && t.estado !== "hecho") { const n = el("div", "next"); n.append(el("strong", "", "Siguiente: "), t.siguiente); c.append(n); }

  const a = el("div", "actions");
  const star = el("button", "icon star", t.top3 ? "★" : "☆"); star.type = "button";
  star.setAttribute("aria-pressed", String(!!t.top3)); star.title = "Top 3 de hoy"; star.setAttribute("aria-label", "Top 3 de hoy");
  star.onclick = () => toggleTop3(t);
  if (t.estado === "hecho") star.hidden = true;
  const mv = el("div", "mv");
  const i = COLS.findIndex(x => x.id === (t.estado || "hacer"));
  if (i > 0) { const b = el("button", "icon", "← " + short(COLS[i-1].id)); b.type = "button"; b.onclick = () => move(t, COLS[i-1].id); mv.append(b); }
  if (i < COLS.length - 1) { const b = el("button", "icon", short(COLS[i+1].id) + " →"); b.type = "button"; b.onclick = () => move(t, COLS[i+1].id); mv.append(b); }
  const left = el("div", "mv"); left.append(star);
  if (t.vence && t.estado !== "hecho") {
    const cal = el("button", "icon", "📅"); cal.type = "button"; cal.title = "Agregar al calendario"; cal.setAttribute("aria-label", "Agregar al calendario");
    cal.onclick = () => openCal(t); left.append(cal);
  }
  a.append(left, mv); c.append(a);
  return c;
}
const short = id => ({ hacer: "Por hacer", curso: "En curso", espera: "Esperando", hecho: "Hecho" })[id];
const openSteps = new Set();

function diasEsperando(t) {
  const desde = t.esperaDesde || t.actualizado || Date.now();
  const a = new Date(desde); a.setHours(0, 0, 0, 0);
  const b = new Date(); b.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((b - a) / 864e5));
}
function followText(t) {
  const h = new Date().getHours();
  const saludo = h < 12 ? "Buenos días" : h < 19 ? "Buenas tardes" : "Buenas noches";
  const quien = t.esperaDe ? " " + t.esperaDe : "";
  const dias = diasEsperando(t);
  return saludo + quien + ", te escribo para hacer seguimiento a \"" + t.titulo + "\"" + (t.proyecto ? " (" + t.proyecto + ")" : "") + ". "
    + "Lo solicité hace " + dias + " día" + (dias !== 1 ? "s" : "") + " y lo necesito para continuar"
    + (t.vence ? ", ya que la fecha límite es el " + fmtDate(t.vence) : "") + ". "
    + "¿Me podrías confirmar cuándo podría tenerlo? Muchas gracias.";
}
async function copyFollow(t) {
  const text = followText(t);
  try { await navigator.clipboard.writeText(text); }
  catch (e) {
    const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.append(ta); ta.select(); try { document.execCommand("copy"); } catch (e2) {} ta.remove();
  }
  writeTask({ ...t, ultimoSeguimiento: Date.now() });
  toast("Mensaje copiado. Pégalo en tu correo o WhatsApp.");
}

function move(t, estado) {
  const n = { ...t, estado };
  if (estado === "hecho") n.top3 = false;
  writeTask(n);
  if (estado === "hecho") toast("¡Hecho! " + (t.titulo || ""));
}
function toggleTop3(t) {
  if (!t.top3 && tasks.filter(x => x.top3 && x.estado !== "hecho").length >= 3) {
    toast("Ya tienes 3 prioridades. Quita una antes de agregar otra."); return;
  }
  writeTask({ ...t, top3: !t.top3 });
}

/* ---------- Calendario ---------- */
let calTask = null;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function calTimes(t) {
  const hora = /^\d\d:\d\d$/.test(t.hora || "") ? t.hora : "09:00";
  const [h, m] = hora.split(":").map(Number);
  const start = new Date(t.vence + "T00:00:00"); start.setHours(h, m, 0, 0);
  const end = new Date(start.getTime() + 30 * 60000);
  const f = d => d.getFullYear() + pad(d.getMonth()+1) + pad(d.getDate()) + "T" + pad(d.getHours()) + pad(d.getMinutes()) + "00";
  return { start: f(start), end: f(end), hora };
}
function calDetails(t) {
  const parts = [];
  if (t.proyecto) parts.push("Proyecto: " + t.proyecto);
  if (t.solicitante) parts.push("Pidió: " + t.solicitante);
  if (t.siguiente) parts.push("Siguiente: " + t.siguiente);
  parts.push("Prioridad: " + PRIO[+t.prioridad || 2]);
  return parts.join("\n");
}
const icsEsc = s => String(s).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
function icsFold(line) {
  const out = []; let cur = "";
  for (const ch of line) {
    if (new TextEncoder().encode(cur + ch).length > 73) { out.push(cur); cur = " " + ch; } else cur += ch;
  }
  out.push(cur); return out.join("\r\n");
}
function buildIcs(t) {
  const { start, end } = calTimes(t);
  const now = new Date(), z = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const alarm = trig => ["BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + icsEsc(t.titulo), "TRIGGER:" + trig, "END:VALARM"];
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Pendientes//ES", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    "UID:" + t.id + "@pendientes",
    "DTSTAMP:" + z,
    "DTSTART:" + start,
    "DTEND:" + end,
    "SUMMARY:" + icsEsc(t.titulo),
    "DESCRIPTION:" + icsEsc(calDetails(t)),
    ...alarm("-PT0M"),
  ];
  const dias = +t.aviso || 0;
  if (dias > 0) lines.push(...alarm("-P" + dias + "D"));
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(icsFold).join("\r\n") + "\r\n";
}
function fileName(t) {
  return (t.titulo || "tarea").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(0, 40).toLowerCase() + ".ics";
}
function openCal(t) {
  if (!t.vence) { toast("Ponle una fecha límite para poder agregarla al calendario."); return; }
  calTask = t;
  const { hora } = calTimes(t);
  const dias = +t.aviso || 0;
  const info = $("#calInfo"); info.replaceChildren(t.titulo || "(sin título)");
  info.append(el("small", "", fmtDate(t.vence) + " · " + hora + " · aviso " + (dias ? dias + " día" + (dias > 1 ? "s" : "") + " antes y " : "") + "a la hora"));
  $("#calDlg").showModal();
}
function calIcs() {
  const ics = buildIcs(calTask);
  if (isIOS) {
    // En iPhone, abrir el evento directamente muestra "Agregar al calendario".
    location.href = "data:text/calendar;charset=utf-8," + encodeURIComponent(ics);
  } else {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }));
    a.download = fileName(calTask);
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast("Abre el archivo descargado para agregarlo a tu calendario");
  }
  $("#calDlg").close();
}
function calGoogle() {
  const { start, end } = calTimes(calTask);
  const u = "https://calendar.google.com/calendar/render?action=TEMPLATE"
    + "&text=" + encodeURIComponent(calTask.titulo)
    + "&dates=" + start + "/" + end
    + "&details=" + encodeURIComponent(calDetails(calTask))
    + "&ctz=" + encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Lima");
  window.open(u, "_blank", "noopener");
  $("#calDlg").close();
}
$("#calIcs").onclick = calIcs;
$("#calGoogle").onclick = calGoogle;
$("#calClose").onclick = () => $("#calDlg").close();

/* ---------- Diálogo ---------- */
function syncDraftSteps() {
  document.querySelectorAll("#stepsEd li").forEach((li, k) => {
    if (!draftSteps[k]) return;
    draftSteps[k].t = li.querySelector(".field").value;
    draftSteps[k].ok = li.querySelector("input[type=checkbox]").checked;
  });
  const pend = $("#stepNew").value.trim();
  if (pend) { draftSteps.push({ t: pend, ok: false }); $("#stepNew").value = ""; }
}
function renderSteps() {
  const ul = $("#stepsEd");
  ul.replaceChildren(...draftSteps.map((s, k) => {
    const li = el("li");
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!s.ok; cb.setAttribute("aria-label", "Paso listo");
    const tx = document.createElement("input"); tx.className = "field"; tx.value = s.t; tx.maxLength = 120; tx.setAttribute("aria-label", "Paso " + (k + 1));
    const x = el("button", "x", "✕"); x.type = "button"; x.setAttribute("aria-label", "Quitar paso");
    x.onclick = () => { syncDraftSteps(); draftSteps.splice(k, 1); renderSteps(); };
    li.append(cb, tx, x); return li;
  }));
  const done = draftSteps.filter(x => x.ok).length;
  $("#stepsCount").textContent = draftSteps.length ? "(" + done + "/" + draftSteps.length + ")" : "";
}
function addStep() {
  const v = $("#stepNew").value.trim(); if (!v) return;
  syncDraftSteps(); renderSteps(); $("#stepNew").focus();
}
$("#stepAddBtn").onclick = addStep;
$("#stepNew").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); addStep(); } });
const F = ["titulo","proyecto","solicitante","vence","prioridad","estado","esperaDe","siguiente","hora","aviso","repite"];
let draftSteps = [];
function openDlg(t) {
  editingId = t ? t.id : null;
  $("#dlgTitle").textContent = t ? "Editar tarea" : "Nueva tarea";
  for (const f of F) $("#f_" + f).value = t ? (t[f] ?? "") : "";
  $("#f_prioridad").value = String(t ? (t.prioridad || 2) : 2);
  $("#f_estado").value = t ? (t.estado || "hacer") : (activeTab || "hacer");
  $("#f_top3").checked = !!(t && t.top3);
  $("#f_hora").value = (t && t.hora) || "09:00";
  $("#f_aviso").value = String((t && t.aviso) || 0);
  draftSteps = (t && Array.isArray(t.checklist) ? t.checklist : []).map(x => ({ ...x }));
  $("#stepNew").value = ""; renderSteps();
  $("#delBtn").hidden = !t;
  $("#confirmDel").hidden = true;
  $("#dlg").showModal();
  if (!t) setTimeout(() => $("#f_titulo").focus(), 30);
}
$("#addBtn").onclick = () => openDlg(null);
$("#cancelBtn").onclick = () => $("#dlg").close();
$("#delBtn").onclick = () => { $("#confirmDel").hidden = false; };
$("#delNo").onclick = () => { $("#confirmDel").hidden = true; };
$("#delYes").onclick = () => { if (editingId) removeTask(editingId); $("#dlg").close(); toast("Tarea eliminada"); };
$("#calSaveBtn").onclick = () => {
  if (!$("#f_titulo").value.trim()) { $("#f_titulo").focus(); return; }
  if (!$("#f_vence").value) { toast("Ponle una fecha límite para agregarla al calendario."); $("#f_vence").focus(); return; }
  const n = saveForm();
  if (n) openCal(n);
};
$("#frm").addEventListener("submit", e => { e.preventDefault(); saveForm(); });
function saveForm() {
  const base = editingId ? (tasks.find(x => x.id === editingId) || {}) : { id: newId(), creado: Date.now() };
  const n = { ...base };
  for (const f of F) n[f] = $("#f_" + f).value.trim();
  n.prioridad = +n.prioridad || 2;
  n.aviso = +n.aviso || 0;
  syncDraftSteps();
  n.checklist = draftSteps.filter(x => x.t.trim()).map(x => ({ t: x.t.trim(), ok: !!x.ok }));
  n.top3 = $("#f_top3").checked && n.estado !== "hecho";
  if (!n.titulo) return null;
  if (n.top3 && !base.top3 && tasks.filter(x => x.top3 && x.estado !== "hecho" && x.id !== n.id).length >= 3) {
    n.top3 = false; toast("Guardada sin ★: ya tienes 3 prioridades hoy.");
  }
  writeTask(n);
  activeTab = n.estado;
  $("#dlg").close();
  return n;
}

$("#q").addEventListener("input", render);
$("#fProj").addEventListener("change", render);
$("#expBtn").onclick = exportar;
$("#expBtn2").onclick = exportar;
$("#impBtn").onclick = () => $("#impFile").click();
$("#impFile").addEventListener("change", e => { const f = e.target.files[0]; if (f) importar(f); e.target.value = ""; });

// Cuenta
$("#authForm").addEventListener("submit", e => { e.preventDefault(); doAuth("in"); });
$("#a_new").onclick = () => doAuth("new");
$("#a_reset").onclick = () => doAuth("reset");
$("#a_skip").onclick = () => { lsSet(LS_SKIP, "1"); $("#authBox").hidden = true; render(); };
$("#syncBtn").onclick = () => { lsSet(LS_SKIP, "0"); $("#authBox").hidden = false; render(); $("#a_email").focus(); };
$("#logoutBtn").onclick = async () => { if (fb) { await fb.signOut(fb.auth); toast("Sesión cerrada en este equipo"); } };

// Volver a dibujar al regresar a la app (cambia el día y los vencimientos)
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (mode === "local") tasks = loadLocal();
  render();
});

// Instalación
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferredPrompt = e; $("#instBtn").hidden = false; });
$("#instBtn").onclick = async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; $("#instBtn").hidden = true;
};
window.addEventListener("appinstalled", () => { $("#instBtn").hidden = true; toast("App instalada"); });

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// Arranque: primero lo guardado en el equipo, luego la nube si está configurada.
tasks = loadLocal();
render();
initFirebase().then(ok => { if (!ok) render(); });
