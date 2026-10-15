// Saves projects (JSON) and their files (Blobs) in this browser's IndexedDB.
// Nothing is uploaded anywhere. The API key is never stored here (see vault.js).

export function openStore(name = 'mvmaker-projects') {
  if (typeof indexedDB === 'undefined') return memoryStore();
  const ready = new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('projects', { keyPath: 'id' });
      req.result.createObjectStore('files');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const run = async (stores, mode, fn) => {
    const db = await ready;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let out;
      Promise.resolve(fn(tx, (v) => { out = v; })).catch(reject);
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error ?? new Error('保存に失敗しました'));
      tx.onabort = () => reject(tx.error ?? new Error('保存できませんでした（ブラウザの空き容量が足りない可能性があります）'));
    });
  };
  const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return {
    async list() {
      const all = await run('projects', 'readonly', async (tx, set) => set(await req2p(tx.objectStore('projects').getAll())));
      return (all ?? []).map(recover).sort((a, b) => b.createdAt - a.createdAt);
    },
    async get(id) {
      const p = await run('projects', 'readonly', async (tx, set) => set(await req2p(tx.objectStore('projects').get(id))));
      return p ? recover(p) : null;
    },
    save: (p) => run('projects', 'readwrite', (tx) => { tx.objectStore('projects').put(structuredClone(p)); }),
    putFile: (projectId, name, blob) => run('files', 'readwrite', (tx) => { tx.objectStore('files').put(blob, `${projectId}/${name}`); }),
    getFile: (projectId, name) => run('files', 'readonly', async (tx, set) => set(await req2p(tx.objectStore('files').get(`${projectId}/${name}`)))),
    async remove(id) {
      await run(['projects', 'files'], 'readwrite', (tx) => {
        tx.objectStore('projects').delete(id);
        tx.objectStore('files').delete(IDBKeyRange.bound(`${id}/`, `${id}/￿`));
      });
    },
  };
}

/** In-memory store with the same interface (tests, or browsers without IndexedDB). */
export function memoryStore() {
  const projects = new Map();
  const files = new Map();
  return {
    async list() { return [...projects.values()].map((p) => recover(structuredClone(p))).sort((a, b) => b.createdAt - a.createdAt); },
    async get(id) { return projects.has(id) ? recover(structuredClone(projects.get(id))) : null; },
    async save(p) { projects.set(p.id, structuredClone(p)); },
    async putFile(pid, name, blob) { files.set(`${pid}/${name}`, blob); },
    async getFile(pid, name) { return files.get(`${pid}/${name}`); },
    async remove(id) {
      projects.delete(id);
      for (const k of [...files.keys()]) if (k.startsWith(`${id}/`)) files.delete(k);
    },
  };
}

/**
 * A paid call still marked "reserved" means the page was closed mid-call:
 * whether it was charged is unknown, so it is counted at the estimate.
 */
export function recover(p) {
  for (const e of p.ledger ?? []) if (e.status === 'reserved') e.status = 'uncertain';
  return p;
}
