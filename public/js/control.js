const $ = (id) => document.getElementById(id);
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function load() {
  try {
    const d = await (await fetch('/api/accounts')).json(), st = $('status');
    st.textContent = d.stream.error ? 'Key problem: ' + d.stream.error : d.mode === 'demo' ? 'Demo mode (no API key)' : d.stream.connected ? `Connected · ${d.mode}` : 'Connecting to MyFundedPerps…';
    st.className = 'status ' + (d.stream.error ? 'bad' : d.stream.connected ? 'ok' : '');
    const sel = $('account'), keep = sel.value;
    sel.innerHTML = d.accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.name)} · ${esc(a.status)}</option>`).join('') || '<option value="">No accounts yet</option>';
    if (keep && d.accounts.some((a) => a.id === keep)) sel.value = keep;
    update();
  } catch { $('status').textContent = 'App not running'; $('status').className = 'status bad'; }
}
function update() {
  const p = new URLSearchParams();
  const D = { layout: 'card', corner: 'left', pos: 'bottom', theme: 'dark', scale: '1' };
  for (const k of Object.keys(D)) if ($(k).value !== D[k]) p.set(k, $(k).value);
  if ($('account').value) p.set('account', $('account').value);
  const url = `${location.origin}/overlay${p.toString() ? '?' + p : ''}`;
  $('url').textContent = url;
  const f = $('frame'); if (f.dataset.src !== url) { f.dataset.src = url; f.src = url; }
  fit();
}
function fit() { const s = $('frame').parentElement.clientWidth / 1920; $('frame').style.transform = `scale(${s})`; }
$('opts').addEventListener('change', update);
window.addEventListener('resize', fit);
$('copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('url').textContent); $('copied').textContent = 'Copied. Paste it into the Browser Source URL.'; } catch { $('copied').textContent = 'Select the URL and copy it.'; } });
load(); setInterval(load, 5000);
