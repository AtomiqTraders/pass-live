// Builds the static website into dist/: the site/ folder plus the real overlay (demo mode) from public/.
import { cpSync, rmSync, mkdirSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true });
cpSync('site', 'dist', { recursive: true });
mkdirSync('dist/overlay/js', { recursive: true }); mkdirSync('dist/overlay/css', { recursive: true });
cpSync('public/overlay.html', 'dist/overlay/overlay.html');
cpSync('public/css/overlay.css', 'dist/overlay/css/overlay.css');
for (const f of ['overlay.js', 'derive.js', 'demo.js']) cpSync('public/js/' + f, 'dist/overlay/js/' + f);
console.log('Built dist/');
