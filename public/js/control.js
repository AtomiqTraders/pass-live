const $ = (id) => document.getElementById(id);
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let S = null, tplKind = 'buy', loadedForm = false;

async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Failed (${r.status})`);
  return j;
}

async function load() {
  try { S = await (await fetch('/api/status')).json(); render(); }
  catch { $('status').textContent = 'Pass Live is not running'; $('status').className = 'status bad'; }
}
function render() {
  const st = $('status');
  st.textContent = S.stream.error ? 'Problem: ' + S.stream.error : S.mode === 'demo' ? 'Demo mode: add your key in step 1' : S.stream.connected ? `Connected · ${S.mode}` : 'Connecting…';
  st.className = 'status ' + (S.stream.error ? 'bad' : S.mode === 'demo' ? '' : S.stream.connected ? 'ok' : '');
  $('key-state').innerHTML = S.key ? `Connected with <code>${esc(S.key)}</code> (${esc(S.mode)}). Paste a new key to switch.` : 'Not connected yet. The overlay is showing a demo account.';
  // account pickers
  for (const [id, keepAuto] of [['account', false], ['tv-account', true]]) {
    const sel = $(id), keep = sel.value;
    sel.innerHTML = (keepAuto ? '<option value="">Default (first active)</option>' : '') + S.accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.name)} · ${esc(a.status)}</option>`).join('');
    if (id === 'tv-account' && !loadedForm) sel.value = S.bridge.accountId || ''; else if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }
  const b = S.bridge;
  if (!loadedForm) { $('tv-enabled').checked = b.enabled; $('tv-max').value = b.maxOrderUsd; $('tv-lev').value = b.maxLeverage; $('tv-block').value = String(b.blockAt); $('tv-allowed').value = b.allowed; loadedForm = true; }
  $('tv-mode').textContent = b.enabled ? 'Live orders' : 'Dry run'; $('tv-mode').className = 'pill ' + (b.enabled ? 'live' : '');
  $('secret').textContent = b.secret; $('hook-port').textContent = S.hookPort;
  $('ngrok-cmd').textContent = `ngrok http --url=YOUR-DOMAIN.ngrok-free.app ${S.hookPort}`;
  $('cf-cmd').textContent = `cloudflared tunnel --url http://localhost:${S.hookPort}`;
  tpl();
  $('alerts').innerHTML = S.alerts.length ? S.alerts.map((a) => `<li class="${esc(a.status)}"><span class="t">${new Date(a.time).toLocaleTimeString()}</span><span class="s">${esc(a.status)}</span><span>${esc(a.text)}</span></li>`).join('') : '<li class="note">None yet.</li>';
  overlayUrl();
}

// ---------- alert templates ----------
const TPL = {
  buy: (s) => ({ text: `{"passphrase":"${s}","action":"buy","symbol":"{{ticker}}","usd":500,"price":{{close}},"sl":0,"id":"{{timenow}}"}`, note: 'Buys $500 worth at the alert price. Change usd, or use "size" for coins. Set "sl" (stop loss) and "tp" (take profit) prices, or remove them.' }),
  sell: (s) => ({ text: `{"passphrase":"${s}","action":"sell","symbol":"{{ticker}}","usd":500,"price":{{close}},"id":"{{timenow}}"}`, note: 'Sells (shorts) $500 worth. Add "sl" and "tp" prices if you want them attached.' }),
  close: (s) => ({ text: `{"passphrase":"${s}","action":"close","symbol":"{{ticker}}","id":"{{timenow}}"}`, note: 'Closes your open position on this symbol at market. "close_all" closes everything.' }),
  strategy: (s) => ({ text: `{"passphrase":"${s}","action":"{{strategy.order.action}}","symbol":"{{ticker}}","size":{{strategy.order.contracts}},"price":{{close}},"id":"{{strategy.order.id}}-{{timenow}}"}`, note: 'For Pine Script strategies: one alert on the strategy sends every buy and sell it makes, sized by the strategy.' }),
};
function tpl() { const t = TPL[tplKind](S ? S.bridge.secret : 'YOUR_PASSPHRASE'); $('tpl').textContent = t.text; $('tpl-note').textContent = t.note; }
document.querySelectorAll('[data-tpl]').forEach((b) => b.addEventListener('click', () => { tplKind = b.dataset.tpl; document.querySelectorAll('[data-tpl]').forEach((x) => x.setAttribute('aria-selected', String(x === b))); tpl(); }));

// ---------- overlay URL + preview ----------
function overlayUrl() {
  const D = { layout: 'card', corner: 'left', pos: 'bottom', theme: 'dark', scale: '1' }, p = new URLSearchParams();
  for (const k of Object.keys(D)) if ($(k).value !== D[k]) p.set(k, $(k).value);
  if ($('account').value) p.set('account', $('account').value);
  const url = `${location.origin}/overlay${p.toString() ? '?' + p : ''}`;
  $('url').textContent = url;
  const f = $('frame'); if (f.dataset.src !== url) { f.dataset.src = url; f.src = url; }
  fit();
}
function fit() { const f = $('frame'); f.style.transform = `scale(${f.parentElement.clientWidth / 1920})`; }
$('opts').addEventListener('change', overlayUrl);
window.addEventListener('resize', fit);

// ---------- actions ----------
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]'); if (!b) return;
  try { await navigator.clipboard.writeText($(b.dataset.copy).textContent); const old = b.textContent; b.textContent = 'Copied'; setTimeout(() => (b.textContent = old), 1200); } catch { b.textContent = 'Select and copy'; }
});
$('key-form').addEventListener('submit', async (e) => {
  e.preventDefault(); const k = $('key').value.trim(); if (!k) return;
  $('key-msg').textContent = 'Checking the key with MyFundedPerps…'; $('key-msg').className = 'msg';
  try { S = await post('/api/key', { key: k }); $('key').value = ''; $('key-msg').textContent = `Connected (${S.mode}). ${S.accounts.length} account(s) found.`; $('key-msg').className = 'msg ok'; loadedForm = false; render(); }
  catch (err) { $('key-msg').textContent = err.message; $('key-msg').className = 'msg bad'; }
});
// In-page confirmation. The browser's own confirm() pop-up is silently dismissed in
// some browsers (embedded panes, OBS docks), which made the switch untick itself.
function ask(text, yes = 'Yes') {
  return new Promise((done) => {
    const d = $('ask'); $('ask-text').textContent = text; $('ask-yes').textContent = yes;
    const end = (v) => { d.close(); $('ask-yes').onclick = $('ask-no').onclick = d.oncancel = null; done(v); };
    $('ask-yes').onclick = () => end(true); $('ask-no').onclick = () => end(false); d.oncancel = (e) => { e.preventDefault(); end(false); };
    d.showModal(); $('ask-no').focus();
  });
}
// the real-orders switch saves straight away, so it can't be left half-changed
$('tv-enabled').addEventListener('change', () => $('tv-form').requestSubmit());
$('tv-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const enabled = $('tv-enabled').checked;
  if (enabled && !S.bridge.enabled && !(await ask(`Send REAL orders from TradingView alerts to your ${S.mode} account? Max order $${$('tv-max').value}, ${$('tv-lev').value}x leverage. You can switch back to dry run any time.`, 'Yes, send real orders'))) { $('tv-enabled').checked = false; $('tv-msg').textContent = 'Still in dry run.'; $('tv-msg').className = 'msg'; return; }
  try {
    S = await post('/api/bridge', { enabled, accountId: $('tv-account').value, maxOrderUsd: +$('tv-max').value, maxLeverage: +$('tv-lev').value, blockAt: +$('tv-block').value, allowed: $('tv-allowed').value });
    $('tv-msg').textContent = enabled ? 'Saved. Alerts now send real orders.' : 'Saved. Dry run: alerts are checked but nothing is sent.'; $('tv-msg').className = 'msg ok'; render();
  } catch (err) { $('tv-msg').textContent = err.message; $('tv-msg').className = 'msg bad'; }
});
$('new-secret').addEventListener('click', async () => {
  if (!(await ask('Make a new passphrase? Alerts using the old one will stop working until you update them in TradingView.', 'Make a new one'))) return;
  S = await post('/api/bridge', { newSecret: true }); render();
});
$('test-alert').addEventListener('click', async () => {
  const body = JSON.parse($('tpl').textContent.replace(/\{\{ticker\}\}/g, 'BTCUSDT').replace(/\{\{close\}\}/g, '0').replace(/\{\{strategy\.order\.action\}\}/g, 'buy').replace(/\{\{strategy\.order\.contracts\}\}/g, '0.001').replace(/\{\{[^}]+\}\}/g, 'test'));
  if (body.price === 0) delete body.price;
  try { const r = await post('/api/test-alert', body); S = r.status; render(); }
  catch (err) { $('tv-msg').textContent = err.message; $('tv-msg').className = 'msg bad'; }
});

load(); setInterval(load, 4000);
