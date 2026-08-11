/**
 * Sorted directory listing guard.
 *
 * The point of utils/readDir is that the app's view of a directory no
 * longer depends on what order the filesystem happens to hand entries back —
 * NTFS returns case-insensitive B-tree order, ext4 returns hash order. These
 * tests stub fs.readdir so the "filesystem" can be made hostile on purpose.
 */

const assert = require("node:assert");
const fs = require("node:fs");

const {
  readDirSorted,
  readDirSortedSync,
  clearDirCache,
} = require("../utils/readDir");

// Stub both readdir flavours to return `entries` verbatim, run `fn`, restore.
async function withFakeReaddir(entries, fn) {
  const realSync = fs.readdirSync;
  const realAsync = fs.promises.readdir;
  fs.readdirSync = () => entries.slice();
  fs.promises.readdir = async () => entries.slice();
  try {
    return await fn();
  } finally {
    fs.readdirSync = realSync;
    fs.promises.readdir = realAsync;
    clearDirCache();
  }
}

const FRAMES = [
  "START.svg",
  "PRE-1.svg",
  "1.svg",
  "10.svg",
  "2.svg",
  "DONE.svg",
];

module.exports = {
  "order is identical whatever order the filesystem returns": async () => {
    const shuffles = [
      FRAMES,
      [...FRAMES].reverse(),
      ["2.svg", "DONE.svg", "START.svg", "1.svg", "PRE-1.svg", "10.svg"],
    ];

    const results = [];
    for (const entries of shuffles) {
      // A distinct dir per shuffle: same dir would hit the memo and pass
      // trivially, testing nothing.
      await withFakeReaddir(entries, async () => {
        results.push((await readDirSorted(`/fake/${results.length}`)).join("|"));
      });
    }

    assert.strictEqual(
      new Set(results).size,
      1,
      `filesystem order leaked into the listing: ${JSON.stringify(results)}`,
    );
    assert.strictEqual(
      results[0],
      "1.svg|10.svg|2.svg|DONE.svg|PRE-1.svg|START.svg",
      "unexpected frame order",
    );
  },

  "sync and async agree": async () => {
    const entries = [...FRAMES].reverse();
    const [asyncOut, syncOut] = await withFakeReaddir(entries, async () => [
      await readDirSorted("/fake/a"),
      readDirSortedSync("/fake/b"),
    ]);
    assert.deepStrictEqual(asyncOut, syncOut);
  },

  "case-insensitive, with a stable tie-break": async () => {
    // Sorting by raw code units would put every capital ahead of every
    // lowercase ("Zoo" before "about"), renumbering real scores.
    await withFakeReaddir(
      ["Zoo.svg", "about.svg", "Beta.svg", "alpha.svg"],
      async () => {
        assert.deepStrictEqual(await readDirSorted("/fake/case"), [
          "about.svg",
          "alpha.svg",
          "Beta.svg",
          "Zoo.svg",
        ]);
      },
    );

    // Names differing only in case must not be able to swap run to run.
    await withFakeReaddir(["b.svg", "B.svg", "A.svg", "a.svg"], async () => {
      assert.deepStrictEqual(await readDirSorted("/fake/tie"), [
        "A.svg",
        "a.svg",
        "B.svg",
        "b.svg",
      ]);
    });
  },

  "recursive paths sort the same under either separator": async () => {
    // A recursive read joins with the platform separator. "/" (0x2F) and "\"
    // (0x5C) straddle the digits, so sorting raw would order these two
    // differently on Windows than on Linux.
    const win = ["Field\\01-Zen.m4a", "Field0.m4a", "Field"];
    const nix = ["Field/01-Zen.m4a", "Field0.m4a", "Field"];

    const shapeOf = (list) => list.map((p) => p.replace(/\\/g, "/"));

    const winOut = await withFakeReaddir(win, () =>
      readDirSorted("/fake/win", { recursive: true }),
    );
    const nixOut = await withFakeReaddir(nix, () =>
      readDirSorted("/fake/nix", { recursive: true }),
    );

    assert.deepStrictEqual(shapeOf(winOut), shapeOf(nixOut));
    // Entries are returned verbatim — only the ORDER is normalized.
    assert.ok(
      winOut.includes("Field\\01-Zen.m4a"),
      "separators must be preserved in the returned entries",
    );
  },

  "ext filter is case-insensitive": async () => {
    await withFakeReaddir(
      ["b.SVG", "notes.txt", "a.svg", "Sounds"],
      async () => {
        assert.deepStrictEqual(
          await readDirSorted("/fake/ext", { ext: ".svg" }),
          ["a.svg", "b.SVG"],
        );
      },
    );
  },

  "callers cannot mutate the cached listing": async () => {
    await withFakeReaddir(FRAMES, async () => {
      const first = await readDirSorted("/fake/shared");
      first.push("INJECTED.svg");
      first.sort().reverse();

      const second = await readDirSorted("/fake/shared");
      assert.ok(
        !second.includes("INJECTED.svg"),
        "a caller mutated the shared cache entry",
      );
      assert.strictEqual(second[0], "1.svg", "cached order was disturbed");
    });
  },

  "clearDirCache forces a re-read": async () => {
    let reads = 0;
    const realSync = fs.readdirSync;
    fs.readdirSync = () => {
      reads++;
      return FRAMES.slice();
    };
    try {
      readDirSortedSync("/fake/cached");
      readDirSortedSync("/fake/cached");
      assert.strictEqual(reads, 1, "second read should have hit the cache");

      clearDirCache("/fake/cached");
      readDirSortedSync("/fake/cached");
      assert.strictEqual(reads, 2, "clearDirCache did not evict the entry");
    } finally {
      fs.readdirSync = realSync;
      clearDirCache();
    }
  },
};
