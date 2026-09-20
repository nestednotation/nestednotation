const { MESSAGES, ABOUT_DATA_DIR } = require("./constants");
const fs = require("fs");
const crypto = require("crypto");

const jade = require("jade");

// Every directory read goes through here: fs.readdir's raw order is
// filesystem-dependent, and frame position is load-bearing (svg<N> ids,
// data-next-file-idx, the persisted currentIndex).
const {
  readDirSorted,
  readDirSortedSync,
  clearDirCacheUnder,
} = require("./utils/readDir");

// Session Lines: pure graph builder (no behavior change for vanilla scores).
const { parseFrameAttrs } = require("./lib/session-lines/parse");
const { buildGraph } = require("./lib/session-lines/graph");
// Session Lines: per-playhead line model + persistence helpers.
const { BMLine, migrateState } = require("./lib/session-lines/line");
const { compactPersistedEvents } = require("./lib/session-lines/map-payload");

const IGNORE_STATE_KEYS = ["svgContent", "htmlContent"];
const REWIND_LOG_MAX = 20;
const HREF_REGX = /(?<=href=")(.*?)(?=")/;
const LINK_REGEX = /((xlink:href)|(href))="(.*?)"/;

let prefixDir = ".";
const testPrefixFile = prefixDir + "/account/admin.dat";
if (!fs.existsSync(testPrefixFile)) {
  prefixDir = "..";
}
// SCORE_DATA_DIR in the environment serves scores from elsewhere (the
// end-to-end tests point a spawned server at test/fixtures).
const DATA_DIR = process.env.SCORE_DATA_DIR || `${prefixDir}/public/data`;
const TEMPLATE_DIR = `${prefixDir}/views`;

// SERVER_STATE_DIR in the environment moves session state and baked score
// files elsewhere; the test runner points it at a per-run temporary directory.
const SERVER_STATE_DIR =
  process.env.SERVER_STATE_DIR || `${prefixDir}/server_state`;
if (!fs.existsSync(SERVER_STATE_DIR)) {
  fs.mkdirSync(SERVER_STATE_DIR, { recursive: true });
}

// A half-written state file is unreadable at the next boot, so anything the
// server must survive a restart is published atomically: the whole payload goes
// to a sibling temp file first, then one rename swaps it in. A reader (or a
// crash) therefore sees either the previous snapshot or the new one, never a
// splice of the two.
const writeFileAtomic = async (filePath, data) => {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmpPath, data);
  try {
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    await fs.promises.rm(tmpPath, { force: true });
    throw err;
  }
};

// A score's baked files (page, content, sub-frames, about) only make sense
// together, and several renames cannot replace a set of files atomically. So a
// build never overwrites a published file: it writes a new revision under names
// of its own, and the session's `bundleRevision` — the one reference every
// reader resolves through `bundleFile` — switches to it only once every file
// is on disk. A failed write removes what it wrote and throws; the previous
// revision, never touched, stays the one served.
const BUNDLE_KINDS = ["html", "content.svg", "subs.json", "about.svg"];

const unavailableWhy = (reason) =>
  reason === "empty" ? "has no frames" : "not found";

// A rebuild that found no score to replace the live one with, or found it
// without a sub-score its frames still dive into (`subs`: [{score, reason}]).
class ScoreUnavailableError extends Error {
  constructor(folder, reason, subs = []) {
    super(
      subs.length > 0
        ? `Score "${folder}" references unavailable sub-scores: ${subs
            .map((sub) => `"${sub.score}" ${unavailableWhy(sub.reason)}`)
            .join(", ")}`
        : `Score "${folder}" ${unavailableWhy(reason)}`,
    );
    this.name = "ScoreUnavailableError";
    this.code = "SCORE_UNAVAILABLE";
    this.folder = folder;
    this.reason = reason;
    this.subs = subs;
  }
}

// Whether a score path is on disk. Only ENOENT means "not there": an existence
// check also answers false when the path cannot be looked up (no permission to
// traverse a parent, an I/O error), and a score that is merely unreachable must
// fail its build — keeping everything saved for it — not read as removed.
const pathPresent = async (target) => {
  try {
    await fs.promises.stat(target);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") {
      return false;
    }
    throw err;
  }
};

// Boot deletes a session whose score folder is gone (owner), so "gone" has to
// be established, not inferred from a failed lookup. The score data directory
// must list cleanly and hold at least one score folder — an unmounted volume
// can leave an empty mount-point directory behind — and the folder must be
// absent from that listing as well as from a direct lookup. Anything short of
// that throws, and the caller keeps the snapshot for a later boot.
const confirmScoreFolderRemoved = async (dataDir, folder) => {
  const entries = await fs.promises.readdir(dataDir, { withFileTypes: true });
  const scoreFolders = entries.filter((entry) => entry.isDirectory());
  if (scoreFolders.length === 0) {
    throw new Error(
      `score data directory ${dataDir} holds no scores; not treating "${folder}" as removed`,
    );
  }
  const wanted = String(folder).toLowerCase();
  if (entries.some((entry) => entry.name.toLowerCase() === wanted)) {
    throw new Error(
      `score "${folder}" is listed in ${dataDir} but could not be read`,
    );
  }
  if (await pathPresent(`${dataDir}/${folder}`)) {
    throw new Error(`score "${folder}" exists but could not be read`);
  }
};

const newBundleRevision = () =>
  `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;

const writeFilesAsNew = async (writes) => {
  const written = [];
  try {
    for (const [filePath, data] of writes) {
      written.push(filePath);
      await fs.promises.writeFile(filePath, data, { flag: "wx" });
    }
  } catch (err) {
    await Promise.all(
      written.map((filePath) =>
        fs.promises.rm(filePath, { force: true }).catch(() => {}),
      ),
    );
    throw err;
  }
};

const escapeRegex = (text) =>
  String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Every baked file of session `id` in `stateDir`, with the revision it belongs
// to (null for the unrevisioned names older builds wrote).
const listBundleFiles = async (stateDir, id) => {
  const kinds = BUNDLE_KINDS.map(escapeRegex).join("|");
  const pattern = new RegExp(
    `^${escapeRegex(id)}\\.(?:rev-([0-9a-z]+)\\.)?(?:${kinds})$`,
  );
  let names;
  try {
    names = await fs.promises.readdir(stateDir);
  } catch (err) {
    return [];
  }
  return names
    .map((name) => ({ name, match: pattern.exec(name) }))
    .filter(({ match }) => match)
    .map(({ name, match }) => ({
      file: `${stateDir}/${name}`,
      revision: match[1] || null,
    }));
};

const regexWithPattern = (str, pattern, groupId) => {
  const match = str.match(pattern);
  if (match === null) {
    return null;
  }

  return match[groupId];
};

const buildAboutSvgAsync = async (
  contentDir,
  svgIdSuffix,
  dataDir = DATA_DIR,
) => {
  const dir = `${dataDir}/${contentDir}`;
  if (!fs.existsSync(dir)) {
    console.log(`${dir} not found`);
    return null;
  }

  let fileList = await readDirSorted(dir);
  if (fileList.length <= 0) {
    console.log(`No data in ${dir} folder`);
    return null;
  }

  let svgContent = "";

  for (const filename of fileList) {
    const filePath = `${dir}/${filename}`;
    const content = await fs.promises.readFile(filePath, "utf8");
    let svg = regexWithPattern(content, /<svg.*?<\/svg>/is, 0);
    svg = svg.replace(
      "<svg",
      `<svg id="${filename}${svgIdSuffix}" class="hidden" file="${filename}" `,
    );

    svgContent += `${svg}\n`;
  }

  console.log(
    `Finish building about/document svg content... for ${contentDir}`,
  );
  return svgContent;
};

const buildAboutSvg = (contentDir, svgIdSuffix) => {
  const dir = `${DATA_DIR}/${contentDir}`;
  if (!fs.existsSync(dir)) {
    console.log(`${dir} not found`);
    return null;
  }

  let fileList = readDirSortedSync(dir);
  if (fileList.length <= 0) {
    console.log(`No data in ${dir} folder`);
    return null;
  }

  let svgContent = "";

  fileList.forEach((filename) => {
    const filePath = `${dir}/${filename}`;
    const content = fs.readFileSync(filePath, "utf8");
    let svg = regexWithPattern(content, /<svg.*?<\/svg>/is, 0);
    svg = svg.replace(
      "<svg",
      `<svg id="${filename}${svgIdSuffix}" class="hidden" file="${filename}" `,
    );

    svgContent += `${svg}\n`;
  });

  console.log(
    `Finish building about/document svg content... for ${contentDir}`,
  );
  return svgContent;
};

let hostAddress = null;
const aboutNestedNotationSvg = buildAboutSvg(ABOUT_DATA_DIR, "-about-nn");

const serverIp = process.env.SERVER_IP;
const wsPath = process.env.WS_PATH || `wss://${serverIp}`;
console.log(`Websocket path is ${wsPath}`);

class BMAdmin {
  constructor(id, name, password, isActive) {
    this.id = id;
    this.name = name;
    this.password = password;
    this.isActive = isActive;
  }
}

class BMAdminTable {
  constructor() {
    this.clear();
  }

  clear() {
    this.data = [];
    this.count = 0;
  }

  add(id, name, password, isActive) {
    this.count++;
    var a = new BMAdmin(id, name, password, isActive);
    this.data.push(a);
    return a;
  }

  addWithIdAuto(name, password, isActive) {
    this.count++;
    var max = 0;
    for (var i = 0; i < this.data.length; i++) {
      var id = parseInt(this.data[i].id);
      if (id > max) {
        max = id;
      }
    }
    var checkExist = this.data.filter((o) => o.name.trim() == name.trim());
    if (checkExist.length == 0) {
      max++;
      var a = new BMAdmin(max.toString(), name, password, isActive);
      this.data.push(a);
      return a;
    }
    return null;
  }

  getById(id) {
    return this.data.find((e) => e.id.trim() == id);
  }

  getByName(name) {
    return this.data.find((e) => e.name.trim() == name);
  }

  dumpToFile(path) {
    var str = "";
    for (var i = 0; i < this.data.length; i++) {
      str += this.data[i].id.trim() + "\r\n";
      str += this.data[i].name.trim() + "\r\n";
      str += this.data[i].password.trim() + "\r\n";
      if (i == this.data.length - 1) {
        str += this.data[i].isActive.trim();
      } else {
        str += this.data[i].isActive.trim() + "\r\n";
      }
    }
    fs.writeFileSync(path, str, "utf8");
  }
}

class BMSession {
  // Offline tools may point a session at test fixtures outside public/data.
  // Runtime sessions keep the production data directory default.
  scoreDataDir = DATA_DIR;
  // Where this session's state and baked score files go. Tests point it at a
  // temporary directory so they never touch the real server_state.
  stateDir = SERVER_STATE_DIR;

  // Session Lines: the playhead(s). A session always has >= 1 line; until a
  // split occurs it has exactly one (`lines[0]`). The per-line fields that used
  // to live flat on BMSession are now owned entirely by BMLine — the runtime
  // (bin/www) reads/writes them through the line object (`line.currentIndex`
  // etc.), and BMSession's own playhead helpers below delegate to `lines[0]`.
  lines = [new BMLine(this)];
  // Structural split history used by the score map's "undo split" operation.
  // Events are append-only in memory (active → undone) so ids remain race-safe
  // during a gesture. `toJSON` omits terminal undone records; the persisted
  // monotonic counters keep ids safe across restarts.
  splitEvents = [];
  nextSplitEventId = 1;
  // One operator GESTURE can fork several lines at once (a track group's
  // release divides every populated line standing on a split frame), and the
  // map offers that release as ONE undo — so the forks of one gesture carry a
  // shared `gestureId` from this counter (`orch.splitGestureEvents`).
  nextSplitGestureId = 1;
  // Structural merge (rejoin) history used by the score map's "undo merge"
  // operation. Active records are kept for the whole session: a merge point
  // stays somewhere the room can go back
  // to, with anything built on top of it undone first
  // (`structuralRewindChain`). Terminal undone records are omitted from saved
  // state, while expired records are reduced to the identity and trail evidence
  // still needed for rewind blocking and barrier corroboration. Absorbed lines'
  // NUMBERS are not held: the undo re-creates them from active snapshots.
  mergeEvents = [];
  nextMergeEventId = 1;
  // Successful operator rewinds, newest first. This is session-owned rather
  // than map-page-owned so the audit survives reloads, reconnects and server
  // restarts. Entries are deliberately compact; the map turns them into prose.
  rewindLog = [];
  // One ordering across both event kinds, so a cascade can walk splits and
  // merges in the order they actually happened (their ids come from separate
  // counters).
  nextStructuralSeq = 1;
  deviceRegistry = {};
  // Rendezvous barriers (#6): session-global registry of frame refs reached by
  // any line — { "<lower ref>": "arrived" | "done" }. Sub frames use the
  // qualified "score/frame" form. Only written on session-lines scores.
  reachedTargets = {};
  // SM-jump rewind generation (S2 option (b)): bumped on every session-lines
  // history jump, when the registry above is restarted so replayed barriers
  // gate like first passes.
  reachedGeneration = 0;
  // The rewind-landing carve-out: hold-until targets the room is DECLARED to
  // have met (it passed that barrier before the rewind), which no line's trail
  // can corroborate afterwards — `orch.registryClaimants` counts them in so the
  // barrier at a rewind landing stays unlocked.
  reachedGranted = [];
  // Decision #13 revision: the newest main-flow track-group landing ({ frame,
  // at }) — dormant-line revivals fast-forward to this group instead of
  // resuming their frozen position. Cleared on rewind (beginReachedGeneration)
  // and when a reloaded score drops its markup.
  latestGroupArrival = null;

  selectedScoreIndex = -1;
  selectedCooldownTimeIndex = -1;
  selectedHoldTimeIndex = -1;

  isPause = false;
  isSessionDeleted = false;

  // Serializes this session's state-file writes; see saveSessionStateToFile.
  #stateWrites = Promise.resolve();

  // The published score revision every reader of the baked files resolves
  // through bundleFile(); see publishScoreBundle. Not persisted: a boot
  // rebuilds the score and publishes a fresh revision.
  bundleRevision = null;
  // "missing" / "empty" while the session has no score to serve (it found
  // none before any publish); null once one is published. Not persisted.
  scoreUnavailable = null;
  // Serializes bundle publication, so one publish's cleanup can never remove
  // a revision another publish is about to switch to.
  #bundlePublishes = Promise.resolve();

  // One mutation lane for every live operation that can change a room. A
  // structural rewind deliberately awaits saves and notifications between its
  // steps; keeping the queue on the session prevents taps, disconnects,
  // countdowns, and score rebuilds from entering through those await gaps.
  #mutations = Promise.resolve();

  synTimeInterval = 0.5;
  standbyDuration = 3;
  holdDuration = 0;
  votingDuration = 10;
  votingSize = 100;
  preloadDuration = 1100;
  hasSounds = false;

  get qrSharePath() {
    return `/session/${this.id}/?p=${encodeURIComponent(
      this.playerPassword,
    )}&t=2`;
  }

  checkScoreHasSounds(score) {
    const dir = `${this.scoreDataDir}/${score}`;

    if (!fs.existsSync(dir)) {
      return;
    }

    const fileList = readDirSortedSync(dir);
    return fileList.includes("Sounds") && fileList.includes("Frames");
  }

  async patchState(stateData, saveToFile = false) {
    for (const [key, val] of Object.entries(stateData)) {
      if (IGNORE_STATE_KEYS.includes(key)) {
        continue;
      }

      // `version` is re-emitted by toJSON; nothing reads it off the instance.
      if (key === "version") {
        continue;
      }

      // Rehydrate persisted lines into BMLine instances (with this session as
      // their back-ref). Partial patches from bin/www/routes never carry
      // `lines`, so they fall through to the plain assignment below.
      if (key === "lines" && Array.isArray(val)) {
        this.lines = val.map((lineObj) => BMLine.fromJSON(this, lineObj));
        continue;
      }

      // State files are local, but keep a malformed/hand-edited log from
      // growing the live session without bound or breaking map rendering.
      if (key === "rewindLog") {
        this.rewindLog = Array.isArray(val)
          ? val
              .filter((entry) => entry && typeof entry === "object")
              .slice(0, REWIND_LOG_MAX)
          : [];
        continue;
      }

      this[key] = val;
    }

    if (saveToFile) {
      await this.saveSessionStateToFile();
    }
  }

  // this use listFiles generate from buildSVGContent. So run it after that method
  async initState(
    id,
    adminId,
    folder,
    sessionName,
    adminpassword,
    playerpassword,
    isHtml5 = false,
    fadeDuration = 1000,
    defaultVolume = 80,
    defaultAutoplay = true,
    enableAutoplayByDefault = false,
  ) {
    this.id = id;
    this.ownerId = adminId;
    this.sessionName = sessionName;
    this.adminPassword = adminpassword;
    this.playerPassword = playerpassword;

    this.isHtml5 = isHtml5;
    this.fadeDuration = fadeDuration;
    this.defaultVolume = defaultVolume;
    this.defaultAutoplay = defaultAutoplay;
    this.enableAutoplayByDefault = enableAutoplayByDefault;

    this.folder = folder;

    await this.buildSVGContent();

    if (this.listFiles.length <= 0) {
      return;
    }

    this.setCurrIdxToStart();
  }

  // Swap to another folder. A build that fails keeps the current folder and
  // score in place, and the room untouched.
  async reloadScore(folderName) {
    await this.buildSVGContent(folderName);
    this.folder = folderName;
    this.resetForScoreChange();
  }

  // Rebuild a score edited in place. A content change cannot safely keep
  // numeric playheads or structural snapshots: frame insertion/reordering
  // changes what those indexes mean. Reset exactly as a folder swap does.
  // Sounds are rediscovered too, so adding or removing one counts as a change.
  async rebuildScore() {
    const contentBefore = this.contentHash;
    await this.buildSVGContent();
    const changed = this.contentHash !== contentBefore;
    if (changed) {
      this.resetForScoreChange();
    }
    return changed;
  }

  resetForScoreChange() {
    for (const line of this.lines || []) {
      line.clearAllTimer();
      if (line._attritionTimer != null) {
        clearTimeout(line._attritionTimer);
        line._attritionTimer = null;
      }
    }

    this.lines = [new BMLine(this)];
    if (this.listFiles && this.listFiles.length > 0) {
      this.lines[0].setCurrIdxToStart();
    }

    this.splitEvents = [];
    this.nextSplitEventId = 1;
    this.nextSplitGestureId = 1;
    this.mergeEvents = [];
    this.nextMergeEventId = 1;
    this.nextStructuralSeq = 1;
    this.deviceRegistry = {};
    this.reachedTargets = {};
    this.reachedGeneration = 0;
    this.reachedGranted = [];
    this.latestGroupArrival = null;
    // The rewind log goes with them (owner). Every entry names a frame of the
    // score being replaced, so on the new one it is an audit of acts at frames
    // that do not exist.
    this.rewindLog = [];

    // Runtime-only projections/barrier state are derived from the score and
    // topology above. They must not survive onto the replacement graph.
    this._barrier = undefined;
    this._barrierRehydrated = false;
    this.__structuralProjection = undefined;
    this.__displayHold = null;
  }

  // Session Lines: playhead operations delegate to the (single, until split)
  // first line. The shim keeps `session.currentIndex`/`history`/… in sync.
  setCurrIdxToStart() {
    this.lines[0].setCurrIdxToStart();
  }

  resetSessionHistory() {
    this.lines[0].resetHistory();
  }

  setCurrIdxTo(index) {
    this.lines[0].setCurrIdxTo(index);
  }

  async getSoundList(folder) {
    const dir = `${this.scoreDataDir}/${folder}/Sounds`;
    if (!fs.existsSync(dir)) {
      return [];
    }
    const files = await readDirSorted(dir, { recursive: true });

    return files.map((file) => file.replace("\\", "/"));
  }

  markScoreUnavailable(reason) {
    this.listFiles = [];
    this.listFilesInLowerCase = [];
    this.listMultiChooseImages = [];
    this.graph = buildGraph([]);
    this.hasSessionLines = false;
    this.subFrames = {};
    this.reachedTargets = {};
    this.reachedGranted = [];
    this.latestGroupArrival = null;
    this.contentHash = crypto
      .createHash("sha256")
      .update(`${this.folder}:${reason}`)
      .digest("hex");
  }

  // Build the score, then publish it. Nothing live changes until the whole
  // replacement is ready: a failed read leaves the previous score (frame lists,
  // graph, sub-scores, sounds, baked files and content hash) complete and in
  // use, and the failure goes to the caller. So does finding no score at all
  // once one is live (ScoreUnavailableError). `folder` defaults to the current
  // one; a folder swap passes the new one so a failed build keeps the old.
  async buildSVGContent(folder = this.folder) {
    const bundle = await this.prepareScoreBundle(folder);
    await this.publishScoreBundle(bundle);
  }

  // Everything a score needs, read and rendered off to the side. Reads `this`
  // only for session settings; never assigns to it or writes a file.
  async prepareScoreBundle(folder) {
    const scoreDir = `${this.scoreDataDir}/${folder}`;
    // Listings are memoized process-wide; a rebuild must see the folder as it
    // is now, including frames and sounds added or removed since.
    clearDirCacheUnder(scoreDir);
    const framesDir = `${scoreDir}/Frames`;
    // A lookup that fails for any reason but absence throws: that is a failed
    // build, not a missing score.
    const dir = (await pathPresent(framesDir)) ? framesDir : scoreDir;
    if (!(await pathPresent(dir))) {
      return { folder, unavailable: "missing" };
    }

    const listFiles = await readDirSorted(dir);

    if (listFiles.length <= 0) {
      return { folder, unavailable: "empty" };
    }

    // Sound discovery belongs to the build: an in-place rebuild must see a
    // sound file added or removed on disk just as a folder swap does, or the
    // content hash below cannot tell the room its audio changed. A sound is
    // identified by its path; replacing the bytes behind an existing path is
    // not detected (rename the file to make devices fetch it again).
    const hasSounds = this.checkScoreHasSounds(folder);
    const soundList = hasSounds ? await this.getSoundList(folder) : [];

    const listFilesInLowerCase = listFiles.map((fileName) =>
      fileName.toLowerCase(),
    );

    const listMultiChooseImages = [];

    // Session Lines: collect each frame's session-* attributes (parsed from the
    // raw content, before the <a> href rewrite below strips href values).
    const sessionFrameAttrs = [];

    // A fingerprint of the score the devices are handed, accumulated as the
    // frames are appended below. The session manager rebuilds a score in place
    // when "update session" leaves the folder alone (the operator edited the
    // frames on disk); comparing this across the rebuild is how routes/sm.js
    // knows whether the attached devices — session pages and the standalone
    // /map — are now holding a stale score and have to reload.
    const contentDigest = crypto.createHash("sha256");

    let contentSvg = "";

    for (const filename of listFiles) {
      const filePath = `${dir}/${filename}`;
      const content = await fs.promises.readFile(filePath, "utf8");
      sessionFrameAttrs.push({
        name: filename,
        attrs: parseFrameAttrs(content),
      });
      let svg = regexWithPattern(content, /<svg.*?<\/svg>/is, 0);
      const svgIndex = listFilesInLowerCase.indexOf(filename.toLowerCase());
      svg = svg?.replace(
        "<svg",
        `<svg id="svg${svgIndex}" class="hidden" file="${filename}" `,
      );

      const listA = svg?.match(/<a.*?>/g);

      if (listA?.length > 1 && !filename.startsWith("PRE")) {
        listMultiChooseImages.push(svgIndex);
      }

      listA?.forEach((a, idx) => {
        const matchedHref = HREF_REGX.exec(a)?.[0];
        const aIndex = listFilesInLowerCase.indexOf(matchedHref?.toLowerCase());
        const newA = a
          .replace(
            "<a",
            `<a id="${aIndex}#${filename}#${idx}" data-next-file-idx="${aIndex}" `,
          )
          .replace(LINK_REGEX, `onclick="handleSelectLink(this)"`);
        svg = svg.replace(a, newA);
      });

      contentDigest.update(filename);
      contentDigest.update(svg ?? "");

      contentSvg += svg ?? "";
    }

    // Session Lines: the relationship graph is built for EVERY score (the
    // admin score map treats a vanilla score as a single-line session), but
    // orchestration is flagged ONLY when the score actually uses session-*
    // markup. All runtime orchestration gates on hasSessionLines, never on
    // graph presence, and `graph` is not persisted (toJSON allowlist) — so
    // vanilla behavior and persisted state are unchanged.
    const graph = buildGraph(sessionFrameAttrs);
    if (graph.hasSessionLines) {
      // Session Lines: per-frame ordered link target indices (resolved against
      // the main frame list). The runtime maps a device's tap on a split frame
      // to a child slot via these. Gated — never built for vanilla scores.
      graph.frameLinks = {};
      for (const { name, attrs } of sessionFrameAttrs) {
        graph.frameLinks[name] = (attrs.hrefs || []).map((href) =>
          listFilesInLowerCase.indexOf(href.toLowerCase()),
        );
      }
    }

    // Session Lines: sub-score frames (gated; a vanilla score has none, and its
    // subs file is removed on publish so build output stays byte-identical).
    const { subFrames, missingSubs } = await this.buildSubFrames(folder, graph);

    // The fingerprint covers everything a connected score page can navigate:
    // main frames, sub-score frames, and sound paths. Persisted in toJSON so a
    // restart can detect edits made while the server was down.
    contentDigest.update(JSON.stringify(soundList));
    for (const score of Object.keys(subFrames).sort()) {
      const sub = subFrames[score];
      contentDigest.update(score);
      contentDigest.update(JSON.stringify(sub.frameList || []));
      contentDigest.update(sub.framesHtml || "");
      contentDigest.update(JSON.stringify(sub.soundList || []));
    }
    const contentHash = contentDigest.digest("hex");

    const aboutSvg = await buildAboutSvgAsync(
      `${folder}/Documentation`,
      "-about-score",
      this.scoreDataDir,
    );

    const sessionTemplate = await fs.promises.readFile(
      `${TEMPLATE_DIR}/session.jade`,
      "utf8",
    );

    const fn = jade.compile(sessionTemplate);
    const html = fn({
      title: `Session: ${folder}`,
      sessionId: this.id,
      scoreTitle: folder,

      msgPing: MESSAGES.MSG_PING,
      msgTap: MESSAGES.MSG_TAP,
      msgShow: MESSAGES.MSG_SHOW,
      msgNeedDisplay: MESSAGES.MSG_NEED_DISPLAY,
      msgUpdateVoting: MESSAGES.MSG_UPDATE_VOTING,
      msgBeginVoting: MESSAGES.MSG_BEGIN_VOTING,
      msgBeginStandby: MESSAGES.MSG_BEGIN_STANDBY,
      msgCheckHold: MESSAGES.MSG_CHECK_HOLD,
      msgBeginHolding: MESSAGES.MSG_BEGIN_HOLDING,
      msgFinish: MESSAGES.MSG_FINISH,
      msgPause: MESSAGES.MSG_PAUSE,
      msgSelectHistory: MESSAGES.MSG_SELECT_HISTORY,
      msgShowNumberConnection: MESSAGES.MSG_SHOW_NUMBER_CONNECTION,
      msgChangeFolder: MESSAGES.MSG_CHANGE_FOLDER,
      msgChangeVolume: MESSAGES.MSG_CHANGE_VOLUME,
      msgGlobalRefresh: MESSAGES.MSG_GLOBAL_REFRESH,

      // Session Lines orchestration protocol (inert for vanilla scores).
      msgLineAssigned: MESSAGES.MSG_LINE_ASSIGNED,
      msgBeginSplit: MESSAGES.MSG_BEGIN_SPLIT,
      msgBarrierWaiting: MESSAGES.MSG_BARRIER_WAITING,
      msgBarrierReleased: MESSAGES.MSG_BARRIER_RELEASED,
      msgSubEnter: MESSAGES.MSG_SUB_ENTER,
      msgSubExit: MESSAGES.MSG_SUB_EXIT,

      defaultAutoplay: JSON.stringify(this.defaultAutoplay),
      enableAutoplayByDefault: JSON.stringify(
        this.enableAutoplayByDefault ?? false,
      ),
      defaultVolume: JSON.stringify(this.defaultVolume),
      fadeDuration: JSON.stringify(this.fadeDuration),
      isHtml5: JSON.stringify(this.isHtml5),
      sessionSvg: contentSvg,
      soundFileList: soundList && JSON.stringify(soundList),
      wsPath: wsPath,
      aboutNestedNotationSvg: aboutNestedNotationSvg,
      aboutScoreSvg: aboutSvg,
      scoreHasAbout: aboutSvg !== null,
      votingSize: this.votingSize,
      qrSharePath: this.qrSharePath,
      listFiles: JSON.stringify(listFiles),
    });

    return {
      folder,
      listFiles,
      listFilesInLowerCase,
      listMultiChooseImages,
      hasSounds,
      soundList,
      graph,
      subFrames,
      missingSubs,
      contentHash,
      contentSvg,
      aboutSvg,
      html,
    };
  }

  // The published copy of one baked file ("html", "content.svg", "subs.json",
  // "about.svg"): the page, content and graph routes all read the revision the
  // live fields describe. Before any publish in this process, the unrevisioned
  // name older builds wrote.
  bundleFile(kind, revision = this.bundleRevision) {
    return revision
      ? `${this.stateDir}/${this.id}.rev-${revision}.${kind}`
      : `${this.stateDir}/${this.id}.${kind}`;
  }

  // Publish a prepared bundle as a new revision. Its files are all written
  // under new names first; the live fields and `bundleRevision` then switch in
  // one synchronous step, so the page, content and graph a reader gets always
  // come from the same build. A failed write switches nothing and leaves no
  // file behind, and the caller's reload notice never goes out. Only after the
  // switch are older revisions removed, keeping the one just replaced for a
  // request that resolved its path a moment before; that cleanup is best
  // effort and never fails the publish (the next publish sweeps again).
  publishScoreBundle(bundle) {
    const run = this.#bundlePublishes.then(() => this.#publishBundle(bundle));
    this.#bundlePublishes = run.catch(() => {});
    return run;
  }

  async #publishBundle(bundle) {
    if (bundle.unavailable) {
      // A missing or emptied score is not a replacement. Once a score is live,
      // finding none (a Frames folder mid-edit, a folder swapped away under
      // the operator) is a failed rebuild: folder, live fields, published
      // revision and the room all stay as they are.
      if (this.bundleRevision != null) {
        throw new ScoreUnavailableError(bundle.folder, bundle.unavailable);
      }
      // With nothing published yet (a new session, a boot), there is no score
      // to keep. The session stays listed with no frames, and the page and
      // content routes refuse it rather than serve older baked files.
      this.folder = bundle.folder;
      this.markScoreUnavailable(bundle.unavailable);
      this.scoreUnavailable = bundle.unavailable;
      return;
    }

    // A sub-score the frames still dive into is part of the score. Once one
    // is live, a replacement without it (the folder moved, emptied or mid-edit)
    // would drop the dive and reset the room for it: a failed rebuild too.
    // Removing the session-sub-start reference is how a sub is retired. With
    // nothing published yet, the score goes live without it, as before.
    if (bundle.missingSubs.length > 0) {
      if (this.bundleRevision != null) {
        throw new ScoreUnavailableError(
          bundle.folder,
          "sub-score",
          bundle.missingSubs,
        );
      }
      for (const { score, reason } of bundle.missingSubs) {
        console.log(
          `Sub-score "${score}" of ${bundle.folder} ${unavailableWhy(reason)}; publishing without it`,
        );
      }
    }

    const revision = newBundleRevision();
    const file = (kind) => this.bundleFile(kind, revision);
    const writes = [
      [file("content.svg"), bundle.contentSvg],
      [file("html"), bundle.html],
    ];

    // A vanilla score has no sub-frame cache at all.
    if (Object.keys(bundle.subFrames).length > 0) {
      // Persist only what the sub route serves (framesHtml/frameList/soundList);
      // the per-sub graph stays in-memory for the runtime.
      const payload = {};
      for (const [score, sub] of Object.entries(bundle.subFrames)) {
        payload[score] = {
          framesHtml: sub.framesHtml,
          frameList: sub.frameList,
          soundList: sub.soundList,
        };
      }
      writes.push([file("subs.json"), JSON.stringify(payload)]);
    }

    if (bundle.aboutSvg) {
      writes.push([file("about.svg"), bundle.aboutSvg]);
    }

    await writeFilesAsNew(writes);

    const previousRevision = this.bundleRevision;
    this.bundleRevision = revision;
    this.scoreUnavailable = null;
    this.folder = bundle.folder;
    this.hasSounds = bundle.hasSounds;
    this.soundList = bundle.soundList;
    this.listFiles = bundle.listFiles;
    this.listFilesInLowerCase = bundle.listFilesInLowerCase;
    this.listMultiChooseImages = bundle.listMultiChooseImages;
    this.graph = bundle.graph;
    this.subFrames = bundle.subFrames;
    this.contentHash = bundle.contentHash;
    if (bundle.graph.hasSessionLines) {
      this.hasSessionLines = true;
    } else {
      // A reloaded score may have DROPPED its session-* markup — clear the
      // stale flag (and the reached registry) so the runtime doesn't keep
      // orchestrating on it; the fresh graph above replaces any stale one.
      this.hasSessionLines = false;
      this.reachedTargets = {};
      this.reachedGranted = [];
      this.latestGroupArrival = null;
    }

    await this.#removeBundleFiles(
      (rev) => rev !== revision && rev !== previousRevision,
    );

    // Last: tooling (and the end-to-end test) reads this line as "published".
    console.log(
      `Finish building svg content... for ${this.folder} with ID ${this.id}`,
    );
  }

  // Remove this session's baked files whose revision `doomed` picks (null is
  // the unrevisioned legacy name). Best effort: a file still open elsewhere or
  // already gone is left for the next sweep.
  async #removeBundleFiles(doomed) {
    const files = await listBundleFiles(this.stateDir, this.id);
    for (const { file, revision } of files) {
      if (!doomed(revision)) continue;
      try {
        await fs.promises.rm(file, { force: true });
      } catch (err) {
        console.warn(`Could not remove old score file ${file}: ${err.message}`);
      }
    }
  }

  // Session Lines: build the on-demand sub-score frame cache. For each sub-score
  // referenced by a session-sub-start, rewrite its frames the same way the main
  // loop does (id/<a> rewrite, resolved WITHIN the sub). Once published it is
  // kept in memory (this.subFrames) and in ${id}.subs.json. A vanilla score has
  // no subs. A referenced sub-score that is missing or has no frames is left
  // out and named in `missingSubs`; publication decides whether that is fatal.
  async buildSubFrames(folder, graph) {
    const subFrames = {};
    const missingSubs = [];
    if (!graph || !graph.hasSessionLines) {
      return { subFrames, missingSubs };
    }

    const scores = [
      ...new Set(
        Object.values(graph.subLinks || {})
          .flat()
          .map((l) => l.score),
      ),
    ];

    for (const score of scores) {
      const built = await this.buildOneSubScore(score, folder);
      if (built.unavailable) {
        missingSubs.push({ score, reason: built.unavailable });
      } else {
        subFrames[score] = built;
      }
    }
    return { subFrames, missingSubs };
  }

  // One sub-score's frame cache, or `{ unavailable: "missing" | "empty" }`.
  // As for the main score, only ENOENT reads as missing; any other lookup
  // error fails the build.
  async buildOneSubScore(score, folder = this.folder) {
    const base = `${this.scoreDataDir}/${folder}/Subscores/${score}`;
    const framesDir = (await pathPresent(`${base}/Frames`))
      ? `${base}/Frames`
      : base;
    if (!(await pathPresent(framesDir))) {
      console.log(`Sub-score frames not found at ${framesDir}`);
      return { unavailable: "missing" };
    }

    const frameList = await readDirSorted(framesDir, { ext: ".svg" });
    if (frameList.length <= 0) {
      return { unavailable: "empty" };
    }
    const frameListLower = frameList.map((f) => f.toLowerCase());

    let soundList = [];
    const soundsDir = `${base}/Sounds`;
    if (await pathPresent(soundsDir)) {
      const files = await readDirSorted(soundsDir, { recursive: true });
      // Normalize EVERY path separator (a single .replace only fixes the first
      // level of nesting on Windows).
      soundList = files.map((f) => String(f).replace(/\\/g, "/"));
    }

    const subAttrs = [];
    let framesHtml = "";

    for (const filename of frameList) {
      const content = await fs.promises.readFile(
        `${framesDir}/${filename}`,
        "utf8",
      );
      subAttrs.push({ name: filename, attrs: parseFrameAttrs(content) });

      let svg = regexWithPattern(content, /<svg.*?<\/svg>/is, 0);
      const svgIndex = frameListLower.indexOf(filename.toLowerCase());
      svg = svg?.replace(
        "<svg",
        `<svg id="sub-${score}-${svgIndex}" class="hidden" file="${filename}" `,
      );

      const listA = svg?.match(/<a.*?>/g);
      listA?.forEach((a, idx) => {
        const matchedHref = HREF_REGX.exec(a)?.[0];
        const aIndex = frameListLower.indexOf(matchedHref?.toLowerCase());
        const newA = a
          .replace(
            "<a",
            `<a id="${aIndex}#${filename}#${idx}" data-next-file-idx="${aIndex}" `,
          )
          .replace(LINK_REGEX, `onclick="handleSelectLink(this)"`);
        svg = svg.replace(a, newA);
      });

      framesHtml += `${svg}\n`;
    }

    const graph = buildGraph(subAttrs);
    graph.frameLinks = {};
    for (const { name, attrs } of subAttrs) {
      graph.frameLinks[name] = (attrs.hrefs || []).map((href) =>
        frameListLower.indexOf(href.toLowerCase()),
      );
    }

    return {
      frameList,
      frameListLower,
      soundList,
      framesHtml,
      graph,
    };
  }

  regexWithPattern(str, pattern, groupId) {
    const match = str.match(pattern);
    if (match === null) {
      return null;
    }

    return match[groupId];
  }

  regexFull(str, patternInStr) {
    return str.match(new RegExp(patternInStr, "gis"));
  }

  randomItem(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  clearAllTimer() {
    // Clear every line's timers (single line until a split).
    for (const line of this.lines) {
      line.clearAllTimer();
    }
  }

  runExclusively(work) {
    const queued = this.#mutations.then(work, work);
    // A failed operation is reported to its own caller but cannot poison the
    // mutation lane for everything queued behind it.
    this.#mutations = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  recordRewind({ kind, frame, lineId, emptied }) {
    const entry = {
      kind: String(kind || "line"),
      frame: frame == null ? null : String(frame),
      at: Date.now(),
      ...(lineId == null ? {} : { lineId: String(lineId) }),
      ...(Array.isArray(emptied) && emptied.length > 0 ? { emptied } : {}),
    };
    this.rewindLog.unshift(entry);
    this.rewindLog.splice(REWIND_LOG_MAX);
    return entry;
  }

  // Versioned persistence allowlist (v2). Serializes session-global fields +
  // lines[] + deviceRegistry, and drops fields buildSVGContent re-derives on
  // load (listFiles*, graph). Timer-nulling / voting-reset happen per-line in
  // BMLine.toJSON.
  toJSON() {
    return {
      version: 2,
      id: this.id,
      ownerId: this.ownerId,
      sessionName: this.sessionName,
      adminPassword: this.adminPassword,
      playerPassword: this.playerPassword,
      folder: this.folder,
      isHtml5: this.isHtml5,
      fadeDuration: this.fadeDuration,
      defaultVolume: this.defaultVolume,
      defaultAutoplay: this.defaultAutoplay,
      enableAutoplayByDefault: this.enableAutoplayByDefault,
      hasSounds: this.hasSounds,
      soundList: this.soundList,
      // Lets boot detect that score files changed while the server was down.
      // Numeric line/snapshot indexes are only meaningful for this exact
      // content hash; buildSVGContent re-derives and compares it on load.
      contentHash: this.contentHash,
      isPause: this.isPause,
      isSessionDeleted: this.isSessionDeleted,
      votingDuration: this.votingDuration,
      holdDuration: this.holdDuration,
      votingSize: this.votingSize,
      standbyDuration: this.standbyDuration,
      synTimeInterval: this.synTimeInterval,
      preloadDuration: this.preloadDuration,
      selectedScoreIndex: this.selectedScoreIndex,
      selectedCooldownTimeIndex: this.selectedCooldownTimeIndex,
      selectedHoldTimeIndex: this.selectedHoldTimeIndex,
      splitEvents: compactPersistedEvents(this.splitEvents, "split"),
      nextSplitEventId: this.nextSplitEventId,
      nextSplitGestureId: this.nextSplitGestureId,
      mergeEvents: compactPersistedEvents(this.mergeEvents, "merge"),
      nextMergeEventId: this.nextMergeEventId,
      rewindLog: this.rewindLog,
      nextStructuralSeq: this.nextStructuralSeq,
      deviceRegistry: this.deviceRegistry,
      reachedTargets: this.reachedTargets,
      reachedGeneration: this.reachedGeneration,
      reachedGranted: this.reachedGranted,
      latestGroupArrival: this.latestGroupArrival,
      lines: this.lines.map((line) => line.toJSON()),
    };
  }

  async saveSessionStateToFile() {
    if (this.isSessionDeleted) {
      return;
    }

    // Snapshot now, publish in turn. fs.writeFile truncates at open and writes
    // afterwards, so two overlapping saves interleave: the shorter payload
    // lands on top of the longer one and the longer one's tail survives past
    // the end of the JSON, leaving a state file the next boot cannot parse.
    // Queueing each save behind the last keeps writes one at a time, and
    // writeFileAtomic keeps the file whole if the process dies mid-save.
    const payload = JSON.stringify(this.toJSON());
    const stateFilePath = `${this.stateDir}/${this.id}.json`;

    this.#stateWrites = this.#stateWrites
      // A failed write must not poison the queue for the saves behind it; the
      // caller that owns the failure still sees it through the await below.
      .catch(() => {})
      .then(() => {
        // The session may have been deleted while this save waited its turn.
        if (this.isSessionDeleted) {
          return undefined;
        }
        return writeFileAtomic(stateFilePath, payload);
      });

    await this.#stateWrites;

    console.log(
      `Write session ${this.sessionName} state to file: ${stateFilePath}`,
    );
  }

  async deleteStateFile() {
    // Latch first, then drain: queued saves re-check this flag before writing,
    // so none of them can resurrect the files removed below.
    this.isSessionDeleted = true;
    await this.#stateWrites.catch(() => {});

    const stateFilePath = `${this.stateDir}/${this.id}.json`;
    if (fs.existsSync(stateFilePath)) {
      await fs.promises.rm(stateFilePath);
    }
    // Every baked revision, the current one included. A publish still under
    // way finishes first, so it cannot leave a revision behind.
    await this.#bundlePublishes;
    await this.#removeBundleFiles(() => true);

    console.log(
      `Deleted session ${this.sessionName} state files: ${stateFilePath} and its baked score`,
    );
  }
}

class BMSessionTable {
  data = [];

  async add(
    sessionId,
    adminId,
    folder,
    sessionName,
    adminpassword,
    playerpassword,
    isHtml5,
    fadeDuration,
    defaultVolume,
    defaultAutoplay,
    enableAutoplayByDefault,
  ) {
    //check folder exist
    const dir = DATA_DIR + "/" + folder;
    if (!fs.existsSync(dir)) {
      console.log(`Unable to get score data at ${dir}`);
      return null;
    }

    const session = new BMSession();
    await session.initState(
      sessionId,
      adminId,
      folder,
      sessionName,
      adminpassword,
      playerpassword,
      isHtml5,
      fadeDuration,
      defaultVolume,
      defaultAutoplay,
      enableAutoplayByDefault,
    );
    await session.saveSessionStateToFile();

    this.data.push(session);
    return session;
  }

  async remove(session) {
    this.data.splice(this.data.indexOf(session), 1);

    await session.deleteStateFile();
  }

  getById(id) {
    return this.data.find((e) => e.id == id);
  }

  getBySessionName(name) {
    return this.data.find((e) => e.sessionName === name);
  }

  async forceSessionStop(session) {
    session.clearAllTimer();

    await this.remove(session);
    console.log(`Session ${session.sessionName} stopped...`);
  }

  // Runs once, from BMDatabase.init() at boot. `stateDir` / `dataDir` let a
  // test restore from a scratch directory against fixture scores.
  async loadStoredSessionStates({
    stateDir = SERVER_STATE_DIR,
    dataDir = null,
  } = {}) {
    // Listings are memoized; read this one as it is now.
    clearDirCacheUnder(stateDir);
    const sessionStateFiles = await readDirSorted(stateDir);

    for (const fileName of sessionStateFiles) {
      // Whole-session snapshots only. The same directory also holds the
      // rendered .html/.content.svg, the ${id}.subs.json sub-frame cache and
      // (after a crash mid-save) a .json.tmp leftover — none of which describe
      // a session, and all of which patchState would happily absorb as junk.
      if (!fileName.endsWith(".json") || fileName.endsWith(".subs.json")) {
        continue;
      }

      const stateFilePath = `${stateDir}/${fileName}`;
      let state;
      try {
        state = JSON.parse(await fs.promises.readFile(stateFilePath, "utf8"));
      } catch (err) {
        // One unreadable file must not cost the operator every other session at
        // boot. Move it aside so it stays recoverable by hand, and carry on.
        const quarantinePath = `${stateFilePath}.corrupt-${Date.now()}`;
        await fs.promises.rename(stateFilePath, quarantinePath);
        console.error(
          `Unreadable session state ${fileName} (${err.message}); moved to ${quarantinePath} and skipped`,
        );
        continue;
      }

      const newSession = new BMSession();
      newSession.stateDir = stateDir;
      if (dataDir) {
        newSession.scoreDataDir = dataDir;
      }
      try {
        // Bring legacy v1 (flat) state up to v2 (lines:[one]) before applying.
        await newSession.patchState(migrateState(state));
        const storedContentHash = newSession.contentHash;
        await newSession.buildSVGContent();

        // A session whose score folder is gone is deleted, not kept (owner):
        // it can never be played again, and its files would only pile up.
        // Only once the removal is confirmed against usable score storage: an
        // unmounted, misconfigured or unreadable data directory, or a score
        // folder that exists but cannot be looked up, deletes nothing.
        if (newSession.scoreUnavailable === "missing") {
          await confirmScoreFolderRemoved(
            newSession.scoreDataDir,
            newSession.folder,
          );
          newSession.clearAllTimer();
          await newSession.deleteStateFile();
          console.log(
            `Session state ${fileName}: score "${newSession.folder}" no longer exists; session deleted`,
          );
          continue;
        }

        const hasStructuralState =
          (newSession.lines || []).length > 1 ||
          (newSession.splitEvents || []).length > 0 ||
          (newSession.mergeEvents || []).length > 0;
        if (
          (storedContentHash && storedContentHash !== newSession.contentHash) ||
          (!storedContentHash && hasStructuralState)
        ) {
          // A pre-fingerprint structural state cannot prove that its numeric
          // positions still describe this score, so expire it once on upgrade.
          newSession.resetForScoreChange();
          await newSession.saveSessionStateToFile();
        }
      } catch (err) {
        // A readable snapshot whose score cannot be built right now (a disk
        // error, a frame being copied) is skipped for this boot but left in
        // place, unlike an unreadable file: the next boot tries it again. The
        // sessions after it still load.
        newSession.clearAllTimer();
        console.error(
          `Session state ${fileName} could not be restored (${err.message}); skipped, file kept`,
        );
        continue;
      }

      this.data.push(newSession);
    }
  }
}

class BMDatabase {
  aboutSvg = "";

  constructor({ hostaddress }) {
    hostAddress = hostaddress;
    this.admin = new BMAdminTable();
    this.sessionTable = new BMSessionTable();
    this.init();

    this.shouldAutoRedirect = false;
    this.autoRedirectSession = "";
    this.autoRedirectPassword = "";

    this.adminUsername = "admin";
    this.adminPassword = "g3tn3st3d";

    this.hostAddress = hostaddress;
    this.MSG_PING = MESSAGES.MSG_PING;
    this.MSG_TAP = MESSAGES.MSG_TAP;
    this.MSG_SHOW = MESSAGES.MSG_SHOW;
    this.MSG_NEED_DISPLAY = MESSAGES.MSG_NEED_DISPLAY;
    this.MSG_UPDATE_VOTING = MESSAGES.MSG_UPDATE_VOTING;
    this.MSG_BEGIN_VOTING = MESSAGES.MSG_BEGIN_VOTING;
    this.MSG_BEGIN_STANDBY = MESSAGES.MSG_BEGIN_STANDBY;
    this.MSG_CHECK_HOLD = MESSAGES.MSG_CHECK_HOLD;
    this.MSG_BEGIN_HOLDING = MESSAGES.MSG_BEGIN_HOLDING;
    this.MSG_FINISH = MESSAGES.MSG_FINISH;
    this.MSG_PAUSE = MESSAGES.MSG_PAUSE;
    this.MSG_SELECT_HISTORY = MESSAGES.MSG_SELECT_HISTORY;
    this.MSG_SHOW_NUMBER_CONNECTION = MESSAGES.MSG_SHOW_NUMBER_CONNECTION;
    this.MSG_CHANGE_VOLUME = MESSAGES.MSG_CHANGE_VOLUME;
    this.MSG_CHANGE_FOLDER = MESSAGES.MSG_CHANGE_FOLDER;
    this.MSG_GLOBAL_REFRESH = MESSAGES.MSG_GLOBAL_REFRESH;

    this.aboutSvg = aboutNestedNotationSvg;
  }

  async init() {
    await this.sessionTable.loadStoredSessionStates();
  }

  dumpToFile(path) {
    var str = "";
    str += (this.shouldAutoRedirect ? "1" : "0") + "\r\n";
    str += this.autoRedirectSession.trim() + "\r\n";
    str += this.autoRedirectPassword.trim() + "\r\n";

    fs.writeFileSync(path, str, "utf8");
  }

  getListScore() {
    var listFiles = readDirSortedSync(DATA_DIR);
    var scoreList = [];
    for (var i = 0; i < listFiles.length; i++) {
      var path = DATA_DIR + "/" + listFiles[i];
      if (fs.lstatSync(path).isDirectory()) {
        scoreList.push(listFiles[i]);
      }
    }
    return scoreList;
  }
}

module.exports = BMDatabase;
// Additive named exports for offline tooling/tests (no behavior change).
module.exports.BMSession = BMSession;
module.exports.BMSessionTable = BMSessionTable;
module.exports.SERVER_STATE_DIR = SERVER_STATE_DIR;
module.exports.DATA_DIR = DATA_DIR;
module.exports.wsPath = wsPath;
