/*
 * Aurethra's service worker: the game plays offline once it has been opened online one time.
 *
 * - On install it reads precache.json (written by the build, see vite.config.ts): every file the game needs, with a
 *   hash of its contents. It downloads only the files that are new or changed since the last version, so an update
 *   costs only what changed. Files that are no longer in the list are removed when the new version takes over.
 * - Pages (index.html, ?screen=top / bottom, the Thor app's URL): network first, so an update shows up when online;
 *   the cached page when offline.
 * - Everything else from this site: the cached copy, else the network (and it is kept for next time).
 * - Other sites (the cloud save, model downloads) are never touched.
 *
 * Saves are not affected: they live in localStorage and the cloud, not in this cache.
 */
const FILES = 'aurethra-files';
const META = 'aurethra-meta';
const scope = new URL(self.registration.scope);
const url = (rel) => new URL(rel, scope).href;

async function readManifest() {
  const res = await (await caches.open(META)).match('manifest');
  return res ? res.json() : { files: {} };
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const next = await (await fetch(url('precache.json'), { cache: 'no-store' })).json();
    const prev = await readManifest();
    const cache = await caches.open(FILES);
    const todo = Object.entries(next.files).filter(([rel, hash]) => prev.files[rel] !== hash);
    const got = { ...prev.files };
    // a few at a time, so a handheld's connection is not flooded; one failure does not stop the rest
    let i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const [rel, hash] = todo[i++];
        try {
          const res = await fetch(url(rel), { cache: 'reload' });
          if (res.ok) { await cache.put(url(rel), res); got[rel] = hash; }
        } catch { /* left for the next update, or fetched when first needed */ }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    // the pages must be there, or offline play cannot start
    if (!(await cache.match(url('index.html')))) throw new Error('index.html not cached');
    await (await caches.open(META)).put('pending', new Response(JSON.stringify({ build: next.build, files: next.files, got })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const meta = await caches.open(META);
    const pending = await meta.match('pending');
    if (pending) {
      const { build, files, got } = await pending.json();
      const cache = await caches.open(FILES);
      // drop what the new version no longer lists (old hashed bundles, removed art)
      const keep = new Set(Object.keys(files).map(url));
      for (const req of await cache.keys()) if (!keep.has(req.url.split('?')[0]) && !/\/assets\/(lib|localModel\.worker)-/.test(req.url)) await cache.delete(req);
      const have = Object.fromEntries(Object.entries(got).filter(([rel]) => rel in files));
      await meta.put('manifest', new Response(JSON.stringify({ build, files: have })));
      await meta.delete('pending');
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin !== scope.origin || !u.pathname.startsWith(scope.pathname)) return;
  if (u.pathname.endsWith('/sw.js') || u.pathname.endsWith('/precache.json')) return;
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(FILES)).put(u.origin + u.pathname, res.clone());
        return res;
      } catch {
        const cache = await caches.open(FILES);
        return (await cache.match(req, { ignoreSearch: true, ignoreVary: true })) ?? (await cache.match(url('index.html'), { ignoreVary: true })) ?? Response.error();
      }
    })());
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(FILES);
    // (ignoreVary: the page asks for its scripts with an Origin header, the copies were stored without one; servers
    // that send "Vary: Origin" would otherwise make every lookup miss, and offline every script fail)
    const hit = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && res.type === 'basic' && !req.headers.has('range')) cache.put(u.origin + u.pathname, res.clone());
    return res;
  })());
});
