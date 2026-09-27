// page-download.js — run this IN THE BROWSER, once, in a NEW TAB opened on the site where you ran
// page-capture.js (any page of that site: its home page is fine).
//
// Saves every product captured on that site as ONE file, `product-captures-<site>.json`, in the browser's
// downloads folder. Give that file to import-fetch.mjs --page.
//
// Why a new tab: browsers allow a tab ONE automatic download and silently block the rest — clicks sent by a
// browser tool included (measured). A fresh tab's first download always goes through, and it sees the same
// captures, because they are kept in the site's storage, not in the tab.
//
// The captures stay in this browser afterwards, so a lost download can simply be repeated. To clear them
// once the file is safe, change the line below to `const CLEAR = true;` and run this again.

(() => {
  const CLEAR = false;
  const STORE = 'codbrand-tools:captures';
  if (CLEAR) { localStorage.removeItem(STORE); return { ok: true, cleared: true }; }
  let all = {};
  try { all = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { all = {}; }
  const captures = Object.values(all);
  if (!captures.length) return { ok: false, reason: 'Nothing captured on this site yet. Run page-capture.js on each product page first.' };
  const name = `product-captures-${location.host.replace(/[^0-9A-Za-z.-]/g, '')}.json`;
  const payload = { kind: 'page-captures/1', site: location.host, saved_at: new Date().toISOString(), captures };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: 'application/json' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return { ok: true, file: name, products: captures.length,
    check: `Confirm ${name} (the browser may add " (1)") is in the downloads folder. If not, open another new tab on this site and run this again.` };
})();
