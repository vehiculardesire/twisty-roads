/* Tiny IndexedDB wrapper for things too big for localStorage: saved scans ("areas") and your GPX rides ("rides"). */

const STORES = ["areas", "rides"];

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("twisty-roads", 2);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: "key" });
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

/** op: "getAll" | "put" (arg = record with a `key`) | "delete" (arg = key) */
export async function idb(store, op, arg) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const st = db.transaction(store, op === "getAll" ? "readonly" : "readwrite").objectStore(store);
    const r = op === "getAll" ? st.getAll() : op === "put" ? st.put(arg) : st.delete(arg);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
