"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  file: null,
  parts: [],          // {name, start, end, size, enabled, status, error}
  contacts: [],       // [{id, name, first, last, email, book}]
  index: new Map(),   // normalized name -> contacts[]
  recipients: [],     // {query, candidates:[contact], chosen:number}
  notFound: [],       // string[]
  pendingNF: null,    // ім'я з "не знайдених", для якого шукаємо вручну
  sending: false,
  cancel: false,
};

/* ---------- утиліти ---------- */

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e[k] = v;
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

function log(msg, level = "info") {
  const box = $("log");
  const line = el("div", {
    class: "log-" + level,
    text: `[${new Date().toLocaleTimeString("uk-UA")}] ${msg}`,
  });
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function fmtSize(n) {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + " ГБ";
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(2) + " МБ";
  if (n >= 1024) return (n / 1024).toFixed(1) + " КБ";
  return n + " Б";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (s) => parseFloat(String(s).replace(",", "."));

// Нормалізація імен: регістр, апострофи, латино-кириличні омогліфи
const HOMO = { a: "а", c: "с", e: "е", i: "і", o: "о", p: "р", x: "х", y: "у",
               k: "к", m: "м", t: "т", b: "в", h: "н" };
function norm(s) {
  return (s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’ʼ`´‘]/g, "'")
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[a-z]/g, (ch) => HOMO[ch] || ch);
}

/* ---------- 1. Файл і розбиття ---------- */

function buildParts() {
  state.parts = [];
  const f = state.file;
  if (f) {
    const mb = num($("maxSize").value);
    if (!(mb > 0)) {
      $("partsSummary").textContent = "Вкажіть коректний максимальний розмір.";
      renderParts();
      return;
    }
    const limit = Math.max(1024, Math.floor(mb * 1024 * 1024));
    if (f.size === 0) {
      $("partsSummary").textContent = "Файл порожній.";
      renderParts();
      return;
    }
    const n = Math.ceil(f.size / limit);
    if (n === 1) {
      state.parts.push({ name: f.name, start: 0, end: f.size, size: f.size,
                         enabled: true, status: "pending" });
    } else {
      const pad = Math.max(3, String(n).length);
      for (let i = 0; i < n; i++) {
        const start = i * limit;
        const end = Math.min(f.size, start + limit);
        state.parts.push({
          name: `${f.name}.${String(i + 1).padStart(pad, "0")}`,
          start, end, size: end - start, enabled: true, status: "pending",
        });
      }
    }
  }
  renderParts();
}

const STATUS_TEXT = {
  pending: "○ очікує",
  sending: "⏳ відправляється",
  ok: "✅ надіслано",
  fail: "❌ помилка",
};

function renderParts() {
  const ul = $("partsList");
  ul.replaceChildren();
  state.parts.forEach((p) => {
    const cb = el("input", { type: "checkbox", checked: p.enabled, disabled: state.sending,
      onchange: (e) => { p.enabled = e.target.checked; updateProgress(); } });
    const st = el("span", { class: "st " + p.status, text: STATUS_TEXT[p.status] });
    if (p.error) st.title = p.error;
    ul.appendChild(el("li", {},
      cb,
      el("span", { class: "name", text: p.name }),
      el("span", { class: "size", text: fmtSize(p.size) }),
      st));
  });
  const n = state.parts.length;
  if (state.file && n) {
    $("partsSummary").textContent = n === 1
      ? `Розбивати не потрібно: відправляється як є (${fmtSize(state.file.size)}).`
      : `Розмір ${fmtSize(state.file.size)} → ${n} частин(и).`;
  } else if (!state.file) {
    $("partsSummary").textContent = "";
  }
  updateProgress();
}

function updateProgress() {
  const active = state.parts.filter((p) => p.enabled);
  const ok = active.filter((p) => p.status === "ok").length;
  $("progress").textContent = active.length ? `Надіслано ${ok} з ${active.length}` : "";
}

/* ---------- 2. Відправники ---------- */

async function loadIdentities() {
  const sel = $("identity");
  sel.replaceChildren();
  const accounts = await messenger.accounts.list();
  for (const acc of accounts) {
    for (const id of acc.identities || []) {
      sel.appendChild(el("option", {
        value: id.id,
        text: `${id.name ? id.name + " " : ""}<${id.email}> — ${acc.name}`,
      }));
    }
  }
}

/* ---------- 3. Адресна книга і адресати ---------- */


function propGet(p, key) {
  if (!p) return "";
  const v = typeof p.get === "function" ? p.get(key) : p[key];
  return v == null ? "" : String(v);
}

function vcardUnescape(s) {
  return s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
}

// Запасний розбір vCard, якщо properties порожні
function parseVCard(text) {
  const out = { name: "", first: "", last: "", email: "", email2: "" };
  if (!text) return out;
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const head = line.slice(0, i).toUpperCase();
    const val = line.slice(i + 1);
    const prop = head.split(";")[0].replace(/^.*\./, "");
    if (prop === "FN") out.name = vcardUnescape(val);
    else if (prop === "N") {
      const [last = "", first = ""] = val.split(";");
      out.last = vcardUnescape(last);
      out.first = vcardUnescape(first);
    } else if (prop === "EMAIL") {
      const e = vcardUnescape(val).replace(/^mailto:/i, "");
      if (!out.email) out.email = e; else if (!out.email2) out.email2 = e;
    }
  }
  return out;
}

function contactInfo(c) {
  const p = c.properties;
  let first = propGet(p, "FirstName");
  let last = propGet(p, "LastName");
  let email = propGet(p, "PrimaryEmail") || propGet(p, "SecondEmail");
  let name = propGet(p, "DisplayName");
  if (!name || !email) {
    const v = parseVCard(c.vCard);
    name = name || v.name;
    first = first || v.first;
    last = last || v.last;
    email = email || v.email || v.email2;
  }
  name = name || `${first} ${last}`.trim() || email;
  return { name, first, last, email };
}

async function loadContacts() {
  const books = await messenger.addressBooks.list();
  const all = [];
  for (const b of books) {
    let list = [];
    try { list = await messenger.addressBooks.contacts.list(b.id); }
    catch (e) { log(`Не вдалося прочитати книгу «${b.name}»: ${e.message}`, "warn"); }
    for (const c of list) {
      const info = contactInfo(c);
      all.push({ id: c.id, ...info, book: b.name });
    }
  }
  state.contacts = all;
  buildIndex();
  $("contactsInfo").textContent = `У книгах (${books.length}): ${all.length} контактів.`;
  log(`Завантажено ${all.length} контактів з ${books.length} адресних книг.`);
}

function buildIndex() {
  const idx = new Map();
  const add = (key, c) => {
    const k = norm(key);
    if (!k) return;
    let a = idx.get(k);
    if (!a) idx.set(k, (a = []));
    if (!a.includes(c)) a.push(c);
  };
  for (const c of state.contacts) {
    add(c.name, c);
    if (c.first || c.last) {
      add(`${c.first} ${c.last}`, c);
      add(`${c.last} ${c.first}`, c);
    }
  }
  state.index = idx;
}

function parseRecipients() {
  const lines = $("recipientsInput").value
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) { log("Список імен порожній.", "warn"); return; }

  state.notFound = [];
  let added = 0, skipped = 0;
  for (const line of lines) {
    const cands = state.index.get(norm(line));
    if (!cands) {
      if (!state.notFound.includes(line)) state.notFound.push(line);
      continue;
    }
    if (state.recipients.some((r) => r.query === line)) { skipped++; continue; }
    const sorted = cands.slice().sort((a, b) => !!b.email - !!a.email);
    state.recipients.push({ query: line, candidates: sorted, chosen: 0 });
    added++;
  }
  log(`Розібрано рядків: ${lines.length}. Додано: ${added}, вже були в списку: ${skipped}, ` +
      `не знайдено: ${state.notFound.length}.`,
      state.notFound.length ? "warn" : "ok");
  for (const n of state.notFound) log(`Не знайдено в адресній книзі: «${n}»`, "warn");
  renderRecipients();
}

function renderRecipients() {
  const tbody = $("foundTable").querySelector("tbody");
  tbody.replaceChildren();
  const seenEmails = new Set();

  state.recipients.forEach((r, i) => {
    const c = r.candidates[r.chosen];
    const emailKey = (c.email || "").toLowerCase();
    const dup = c.email && seenEmails.has(emailKey);
    if (c.email) seenEmails.add(emailKey);

    let contactCell;
    if (r.candidates.length > 1) {
      const sel = el("select", { onchange: (e) => { r.chosen = +e.target.value; renderRecipients(); } });
      r.candidates.forEach((cc, k) => sel.appendChild(el("option", {
        value: k, selected: k === r.chosen,
        text: `${cc.name} <${cc.email || "немає email"}> (${cc.book})`,
      })));
      contactCell = el("td", {}, sel);
    } else {
      contactCell = el("td", { text: `${c.name} <${c.email || "немає email"}>` });
    }

    const tr = el("tr", { class: !c.email ? "noemail" : dup ? "dup" : "" },
      el("td", { text: i + 1 }),
      el("td", { text: r.query }),
      contactCell,
      el("td", {}, el("button", { class: "secondary", text: "✕", title: "Видалити зі списку",
        onclick: () => { state.recipients.splice(i, 1); renderRecipients(); } })));
    if (dup) tr.title = "Дублікат email — буде надіслано лише один раз";
    if (!c.email) tr.title = "У контакта немає email — буде пропущено";
    tbody.appendChild(tr);
  });

  $("foundCount").textContent = state.recipients.length;

  const ul = $("notFound");
  ul.replaceChildren();
  state.notFound.forEach((n, i) => {
    ul.appendChild(el("li", {},
      el("span", { class: "n", text: n }),
      el("button", { class: "secondary", text: "Знайти вручну", onclick: () => {
        state.pendingNF = n;
        const s = $("manualSearch");
        s.value = n;
        s.focus();
        runManualSearch();
      } }),
      el("button", { class: "secondary", text: "✕", title: "Прибрати з переліку",
        onclick: () => { state.notFound.splice(i, 1); renderRecipients(); } })));
  });
  $("nfCount").textContent = state.notFound.length;
}

function runManualSearch() {
  const q = norm($("manualSearch").value);
  const ul = $("manualResults");
  ul.replaceChildren();
  if (q.length < 2) return;
  const hits = state.contacts
    .filter((c) => norm(c.name).includes(q) || (c.email || "").toLowerCase().includes(q))
    .slice(0, 30);
  for (const c of hits) {
    ul.appendChild(el("li", {
      text: `${c.name} <${c.email || "немає email"}> — ${c.book}`,
      onclick: () => addManual(c),
    }));
  }
  if (!hits.length) ul.appendChild(el("li", { text: "Нічого не знайдено" }));
}

function addManual(c) {
  if (state.recipients.some((r) => r.candidates[r.chosen].id === c.id)) {
    log(`«${c.name}» вже є в списку.`, "warn");
    return;
  }
  state.recipients.push({ query: c.name, candidates: [c], chosen: 0 });
  log(`Додано вручну: ${c.name} <${c.email || "немає email"}>`);
  if (state.pendingNF) {
    state.notFound = state.notFound.filter((n) => n !== state.pendingNF);
    state.pendingNF = null;
  }
  renderRecipients();
}

function collectRecipients() {
  const out = [];
  const seen = new Set();
  for (const r of state.recipients) {
    const c = r.candidates[r.chosen];
    if (!c.email) { log(`Пропущено «${c.name}»: немає email.`, "warn"); continue; }
    const key = c.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`"${c.name.replace(/["\\]/g, "")}" <${c.email}>`);
  }
  return out;
}

/* ---------- 4. Відправка ---------- */

function setSending(v) {
  state.sending = v;
  $("sendBtn").disabled = v;
  $("cancelBtn").disabled = !v;
  for (const id of ["fileInput", "maxSize", "parseBtn", "clearBtn", "reloadBtn"]) $(id).disabled = v;
  renderParts();
}

async function sendAll() {
  if (state.sending) return;

  const todo = state.parts.filter((p) => p.enabled && p.status !== "ok");
  if (!state.file || !state.parts.length) { alert("Спочатку виберіть файл."); return; }
  if (!todo.length) { alert("Немає частин для відправки."); return; }

  const recipients = collectRecipients();
  if (!recipients.length) { alert("Список адресатів порожній."); return; }

  const identityId = $("identity").value;
  if (!identityId) { alert("Не вибрано відправника."); return; }
  const subjectBase = $("subject").value.trim();
  if (!subjectBase) { alert("Вкажіть тему листа."); return; }
  const bodyBase = $("body").value;
  const field = $("fieldType").value;
  const delayMs = Math.max(0, (num($("delay").value) || 0) * 1000);

  const total = state.parts.length;
  setSending(true);
  state.cancel = false;
  log(`Початок відправки: частин ${todo.length}, адресатів ${recipients.length}.`);

  for (const part of todo) {
    if (state.cancel) { log("Відправку зупинено користувачем.", "warn"); break; }

    const index = state.parts.indexOf(part) + 1;
    part.status = "sending";
    part.error = "";
    renderParts();
    log(`Відправляється «${part.name}» (${fmtSize(part.size)})…`);

    try {
      const blob = state.file.slice(part.start, part.end);
      const type = total === 1 ? (state.file.type || "application/octet-stream")
                               : "application/octet-stream";
      const att = new File([blob], part.name, { type });

      const subject = total > 1 ? `${subjectBase} (частина ${index} з ${total})` : subjectBase;
      let body = bodyBase;
      if (total > 1) {
        body += `${body ? "\n\n" : ""}Частина ${index} з ${total} файла «${state.file.name}». ` +
                `Щоб зібрати файл, об'єднайте всі частини за порядком номерів.`;
      }

      const details = {
        identityId,
        subject,
        isPlainText: true,
        plainTextBody: body,
        attachments: [{ file: att, name: part.name }],
      };
      details[field] = recipients;

      const tab = await messenger.compose.beginNew(details);
      try { await messenger.windows.update(tab.windowId, { state: "minimized" }); } catch (_) {}

      await messenger.compose.sendMessage(tab.id, { mode: "sendNow" });

      part.status = "ok";
      log(`✔ «${part.name}» надіслано.`, "ok");
    } catch (e) {
      part.status = "fail";
      part.error = e && e.message ? e.message : String(e);
      log(`✘ «${part.name}»: ${part.error}`, "err");
    }
    renderParts();

    if (delayMs && todo.indexOf(part) < todo.length - 1 && !state.cancel) await sleep(delayMs);
  }

  const failed = state.parts.filter((p) => p.enabled && p.status === "fail").length;
  const okCount = state.parts.filter((p) => p.enabled && p.status === "ok").length;
  log(`Завершено. Успішно: ${okCount}, з помилкою: ${failed}.`, failed ? "warn" : "ok");
  setSending(false);
}

/* ---------- ініціалізація ---------- */

$("fileInput").addEventListener("change", (e) => {
  state.file = e.target.files[0] || null;
  if (state.file) log(`Вибрано файл «${state.file.name}», ${fmtSize(state.file.size)}.`);
  buildParts();
});
$("maxSize").addEventListener("change", buildParts);
$("parseBtn").addEventListener("click", parseRecipients);
$("clearBtn").addEventListener("click", () => {
  state.recipients = []; state.notFound = []; state.pendingNF = null;
  $("recipientsInput").value = "";
  renderRecipients();
});
$("reloadBtn").addEventListener("click", async () => { await loadContacts(); });
$("manualSearch").addEventListener("input", () => runManualSearch);
$("sendBtn").addEventListener("click", sendAll);
$("cancelBtn").addEventListener("click", () => { state.cancel = true; $("cancelBtn").disabled = true; });
$("clearLog").addEventListener("click", () => $("log").replaceChildren());

(async function init() {
  try {
    await loadIdentities();
    await loadContacts();
  } catch (e) {
    log("Помилка ініціалізації: " + e.message, "err");
  }
  renderRecipients();
})();
