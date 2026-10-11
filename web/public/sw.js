// KRATOS service worker: the app opens, and a workout carries on, without a connection.
// - Pages: network first, the cached app shell offline (every route is the same index.html).
// - Built assets (content-hashed) and the versioned pose model: cache first.
// - MediaPipe's wasm and GET /api: network first, the cached copy offline, so the plan and workout load in a dead zone.
// Writes are never cached: the app queues them itself (outbox in src/api.ts) and replays them when back online.
const SHELL = 'kratos-shell-v1'
const STATIC = 'kratos-static-v1'
const API = 'kratos-api-v1'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (![SHELL, STATIC, API].includes(k)) await caches.delete(k)
  await self.clients.claim()
})()))

async function networkFirst(name, req, key = req) {
  const cache = await caches.open(name)
  try {
    const res = await fetch(req)
    if (res.ok && res.type === 'basic') await cache.put(key, res.clone()) // never a login redirect
    return res
  } catch (err) {
    const hit = await cache.match(key)
    if (hit) return hit
    throw err
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(STATIC)
  const hit = await cache.match(req)
  if (hit) return hit
  const res = await fetch(req)
  if (res.ok) await cache.put(req, res.clone())
  return res
}

self.addEventListener('fetch', (e) => {
  const req = e.request
  const url = new URL(req.url)
  // Logging out, here or everywhere, drops cached personal data from this device.
  if (url.pathname === '/logout' || url.pathname === '/api/logout-everywhere') {
    e.waitUntil(caches.delete(API))
    return
  }
  if (req.method !== 'GET') return
  if (url.hostname === 'storage.googleapis.com' && url.pathname.includes('/mediapipe-models/')) return e.respondWith(cacheFirst(req))
  if (url.origin !== location.origin || url.pathname === '/login') return
  if (req.mode === 'navigate') return e.respondWith(networkFirst(SHELL, req, '/'))
  if (url.pathname.startsWith('/assets/')) return e.respondWith(cacheFirst(req))
  if (url.pathname.startsWith('/mediapipe/')) return e.respondWith(networkFirst(STATIC, req))
  if (url.pathname.startsWith('/api/') && url.pathname !== '/api/backup') return e.respondWith(networkFirst(API, req))
})
