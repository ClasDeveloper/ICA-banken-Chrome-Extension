// Körs på docs.google.com/spreadsheets/*. Klistrar in data som content.js lämnat i storage.

const MAX_AGE_MS = 2 * 60 * 1000; // ignorera gammal data så vi aldrig klistrar in oväntat
const GRID_SELECTOR = ".grid-container, #waffle-grid-container, .waffle";

function banner(message, { sticky = false } = {}) {
  document.getElementById("ib-sheets-banner")?.remove();
  const el = document.createElement("div");
  el.id = "ib-sheets-banner";
  el.style.cssText =
    "position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;" +
    "background:#222;color:#fff;padding:12px 16px;border-radius:8px;font:14px system-ui,sans-serif;" +
    "display:flex;gap:12px;align-items:center;max-width:90vw;box-shadow:0 4px 16px rgba(0,0,0,.3);";
  const text = document.createElement("span");
  text.textContent = message;
  const close = document.createElement("button");
  close.textContent = "×";
  close.style.cssText = "background:none;border:0;color:#fff;font-size:18px;cursor:pointer;";
  close.addEventListener("click", () => el.remove());
  el.append(text, close);
  document.body.append(el);
  if (!sticky) setTimeout(() => el.remove(), 8000);
}

function waitFor(selector, timeoutMs) {
  return new Promise((resolve) => {
    const found = document.querySelector(selector);
    if (found) return resolve(found);
    const t0 = Date.now();
    const timer = setInterval(() => {
      const el = document.querySelector(selector);
      if (el || Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        resolve(el);
      }
    }, 250);
  });
}

function pasteText(text) {
  const target = document.activeElement || document.body;
  const dt = new DataTransfer();
  dt.setData("text/plain", text);
  const event = new ClipboardEvent("paste", {
    clipboardData: dt,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
}

async function run() {
  const { pendingSheetsPaste } = await chrome.storage.local.get("pendingSheetsPaste");
  if (!pendingSheetsPaste) return;
  // Förbruka direkt så att en omladdning av arket inte klistrar in igen
  await chrome.storage.local.remove("pendingSheetsPaste");
  if (Date.now() - pendingSheetsPaste.ts > MAX_AGE_MS) return;

  banner("Klistrar in data från ICA Banken…", { sticky: true });

  const grid = await waitFor(GRID_SELECTOR, 20000);
  if (!grid) {
    banner(
      "Arket laddades inte i tid. Klicka i cell A1 och tryck Ctrl+V (datan ligger i urklipp).",
      {
        sticky: true,
      },
    );
    return;
  }

  // Ge Sheets en stund att sätta fokus och markera A1 i ett nytt ark
  await new Promise((r) => setTimeout(r, 1500));
  pasteText(pendingSheetsPaste.tsv);

  // Vi kan inte läsa av arkets canvas, så vi kan inte veta säkert att det gick igenom
  banner(
    "Försökte klistra in automatiskt. Ser arket tomt ut: klicka i cell A1 och tryck Ctrl+V (datan ligger i urklipp).",
    { sticky: true },
  );
}

run().catch((err) => console.error("[ICA budget] Sheets-inklistring misslyckades:", err));
