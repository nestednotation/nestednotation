const fs = require("fs");

/**
 * Deterministic directory listings.
 *
 * fs.readdir hands back entries in whatever order the filesystem keeps them:
 * NTFS returns a case-insensitive B-tree order, ext4 returns hash order, and
 * neither is promised to be stable. Every consumer of a listing in this app
 * treats that order as meaningful — a frame's position in `listFiles` becomes
 * its `svg<N>` id, its `data-next-file-idx`, and the `currentIndex` persisted
 * into server_state — so an unsorted read numbers a score's frames differently
 * on the venue machine than on the composer's, and a score copied between them
 * silently changes shape. Every directory read goes through here instead.
 *
 * Listings are memoized for the lifetime of the process, so a score folder
 * added while the server is running is not picked up until a restart (or an
 * explicit clearDirCache()).
 */

// Case-insensitive first: that is the order every existing score was authored
// against (and the order Explorer/Finder show), so routing the reads through
// here renumbers nothing. Tie-break on raw code units so two names differing
// only in case can never swap places. toLowerCase() is locale-independent —
// localeCompare() is NOT, and would reintroduce exactly the machine-to-machine
// variance this file exists to remove.
const compareNames = (a, b) => {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la !== lb) {
    return la < lb ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
};

// A recursive read returns paths joined with the platform separator, and
// sorting those raw would itself be platform-dependent ("a/b" and "a0" order
// one way under "/" and the other under "\"). Sort on a normalized key but
// return the raw entries, so callers still see byte-identical strings.
const sortKey = (name) => String(name).replace(/\\/g, "/");

// A recursive read is genuinely different data from a plain one, so the two get
// their own map and the directory path alone is the key. `ext` is deliberately
// NOT part of that identity: it is a filter over the same listing, applied
// after the lookup, so a directory read plainly and then read filtered costs
// one syscall instead of two.
const listCache = new Map();
const recursiveCache = new Map();

const sortEntries = (raw) =>
  [...raw].sort((a, b) => compareNames(sortKey(a), sortKey(b)));

// Always hands back a fresh array, so a caller can never reach the cached
// listing — two sessions built from the same score would otherwise share one
// `listFiles` instance. Filtering after the sort is equivalent to filtering
// before it: dropping entries cannot reorder the survivors.
const viewOf = (entries, ext) =>
  ext
    ? entries.filter((name) => String(name).toLowerCase().endsWith(ext))
    : entries.slice();

/**
 * @param {string} dir
 * @param {{ recursive?: boolean, ext?: string }} [opts] `ext` filters to a
 *   single extension, matched case-insensitively (e.g. ".svg").
 * @returns {Promise<string[]>} sorted entry names
 */
async function readDirSorted(dir, opts = {}) {
  const { recursive = false, ext = "" } = opts;
  const cache = recursive ? recursiveCache : listCache;

  let entries = cache.get(dir);
  if (!entries) {
    entries = sortEntries(
      await fs.promises.readdir(
        dir,
        recursive ? { recursive: true } : undefined,
      ),
    );
    cache.set(dir, entries);
  }

  console.log({ listCache, recursiveCache });
  return viewOf(entries, ext.toLowerCase());
}

/**
 * Synchronous twin of readDirSorted, sharing the same cache — a sync read hits
 * an entry an async read populated, and vice versa.
 *
 * @param {string} dir
 * @param {{ recursive?: boolean, ext?: string }} [opts]
 * @returns {string[]} sorted entry names
 */
function readDirSortedSync(dir, opts = {}) {
  const { recursive = false, ext = "" } = opts;
  const cache = recursive ? recursiveCache : listCache;

  let entries = cache.get(dir);
  if (!entries) {
    entries = sortEntries(
      fs.readdirSync(dir, recursive ? { recursive: true } : undefined),
    );
    cache.set(dir, entries);
  }

  console.log({ listCache, recursiveCache });
  return viewOf(entries, ext.toLowerCase());
}

/** Drop one directory's memoized listings, or all of them when called bare. */
function clearDirCache(dir) {
  if (dir === undefined) {
    listCache.clear();
    recursiveCache.clear();
    return;
  }
  listCache.delete(dir);
  recursiveCache.delete(dir);
}

module.exports = { readDirSorted, readDirSortedSync, clearDirCache };
