// 改了任何程式檔後，把版本號加一，手機才會更新到新版
const VERSION = 'v2';
const SHELL = `shell-${VERSION}`;
const IMAGES = 'images';

const SHELL_FILES = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.json',
  'sample-recipes.csv',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== IMAGES).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 食譜圖片：先用快取，離線也看得到
  if (req.destination === 'image' && url.origin !== location.origin) {
    e.respondWith(
      caches.open(IMAGES).then(async c => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') c.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  // 程式本體：先用快取（秒開），背景再更新
  if (url.origin === location.origin && !url.search.includes('_=')) {
    e.respondWith(
      caches.open(SHELL).then(async c => {
        const hit = await c.match(req, { ignoreSearch: true });
        const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
        return hit || net;
      })
    );
  }
  // 試算表資料由 app.js 自己處理（失敗就用 localStorage 裡上次的資料）
});
