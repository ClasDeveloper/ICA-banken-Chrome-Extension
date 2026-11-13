const sek = new Intl.NumberFormat("sv-SE", { style: "currency", currency: "SEK" });

const UNCATEGORIZED = "Okategoriserat";
const NEW_CATEGORY = "__new__";
let categories = ["Mat", "Hobby", "Transport", "Hälsa", "Boende", "Nöje", "Shopping", "Övrigt"];
let mapping = {}; // normaliserad nyckel -> kategori
let loaded = false;
let salary = 0;

const IGNORED_PREFIXES = ["överför"];

function isIgnored(name) {
  const lower = name.toLowerCase();
  return IGNORED_PREFIXES.some((p) => lower.startsWith(p));
}

// ---------- Normalisering: "ICA MAXI 1234" och "Ica Maxi" blir samma nyckel ----------

function keyOf(name) {
  const key = name
    .toLowerCase()
    .replace(/\d+/g, " ")
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return key || name.toLowerCase();
}

function normalizeMapping(raw) {
  const out = {};
  for (const [name, cat] of Object.entries(raw ?? {})) out[keyOf(name)] = cat;
  return out;
}

function parseSalary(value) {
  const n = parseFloat(String(value).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

chrome.storage.local
  .get({ categories, mapping, salary: 0 })
  .then((data) => {
    categories = data.categories;
    mapping = normalizeMapping(data.mapping);
    salary = parseSalary(data.salary);
    loaded = true;
    save(); // skriver tillbaka mappningen med normaliserade nycklar
    refresh();
  })
  .catch((err) => console.error("[ICA budget] Kunde inte läsa storage:", err));

function save() {
  chrome.storage.local
    .set({ categories, mapping, salary })
    .catch((err) => console.error("[ICA budget] Kunde inte spara:", err));
}

function saveSalary(value) {
  salary = parseSalary(value);
  save();
  refresh();
}

// Håll flera öppna flikar synkade (annars skriver en gammal flik över nyare data)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !loaded) return;
  if (changes.categories) categories = changes.categories.newValue ?? categories;
  if (changes.mapping) mapping = normalizeMapping(changes.mapping.newValue);
  if (changes.salary) salary = parseSalary(changes.salary.newValue);
  refresh();
});

function addCategory(value) {
  if (!categories.includes(value)) categories.push(value);
}

// ---------- Parsing ----------

function parseAmount(text) {
  const cleaned = text
    .replace(/\u2212/g, "-")
    .replace(/[^\d,.-]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  return parseFloat(cleaned);
}

// Läser namnet utan vår egen badge (som ligger inuti cellen)
function readName(cell) {
  const clone = cell.cloneNode(true);
  clone.querySelectorAll(".ib-badge").forEach((el) => el.remove());
  clone.querySelectorAll("br, div, p, li").forEach((el) => el.after(document.createTextNode(" ")));
  return clone.textContent.replace(/\s+/g, " ").trim();
}

let lastExpandRowCount = -1;

function expandAllRows() {
  const transactionsDiv = document.getElementById("transactions");
  if (!transactionsDiv) return;
  // Klicka bara om antalet rader ändrats sedan förra klicket. Annars loopar vi
  // och spammar bankens egen klick-/XHR-spårning (-> 429 från deras telemetri).
  const rowCount = transactionsDiv.querySelectorAll("tr").length;
  if (rowCount === lastExpandRowCount) return;
  // OBS: positionsbaserad, går sönder om bankens markup ändras
  const button = transactionsDiv.lastChild?.lastChild?.lastChild;
  if (typeof button?.click !== "function") return;
  lastExpandRowCount = rowCount;
  button.click();
}

function getCosts(transactionsDiv) {
  const costs = [];
  for (const row of transactionsDiv.querySelectorAll("tr")) {
    const nameCell = row.children[1];
    const amountCell = row.children[2];
    if (!nameCell || !amountCell) continue;

    const amount = parseAmount(amountCell.innerText);
    if (isNaN(amount) || amount >= 0) continue;

    const name = readName(nameCell);
    if (!name) continue;
    if (isIgnored(name)) continue;

    costs.push({ name, key: keyOf(name), amount: -amount, row, nameCell });
  }
  return costs;
}

// key -> { label, sum, count }
function sumByKey(costs) {
  const stats = new Map();
  for (const { name, key, amount } of costs) {
    const s = stats.get(key) ?? { label: name, sum: 0, count: 0 };
    s.sum += amount;
    s.count++;
    stats.set(key, s);
  }
  return stats;
}

// ---------- Tiny DOM helper (textContent only, never innerHTML) ----------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value);
  }
  el.append(...children);
  return el;
}

// ---------- Färger: samma kategori får alltid samma nyans ----------

function hue(cat) {
  let n = 0;
  for (const ch of cat) n = (n * 31 + ch.codePointAt(0)) % 360;
  return n;
}

function catColor(cat) {
  return cat === UNCATEGORIZED ? "#e3000b" : `hsl(${hue(cat)} 65% 48%)`;
}

// ---------- Styles ----------

const style = document.createElement("style");
style.textContent = `
  .ib-summary { display:flex; align-items:center; gap:10px; margin:8px 0; flex-wrap:wrap; }
  .ib-finance { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:8px 10px; background:#f7f7f7; border-radius:8px; }
  .ib-salary { width:130px; min-width:110px; }
  .ib-remaining { font-weight:700; }
  .ib-export { background:#333; }
  .ib-export:hover { filter:brightness(1.12); }
  .ib-btn { padding:6px 14px; border:0; border-radius:6px; background:#e3000b; color:#fff; font-weight:600; cursor:pointer; }
  .ib-btn.ib-ghost { background:#eee; color:#222; }
  .ib-btn[disabled] { opacity:.4; cursor:default; }
  .ib-overlay { position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:2147483647; display:flex; align-items:center; justify-content:center; }
  .ib-card { background:#fff; color:#222; width:min(640px, 94vw); max-height:85vh; overflow:auto; border-radius:12px; padding:24px; font:15px/1.4 system-ui, sans-serif; }
  .ib-card h2 { margin:6px 0; font-size:22px; }
  .ib-muted { color:#666; font-size:13px; }
  .ib-chips { display:flex; flex-wrap:wrap; gap:8px; margin:16px 0; }
  .ib-chip { padding:8px 14px; border:1px solid #ccc; border-radius:999px; background:#fafafa; cursor:pointer; font-size:14px; }
  .ib-chip:hover, .ib-chip.ib-on { background:#e3000b; color:#fff; border-color:#e3000b; }
  .ib-row { display:flex; gap:8px; margin-top:16px; flex-wrap:wrap; }
  .ib-input { flex:1; padding:6px 10px; border:1px solid #ccc; border-radius:6px; font-size:14px; }

  /* Badge (både på bankens rader och i summeringen) */
  .ib-badge { position:relative; display:inline-flex; align-items:center; margin-left:8px; padding:1px 9px; border-radius:999px; font:600 12px/1.7 system-ui, sans-serif; white-space:nowrap; vertical-align:middle; cursor:pointer; background:hsl(var(--ib-hue) 70% 93%); color:hsl(var(--ib-hue) 60% 26%); border:1px solid hsl(var(--ib-hue) 55% 78%); transition:filter .15s, box-shadow .15s; }
  .ib-badge:hover { filter:brightness(.96); box-shadow:0 1px 3px rgba(0,0,0,.15); }
  .ib-badge::after { content:"▾"; margin-left:5px; font-size:10px; opacity:.55; }
  .ib-badge.ib-empty { background:transparent; color:#e3000b; border:1px dashed #e3000b; }
  .ib-badge-select { position:absolute; inset:0; width:100%; height:100%; opacity:0; cursor:pointer; font-size:14px; }

  /* Summeringsdialog */
  .ib-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
  .ib-hint { margin:10px 0 14px; padding:8px 12px; background:#f6f6f6; border-radius:8px; color:#555; font-size:13px; }
  .ib-cat { border:1px solid #e5e5e5; border-radius:10px; margin:8px 0; overflow:hidden; }
  .ib-cat > summary { list-style:none; cursor:pointer; padding:12px 14px; user-select:none; }
  .ib-cat > summary::-webkit-details-marker { display:none; }
  .ib-cat > summary:hover { background:#f7f7f7; }
  .ib-cat[open] > summary { background:#fafafa; border-bottom:1px solid #eee; }
  .ib-cat-head { display:flex; align-items:center; gap:10px; }
  .ib-chev { display:inline-block; width:14px; font-size:18px; line-height:1; color:#888; transition:transform .15s; }
  .ib-cat[open] .ib-chev { transform:rotate(90deg); }
  .ib-dot { width:10px; height:10px; border-radius:50%; flex:none; }
  .ib-cat-name { flex:1; font-weight:600; }
  .ib-cat-name small { font-weight:400; color:#888; margin-left:6px; }
  .ib-cat-sum { font-weight:700; font-variant-numeric:tabular-nums; }
  .ib-bar { height:6px; background:#eee; border-radius:3px; margin-top:8px; }
  .ib-bar > div { height:100%; border-radius:3px; }
  .ib-items { padding:4px 0; }
  .ib-item { display:flex; align-items:center; gap:10px; padding:7px 14px 7px 38px; font-size:14px; }
  .ib-item:hover { background:#fafafa; }
  .ib-item-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ib-item-meta { color:#888; font-size:12px; white-space:nowrap; }
  .ib-item-sum { width:96px; text-align:right; font-variant-numeric:tabular-nums; }
  .ib-item .ib-badge { margin-left:0; }
`;
document.head.append(style);

// ---------- Kategori-badge ----------

function buildOptions(select) {
  const sig = categories.join("|");
  if (select.dataset.sig === sig) return;
  select.dataset.sig = sig;
  select.replaceChildren(
    h("option", { value: "" }, "Ingen kategori"),
    ...categories.map((c) => h("option", { value: c }, c)),
    h("option", { value: NEW_CATEGORY }, "+ Ny kategori…"),
  );
}

// En klickbar pill. Den osynliga <select>:en ligger ovanpå så att pillen
// är exakt så bred som texten, men man får ändå den vanliga dropdownen.
function makeBadge(onPick) {
  const label = h("span", { class: "ib-badge-label" });
  const select = h("select", { class: "ib-badge-select", title: "Byt kategori" });
  const el = h("span", { class: "ib-badge" }, label, select);

  select.addEventListener("change", () => {
    if (select.value === NEW_CATEGORY) {
      const value = prompt("Ny kategori:")?.trim();
      if (value) {
        addCategory(value);
        onPick(value);
      } else {
        select.value = el.dataset.cat ?? ""; // ångra valet
      }
      return;
    }
    onPick(select.value);
  });
  el.addEventListener("click", (e) => e.stopPropagation()); // bankens rad-klick ska inte triggas
  return el;
}

function updateBadge(el, cat) {
  const label = el.firstChild;
  const select = el.lastChild;
  buildOptions(select);
  const value = cat ?? "";
  if (select.value !== value) select.value = value;
  el.dataset.cat = value;
  const text = cat || "Välj kategori";
  if (label.textContent !== text) label.textContent = text;
  el.classList.toggle("ib-empty", !cat);
  if (cat) el.style.setProperty("--ib-hue", hue(cat));
}

function setCategory(key, category) {
  if (category) mapping[key] = category;
  else delete mapping[key];
  save();
  refresh();
}

// Badge till höger om namnet, inuti namncellen
function syncRowBadge(cost) {
  let badge = cost.nameCell.querySelector(":scope .ib-badge");
  if (!badge) {
    badge = makeBadge((cat) => setCategory(badge.dataset.key, cat));
    cost.nameCell.append(badge);
  }
  badge.dataset.key = cost.key;
  updateBadge(badge, mapping[cost.key]);
}

// ---------- Categorize modal ----------

let card = null;
let stats = new Map();
let queue = [];
let step = 0;
const openCats = new Set(); // vilka kategorier som är expanderade i summeringen

function closeModal() {
  document.getElementById("ib-overlay")?.remove();
  card = null;
}

function openModal() {
  closeModal();
  const transactionsDiv = document.getElementById("transactions");
  stats = transactionsDiv ? sumByKey(getCosts(transactionsDiv)) : new Map();

  const overlay = h("div", {
    id: "ib-overlay",
    class: "ib-overlay",
    onclick: (e) => {
      if (e.target === overlay) closeModal();
    },
  });
  card = h("div", { class: "ib-card" });
  overlay.append(card);
  document.body.append(overlay);

  if (stats.size === 0) {
    card.append(
      h("p", {}, "Inga kostnader hittades."),
      h("button", { class: "ib-btn", onclick: closeModal }, "Stäng"),
    );
    return;
  }

  startQueue([...stats.keys()].filter((k) => !mapping[k]));
}

function startQueue(keys) {
  queue = keys.sort((a, b) => stats.get(b).sum - stats.get(a).sum);
  step = 0;
  renderStep();
}

function assign(key, category) {
  mapping[key] = category;
  save();
  refresh();
  step++;
  renderStep();
}

function renderStep() {
  if (step >= queue.length) return renderSummary();

  const key = queue[step];
  const s = stats.get(key);

  const input = h("input", { class: "ib-input", placeholder: "Ny kategori…" });
  const addNew = () => {
    const value = input.value.trim();
    if (!value) return;
    addCategory(value);
    assign(key, value);
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") addNew();
  });

  card.replaceChildren(
    h("div", { class: "ib-muted" }, `${step + 1} / ${queue.length}`),
    h("h2", {}, s.label),
    h("div", { class: "ib-muted" }, `${s.count} köp, totalt ${sek.format(s.sum)}`),
    h(
      "div",
      { class: "ib-chips" },
      ...categories.map((c) =>
        h(
          "button",
          {
            class: "ib-chip" + (mapping[key] === c ? " ib-on" : ""),
            onclick: () => assign(key, c),
          },
          c,
        ),
      ),
    ),
    h(
      "div",
      { class: "ib-row" },
      input,
      h("button", { class: "ib-btn", onclick: addNew }, "Lägg till"),
    ),
    h(
      "div",
      { class: "ib-row" },
      h(
        "button",
        {
          class: "ib-btn ib-ghost",
          ...(step === 0 ? { disabled: "" } : {}),
          onclick: () => {
            step = Math.max(0, step - 1);
            renderStep();
          },
        },
        "Tillbaka",
      ),
      h(
        "button",
        {
          class: "ib-btn ib-ghost",
          onclick: () => {
            step++;
            renderStep();
          },
        },
        "Hoppa över",
      ),
      h("button", { class: "ib-btn ib-ghost", onclick: renderSummary }, "Visa summering"),
    ),
  );
}

// Byt kategori på en rad i summeringen: spara, uppdatera sidan, rita om dialogen
function moveItem(key, category) {
  setCategory(key, category);
  if (card) renderSummary();
}

function renderSummary() {
  const scroll = card.scrollTop;

  const totals = new Map(); // category -> { sum, items: [{ key, label, sum, count }] }
  let grand = 0;
  for (const [key, s] of stats) {
    const cat = mapping[key] || UNCATEGORIZED;
    const t = totals.get(cat) ?? { sum: 0, items: [] };
    t.sum += s.sum;
    t.items.push({ key, ...s });
    totals.set(cat, t);
    grand += s.sum;
  }

  const sorted = [...totals.entries()].sort((a, b) => b[1].sum - a[1].sum);
  const allOpen = sorted.length > 0 && sorted.every(([cat]) => openCats.has(cat));

  const rows = sorted.map(([cat, t]) => {
    const pct = grand > 0 ? (t.sum / grand) * 100 : 0;
    const color = catColor(cat);

    const items = t.items
      .sort((a, b) => b.sum - a.sum)
      .map((item) => {
        const badge = makeBadge((c) => moveItem(item.key, c));
        updateBadge(badge, mapping[item.key]);
        return h(
          "div",
          { class: "ib-item" },
          h("span", { class: "ib-item-name", title: item.label }, item.label),
          h("span", { class: "ib-item-meta" }, `${item.count} köp`),
          h("span", { class: "ib-item-sum" }, sek.format(item.sum)),
          badge,
        );
      });

    return h(
      "details",
      {
        class: "ib-cat",
        ...(openCats.has(cat) ? { open: "" } : {}),
        ontoggle: (e) => {
          if (e.target.open) openCats.add(cat);
          else openCats.delete(cat);
        },
      },
      h(
        "summary",
        {},
        h(
          "div",
          { class: "ib-cat-head" },
          h("span", { class: "ib-chev" }, "›"),
          h("span", { class: "ib-dot", style: `background:${color}` }),
          h(
            "span",
            { class: "ib-cat-name" },
            cat,
            h(
              "small",
              {},
              `${t.items.length} ${t.items.length === 1 ? "sort" : "sorter"} · ${Math.round(pct)} %`,
            ),
          ),
          h("span", { class: "ib-cat-sum" }, sek.format(t.sum)),
        ),
        h("div", { class: "ib-bar" }, h("div", { style: `width:${pct}%; background:${color}` })),
      ),
      h("div", { class: "ib-items" }, ...items),
    );
  });

  const uncategorized = [...stats.keys()].filter((k) => !mapping[k]);

  card.replaceChildren(
    h(
      "div",
      { class: "ib-head" },
      h(
        "div",
        {},
        h("h2", {}, "Summering"),
        h("div", { class: "ib-muted" }, `Totalt ${sek.format(grand)}`),
      ),
      h(
        "button",
        {
          class: "ib-btn ib-ghost",
          onclick: () => {
            if (allOpen) openCats.clear();
            else sorted.forEach(([cat]) => openCats.add(cat));
            renderSummary();
          },
        },
        allOpen ? "Fäll ihop alla" : "Expandera alla",
      ),
    ),
    ...rows,
    h(
      "div",
      { class: "ib-row" },
      ...(uncategorized.length
        ? [
            h(
              "button",
              { class: "ib-btn", onclick: () => startQueue(uncategorized) },
              "Kategorisera resten",
            ),
          ]
        : []),
      h(
        "button",
        { class: "ib-btn ib-ghost", onclick: () => startQueue([...stats.keys()]) },
        "Kategorisera om allt",
      ),
      h("button", { class: "ib-btn ib-ghost", onclick: closeModal }, "Stäng"),
    ),
  );

  card.scrollTop = scroll;
}

// ---------- Export: skapa en riktig XLSX-fil utan externa bibliotek ----------

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnName(n) {
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

// Cellstilar: index motsvarar <xf> i stylesXml() nedan
const STYLE = { header: 1, cur: 2, pct: 3, title: 4 };
const hdr = (v) => ({ v, s: "header" });
const cur = (v) => ({ v, s: "cur" });
const pct = (v) => ({ v, s: "pct" });
const title = (v) => ({ v, s: "title" });

function worksheetXml(rows, widths = []) {
  const cols = widths.length
    ? `<cols>${widths
        .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
        .join("")}</cols>`
    : "";
  const body = rows
    .map((row, ri) => {
      const cells = row
        .map((cell, ci) => {
          const styled = cell && typeof cell === "object";
          const value = styled ? cell.v : cell;
          const sid = styled ? (STYLE[cell.s] ?? 0) : 0;
          const sAttr = sid ? ` s="${sid}"` : "";
          const ref = `${columnName(ci + 1)}${ri + 1}`;
          if (typeof value === "number" && Number.isFinite(value)) {
            return `<c r="${ref}"${sAttr}><v>${value}</v></c>`;
          }
          return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData></worksheet>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00\ &quot;kr&quot;"/></numFmts>
<fonts count="3">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE3000B"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
</styleSheet>`;
}

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}

function makeZip(files) {
  const enc = new TextEncoder();
  const localParts = [],
    centralParts = [];
  let offset = 0;
  const u16 = (n) => [n & 255, (n >>> 8) & 255];
  const u32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  const join = (parts) => {
    const length = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(length);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };

  for (const [name, content] of Object.entries(files)) {
    const filename = enc.encode(name),
      data = enc.encode(content),
      crc = crc32(data);
    const local = join([
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      new Uint8Array(u16(20)),
      new Uint8Array(u16(0)),
      new Uint8Array(u16(0)),
      new Uint8Array(u16(0)),
      new Uint8Array(u16(0)),
      new Uint8Array(u32(crc)),
      new Uint8Array(u32(data.length)),
      new Uint8Array(u32(data.length)),
      new Uint8Array(u16(filename.length)),
      new Uint8Array(u16(0)),
      filename,
      data,
    ]);
    localParts.push(local);
    const central = join([
      new Uint8Array([0x50, 0x4b, 0x01, 0x02]),
      new Uint8Array(u16(20)),
      new Uint8Array(u16(20)),
      new Uint8Array(u16(0)),
      new Uint8Array(u16(0)),
      new Uint8Array(u16(0)),
      new Uint8Array(u16(0)),
      new Uint8Array(u32(crc)),
      new Uint8Array(u32(data.length)),
      new Uint8Array(u32(data.length)),
      new Uint8Array(u16(filename.length)),
      new Uint8Array(u16(0)),
      new Uint8Array(u16(0)),
      new Uint8Array(u16(0)),
      new Uint8Array(u16(0)),
      new Uint8Array(u32(0)),
      new Uint8Array(u32(offset)),
      filename,
    ]);
    centralParts.push(central);
    offset += local.length;
  }
  const centralData = join(centralParts);
  const end = join([
    new Uint8Array([0x50, 0x4b, 0x05, 0x06]),
    new Uint8Array(u16(0)),
    new Uint8Array(u16(0)),
    new Uint8Array(u16(centralParts.length)),
    new Uint8Array(u16(centralParts.length)),
    new Uint8Array(u32(centralData.length)),
    new Uint8Array(u32(offset)),
    new Uint8Array(u16(0)),
  ]);
  return join([...localParts, centralData, end]);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

// Bygger raderna en gång, används av både Excel- och Sheets-exporten
function buildExportData() {
  const transactionsDiv = document.getElementById("transactions");
  const costs = transactionsDiv ? getCosts(transactionsDiv) : [];
  const stats = sumByKey(costs);
  const total = costs.reduce((sum, c) => sum + c.amount, 0);
  const remaining = salary - total;

  const categoryTotals = new Map();
  for (const [key, item] of stats) {
    const cat = mapping[key] || UNCATEGORIZED;
    const current = categoryTotals.get(cat) || { sum: 0, count: 0 };
    current.sum += item.sum;
    current.count += item.count;
    categoryTotals.set(cat, current);
  }

  const categoriesRows = [
    [hdr("Kategori"), hdr("Summa"), hdr("Andel av utgifter"), hdr("Antal köp")],
  ];
  for (const [cat, item] of [...categoryTotals.entries()].sort((a, b) => b[1].sum - a[1].sum)) {
    categoriesRows.push([cat, cur(item.sum), pct(total ? item.sum / total : 0), item.count]);
  }

  const transactionRows = [
    [hdr("Butik / mottagare"), hdr("Kategori"), hdr("Belopp"), hdr("Normaliserad nyckel")],
  ];
  for (const item of costs) {
    transactionRows.push([
      item.name,
      mapping[item.key] || UNCATEGORIZED,
      cur(item.amount),
      item.key,
    ]);
  }

  const overviewRows = [
    [title("ICA Banken – privatekonomi")],
    ["Exporterad", new Date().toLocaleString("sv-SE")],
    ["Nettolön", cur(salary)],
    ["Totala utgifter", cur(total)],
    ["Kvar efter utgifter", cur(remaining)],
    ["Andel av lön spenderad", pct(salary > 0 ? total / salary : 0)],
    ["Antal kostnadstransaktioner", costs.length],
  ];

  return { overviewRows, categoriesRows, transactionRows };
}

function exportWorkbook() {
  const { overviewRows, categoriesRows, transactionRows } = buildExportData();
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Översikt" sheetId="1" r:id="rId1"/><sheet name="Kategorier" sheetId="2" r:id="rId2"/><sheet name="Transaktioner" sheetId="3" r:id="rId3"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    "xl/styles.xml": stylesXml(),
    "xl/worksheets/sheet1.xml": worksheetXml(overviewRows, [32, 22]),
    "xl/worksheets/sheet2.xml": worksheetXml(categoriesRows, [24, 18, 20, 12]),
    "xl/worksheets/sheet3.xml": worksheetXml(transactionRows, [38, 20, 18, 30]),
  };
  const bytes = makeZip(files);
  downloadBlob(
    new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    `ica-banken-${new Date().toISOString().slice(0, 10)}.xlsx`,
  );
}

// ---------- Export: Google Sheets via urklipp (TSV) ----------

// Tal med decimalkomma, annars tolkar ett svenskt Sheets-ark "12.5" som text/datum
function tsvCell(cell) {
  const styled = cell && typeof cell === "object";
  const value = styled ? cell.v : cell;
  if (typeof value === "number" && Number.isFinite(value)) {
    // Procent som text ("54%") tolkas av Sheets som procent-format
    if (styled && cell.s === "pct") return `${Math.round(value * 100)}%`;
    return String(Math.round(value * 10000) / 10000).replace(".", ",");
  }
  return String(value ?? "").replace(/[\t\r\n]+/g, " ");
}

function toTsv(blocks) {
  return blocks
    .map((rows) => rows.map((row) => row.map(tsvCell).join("\t")).join("\n"))
    .join("\n\n");
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback om Clipboard API nekas på sidan
    const ta = h("textarea", { style: "position:fixed;opacity:0;top:0;left:0" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {}
    ta.remove();
    return ok;
  }
}

function toast(message) {
  const el = h(
    "div",
    {
      style:
        "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483647;" +
        "background:#222;color:#fff;padding:12px 18px;border-radius:8px;font:14px system-ui,sans-serif;",
    },
    message,
  );
  document.body.append(el);
  setTimeout(() => el.remove(), 10000);
}

async function exportForGoogleSheets() {
  const { overviewRows, categoriesRows } = buildExportData();
  const tsv = toTsv([overviewRows, categoriesRows]); // transaktionerna tas inte med i Sheets

  // 1) Urklipp som reserv: Ctrl+V fungerar alltid om auto-inklistringen skulle misslyckas
  const copied = await copyText(tsv);

  // 2) Lämna över datan till sheets.js, som klistrar in när det nya arket laddats
  try {
    await chrome.storage.local.set({ pendingSheetsPaste: { tsv, ts: Date.now() } });
  } catch (err) {
    console.error("[ICA budget] Kunde inte lämna över till Sheets:", err);
    if (!copied) {
      exportWorkbook(); // sista reservlösning: ladda ner filen
      toast(
        "Kunde varken klistra in eller kopiera. Excel-filen laddades ner: importera den i Sheets via Arkiv → Importera.",
      );
      return;
    }
  }

  window.open("https://sheets.new", "_blank", "noopener");
  toast(
    "Öppnar nytt Google Sheets-ark och klistrar in datan automatiskt. " +
      (copied ? "Om arket förblir tomt: klicka i cell A1 och tryck Ctrl+V." : ""),
  );
}

// ---------- Summary line + rader ----------

function refresh() {
  if (!loaded) return;
  const transactionsDiv = document.getElementById("transactions");
  if (!transactionsDiv) return;
  expandAllRows();

  let summary = document.getElementById("summary");
  if (!summary) {
    summary = h(
      "div",
      { id: "summary", class: "ib-summary" },
      h("span", { id: "ib-total" }),
      h("button", { id: "ib-sum-btn", class: "ib-btn", onclick: openModal }, "Summera"),
      h(
        "div",
        { class: "ib-finance" },
        h("label", { for: "ib-salary-input" }, "Nettolön (kr)"),
        h("input", {
          id: "ib-salary-input",
          class: "ib-input ib-salary",
          type: "number",
          min: "0",
          step: "0.01",
          placeholder: "Ange nettolön",
        }),
        h("strong", { id: "ib-remaining", class: "ib-remaining" }, "Kvar: –"),
      ),
      h(
        "button",
        { class: "ib-btn ib-export", id: "ib-export-xlsx", onclick: exportWorkbook },
        "Exportera Excel",
      ),
      h(
        "button",
        { class: "ib-btn ib-export", id: "ib-export-sheets", onclick: exportForGoogleSheets },
        "Google Sheets",
      ),
    );
    transactionsDiv.insertBefore(summary, transactionsDiv.children[1] ?? null);
    const salaryInput = summary.querySelector("#ib-salary-input");
    salaryInput.value = salary || "";
    salaryInput.addEventListener("change", () => saveSalary(salaryInput.value));
    salaryInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") salaryInput.blur();
    });
  }

  const costs = getCosts(transactionsDiv);
  const costRows = new Set(costs.map((c) => c.row));
  for (const badge of transactionsDiv.querySelectorAll(".ib-badge")) {
    if (!costRows.has(badge.closest("tr"))) badge.remove();
  }
  costs.forEach(syncRowBadge);

  const total = costs.reduce((sum, c) => sum + c.amount, 0);
  const uncategorizedCount = costs.filter((c) => !mapping[c.key]).length;
  const label = summary.querySelector("#ib-total");
  const totalText = sek.format(total);
  if (label && label.dataset.v !== totalText) {
    label.dataset.v = totalText;
    label.replaceChildren("Utgifter: ", h("b", {}, totalText));
  }

  const btn = summary.querySelector("#ib-sum-btn");
  let btnText = `Summera`;
  if (uncategorizedCount > 0) btnText += ` (${uncategorizedCount})`;
  if (btn && btn.textContent !== btnText) btn.textContent = btnText;

  const salaryInput = summary.querySelector("#ib-salary-input");
  if (
    salaryInput &&
    document.activeElement !== salaryInput &&
    salaryInput.value !== (salary ? String(salary) : "")
  ) {
    salaryInput.value = salary || "";
  }
  const remainingLabel = summary.querySelector("#ib-remaining");
  const remaining = salary - total;
  if (remainingLabel) {
    const remainingText = "Kvar: " + sek.format(remaining);
    if (remainingLabel.textContent !== remainingText) remainingLabel.textContent = remainingText;
    remainingLabel.style.color = remaining >= 0 ? "#16803c" : "#e3000b";
  }
}
let scheduled = false;

function isOwnNode(node) {
  const el = node.nodeType === 1 ? node : node.parentElement;
  return !!el?.closest?.("#summary, #ib-overlay, .ib-badge");
}

const observer = new MutationObserver((mutations) => {
  // Ignorera ändringar som bara är våra egna (badges, summering, modal)
  const foreign = mutations.some(
    (m) => !isOwnNode(m.target) || [...m.addedNodes, ...m.removedNodes].some((n) => !isOwnNode(n)),
  );
  if (!foreign) return;
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    refresh();
  });
});
observer.observe(document.body, { childList: true, subtree: true });
