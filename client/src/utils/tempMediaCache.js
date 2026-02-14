const DB_NAME = 'lovestream-cache';
const STORE_NAME = 'media';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function makeKey(roomCode, role) {
    return `${String(roomCode || '').toUpperCase()}::${role || 'unknown'}`;
}

function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'key' });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Failed to open cache DB'));
    });
}

function transaction(storeName, mode, callback) {
    return openDb().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        const result = callback(store);

        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    }));
}

export async function saveTempMedia({ roomCode, role, blob, fileName = 'movie.mp4', sourcePath = null, ttlMs = DEFAULT_TTL_MS }) {
    if (!roomCode || !role || !blob) return;

    const now = Date.now();
    const record = {
        key: makeKey(roomCode, role),
        roomCode: String(roomCode).toUpperCase(),
        role,
        fileName,
        sourcePath: sourcePath || null,
        mimeType: blob.type || 'video/mp4',
        size: blob.size || 0,
        blob,
        savedAt: now,
        updatedAt: now,
        lastPosition: 0,
        expiresAt: now + Math.max(1000, ttlMs),
    };

    await transaction(STORE_NAME, 'readwrite', (store) => {
        store.put(record);
    });
}

export async function updateTempMediaPosition({ roomCode, role, position }) {
    if (!roomCode || !role || typeof position !== 'number' || Number.isNaN(position)) return;
    const key = makeKey(roomCode, role);

    await transaction(STORE_NAME, 'readwrite', (store) => {
        const req = store.get(key);
        req.onsuccess = () => {
            const value = req.result;
            if (!value) return;
            value.lastPosition = Math.max(0, position);
            value.updatedAt = Date.now();
            store.put(value);
        };
    });
}

export async function getTempMedia({ roomCode, role }) {
    if (!roomCode || !role) return null;
    const key = makeKey(roomCode, role);

    return transaction(STORE_NAME, 'readonly', (store) => {
        const req = store.get(key);
        return new Promise((resolve) => {
            req.onsuccess = async () => {
                const value = req.result;
                if (!value) {
                    resolve(null);
                    return;
                }

                if (value.expiresAt && Date.now() > value.expiresAt) {
                    resolve(null);
                    await removeTempMedia({ roomCode, role });
                    return;
                }

                resolve(value);
            };
            req.onerror = () => resolve(null);
        });
    });
}

export async function removeTempMedia({ roomCode, role }) {
    if (!roomCode || !role) return;
    const key = makeKey(roomCode, role);

    await transaction(STORE_NAME, 'readwrite', (store) => {
        store.delete(key);
    });
}

export async function clearExpiredTempMedia() {
    await transaction(STORE_NAME, 'readwrite', (store) => {
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) return;
            const value = cursor.value;
            if (value?.expiresAt && Date.now() > value.expiresAt) {
                cursor.delete();
            }
            cursor.continue();
        };
    });
}

export const TEMP_MEDIA_TTL_MS = DEFAULT_TTL_MS;
