const { MESSAGES, ABOUT_DATA_DIR } = require("./constants");
const fs = require("fs");

const jade = require("jade");

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

const regexWithPattern = (str, pattern, groupId) => {
  const match = str.match(pattern);
  if (match === null) {
    return null;
  }

  return match[groupId];
};

const buildAboutSvgAsync = async (contentDir, svgIdSuffix) => {
  const dir = `${DATA_DIR}/${contentDir}`;
  if (!fs.existsSync(dir)) {
    console.log(`${dir} not found`);
    return null;
  }

  let fileList = await fs.promises.readdir(dir);
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
      `<svg id="${filename}${svgIdSuffix}" class="hidden" file="${filename}" `
    );

    svgContent += `${svg}\n`;
  }

  console.log(
    `Finish building about/document svg content... for ${contentDir}`
  );
  return svgContent;
};

const buildAboutSvg = (contentDir, svgIdSuffix) => {
  const dir = `${DATA_DIR}/${contentDir}`;
  if (!fs.existsSync(dir)) {
    console.log(`${dir} not found`);
    return null;
  }

  let fileList = fs.readdirSync(dir);
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
      `<svg id="${filename}${svgIdSuffix}" class="hidden" file="${filename}" `
    );

    svgContent += `${svg}\n`;
  });

  console.log(
    `Finish building about/document svg content... for ${contentDir}`
  );
  return svgContent;
};

let hostAddress = null;
const aboutNestedNotationSvg = buildAboutSvg(ABOUT_DATA_DIR, "-about-nn");

const serverIp = process.env.SERVER_IP;
const wsPath = `wss://${serverIp}`;
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
  history = [];
  historyIndex = 0;

  selectedScoreIndex = -1;
  selectedCooldownTimeIndex = -1;
  selectedHoldTimeIndex = -1;

  currentEndTimeStamp = 0;
  currentVotingDuration = 0;

  currentEndHoldTimeStamp = 0;
  currentHoldingDuration = 0;

  currentIndex = 0;

  isHolding = false;
  isPause = false;
  isVoting = false;
  isStandby = false;
  isSessionDeleted = false;

  holdingTimer = null;
  standbyTimer = null;
  votingTimer = null;

  synTimeInterval = 0.5;
  standbyDuration = 3;
  holdDuration = 0;
  votingDuration = 10;
  votingSize = 100;
  hasSounds = false;

  checkScoreHasSounds(score) {
    const dir = `${DATA_DIR}/${score}`;

    if (!fs.existsSync(dir)) {
      return;
    }

    const fileList = fs.readdirSync(dir);
    return fileList.includes("Sounds") && fileList.includes("Frames");
  }

  async patchState(stateData, saveToFile = false) {
    for (const [key, val] of Object.entries(stateData)) {
      if (IGNORE_STATE_KEYS.includes(key)) {
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
    fadeDuration = 1000
  ) {
    this.id = id;
    this.ownerId = adminId;
    this.sessionName = sessionName;
    this.adminPassword = adminpassword;
    this.playerPassword = playerpassword;

    this.isHtml5 = isHtml5;
    this.fadeDuration = fadeDuration;

    this.folder = folder;

    this.hasSounds = this.checkScoreHasSounds(folder);
    this.soundList = this.hasSounds ? await this.getSoundList(folder) : [];

    await this.buildSVGContent();

    if (this.listFiles.length <= 0) {
      return;
    }

    // random pick first index (files begin with Pre or Start)
    const listPreFile = this.listFiles.filter((o) => o.startsWith("PRE"));
    const listStartFile = this.listFiles.filter((o) => o.startsWith("START"));
    const startedFile = this.randomItem(
      listStartFile.length > 0 ? listStartFile : listPreFile
    );

    this.setCurrentIndexTo(this.listFiles.indexOf(startedFile));
  }

  async reloadScore(folderName) {
    this.folder = folderName;
    this.hasSounds = this.checkScoreHasSounds(folderName);

    this.soundList = this.hasSounds ? await this.getSoundList(folderName) : [];

    await this.buildSVGContent();

    if (this.listFiles.length <= 0) {
      return;
    }

    //random pick first index (files begin with Pre or Start)
    const listPreFile = this.listFiles.filter((o) => o.startsWith("PRE"));
    const listStartFile = this.listFiles.filter((o) => o.startsWith("START"));
    const startedFile = this.randomItem(
      listStartFile.length > 0 ? listStartFile : listPreFile
    );

    this.setCurrentIndexTo(this.listFiles.indexOf(startedFile));
  }

  setCurrentIndexTo(index) {
    this.currentIndex = parseInt(index);
    this.isVoting = false;
    this.isStandby = false;

    if (this.history.length > 0) {
      const countRemove = Math.max(
        0,
        this.history.length - (this.historyIndex + 1)
      );
      const indexRemove = Math.min(
        this.history.length - 1,
        this.historyIndex + 1
      );

      if (countRemove > 0) {
        this.history.splice(indexRemove - 1, countRemove + 1);
      }
    }

    this.history.push(this.listFiles[index]);
    this.historyIndex = this.history.length - 1;
  }

  async getSoundList(folder) {
    const dir = `${DATA_DIR}/${folder}/Sounds`;
    if (!fs.existsSync(dir)) {
      return [];
    }

    return await fs.promises.readdir(dir);
  }

  async buildSVGContent() {
    const dir = this.hasSounds
      ? `${DATA_DIR}/${this.folder}/Frames`
      : `${DATA_DIR}/${this.folder}`;
    if (!fs.existsSync(dir)) {
      return;
    }

    this.listFiles = await fs.promises.readdir(dir);
    if (this.listFiles.length <= 0) {
      return;
    }

    this.listFilesInLowerCase = this.listFiles.map((fileName) =>
      fileName.toLowerCase()
    );

    this.listMultiChooseImages = [];

    const svgFilePath = `${SERVER_STATE_DIR}/${this.id}.content.svg`;
    if (fs.existsSync(svgFilePath)) {
      await fs.promises.rm(svgFilePath);
    }

    for (const filename of this.listFiles) {
      const filePath = `${dir}/${filename}`;
      const content = await fs.promises.readFile(filePath, "utf8");
      let svg = regexWithPattern(content, /<svg.*?<\/svg>/is, 0);
      const svgIndex = this.listFilesInLowerCase.indexOf(
        filename.toLowerCase()
      );
      svg = svg.replace(
        "<svg",
        `<svg id="svg${svgIndex}" class="hidden" file="${filename}" `
      );

      const listA = svg.match(/<a.*?>/g);
      if (listA === null) {
        return;
      }

      if (listA.length > 1 && !filename.startsWith("PRE")) {
        this.listMultiChooseImages.push(svgIndex);
      }

      listA.forEach((a, idx) => {
        const matchedHref = HREF_REGX.exec(a)?.[0];
        const aIndex = this.listFilesInLowerCase.indexOf(
          matchedHref?.toLowerCase()
        );
        let newA = a
          .replace(
            "<a",
            `<a id="${aIndex}#${filename}#${idx}" data-next-file-idx="${aIndex}" `
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

      await fs.promises.appendFile(
        `${SERVER_STATE_DIR}/${this.id}.content.svg`,
        svg
      );
    }

    const aboutSvg = await buildAboutSvgAsync(
      `${this.folder}/Documentation`,
      "-about-score"
    );

    if (aboutSvg) {
      await fs.promises.writeFile(
        `${SERVER_STATE_DIR}/${this.id}.about.svg`,
        aboutSvg
      );
    }

    const sessionTemplate = await fs.promises.readFile(
      `${TEMPLATE_DIR}/session.jade`,
      "utf8"
    );

    const fn = jade.compile(sessionTemplate);
    const html = fn({
      title: `Session: ${this.folder}`,
      sessionId: this.id,
      noSleepDuration: 60,
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

      fadeDuration: JSON.stringify(this.fadeDuration),
      isHtml5: JSON.stringify(this.isHtml5),
      sessionSvg: await fs.promises.readFile(
        `${SERVER_STATE_DIR}/${this.id}.content.svg`,
        "utf8"
      ),
      soundFileList: this.soundList && JSON.stringify(this.soundList),
      wsPath: wsPath,
      aboutNestedNotationSvg: aboutNestedNotationSvg,
      aboutScoreSvg: aboutSvg,
      scoreHasAbout: aboutSvg !== null,
      votingSize: this.votingSize,
      qrSharePath: `/session/${this.id}/?p=${encodeURIComponent(
        this.playerPassword
      )}&t=2`,
      listFiles: JSON.stringify(this.listFiles),
    });

    await fs.promises.writeFile(`${SERVER_STATE_DIR}/${this.id}.html`, html);

    console.log(
      `Finish building svg content... for ${this.folder} with ID ${this.id}`
    );
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
    //stop holding timer
    if (this.holdingTimer != null) {
      clearTimeout(this.holdingTimer);
      this.holdingTimer = null;
    }
    //stop standby timer
    if (this.standbyTimer != null) {
      clearTimeout(this.standbyTimer);
      this.standbyTimer = null;
    }
    //stop voting timer
    if (this.votingTimer != null) {
      clearInterval(this.votingTimer);
      this.votingTimer = null;
    }
  }

  async saveSessionStateToFile() {
    if (this.isSessionDeleted) {
      return;
    }

    const clonedData = { ...this };
    clonedData.votingTimer = null;
    clonedData.standbyTimer = null;
    clonedData.holdingTimer = null;
    clonedData.isVoting = false;

    const stateFilePath = `${SERVER_STATE_DIR}/${this.id}.json`;
    await fs.promises.writeFile(stateFilePath, JSON.stringify(clonedData));

    console.log(
      `Write session ${this.sessionName} state to file: ${stateFilePath}`
    );
  }

  async deleteStateFile() {
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

    this.isSessionDeleted = true;
    console.log(
      `Deleted session ${this.sessionName} state files: ${stateFilePath}, ${htmlFilePath}, ${svgFilePath}`
    );
  }
}

class BMSessionTable {
  data = [];

  constructor() {
    this.loadStoredSessionStates();
  }

  async add(
    sessionId,
    adminId,
    folder,
    sessionName,
    adminpassword,
    playerpassword,
    isHtml5,
    fadeDuration
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
      fadeDuration
    );
    await session.saveSessionStateToFile();

    this.data.push(session);
    return session;
  }

  remove(session) {
    this.data.splice(this.data.indexOf(session), 1);

    session.deleteStateFile();
  }

  getById(id) {
    return this.data.find((e) => e.id == id);
  }

  getBySessionName(name) {
    return this.data.find((e) => e.sessionName.trim() === name);
  }

  forceSessionStop(session) {
    session.clearAllTimer();

    this.remove(session);
    console.log(`Session ${session.sessionName} stopped...`);
  }

  async loadStoredSessionStates() {
    const sessionStateFiles = await fs.promises.readdir(SERVER_STATE_DIR, {
      withFileTypes: true,
    });

    for (const file of sessionStateFiles) {
      if (file.name.endsWith(".html") || file.name.endsWith(".svg")) {
        continue;
      }

      const newSession = new BMSession();
      const state = JSON.parse(
        await fs.promises.readFile(`${SERVER_STATE_DIR}/${file.name}`, "utf8")
      );
      await newSession.patchState(state);
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

    this.aboutSvg = aboutNestedNotationSvg;
  }

  dumpToFile(path) {
    var str = "";
    str += (this.shouldAutoRedirect ? "1" : "0") + "\r\n";
    str += this.autoRedirectSession.trim() + "\r\n";
    str += this.autoRedirectPassword.trim() + "\r\n";

    fs.writeFileSync(path, str, "utf8");
  }

  getListScore() {
    var listFiles = fs.readdirSync(DATA_DIR);
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
