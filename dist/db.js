let database;
export async function db() {
  if (database) return database;
  database = await new Promise((resolve, reject) => {
    const request = indexedDB.open("scribe-browser-v1", 3);
    request.onupgradeneeded = () => {
      const d = request.result;
      if (!d.objectStoreNames.contains("settings")) {
        d.createObjectStore("settings");
      }
      if (!d.objectStoreNames.contains("jobs")) {
        d.createObjectStore("jobs", { keyPath: "id" });
        const c = d.createObjectStore("chunks", { keyPath: ["job", "number"] });
        c.createIndex("job", "job");
        d.createObjectStore("audio", { keyPath: ["job", "number"] });
      }
      if (!d.objectStoreNames.contains("views")) {
        const views = d.createObjectStore("views", {
          keyPath: ["job", "number"],
        });
        views.createIndex("job", "job");
        const cursor = request.transaction.objectStore("chunks").openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (c) {
            if (c.value.response)
              views.put({
                job: c.value.job,
                number: c.value.number,
                segments: c.value.segments,
              });
            c.continue();
          }
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.onversionchange = () => database.close();
  return database;
}
async function transaction(stores, mode, run) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(stores, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () =>
      reject(tx.error || new Error("Не удалось сохранить прогресс."));
    run(tx, (value) => (result = value));
  });
}
export const jobs = () =>
  transaction(["jobs"], "readonly", (tx, set) => {
    const r = tx.objectStore("jobs").getAll();
    r.onsuccess = () => set(r.result.sort((a, b) => b.created - a.created));
  });
export const getSetting = (key) =>
  transaction(["settings"], "readonly", (tx, set) => {
    const request = tx.objectStore("settings").get(key);
    request.onsuccess = () => set(request.result);
  });
export const setSetting = (key, value) =>
  transaction(["settings"], "readwrite", (tx) => {
    const store = tx.objectStore("settings");
    if (value) store.put(value, key);
    else store.delete(key);
  });
export const getJob = (id) =>
  transaction(["jobs"], "readonly", (tx, set) => {
    const r = tx.objectStore("jobs").get(id);
    r.onsuccess = () => set(r.result);
  });
export const putJob = (job) =>
  transaction(["jobs"], "readwrite", (tx) =>
    tx.objectStore("jobs").put({ ...job, updated: Date.now() }),
  );
export const getChunks = (id) =>
  transaction(["chunks"], "readonly", (tx, set) => {
    const r = tx.objectStore("chunks").index("job").getAll(id);
    r.onsuccess = () => set(r.result.sort((a, b) => a.number - b.number));
  });
export const getChunk = (id, number) =>
  transaction(["chunks"], "readonly", (tx, set) => {
    const r = tx.objectStore("chunks").get([id, number]);
    r.onsuccess = () => set(r.result);
  });
export const getViews = (id, limit = 100) =>
  transaction(["views"], "readonly", (tx, set) => {
    const result = [];
    let count = 0;
    const r = tx
      .objectStore("views")
      .index("job")
      .openCursor(IDBKeyRange.only(id));
    r.onsuccess = () => {
      const c = r.result;
      if (c) {
        result.push(c.value);
        count += (c.value.segments || []).length;
        if (count < limit) c.continue();
        else set(result);
      } else set(result);
    };
  });
export const putChunk = (chunk) =>
  transaction(["chunks"], "readwrite", (tx) =>
    tx.objectStore("chunks").put(chunk),
  );
export const commitChunk = (job, chunk) =>
  transaction(["jobs", "chunks", "views"], "readwrite", (tx) => {
    tx.objectStore("chunks").put(chunk);
    tx.objectStore("jobs").put(job);
    if (chunk.response)
      tx.objectStore("views").put({
        job: chunk.job,
        number: chunk.number,
        segments: chunk.segments,
      });
  });
async function folder(job, create = false) {
  const root = await navigator.storage.getDirectory();
  const app = await root.getDirectoryHandle("scribe-studio", { create: true });
  return app.getDirectoryHandle(job, { create });
}
export async function saveAudio(job, number, blob) {
  if (navigator.storage?.getDirectory) {
    const dir = await folder(job, true),
      handle = await dir.getFileHandle(number + ".wav", { create: true }),
      writable = await handle.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
    return;
  }
  await transaction(["audio"], "readwrite", (tx) =>
    tx.objectStore("audio").put({ job, number, blob }),
  );
}
export async function getAudio(job, number) {
  if (navigator.storage?.getDirectory) {
    try {
      return await (
        await (await folder(job)).getFileHandle(number + ".wav")
      ).getFile();
    } catch (error) {
      if (error.name === "NotFoundError") return null;
      throw error;
    }
  }
  return transaction(["audio"], "readonly", (tx, set) => {
    const r = tx.objectStore("audio").get([job, number]);
    r.onsuccess = () => set(r.result?.blob || null);
  });
}
export async function deleteAudio(job, number) {
  if (navigator.storage?.getDirectory) {
    try {
      await (await folder(job)).removeEntry(number + ".wav");
    } catch {}
    return;
  }
  await transaction(["audio"], "readwrite", (tx) =>
    tx.objectStore("audio").delete([job, number]),
  );
}
export async function deleteJob(id) {
  await transaction(["jobs", "chunks", "audio", "views"], "readwrite", (tx) => {
    tx.objectStore("jobs").delete(id);
    for (const name of ["chunks", "audio", "views"]) {
      const request = tx.objectStore(name).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          if (cursor.value.job === id) cursor.delete();
          cursor.continue();
        }
      };
    }
  });
  if (navigator.storage?.getDirectory) {
    try {
      const root = await navigator.storage.getDirectory(),
        dir = await root.getDirectoryHandle("scribe-studio");
      await dir.removeEntry(id, { recursive: true });
    } catch {}
  }
}
