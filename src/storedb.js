// IndexedDB 键值持久层：localStorage 配额只有 ~5MB，对话一多就写不进。
// 这里用 IndexedDB 存同一份 JSON 字符串，localStorage 仅作旧版本回退/迁移源。
// 全部 API 不抛异常：任何失败都回退（调用方保持原有 localStorage 行为）。

export function hasStoreDb() {
  return typeof indexedDB !== 'undefined';
}

// 按 indexedDB factory 实例缓存打开中的数据库：
// 测试里每次重挂 fake factory 都会得到全新 db；真实浏览器里始终是单例。
const dbCache = new WeakMap();

function openDb() {
  let factory;
  try {
    factory = indexedDB;
  } catch {
    return Promise.reject(new Error('indexedDB unavailable'));
  }
  const hit = dbCache.get(factory);
  if (hit) return hit;
  const p = new Promise((resolve, reject) => {
    let req;
    try {
      // 隐私模式下 open 本身可能同步抛错
      req = factory.open('newqa', 1);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      try {
        req.result.createObjectStore('kv');
      } catch {}
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
  });
  dbCache.set(factory, p);
  return p;
}

export function readStoreDb(key) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        let req;
        try {
          req = db.transaction('kv', 'readonly').objectStore('kv').get(key);
        } catch (e) {
          reject(e);
          return;
        }
        req.onsuccess = () =>
          resolve(typeof req.result === 'string' ? req.result : null);
        req.onerror = () => reject(req.error || new Error('indexedDB get failed'));
      }),
  );
}

export function writeStoreDb(key, value) {
  return openDb()
    .then(
      (db) =>
        new Promise((resolve) => {
          let req;
          try {
            req = db.transaction('kv', 'readwrite').objectStore('kv').put(value, key);
          } catch {
            resolve(false);
            return;
          }
          req.onsuccess = () => resolve(true);
          req.onerror = () => resolve(false);
        }),
    )
    .catch(() => false);
}
