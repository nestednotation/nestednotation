/**
 * A REPLAYED barrier gates again: the reached registry only counts a mark the
 * room can still account for.
 *
 * The registry is a one-way latch and only a ROOM rewind restarts it — the
 * per-line rewind, the dive rollback and the structural undos leave it alone on
 * purpose ("the ROOM did not rewind", §8.2/§8.3/§8.4). So a passage walked a
 * second time — which is what those undos are FOR ("this replays the passage, it
 * does not unmake it") — used to meet its own `hold-until` frames already
 * satisfied, and a wait that is already met is not a wait. Reported by the owner
 * as "hold-until not working, it reached but not wait for other lines", and
 * provable from their live state: `E` waited on `F`/`G`, both `done` from a pass
 * 42 minutes earlier, while the two lines that had since been rewound behind
 * them were sitting inside `Tetra2` and `Cube1` with `F`/`G` gone from their
 * trails.
 *
 * So coverage asks two questions now: the latch says the frame was played out,
 * and `registryClaimants` says the room can still account for having been there.
 * A rewind un-reaches what it un-walks for free — trails are what answer, and
 * every rewind already truncates them.
 */

const assert = require("node:assert");

const {
  markReached,
  registryCoveredTargets,
  registryClaimants,
  roomWalkedRefs,
  beginReachedGeneration,
  holdUntilSatisfied,
} = require("../lib/session-lines/orchestrator");

const line = (id, over = {}) => ({
  id,
  status: "active",
  history: [],
  savedHistories: [],
  visitedSubFrames: [],
  subStack: [],
  ...over,
});

/** The owner's live room: L0 out of Tetra1 on E, the other two re-diving. */
function ownersRoom() {
  const reachedTargets = {};
  for (const ref of ["a.svg", "b.svg", "c.svg", "d.svg", "e.svg", "f.svg", "g.svg", "h.svg"]) {
    markReached(reachedTargets, ref, true);
  }
  return {
    reachedTargets,
    reachedGranted: [],
    lines: [
      line("L0", { history: ["B.svg", "E.svg"], visitedSubFrames: ["tetra1/start.svg", "tetra1/end.svg"] }),
      // rewound behind F, then re-dived: the main trail is back to C
      line("L1", {
        history: ["START.svg"],
        subStack: [{ score: "Tetra2", returnHref: "F.svg" }],
        savedHistories: [{ history: ["C.svg"], historyIndex: 0 }],
        visitedSubFrames: ["tetra2/start.svg"],
      }),
      line("L2", {
        history: ["START.svg"],
        subStack: [{ score: "Cube1", returnHref: "G.svg" }],
        savedHistories: [{ history: ["D.svg"], historyIndex: 0 }],
        visitedSubFrames: ["cube1/start.svg"],
      }),
    ],
    splitEvents: [{ id: "S1", status: "active", parentHistory: ["START.svg", "A.svg"] }],
    mergeEvents: [
      {
        id: "M1",
        status: "undone",
        frame: "H.svg",
        participants: [
          { lineId: "L0", history: ["B.svg", "E.svg", "H.svg"], savedHistories: [], visitedSubFrames: [], subStack: [] },
          { lineId: "L1", history: ["C.svg", "F.svg", "H.svg"], savedHistories: [], visitedSubFrames: [], subStack: [] },
        ],
      },
    ],
  };
}

module.exports = {
  "the owner's case: a replayed barrier is NOT satisfied by the old pass": () => {
    const s = ownersRoom();
    const targets = ["F.svg", "G.svg"]; // E.svg's hold-until

    // The latch alone says the wait is over — the reading that shipped before.
    const latchOnly = registryCoveredTargets(s.reachedTargets, targets);
    assert.deepStrictEqual([...latchOnly].sort(), ["F.svg", "G.svg"]);
    assert.strictEqual(holdUntilSatisfied(targets, latchOnly), true);

    // Corroborated: nobody can account for F or G any more, so E waits.
    const covered = registryCoveredTargets(s.reachedTargets, targets, registryClaimants(s));
    assert.deepStrictEqual([...covered], []);
    assert.strictEqual(holdUntilSatisfied(targets, covered), false);
  },

  "the frames still in a trail keep counting": () => {
    const s = ownersRoom();
    const claimants = registryClaimants(s);
    // L0 is standing on E and came through B; the split snapshot holds START/A.
    for (const ref of ["b.svg", "e.svg", "start.svg", "a.svg"]) {
      assert.ok(claimants.has(ref), `${ref} must still be accounted for`);
    }
    // …and the ones every line was rewound behind are gone.
    for (const ref of ["f.svg", "g.svg", "h.svg"]) {
      assert.ok(!claimants.has(ref), `${ref} must not be accounted for`);
    }
  },

  "a line that walks back onto the target makes it good again": () => {
    const s = ownersRoom();
    const targets = ["F.svg", "G.svg"];
    // L1 comes out of Tetra2 onto F and plays it out.
    s.lines[1].subStack = [];
    s.lines[1].history = ["C.svg", "F.svg"];
    s.lines[1].savedHistories = [];
    markReached(s.reachedTargets, "F.svg", true);

    const covered = registryCoveredTargets(s.reachedTargets, targets, registryClaimants(s));
    assert.deepStrictEqual([...covered], ["F.svg"]);
    assert.strictEqual(holdUntilSatisfied(targets, covered), false); // G still owed
  },

  "an ACTIVE split event speaks for the trail it truncated": () => {
    const s = ownersRoom();
    assert.ok(registryClaimants(s).has("a.svg"), "the fork frame is in no child's trail");

    // Undone, it speaks for nothing: the parent comes back carrying that
    // history itself, and rewinds after the undo must be able to drop it.
    s.splitEvents[0].status = "undone";
    assert.ok(!registryClaimants(s).has("a.svg"));
  },

  "an ACTIVE merge event speaks for the lines it swallowed": () => {
    const s = ownersRoom();
    assert.ok(!registryClaimants(s).has("h.svg"), "M1 is undone — nothing stands on H");

    s.mergeEvents[0].status = "active";
    const claimants = registryClaimants(s);
    assert.ok(claimants.has("h.svg"), "the rejoin frame is in the survivor's snapshot");
    assert.ok(claimants.has("f.svg"), "so is the absorbed line's route into it");

    // An EXPIRED event counts too: it can never be undone, so nothing will ever
    // hand those trails back and the room did walk them.
    s.mergeEvents[0].status = "expired";
    assert.ok(registryClaimants(s).has("f.svg"));
  },

  "an in-sub trail never corroborates the MAIN frame of the same name": () => {
    const s = ownersRoom();
    // Both re-dived lines are standing on a sub frame called START.svg, and the
    // main flow has a START.svg too. Only the split snapshot may account for it.
    s.splitEvents = [];
    const claimants = registryClaimants(s);
    assert.ok(!claimants.has("start.svg"), "bare sub frame names must not leak into the main flow");
    // The qualified form is what a sub-ref target is matched against.
    assert.ok(claimants.has("tetra2/start.svg"));
    assert.ok(claimants.has("cube1/start.svg"));
  },

  "a retired line speaks for nothing on its own": () => {
    const s = ownersRoom();
    s.lines.push(line("L9", { status: "retired", history: ["K.svg"] }));
    assert.ok(!registryClaimants(s).has("k.svg"));
  },

  "a room rewind's landing carve-out survives corroboration": () => {
    // beginReachedGeneration pre-satisfies the landing frame's own hold-until
    // targets (the room already passed that barrier). No trail can corroborate
    // them — the lines have just been rewound behind those very frames — so the
    // grant is recorded and counted, or the carve-out would be cancelled in the
    // same tick it was made.
    const s = ownersRoom();
    beginReachedGeneration(s, ["F.svg", "G.svg"]);
    assert.strictEqual(s.reachedGeneration, 1);
    assert.deepStrictEqual(s.reachedGranted, ["f.svg", "g.svg"]);

    const covered = registryCoveredTargets(s.reachedTargets, ["F.svg", "G.svg"], registryClaimants(s));
    assert.deepStrictEqual([...covered].sort(), ["F.svg", "G.svg"]);
    assert.strictEqual(holdUntilSatisfied(["F.svg", "G.svg"], covered), true);

    // …and it restarts with the generation, rather than accumulating.
    beginReachedGeneration(s, []);
    assert.deepStrictEqual(s.reachedGranted, []);
    assert.deepStrictEqual(s.reachedTargets, {});
  },

  "the map's walked set is the claimants without the granted carve-out": () => {
    const s = ownersRoom();
    s.reachedGranted = ["F.svg"];
    assert.ok(registryClaimants(s).has("f.svg"), "granted still corroborates a barrier");
    const walked = roomWalkedRefs(s);
    assert.ok(!walked.has("f.svg"), "but nobody stood on it, so it is not walked");
    // Before the fork, a line's main route while it dives, and the qualified
    // sub frames all count as walked.
    for (const ref of ["start.svg", "a.svg", "c.svg", "d.svg", "tetra2/start.svg"]) {
      assert.ok(walked.has(ref), `${ref} was walked`);
    }
  },

  "an empty branch's seed frame is not walked, but still counts for barriers": () => {
    const s = ownersRoom();
    // A one-device split: L3 was seeded on C.svg and nobody ever joined it.
    s.lines.push(line("L3", { status: "dormant", history: ["C2.svg"], historyIndex: 0 }));
    assert.ok(!roomWalkedRefs(s).has("c2.svg"), "no device stood on the seed frame");
    assert.ok(registryClaimants(s).has("c2.svg"), "barrier corroboration is unchanged");
    // A line that walked and THEN went dormant keeps the frames behind it.
    s.lines[3] = line("L3", { status: "dormant", history: ["C2.svg", "D2.svg"], historyIndex: 1 });
    const walked = roomWalkedRefs(s);
    assert.ok(walked.has("c2.svg"));
    assert.ok(!walked.has("d2.svg"), "its position is the dormant marker's, not green");
  },
};
