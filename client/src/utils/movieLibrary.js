/**
 * Movie Library — persistent IndexedDB storage for downloaded/transcoded movies.
 *
 * Lets viewers skip re-downloading and hosts skip re-transcoding
 * when the same movie is loaded again.
 */

const LIB_DB_NAME = 'lovestream-library';
const LIB_STORE = 'movies';
const LIB_DB_VERSION = 1;

/* ── helpers ── */

function makeKey(fileName, fileSize) {
    return `${fileName}::${fileSize}`;
}

function openLibDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(LIB_DB_NAME, LIB_DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(LIB_STORE)) {
                const store = db.createObjectStore(LIB_STORE, { keyPath: 'key' });
                store.createIndex('fileName', 'fileName', { unique: false });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Failed to open library DB'));
    });
}

function libTransaction(mode, callback) {
    return openLibDb().then(
        (db) =>
            new Promise((resolve, reject) => {
                const tx = db.transaction(LIB_STORE, mode);
                const store = tx.objectStore(LIB_STORE);
                const result = callback(store);

                tx.oncomplete = () => resolve(result);
                tx.onerror = () => reject(tx.error || new Error('Library transaction failed'));
                tx.onabort = () => reject(tx.error || new Error('Library transaction aborted'));
            }),
    );
}

/* ── public API ── */

/**
 * Save a movie blob to the library.
 * @param {Blob|File} blob
 * @param {string} fileName
 * @returns {Promise<string>} key
 */
export async function saveMovie(blob, fileName) {
    if (!blob || !fileName) throw new Error('blob and fileName required');

    const key = makeKey(fileName, blob.size);
    const record = {
        key,
        fileName,
        fileSize: blob.size,
        mimeType: blob.type || 'video/mp4',
        blob,
        addedAt: Date.now(),
        lastWatchedAt: Date.now(),
    };

    await libTransaction('readwrite', (store) => {
        store.put(record);
    });

    return key;
}

/**
 * Find a movie by name. Returns metadata (no blob) or null.
 * If fileSize is provided, matches exactly; otherwise returns the first match by name.
 */
export async function findMovie(fileName, fileSize) {
    if (!fileName) return null;

    if (fileSize != null) {
        const key = makeKey(fileName, fileSize);
        return libTransaction('readonly', (store) => {
            const req = store.get(key);
            return new Promise((resolve) => {
                req.onsuccess = () => {
                    const val = req.result;
                    resolve(val ? { ...val, blob: undefined } : null);
                };
                req.onerror = () => resolve(null);
            });
        });
    }

    // Search by name index
    return libTransaction('readonly', (store) => {
        const idx = store.index('fileName');
        const req = idx.get(fileName);
        return new Promise((resolve) => {
            req.onsuccess = () => {
                const val = req.result;
                resolve(val ? { ...val, blob: undefined } : null);
            };
            req.onerror = () => resolve(null);
        });
    });
}

/**
 * Load the full movie blob from library.
 * Also bumps lastWatchedAt.
 * @returns {Promise<{blob: Blob, fileName: string, mimeType: string} | null>}
 */
export async function loadMovie(key) {
    if (!key) return null;

    const db = await openLibDb();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(LIB_STORE, 'readwrite');
        const store = tx.objectStore(LIB_STORE);
        const req = store.get(key);

        req.onsuccess = () => {
            const val = req.result;
            if (!val || !val.blob) {
                resolve(null);
                return;
            }

            // Bump lastWatchedAt
            val.lastWatchedAt = Date.now();
            store.put(val);

            resolve({
                blob: val.blob,
                fileName: val.fileName,
                mimeType: val.mimeType,
                fileSize: val.fileSize,
            });
        };

        req.onerror = () => resolve(null);
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * List all movies in the library (metadata only, no blobs).
 * Sorted by lastWatchedAt descending (most recent first).
 */
export async function listMovies() {
    return libTransaction('readonly', (store) => {
        const req = store.getAll();
        return new Promise((resolve) => {
            req.onsuccess = () => {
                const records = (req.result || []).map((r) => ({
                    key: r.key,
                    fileName: r.fileName,
                    fileSize: r.fileSize,
                    mimeType: r.mimeType,
                    addedAt: r.addedAt,
                    lastWatchedAt: r.lastWatchedAt,
                }));
                records.sort((a, b) => (b.lastWatchedAt || 0) - (a.lastWatchedAt || 0));
                resolve(records);
            };
            req.onerror = () => resolve([]);
        });
    });
}

/**
 * Remove a movie from the library.
 */
export async function removeMovie(key) {
    if (!key) return;
    await libTransaction('readwrite', (store) => {
        store.delete(key);
    });
}

/**
 * Get total library size in bytes.
 */
export async function getLibrarySize() {
    return libTransaction('readonly', (store) => {
        const req = store.getAll();
        return new Promise((resolve) => {
            req.onsuccess = () => {
                const total = (req.result || []).reduce((sum, r) => sum + (r.fileSize || 0), 0);
                resolve(total);
            };
            req.onerror = () => resolve(0);
        });
    });
}

/**
 * Format byte size for display.
 */
export function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
