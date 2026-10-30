import { RecipientList, normalizeName } from "./recipients.js";

const $ = (id) => document.getElementById(id);

const list = new RecipientList();   // вся логіка розпізнавання — у recipients.js
const selected = new Set();         // id адресатів, вибраних чекбоксами

const state = {
  file: null,
  parts: [],          // {name, start, end, size, enabled, status, error}
  contacts: [],       // [{id, name, first, last, email, book}]
  pendingId: null,    // нерозпізнаний адресат, для якого шукаємо контакт вручну
  sending: false,
  cancel: false,
  queued: false,      // чекає черги: інша вкладка зараз відправляє
  abort: null,        // AbortController для скасування очікування черги
};

const LOCK_NAME = "bigfile-sender:send";
const openedAt = new Date().toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });

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
  $("progress").textContent =
    (active.length ? `Надіслано ${ok} з ${active.length}` : "") +
    (state.queued ? " · у черзі: інша вкладка відправляє" : "");
  updateTitle();
}

// Заголовок вкладки показує стан, щоб вкладки можна було розрізняти
function updateTitle() {
  const active = state.parts.filter((p) => p.enabled);
  const ok = active.filter((p) => p.status === "ok").length;
  let mark = "";
  if (state.queued) mark = "⏳ черга · ";
  else if (state.sending) mark = `⏳ ${ok}/${active.length} · `;
  else if (active.length && ok === active.length) mark = "✅ ";
  else if (active.some((p) => p.status === "fail")) mark = "⚠ ";
  const subj = $("subject").value.trim();
  document.title = `${mark}Розсилка ${openedAt}${subj ? " · " + subj.slice(0, 40) : ""}`;
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

/* ---------- 3. Адресна книга і адресати ---------- */

async function loadContacts() {
  const books = await messenger.addressBooks.list();
  const all = [];
  for (const b of books) {
    let items = [];
    try { items = await messenger.addressBooks.contacts.list(b.id); }
    catch (e) { log(`Не вдалося прочитати книгу «${b.name}»: ${e.message}`, "warn"); }
    for (const c of items) all.push({ id: c.id, ...contactInfo(c), book: b.name });
  }
  state.contacts = all;
  list.setContacts(all);
  $("contactsInfo").textContent = `У книгах (${books.length}): ${all.length} контактів.`;
  log(`Завантажено ${all.length} контактів з ${books.length} адресних книг.`);
  renderRecipients();
}

const contactText = (c) => `${c.name} <${c.email || "немає email"}>`;

function namesOf(ids) {
  const names = ids.map((id) => { const r = list.get(id); return r ? `«${r.query}»` : ""; }).filter(Boolean);
  return names.length > 10 ? names.slice(0, 10).join(", ") + ` … (+${names.length - 10})` : names.join(", ");
}

function reasonText(row) {
  switch (row.reason) {
    case "not_found": return "не знайдено в адресній книзі";
    case "no_email":  return `контакт «${row.contact.name}» не має email`;
    case "ambiguous": return `кілька збігів: ${row.candidates.length}`;
    default: return "";
  }
}

function orderText(row) {
  if (!row.ordinals.length) return "додано вручну";
  return row.ordinals.join(", ") + (row.ordinals.length > 1 ? `  (×${row.ordinals.length})` : "");
}

function briefText(b) {
  return `«${b.query}»` + (b.ordinals.length ? ` (№ ${b.ordinals.join(", ")})` : " (додано вручну)");
}

function noteNodes(row) {
  return row.notes.map((n) => el("div", {
    class: n.type === "same_contact" ? "note-warn" : "note-info",
    text: (n.type === "same_contact" ? "⚠ Той самий контакт, що й " : "ℹ Спільний email з ") +
          n.with.map(briefText).join("; "),
  }));
}

/* ----- розбір тексту ----- */

function parseRecipients() {
  const n = list.parse($("recipientsInput").value);
  if (!n) { log("Список імен порожній.", "warn"); return; }
  if (!state.contacts.length) log("Адресну книгу не завантажено або вона порожня.", "warn");

  selected.clear();
  state.pendingId = null;

  const v = list.view();
  const s = v.stats;
  log(`Розібрано рядків: ${s.totalLines}; унікальних: ${s.uniqueInText}; повторів: ${s.duplicatesInText}. ` +
      `Розпізнано: ${s.recognized}, не розпізнано: ${s.unrecognized}, ігноровано: ${s.ignored}.`,
      s.unrecognized ? "warn" : "ok");

  for (const r of [...v.recognized, ...v.unrecognized, ...v.ignored]) {
    if (r.ordinals.length > 1) log(`Повтор: «${r.query}» — рядки № ${r.ordinals.join(", ")}.`, "warn");
  }
  for (const r of v.unrecognized) {
    log(`Не розпізнано (№ ${r.ordinals.join(", ") || "—"}): «${r.query}» — ${reasonText(r)}.`, "warn");
  }
  renderRecipients();
}

/* ----- групові операції ----- */

function ignoreSelected(ids) {
  if (!ids.length || state.sending) return;
  const n = list.ignore(ids);
  log(`Проігноровано адресатів: ${n}. ${namesOf(ids)}`);
  ids.forEach((id) => selected.delete(id));
  renderRecipients();
}

function activateSelected(ids) {
  if (!ids.length || state.sending) return;
  const n = list.activate(ids);
  log(`Активовано адресатів: ${n}. ${namesOf(ids)}`);
  ids.forEach((id) => selected.delete(id));
  renderRecipients();
}

/* ----- ручний вибір з адресної книги ----- */

function runManualSearch() {
  const q = normalizeName($("manualSearch").value);
  const ul = $("manualResults");
  ul.replaceChildren();
  if (q.length < 2) return;
  const inUse = list.contactIdsInUse();
  const hits = state.contacts
    .filter((c) => normalizeName(c.name).includes(q) || (c.email || "").toLowerCase().includes(q))
    .slice(0, 30);
  for (const c of hits) {
    ul.appendChild(el("li", {
      text: `${contactText(c)} — ${c.book}${inUse.has(c.id) ? "  ✓ у списку" : ""}`,
      onclick: () => addFromBook(c),
    }));
  }
  if (!hits.length) ul.appendChild(el("li", { text: "Нічого не знайдено" }));
}

function addFromBook(c) {
  if (state.sending) return;
  if (state.pendingId != null) {
    const target = list.get(state.pendingId);
    const res = list.resolveManually(state.pendingId, c);
    log(`Для «${target ? target.query : "?"}» вибрано контакт ${contactText(c)}.`, c.email ? "ok" : "warn");
    if (res.duplicateOf) {
      log(`Увага: цей контакт уже є серед адресатів — «${res.duplicateOf.query}».`, "warn");
    }
    selected.delete(state.pendingId);
    state.pendingId = null;
  } else {
    const res = list.addManual(c);
    if (res.added) log(`Додано вручну: ${contactText(c)}.`, c.email ? "info" : "warn");
    else log(`«${c.name}» уже є в списку (${res.existing.ignored ? "серед ігнорованих" : "«" + res.existing.query + "»"}).`, "warn");
  }
  $("manualSearch").value = "";
  runManualSearch();
  renderRecipients();
}

function renderPending() {
  const box = $("pendingInfo");
  const r = state.pendingId != null ? list.get(state.pendingId) : null;
  if (!r) { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;
  box.replaceChildren(
    el("span", { text: `Оберіть контакт для «${r.query}»` }),
    el("button", { class: "secondary", text: "Скасувати",
      onclick: () => { state.pendingId = null; renderRecipients(); } }));
}

/* ----- відображення секцій ----- */

function renderStats(s) {
  const box = $("recStats");
  box.replaceChildren();
  const add = (label, value, cls = "") =>
    box.append(el("span", { class: "stat " + cls }, `${label}: `, el("b", { text: String(value) })));
  add("Вставлено рядків", s.totalLines);
  add("з них повторів", s.duplicatesInText, s.duplicatesInText ? "warn" : "");
  add("Розпізнано", s.recognized, "ok");
  add("Не розпізнано", s.unrecognized, s.unrecognized ? "err" : "");
  add("Ігноровано", s.ignored);
  if (s.manualAdded) add("Додано вручну", s.manualAdded);
}

function renderSection(container, cfg) {
  const oldWrap = container.querySelector(".tablewrap");
  const scrollTop = oldWrap ? oldWrap.scrollTop : 0;
  container.replaceChildren();

  const ids = cfg.rows.map((r) => r.id);
  const picked = ids.filter((id) => selected.has(id));
  const all = ids.length > 0 && picked.length === ids.length;

  container.append(el("div", { class: "sec-head" },
    el("h3", { class: cfg.cls, text: `${cfg.title} (${cfg.rows.length})` }),
    el("button", {
      class: "secondary",
      text: cfg.actionLabel + (picked.length ? ` (${picked.length})` : ""),
      disabled: picked.length === 0 || state.sending,
      onclick: () => cfg.action(picked),
    })));

  if (!cfg.rows.length) {
    container.append(el("div", { class: "empty", text: cfg.empty }));
    return;
  }

  // чекбокс секції з трьома станами: нічого / частково / усі
  const master = el("input", {
    type: "checkbox",
    title: "Вибрати всіх / скинути вибір",
    checked: all,
    indeterminate: picked.length > 0 && !all,
    disabled: state.sending,
    onclick: () => {
      if (all) ids.forEach((id) => selected.delete(id));
      else ids.forEach((id) => selected.add(id));
      renderRecipients();
    },
  });

  const thead = el("thead", {}, el("tr", {},
    el("th", { class: "chk" }, master),
    ...cfg.columns.map((c) => el("th", { text: c.title }))));

  const tbody = el("tbody");
  for (const row of cfg.rows) {
    const cb = el("input", {
      type: "checkbox",
      checked: selected.has(row.id),
      disabled: state.sending,
      onchange: (e) => {
        if (e.target.checked) selected.add(row.id); else selected.delete(row.id);
        renderRecipients();
      },
    });
    const tr = el("tr", { class: row.id === state.pendingId ? "pending-row" : "" },
      el("td", { class: "chk" }, cb));
    for (const col of cfg.columns) {
      const td = el("td");
      const v = col.cell(row);
      if (v != null) td.append(...(Array.isArray(v) ? v : [v]));
      tr.append(td);
    }
    tbody.append(tr);
  }

  const wrap = el("div", { class: "tablewrap" }, el("table", {}, thead, tbody));
  container.append(wrap);
  wrap.scrollTop = scrollTop;
}

function renderRecipients() {
  const v = list.view();

  const present = new Set([...v.recognized, ...v.unrecognized, ...v.ignored].map((r) => r.id));
  for (const id of [...selected]) if (!present.has(id)) selected.delete(id);
  if (state.pendingId != null && !v.unrecognized.some((r) => r.id === state.pendingId)) state.pendingId = null;

  renderStats(v.stats);
  renderPending();

  renderSection($("secRecognized"), {
    title: "Розпізнані", cls: "sec-ok", rows: v.recognized,
    actionLabel: "Ігнорувати вибраних", action: ignoreSelected,
    empty: "Немає розпізнаних адресатів.",
    columns: [
      { title: "№ у списку", cell: (r) => orderText(r) },
      { title: "Запит", cell: (r) => r.query },
      { title: "Контакт", cell: (r) => contactText(r.contact) },
      { title: "Примітки", cell: (r) => noteNodes(r) },
    ],
  });

  renderSection($("secUnrecognized"), {
    title: "Не розпізнані", cls: "sec-err", rows: v.unrecognized,
    actionLabel: "Ігнорувати вибраних", action: ignoreSelected,
    empty: "Усіх адресатів розпізнано.",
    columns: [
      { title: "№ у списку", cell: (r) => orderText(r) },
      { title: "Запит", cell: (r) => r.query },
      {
        title: "Проблема / вибір",
        cell: (r) => {
          if (r.reason !== "ambiguous") return reasonText(r);
          const sel = el("select", {
            disabled: state.sending,
            onchange: (e) => {
              if (e.target.value === "") return;
              list.setChoice(r.id, +e.target.value);
              selected.delete(r.id);
              renderRecipients();
            },
          }, el("option", { value: "", text: "— оберіть контакт —", selected: r.chosen == null }));
          r.candidates.forEach((c, k) =>
            sel.append(el("option", { value: String(k), text: `${contactText(c)} (${c.book})` })));
          return sel;
        },
      },
      {
        title: "Дія",
        cell: (r) => el("button", {
          class: "secondary", text: "Знайти вручну", disabled: state.sending,
          onclick: () => {
            state.pendingId = r.id;
            const s = $("manualSearch");
            s.value = r.query;
            s.focus();
            runManualSearch();
            renderRecipients();
          },
        }),
      },
    ],
  });

  renderSection($("secIgnored"), {
    title: "Ігноровані", cls: "sec-muted", rows: v.ignored,
    actionLabel: "Активувати вибраних", action: activateSelected,
    empty: "Немає ігнорованих адресатів.",
    columns: [
      { title: "№ у списку", cell: (r) => orderText(r) },
      { title: "Запит", cell: (r) => r.query },
      {
        title: "Стан до ігнорування",
        cell: (r) => r.status === "recognized"
          ? `розпізнано: ${contactText(r.contact)}`
          : `не розпізнано: ${reasonText(r)}`,
      },
    ],
  });

  updateSendState();
}

function updateSendState() {
  const gate = list.canSend();
  $("sendBtn").disabled = state.sending || !gate.ok;
  $("sendBlock").textContent = gate.ok ? "" : "⛔ " + gate.reason;
}

function collectRecipients() {
  const entries = list.recipientsForSending();
  const total = entries.reduce((n, e) => n + e.recipientIds.length, 0);
  log(`Адресатів: ${total}; унікальних email у листі: ${entries.length}.`);
  return entries.map((e) => `"${e.name.replace(/["\\]/g, "")}" <${e.email}>`);
}

/* ---------- 4. Відправка ---------- */

function setSending(v) {
  state.sending = v;
  $("cancelBtn").disabled = !v;
  for (const id of ["fileInput", "maxSize", "parseBtn", "clearBtn", "reloadBtn", "manualSearch"]) $(id).disabled = v;
  renderParts();
  renderRecipients();
}

async function sendAll() {
  if (state.sending) return;

  const todo = state.parts.filter((p) => p.enabled && p.status !== "ok");
  if (!state.file || !state.parts.length) { alert("Спочатку виберіть файл."); return; }
  if (!todo.length) { alert("Немає частин для відправки."); return; }

  const gate = list.canSend();
  if (!gate.ok) { alert(gate.reason); return; }
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
  state.abort = new AbortController();
  try {
    await withSendLock(async () => {
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
          log(`Створено вікно листа (tab ${tab.id}) для «${part.name}».`);
          try { await messenger.windows.update(tab.windowId, { state: "minimized" }); } catch (_) {}

          const res = await messenger.compose.sendMessage(tab.id, { mode: "sendNow" });
          try {
            const msgs = (res && res.messages) || [];
            log(`Відповідь Thunderbird: режим=${res && res.mode}, збережених копій=${msgs.length}` +
                (msgs.length ? " [" + msgs.map((m) => `${m.folder ? m.folder.path : "?"} #${m.headerMessageId || m.id}`).join("; ") + "]" : ""));
          } catch (_) {}

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
    });
  } catch (e) {
    if (e && e.name === "AbortError") log("Відправку скасовано під час очікування черги.", "warn");
    else log(`Помилка відправки: ${e && e.message ? e.message : e}`, "err");
  } finally {
    state.queued = false;
    state.abort = null;
    setSending(false);
  }
}

// Одна відправка одночасно на всі вкладки розширення (Web Locks API):
// SMTP-сервер і вікна листів не навантажуються паралельними розсилками.
async function withSendLock(fn) {
  if (!navigator.locks) return fn();

  let ran = false;
  await navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
    if (!lock) return;
    ran = true;
    await fn();
  });
  if (ran) return;

  state.queued = true;
  log("Інша вкладка зараз відправляє листи — чекаю на чергу…", "warn");
  updateProgress();
  await navigator.locks.request(LOCK_NAME, { signal: state.abort.signal }, async () => {
    state.queued = false;
    updateProgress();
    log("Черга дійшла, починаю відправку.");
    await fn();
  });
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
  if (list.items.length && !confirm("Очистити весь список адресатів разом з ігнорованими?")) return;
  list.clear();
  selected.clear();
  state.pendingId = null;
  $("recipientsInput").value = "";
  log("Список адресатів очищено.");
  renderRecipients();
});
$("reloadBtn").addEventListener("click", async () => {
  try { await loadContacts(); } catch (e) { log("Помилка оновлення книги: " + e.message, "err"); }
});
$("manualSearch").addEventListener("input", runManualSearch);
$("sendBtn").addEventListener("click", sendAll);
$("cancelBtn").addEventListener("click", () => {
  state.cancel = true;
  if (state.abort) state.abort.abort();     // перериває лише очікування черги
  $("cancelBtn").disabled = true;
});
$("subject").addEventListener("input", updateTitle);
// Закриття вкладки під час відправки обірвало б розсилку
window.addEventListener("beforeunload", (e) => {
  if (state.sending) { e.preventDefault(); e.returnValue = ""; }
});
$("clearLog").addEventListener("click", () => $("log").replaceChildren());

(async function init() {
  updateTitle();
  renderRecipients();
  try {
    await loadIdentities();
    await loadContacts();
  } catch (e) {
    log("Помилка ініціалізації: " + e.message, "err");
  }
})();
