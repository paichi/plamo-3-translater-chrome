const DATABASE = 'plamo-translate-cache';
const STORE = 'segments';
const SCHEMA_VERSION = 1;
const MAX_ENTRIES = 20_000;

function engineKey(settings) {
  return JSON.stringify(settings.engine === 'builtin'
    ? ['builtin', settings.builtinModel]
    : ['server', settings.baseUrl, settings.model]);
}

export async function createCacheKey(settings, text) {
  const input = JSON.stringify([SCHEMA_VERSION, text, settings.targetLang, engineKey(settings)]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function indexedDBStore() {
  let opening;
  function open() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore(STORE).createIndex('lastUsed', 'lastUsed');
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); opening = undefined; };
          resolve(db);
        };
      }).catch((error) => { opening = undefined; throw error; });
    }
    return opening;
  }

  async function transaction(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error ?? new Error('翻訳キャッシュの操作に失敗しました'));
      action(tx.objectStore(STORE), (value) => { result = value; });
    });
  }

  return {
    get(key, lastUsed) {
      return transaction('readwrite', (store, done) => {
        const request = store.get(key);
        request.onsuccess = () => {
          const entry = request.result;
          if (entry) store.put({ ...entry, lastUsed }, key);
          done(entry);
        };
      });
    },
    set(key, entry, cap) {
      return transaction('readwrite', (store) => {
        store.put(entry, key);
        const count = store.count();
        count.onsuccess = () => {
          let excess = count.result - cap;
          if (excess <= 0) return;
          const cursor = store.index('lastUsed').openCursor();
          cursor.onsuccess = () => {
            if (!cursor.result || excess <= 0) return;
            cursor.result.delete();
            excess--;
            if (excess > 0) cursor.result.continue();
          };
        };
      });
    },
    count() {
      return transaction('readonly', (store, done) => {
        const request = store.count();
        request.onsuccess = () => done(request.result);
      });
    },
    clear() {
      return transaction('readwrite', (store) => { store.clear(); });
    },
  };
}

// Store operations are atomic: concurrent segment writes cannot overrun the cap,
// and a hit cannot resurrect an entry deleted by clear/eviction.
export function createTranslationCache({ store = indexedDBStore(), maxEntries = MAX_ENTRIES, now = Date.now } = {}) {
  let generation = 0;
  return {
    async get(settings, text) {
      const entry = await store.get(await createCacheKey(settings, text), now());
      return entry?.translation;
    },
    async set(settings, text, translation) {
      const started = generation;
      const key = await createCacheKey(settings, text);
      if (started !== generation) return;
      await store.set(key, {
        text, translation, targetLang: settings.targetLang, engineKey: engineKey(settings), lastUsed: now(),
      }, maxEntries);
    },
    count: () => store.count(),
    clear() {
      generation++;
      return store.clear();
    },
  };
}
