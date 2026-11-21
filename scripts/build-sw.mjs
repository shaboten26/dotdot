import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const distDir = path.resolve('dist')
if (!fs.existsSync(distDir)) {
  process.exit(0)
}

function collectFiles(dir, prefix = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  let results = []
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results = results.concat(collectFiles(full, rel))
    } else if (entry.name !== 'sw.js') {
      results.push(`/${rel}`)
    }
  }
  return results
}

const assetUrls = ['/', ...collectFiles(distDir).sort()]
const uniqueUrls = Array.from(new Set(assetUrls))
const hash = crypto
  .createHash('sha256')
  .update(uniqueUrls.join('|'))
  .digest('hex')
  .slice(0, 12)

const swSource = `/* dotdot Offline-First PWA Service Worker (Preserves IndexedDB across updates) */
const CACHE_NAME = 'dotdot-pwa-${hash}';
const PRECACHE_URLS = ${JSON.stringify(uniqueUrls, null, 2)};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key.startsWith('dotdot-pwa-') && key !== CACHE_NAME) {
            return caches.delete(key);
          }
          return Promise.resolve();
        })
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // SPA Navigation fallback: serve cached /index.html offline for /editor/*, /project/*, /settings, /
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html').then((cached) => cached || caches.match('/')))
    );
    return;
  }

  // Cache-first for hashed fonts, icons, JS, CSS, manifest; background revalidate
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      });
    })
  );
});
`

fs.writeFileSync(path.join(distDir, 'sw.js'), swSource, 'utf8')
console.log(`Generated offline Service Worker dist/sw.js (${uniqueUrls.length} precached files, rev=${hash})`)
