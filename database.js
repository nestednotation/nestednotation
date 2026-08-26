const { MESSAGES, ABOUT_DATA_DIR } = require("./constants");
const fs = require("fs");
const crypto = require("crypto");

const jade = require("jade");

// Every directory read goes through here: fs.readdir's raw order is
// filesystem-dependent, and frame position is load-bearing (svg<N> ids,
// data-next-file-idx, the persisted currentIndex).
const { readDirSorted, readDirSortedSync } = require("./utils/readDir");

// Session Lines: pure graph builder (no behavior change for vanilla scores).
const { parseFrameAttrs } = require("./lib/session-lines/parse");
const { buildGraph } = require("./lib/session-lines/graph");
// Session Lines: per-playhead line model + persistence helpers.
const { BMLine, migrateState } = require("./lib/session-lines/line");

const IGNORE_STATE_KEYS = ["svgContent", "htmlContent"];
const HREF_REGX = /(?<=href=")(.*?)(?=")/;
const LINK_REGEX = /((xlink:href)|(href))="(.*?)"/;

let prefixDir = ".";
const testPrefixFile = prefixDir + "/account/admin.dat";
if (!fs.existsSync(testPrefixFile)) {
  prefixDir = "..";
}
const DATA_DIR = `${prefixDir}/public/data`;
const TEMPLATE_DIR = `${prefixDir}/views`;

const SERVER_STATE_DIR = `${prefixDir}/server_state`;
if (!fs.existsSync(SERVER_STATE_DIR)) {
  fs.mkdirSync(SERVER_STATE_DIR);
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

  // Session Lines: the playhead(s). A session always has >= 1 line; until a
  // split occurs it has exactly one (`lines[0]`). The per-line fields that used
  // to live flat on BMSession are now owned entirely by BMLine — the runtime
  // (bin/www) reads/writes them through the line object (`line.currentIndex`
  // etc.), and BMSession's own playhead helpers below delegate to `lines[0]`.
  lines = [new BMLine(this)];
  nextLineId = 1;
  // Structural split history used by the score map's "undo split" operation.
  // Events are append-only (active → undone) so ids remain race-safe across
  // restarts and repeated visits to the same split frame.
  splitEvents = [];
  nextSplitEventId = 1;
  deviceRegistry = {};
  // Rendezvous barriers (#6): session-global registry of frame refs reached by
  // any line — { "<lower ref>": "arrived" | "done" }. Sub frames use the
  // qualified "score/frame" form. Only written on session-lines scores.
  reachedTargets = {};
  // SM-jump rewind generation (S2 option (b), decided 2026-07-07): bumped on
  // every session-lines history jump, when the registry above is restarted so
  // replayed barriers gate like first passes.
  reachedGeneration = 0;
  // Decision #13 revision (2026-07-18): the newest main-flow track-group
  // landing ({ frame, at }) — dormant-line revivals fast-forward to this
  // group instead of resuming their frozen position. Cleared on rewind
  // (beginReachedGeneration) and when a reloaded score drops its markup.
  latestGroupArrival = null;

  selectedScoreIndex = -1;
  selectedCooldownTimeIndex = -1;
  selectedHoldTimeIndex = -1;

  isPause = false;
  isSessionDeleted = false;

  // Serializes this session's state-file writes; see saveSessionStateToFile.
  #stateWrites = Promise.resolve();

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

    this.hasSounds = this.checkScoreHasSounds(folder);
    this.soundList = this.hasSounds ? await this.getSoundList(folder) : [];

    await this.buildSVGContent();

    if (this.listFiles.length <= 0) {
      return;
    }

    this.setCurrIdxToStart();
  }

  async reloadScore(folderName) {
    this.folder = folderName;
    this.hasSounds = this.checkScoreHasSounds(folderName);

    this.soundList = this.hasSounds ? await this.getSoundList(folderName) : [];

    await this.buildSVGContent();

    if (this.listFiles.length <= 0) {
      return;
    }

    this.setCurrIdxToStart();
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

  async buildSVGContent() {
    const scoreDir = `${this.scoreDataDir}/${this.folder}`;
    const framesDir = `${scoreDir}/Frames`;
    const dir = fs.existsSync(framesDir) ? framesDir : scoreDir;
    if (!fs.existsSync(dir)) {
      return;
    }

    this.listFiles = await readDirSorted(dir);

    if (this.listFiles.length <= 0) {
      return;
    }

    this.listFilesInLowerCase = this.listFiles.map((fileName) =>
      fileName.toLowerCase(),
    );

    this.listMultiChooseImages = [];

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

    const svgFilePath = `${SERVER_STATE_DIR}/${this.id}.content.svg`;
    if (fs.existsSync(svgFilePath)) {
      await fs.promises.rm(svgFilePath);
    }

    for (const filename of this.listFiles) {
      const filePath = `${dir}/${filename}`;
      const content = await fs.promises.readFile(filePath, "utf8");
      sessionFrameAttrs.push({
        name: filename,
        attrs: parseFrameAttrs(content),
      });
      let svg = regexWithPattern(content, /<svg.*?<\/svg>/is, 0);
      const svgIndex = this.listFilesInLowerCase.indexOf(
        filename.toLowerCase(),
      );
      svg = svg?.replace(
        "<svg",
        `<svg id="svg${svgIndex}" class="hidden" file="${filename}" `,
      );

      const listA = svg?.match(/<a.*?>/g);

      if (listA?.length > 1 && !filename.startsWith("PRE")) {
        this.listMultiChooseImages.push(svgIndex);
      }

      listA?.forEach((a, idx) => {
        const matchedHref = HREF_REGX.exec(a)?.[0];
        const aIndex = this.listFilesInLowerCase.indexOf(
          matchedHref?.toLowerCase(),
        );
        let newA = a
          .replace(
            "<a",
            `<a id="${aIndex}#${filename}#${idx}" data-next-file-idx="${aIndex}" `,
          )
          .replace(LINK_REGEX, `onclick="handleSelectLink(this)"`);
        svg = svg.replace(a, newA);

        if (filename.startsWith("PRE")) {
          return;
        }

        newA = newA.replace(" ", "\\s*");
        newA = newA.replace("(", "\\(");
        newA = newA.replace(")", "\\)");
      });

      contentDigest.update(filename);
      contentDigest.update(svg ?? "");

      await fs.promises.appendFile(
        `${SERVER_STATE_DIR}/${this.id}.content.svg`,
        svg,
      );
    }

    // Not persisted (toJSON allowlist) — buildSVGContent re-derives it on load,
    // exactly like listFiles and graph.
    this.contentHash = contentDigest.digest("hex");

    // Session Lines: the relationship graph is built for EVERY score (the
    // admin score map treats a vanilla score as a single-line session), but
    // orchestration is flagged ONLY when the score actually uses session-*
    // markup. All runtime orchestration gates on hasSessionLines, never on
    // graph presence, and `graph` is not persisted (toJSON allowlist) — so
    // vanilla behavior and persisted state are unchanged.
    const sessionGraph = buildGraph(sessionFrameAttrs);
    this.graph = sessionGraph;
    if (sessionGraph.hasSessionLines) {
      // Session Lines: per-frame ordered link target indices (resolved against
      // the main frame list). The runtime maps a device's tap on a split frame
      // to a child slot via these. Gated — never built for vanilla scores.
      sessionGraph.frameLinks = {};
      for (const { name, attrs } of sessionFrameAttrs) {
        sessionGraph.frameLinks[name] = (attrs.hrefs || []).map((href) =>
          this.listFilesInLowerCase.indexOf(href.toLowerCase()),
        );
      }
      this.hasSessionLines = true;
    } else {
      // A reloaded score may have DROPPED its session-* markup — clear the
      // stale flag (and the reached registry) so the runtime doesn't keep
      // orchestrating on it; the fresh graph above replaces any stale one.
      this.hasSessionLines = false;
      this.reachedTargets = {};
      this.latestGroupArrival = null;
    }

    // Session Lines: build sub-score frames on demand cache (gated; the file is
    // removed for vanilla scores so build output stays byte-identical).
    await this.buildSubFramesContent(sessionGraph);

    const aboutSvg = await buildAboutSvgAsync(
      `${this.folder}/Documentation`,
      "-about-score",
      this.scoreDataDir,
    );

    if (aboutSvg) {
      await fs.promises.writeFile(
        `${SERVER_STATE_DIR}/${this.id}.about.svg`,
        aboutSvg,
      );
    }

    const sessionTemplate = await fs.promises.readFile(
      `${TEMPLATE_DIR}/session.jade`,
      "utf8",
    );

    const fn = jade.compile(sessionTemplate);
    const html = fn({
      title: `Session: ${this.folder}`,
      sessionId: this.id,
      scoreTitle: this.folder,

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
      sessionSvg: await fs.promises.readFile(
        `${SERVER_STATE_DIR}/${this.id}.content.svg`,
        "utf8",
      ),
      soundFileList: this.soundList && JSON.stringify(this.soundList),
      wsPath: wsPath,
      aboutNestedNotationSvg: aboutNestedNotationSvg,
      aboutScoreSvg: aboutSvg,
      scoreHasAbout: aboutSvg !== null,
      votingSize: this.votingSize,
      qrSharePath: this.qrSharePath,
      listFiles: JSON.stringify(this.listFiles),
    });

    await fs.promises.writeFile(`${SERVER_STATE_DIR}/${this.id}.html`, html);

    console.log(
      `Finish building svg content... for ${this.folder} with ID ${this.id}`,
    );
  }

  // Session Lines: build the on-demand sub-score frame cache. For each sub-score
  // referenced by a session-sub-start, rewrite its frames the same way the main
  // loop does (id/<a> rewrite, resolved WITHIN the sub) and keep them in memory
  // (this.subFrames) plus a ${id}.subs.json the sub route streams. Gated: a
  // vanilla score builds NO subs file (removed if stale), so HTML stays
  // byte-identical.
  async buildSubFramesContent(graph) {
    const subsFile = `${SERVER_STATE_DIR}/${this.id}.subs.json`;
    this.subFrames = {};

    if (!graph || !graph.hasSessionLines) {
      if (fs.existsSync(subsFile)) {
        await fs.promises.rm(subsFile);
      }
      return;
    }

    const scores = [
      ...new Set(
        Object.values(graph.subLinks || {})
          .flat()
          .map((l) => l.score),
      ),
    ];

    for (const score of scores) {
      const built = await this.buildOneSubScore(score);
      if (built) {
        this.subFrames[score] = built;
      }
    }

    if (Object.keys(this.subFrames).length > 0) {
      // Persist only what the sub route serves (framesHtml/frameList/soundList);
      // the per-sub graph stays in-memory for the runtime.
      const payload = {};
      for (const [score, sub] of Object.entries(this.subFrames)) {
        payload[score] = {
          framesHtml: sub.framesHtml,
          frameList: sub.frameList,
          soundList: sub.soundList,
        };
      }
      await fs.promises.writeFile(subsFile, JSON.stringify(payload));
    } else if (fs.existsSync(subsFile)) {
      await fs.promises.rm(subsFile);
    }
  }

  async buildOneSubScore(score) {
    const base = `${this.scoreDataDir}/${this.folder}/Subscores/${score}`;
    const framesDir = fs.existsSync(`${base}/Frames`) ? `${base}/Frames` : base;
    if (!fs.existsSync(framesDir)) {
      console.log(`Sub-score frames not found at ${framesDir}`);
      return null;
    }

    const frameList = await readDirSorted(framesDir, { ext: ".svg" });
    if (frameList.length <= 0) {
      return null;
    }
    const frameListLower = frameList.map((f) => f.toLowerCase());

    let soundList = [];
    const soundsDir = `${base}/Sounds`;
    if (fs.existsSync(soundsDir)) {
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
      nextLineId: this.nextLineId,
      splitEvents: this.splitEvents,
      nextSplitEventId: this.nextSplitEventId,
      deviceRegistry: this.deviceRegistry,
      reachedTargets: this.reachedTargets,
      reachedGeneration: this.reachedGeneration,
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
    const stateFilePath = `${SERVER_STATE_DIR}/${this.id}.json`;

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

    const stateFilePath = `${SERVER_STATE_DIR}/${this.id}.json`;
    if (fs.existsSync(stateFilePath)) {
      await fs.promises.rm(stateFilePath);
    }
    const htmlFilePath = `${SERVER_STATE_DIR}/${this.id}.html`;
    if (fs.existsSync(htmlFilePath)) {
      await fs.promises.rm(htmlFilePath);
    }

    const svgFilePath = `${SERVER_STATE_DIR}/${this.id}.content.svg`;
    if (fs.existsSync(svgFilePath)) {
      await fs.promises.rm(svgFilePath);
    }

    const aboutSvgFilePath = `${SERVER_STATE_DIR}/${this.id}.about.svg`;
    if (fs.existsSync(aboutSvgFilePath)) {
      await fs.promises.rm(aboutSvgFilePath);
    }

    console.log(
      `Deleted session ${this.sessionName} state files: ${stateFilePath}, ${htmlFilePath}, ${svgFilePath}`,
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

  async loadStoredSessionStates() {
    // Runs once, from BMDatabase.init() at boot. The listing is memoized, so a
    // second call would not see sessions created/deleted since — clearDirCache
    // (SERVER_STATE_DIR) first if this ever needs to run again.
    const sessionStateFiles = await readDirSorted(SERVER_STATE_DIR);

    for (const fileName of sessionStateFiles) {
      // Whole-session snapshots only. The same directory also holds the
      // rendered .html/.content.svg, the ${id}.subs.json sub-frame cache and
      // (after a crash mid-save) a .json.tmp leftover — none of which describe
      // a session, and all of which patchState would happily absorb as junk.
      if (!fileName.endsWith(".json") || fileName.endsWith(".subs.json")) {
        continue;
      }

      const stateFilePath = `${SERVER_STATE_DIR}/${fileName}`;
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
      // Bring legacy v1 (flat) state up to v2 (lines:[one]) before applying.
      await newSession.patchState(migrateState(state));
      await newSession.buildSVGContent();

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
module.exports.SERVER_STATE_DIR = SERVER_STATE_DIR;
module.exports.DATA_DIR = DATA_DIR;
module.exports.wsPath = wsPath;
