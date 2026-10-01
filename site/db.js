/* Tiny IndexedDB wrapper for things too big for localStorage: saved scans ("areas"), your GPX rides ("rides"), and
 * downloaded OpenStreetMap squares ("osm", with their dates in "osmMeta") so a bigger scan can reuse them. */

const STORES = ["areas", "rides", "osm", "osmMeta"];

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("twisty-roads", 3);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: "key" });
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

/** op: "getAll" | "get" (arg = key) | "put" (arg = record with a `key`) | "delete" (arg = key) */
export async function idb(store, op, arg) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, op === "getAll" || op === "get" ? "readonly" : "readwrite");
    const st = tx.objectStore(store);
    const r = op === "getAll" ? st.getAll() : op === "get" ? st.get(arg) : op === "put" ? st.put(arg) : st.delete(arg);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    tx.oncomplete = tx.onabort = () => db.close();   // an open connection would block the next version upgrade
  });
}
