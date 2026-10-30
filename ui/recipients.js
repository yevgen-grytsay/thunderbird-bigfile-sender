/*
 * Модуль розпізнавання адресатів.
 * Чиста логіка: без DOM і без messenger API, тому її можна тестувати окремо.
 *
 * Модель адресата (внутрішня):
 *   id               унікальний номер
 *   key              нормалізоване ім'я з тексту (null для доданих вручну)
 *   query            ім'я так, як воно було у тексті (після очищення)
 *   ordinals         порядкові номери появи в тексті (1-based, лише непорожні рядки)
 *   candidates       знайдені контакти адресної книги
 *   chosen           індекс вибраного кандидата або null
 *   manual           доданий вручну з адресної книги (немає у тексті)
 *   resolvedManually нерозпізнаний, якому користувач вручну призначив контакт
 *   ignored          деактивований користувачем
 *
 * Секції (обчислюються, не зберігаються):
 *   ignored      — ignored === true
 *   recognized   — є однозначно вибраний контакт з email
 *   unrecognized — решта (не знайдено / кілька збігів / у контакта немає email)
 */

/* ---------- нормалізація ---------- */

// Латинські літери, схожі на кириличні (порівнюємо обидві сторони однаково)
const HOMO = { a: "а", c: "с", e: "е", i: "і", o: "о", p: "р", x: "х", y: "у",
               k: "к", m: "м", t: "т", b: "в", h: "н" };
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
const LINE_BREAKS = /\r\n|[\n\r\u000B\u000C\u0085\u2028\u2029]/;

export function normalizeName(s) {
  return String(s || "")
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .toLowerCase()
    .replace(/[’ʼ`´‘]/g, "'")
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/ё/g, "е")
    .replace(/[,;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[a-z]/g, (ch) => HOMO[ch] || ch);
}

// Прибирає невидимі символи та маркери списків на початку рядка ("1. ", "- ", "• ")
export function cleanLine(line) {
  let t = String(line || "").replace(INVISIBLE, "").replace(/\u00A0/g, " ").trim();
  let prev;
  do {
    prev = t;
    t = t.replace(/^(?:[-–—•*·▪●○]+\s*|\d+\s*[.)]\s+)/, "").trim();
  } while (t !== prev);
  return t;
}

// Розбиває вставлений текст на рядки. Порядковий номер рахується лише для непорожніх рядків.
export function parseLines(text) {
  const out = [];
  let ordinal = 0;
  for (const raw of String(text || "").split(LINE_BREAKS)) {
    const query = cleanLine(raw);
    if (!normalizeName(query)) continue;
    ordinal++;
    out.push({ ordinal, query });
  }
  return out;
}

/* ---------- індекс адресної книги ---------- */

export function buildIndex(contacts) {
  const idx = new Map();
  const add = (key, c) => {
    const k = normalizeName(key);
    if (!k) return;
    let a = idx.get(k);
    if (!a) idx.set(k, (a = []));
    if (!a.includes(c)) a.push(c);
  };
  for (const c of contacts) {
    add(c.name, c);
    if (c.first || c.last) {
      add(`${c.first} ${c.last}`, c);
      add(`${c.last} ${c.first}`, c);
    }
  }
  return idx;
}

// Прибирає «фальшиву» неоднозначність: той самий email у кількох книгах,
// контакти без email, коли є контакти з email.
function reduceCandidates(cands) {
  const withEmail = cands.filter((c) => c.email);
  const pool = withEmail.length ? withEmail : cands.slice(0, 1);
  const seen = new Set();
  const out = [];
  for (const c of pool) {
    const k = (c.email || "").toLowerCase();
    if (k && seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/* ---------- стан адресата ---------- */

export const STATUS = { RECOGNIZED: "recognized", UNRECOGNIZED: "unrecognized" };
export const REASON = { NOT_FOUND: "not_found", AMBIGUOUS: "ambiguous", NO_EMAIL: "no_email" };

function chosenContact(r) {
  return r.chosen != null ? r.candidates[r.chosen] || null : null;
}

function evaluate(r) {
  if (!r.candidates.length) return { status: STATUS.UNRECOGNIZED, reason: REASON.NOT_FOUND };
  const c = chosenContact(r);
  if (!c) return { status: STATUS.UNRECOGNIZED, reason: REASON.AMBIGUOUS };
  if (!c.email) return { status: STATUS.UNRECOGNIZED, reason: REASON.NO_EMAIL };
  return { status: STATUS.RECOGNIZED, reason: null };
}

const brief = (r) => ({ id: r.id, query: r.query, ordinals: r.ordinals.slice() });

/* ---------- список адресатів ---------- */

export class RecipientList {
  constructor() {
    this.items = [];
    this.totalLines = 0;   // скільки непорожніх рядків було у вставленому тексті
    this._index = new Map();
    this._seq = 0;
  }

  /** Оновлює адресну книгу; наявні адресати перераховуються. */
  setContacts(contacts) {
    this._index = buildIndex(contacts);
    const byId = new Map(contacts.map((c) => [c.id, c]));
    for (const r of this.items) {
      if (r.manual || r.resolvedManually) {
        r.candidates = r.candidates.map((c) => byId.get(c.id) || c);
      } else {
        this._resolveFresh(r);
      }
    }
  }

  _resolveFresh(r) {
    const prev = chosenContact(r);
    const cands = reduceCandidates(this._index.get(r.key) || []);
    r.candidates = cands;
    const keep = prev ? cands.findIndex((c) => c.id === prev.id) : -1;
    r.chosen = keep >= 0 ? keep : cands.length === 1 ? 0 : null;
  }

  get(id) {
    return this.items.find((r) => r.id === id) || null;
  }

  /**
   * Перебудовує список за текстом. Адресати, які були у списку раніше,
   * зберігають стан (ігнорування, ручний вибір). Додані вручну залишаються.
   * Повертає кількість рядків, або 0, якщо текст порожній (список не змінюється).
   */
  parse(text) {
    const lines = parseLines(text);
    if (!lines.length) return 0;

    const prevByKey = new Map();
    for (const r of this.items) if (!r.manual) prevByKey.set(r.key, r);
    const manual = this.items.filter((r) => r.manual);

    const byKey = new Map();
    for (const { ordinal, query } of lines) {
      const key = normalizeName(query);
      let r = byKey.get(key);
      if (!r) {
        const prev = prevByKey.get(key);
        r = {
          id: prev ? prev.id : ++this._seq,
          key, query,
          ordinals: [],
          candidates: prev ? prev.candidates : [],
          chosen: prev ? prev.chosen : null,
          manual: false,
          resolvedManually: prev ? prev.resolvedManually : false,
          ignored: prev ? prev.ignored : false,
        };
        if (!r.resolvedManually) this._resolveFresh(r);
        byKey.set(key, r);
      }
      r.ordinals.push(ordinal);
    }

    // Додані вручну, яких тепер уже розпізнано з тексту, не дублюємо
    const used = new Set();
    for (const r of byKey.values()) {
      const c = chosenContact(r);
      if (c) used.add(c.id);
    }
    this.items = [
      ...byKey.values(),
      ...manual.filter((m) => !used.has(chosenContact(m).id)),
    ];
    this.totalLines = lines.length;
    return lines.length;
  }

  clear() {
    this.items = [];
    this.totalLines = 0;
  }

  /** Додає контакт з адресної книги, якого немає в тексті. */
  addManual(contact) {
    const existing = this.items.find((r) => chosenContact(r) && chosenContact(r).id === contact.id);
    if (existing) {
      return { added: false, existing: { id: existing.id, query: existing.query, ignored: existing.ignored } };
    }
    const r = {
      id: ++this._seq, key: null, query: contact.name, ordinals: [],
      candidates: [contact], chosen: 0,
      manual: true, resolvedManually: false, ignored: false,
    };
    this.items.push(r);
    return { added: true, id: r.id };
  }

  /** Призначає нерозпізнаному адресату контакт вручну (порядкові номери зберігаються). */
  resolveManually(id, contact) {
    const r = this.get(id);
    if (!r) return { ok: false, duplicateOf: null };
    r.candidates = [contact];
    r.chosen = 0;
    r.resolvedManually = true;
    const dup = this.items.find((o) =>
      o !== r && !o.ignored && chosenContact(o) && chosenContact(o).id === contact.id);
    return { ok: true, duplicateOf: dup ? brief(dup) : null };
  }

  /** Вибір одного з кількох збігів. */
  setChoice(id, index) {
    const r = this.get(id);
    if (!r || !(index >= 0 && index < r.candidates.length)) return false;
    r.chosen = index;
    return true;
  }

  ignore(ids) {
    return this._setIgnored(ids, true);
  }

  activate(ids) {
    return this._setIgnored(ids, false);
  }

  _setIgnored(ids, value) {
    const set = new Set(ids);
    let n = 0;
    for (const r of this.items) {
      if (set.has(r.id) && r.ignored !== value) { r.ignored = value; n++; }
    }
    return n;
  }

  contactIdsInUse() {
    const s = new Set();
    for (const r of this.items) {
      const c = chosenContact(r);
      if (c) s.add(c.id);
    }
    return s;
  }

  /** Знімок для інтерфейсу: три секції, статистика, примітки про збіги. */
  view() {
    const rows = this.items.map((r) => {
      const ev = evaluate(r);
      return {
        id: r.id, query: r.query, ordinals: r.ordinals.slice(),
        manual: r.manual, resolvedManually: r.resolvedManually, ignored: r.ignored,
        status: ev.status, reason: ev.reason,
        contact: chosenContact(r), candidates: r.candidates, chosen: r.chosen,
        notes: [],
      };
    });
    this._annotate(rows);

    const recognized = [], unrecognized = [], ignored = [];
    for (const row of rows) {
      if (row.ignored) ignored.push(row);
      else if (row.status === STATUS.RECOGNIZED) recognized.push(row);
      else unrecognized.push(row);
    }
    const fromText = this.items.filter((r) => !r.manual).length;
    return {
      recognized, unrecognized, ignored,
      stats: {
        totalLines: this.totalLines,                       // з дублікатами
        uniqueInText: fromText,
        duplicatesInText: Math.max(0, this.totalLines - fromText),
        recognized: recognized.length,                     // без дублікатів
        unrecognized: unrecognized.length,
        ignored: ignored.length,
        manualAdded: this.items.filter((r) => r.manual).length,
      },
    };
  }

  // Примітки: той самий контакт під різним записом (імовірна помилка)
  // або різні адресати зі спільним email (допустимо, але варто бачити).
  _annotate(rows) {
    const act = rows.filter((r) => !r.ignored && r.status === STATUS.RECOGNIZED);
    const byContact = new Map();
    const byEmail = new Map();
    const push = (m, k, r) => { if (!m.has(k)) m.set(k, []); m.get(k).push(r); };
    for (const r of act) {
      push(byContact, r.contact.id, r);
      push(byEmail, r.contact.email.toLowerCase(), r);
    }
    for (const r of act) {
      const sameC = byContact.get(r.contact.id).filter((o) => o !== r);
      if (sameC.length) r.notes.push({ type: "same_contact", with: sameC.map(brief) });
      const sameE = byEmail.get(r.contact.email.toLowerCase())
        .filter((o) => o !== r && o.contact.id !== r.contact.id);
      if (sameE.length) r.notes.push({ type: "same_email", with: sameE.map(brief) });
    }
  }

  /** Чи можна відправляти. Нерозпізнані (не ігноровані) адресати блокують відправку. */
  canSend() {
    const { stats } = this.view();
    if (stats.unrecognized > 0) {
      return { ok: false, reason: `Є нерозпізнані адресати: ${stats.unrecognized}. Розпізнайте їх або позначте як ігноровані.` };
    }
    if (stats.recognized === 0) {
      return { ok: false, reason: "Немає жодного активного адресата." };
    }
    return { ok: true, reason: "" };
  }

  /**
   * Список для поля To/Cc/Bcc. Один email — один запис,
   * але всі адресати з цим email зберігаються в recipientIds.
   */
  recipientsForSending() {
    const out = [];
    const byEmail = new Map();
    for (const r of this.items) {
      if (r.ignored || evaluate(r).status !== STATUS.RECOGNIZED) continue;
      const c = chosenContact(r);
      const k = c.email.toLowerCase();
      if (byEmail.has(k)) { byEmail.get(k).recipientIds.push(r.id); continue; }
      const entry = { email: c.email, name: c.name, recipientIds: [r.id] };
      byEmail.set(k, entry);
      out.push(entry);
    }
    return out;
  }
}
