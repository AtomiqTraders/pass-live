// OS tabs: pick the visitor's system by default
const tabs = [...document.querySelectorAll('[data-os]')];
function showOS(os) { for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.os === os)); for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== os; }
tabs.forEach((t) => t.addEventListener('click', () => showOS(t.dataset.os)));
const ua = navigator.userAgent; showOS(/Windows/i.test(ua) ? 'win' : /Mac OS X/i.test(ua) && !/iPhone|iPad/.test(ua) ? 'mac' : /Linux|X11/i.test(ua) && !/Android/i.test(ua) ? 'linux' : 'win');

// live overlay demo
const f = document.getElementById('d-frame');
function fit() { f.style.transform = `scale(${f.parentElement.clientWidth / 1920})`; }
function update() {
  const p = new URLSearchParams('demo&from=20');
  for (const k of ['layout', 'theme', 'corner']) { const v = document.getElementById('d-' + k).value; if (!['card', 'dark', 'left'].includes(v)) p.set(k, v); }
  f.src = 'overlay/overlay.html?' + p.toString().replace('demo=', 'demo');
}
document.querySelectorAll('.demo-controls select').forEach((s) => s.addEventListener('change', update));
window.addEventListener('resize', fit); fit();
