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
    let result;
    r.onsuccess = () => { result = r.result; };
    r.onerror = () => reject(r.error);
    // A successful request can still be rolled back. Callers may delete old scans only after commit.
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onabort = () => { db.close(); reject(tx.error || r.error || new Error("Storage transaction aborted")); };
  });
}
