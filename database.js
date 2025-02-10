const { MESSAGES } = require("./constants");
const fs = require("fs");

const HREF_REGX = /(?<=href=")(.*?)(?=")/;
const LINK_REGEX = /((xlink:href)|(href))="(.*?)"/;

let prefixDir = ".";
const testPrefixFile = prefixDir + "/account/admin.dat";
if (!fs.existsSync(testPrefixFile)) {
  prefixDir = "..";
}
const DATA_DIR = `${prefixDir}/data`;

const SERVER_STATE_DIR = `${prefixDir}/server_state`;
const SESSIONS_FILE = `${SERVER_STATE_DIR}/sessions.json`;
if (!fs.existsSync(SERVER_STATE_DIR)) {
  fs.mkdirSync(SERVER_STATE_DIR);
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify([]), { encoding: "utf8" });
}

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

  votingDuration = 0;

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

  holdingTimer = null;
  standbyTimer = null;
  votingTimer = null;

  synTimeInterval = 0.5;
  standbyDuration = 3;
  holdDuration = 0;
  votingDuration = 10;

  constructor() {}

  checkScoreHasSounds(score) {
    const dir = `${DATA_DIR}/${score}`;

    if (!fs.existsSync(dir)) {
      return;
    }

    const fileList = fs.readdirSync(dir);
    return fileList.includes("Sounds") && fileList.includes("Frames");
  }

  patchState(stateData) {
    for (const [key, val] of Object.entries(stateData)) {
      this[key] = val;
    }
  }

  // this use listFiles generate from buildSVGContent. So run it after that method
  initState(
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
    this.soundList = this.hasSounds ? this.getSoundList(folder) : [];

    this.buildSVGContent();

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

  reloadScore(folderName) {
    this.folder = folderName;
    this.hasSounds = this.checkScoreHasSounds(folderName);

    this.soundList = this.hasSounds ? this.getSoundList(folderName) : [];

    this.buildSVGContent();

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

  getSoundList(folder) {
    const dir = `${DATA_DIR}/${folder}/Sounds`;
    if (!fs.existsSync(dir)) {
      return [];
    }

    return fs.readdirSync(dir);
  }

  buildSVGContent() {
    const dir = this.hasSounds
      ? `${DATA_DIR}/${this.folder}/Frames`
      : `${DATA_DIR}/${this.folder}`;
    if (!fs.existsSync(dir)) {
      return;
    }

    this.listFiles = fs.readdirSync(dir);
    if (this.listFiles.length <= 0) {
      return;
    }

    this.listFilesInLowerCase = this.listFiles.map((fileName) =>
      fileName.toLowerCase()
    );

    this.listPreImages = [];
    this.listMultiChooseImages = [];
    this.svgContent = "";

    this.listFiles.forEach((filename) => {
      const filePath = `${dir}/${filename}`;
      const content = fs.readFileSync(filePath, "utf8");
      let svg = this.regexWithPattern(content, /<svg.*?<\/svg>/is, 0);
      const svgIndex = this.listFilesInLowerCase.indexOf(
        filename.toLowerCase()
      );
      svg = svg.replace(
        "<svg",
        `<svg id="svg${svgIndex}" class="hidden" file="${filename}" `
      );

      if (filename.startsWith("PRE") || filename.startsWith("START")) {
        this.listPreImages.push(svgIndex);
      }

      const listA = svg.match(/<a.*?>/g);
      if (listA === null) {
        return;
      }
      if (listA.length > 1 && !filename.startsWith("PRE")) {
        this.listMultiChooseImages.push(svgIndex);
      }

      listA.forEach((a) => {
        const matchedHref = HREF_REGX.exec(a)?.[0];
        const aIndex = this.listFilesInLowerCase.indexOf(
          matchedHref?.toLowerCase()
        );
        let newA = a.replace(LINK_REGEX, `href="javascript:tapOn(${aIndex});"`);
        svg = svg.replace(a, newA);

        if (filename.startsWith("PRE")) {
          return;
        }

        newA = newA.replace(" ", "\\s*");
        newA = newA.replace("(", "\\(");
        newA = newA.replace(")", "\\)");

        let pattern = `${newA}.*?serif:id="Ring and Background".*?>.*?<ellipse.*?/>.*?(<ellipse.*?/>)`;
        let ellipse = this.regexWithPattern(svg, new RegExp(pattern, "is"), 1);
        if (ellipse != null) {
          //add elipse
          const cx = parseFloat(
            this.regexWithPattern(ellipse, /<ellipse.*?cx="(.*?)"/is, 1)
          );
          const cy = parseFloat(
            this.regexWithPattern(ellipse, /<ellipse.*?cy="(.*?)"/is, 1)
          );
          const rx =
            parseFloat(
              this.regexWithPattern(ellipse, /<ellipse.*?rx="(.*?)"/is, 1)
            ) * 0.9126;
          const ry =
            parseFloat(
              this.regexWithPattern(ellipse, /<ellipse.*?rx="(.*?)"/is, 1)
            ) * 0.9126;
          const style = this.regexWithPattern(
            ellipse,
            /<ellipse.*?style="(.*?)"/is,
            1
          );
          const ellipseId = `${svgIndex}-${aIndex}`;
          ellipse = this.regexWithPattern(svg, new RegExp(pattern, "is"), 0);

          const newEllipse = `${ellipse}\r\n<ellipse id="${ellipseId}" class="hidden" cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" style="${style}"></ellipse>`;
          svg = svg.replace(ellipse, newEllipse);

          //add text area
          pattern = `${newA}(.*?serif:id="Ring and Background".*?)<g id="Notes`;
          const midGap = this.regexWithPattern(
            svg,
            new RegExp(pattern, "is"),
            1
          );
          const textId = `ta-${svgIndex}-${aIndex}`;

          const newTextArea = `${midGap}\r\n<g xmlns="http://www.w3.org/2000/svg" transform="matrix(-3.99305,0,0,-3.99305,0,0)">\r\n<text id="${textId}" x="-212.19" y="-231.138" style="font-family:\'ArialMT\', \'Arial\', sans-serif; font-size: 72px; fill-opacity: 1.0;"></text>\r\n</g>\r\n`;
          svg = svg.replace(midGap, newTextArea);
        }

        pattern = `${newA}.*?<g[^>]*?id="Notes.*?>(.*?</g>[^<]*?</g>)`;
        const notesEllipse = this.regexWithPattern(
          svg,
          new RegExp(pattern, "is"),
          1
        );
        if (notesEllipse === null) {
          return;
        }

        const listEllipse = this.regexFull(notesEllipse, "<ellipse[^>]*?>");
        if (listEllipse === null) {
          return;
        }

        for (let i = 0; i < listEllipse.length; i++) {
          const oldEllipse = listEllipse[i];
          const part = oldEllipse.match(
            /(<ellipse[^>]*?)(style=".*?fill:rgb\((.*?),(.*?),(.*?)\).*?")([^>]*?>)/is
          );
          if (part != null) {
            const newEllipse = `${part[1]}id="dot${svgIndex}" r="${part[3]}" g="${part[4]}" b="${part[5]}" ${part[2]}${part[6]}`;
            svg = svg.replace(oldEllipse, newEllipse);
          }
        }
      });

      this.svgContent += `${svg}\n`;
    });
    //final

    console.log(`finish building svg content... for ${this.folder}`);
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

  forceReset() {
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
}

class BMSessionTable {
  constructor() {
    const savedData = JSON.parse(
      fs.readFileSync(SESSIONS_FILE, { encoding: "utf8" })
    );
    this.data = savedData.map((d) => {
      const session = new BMSession();
      session.patchState(d);

      return session;
    });
  }

  add(
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
      return null;
    }

    const s = new BMSession();
    s.initState(
      Date.now(),
      adminId,
      folder,
      sessionName,
      adminpassword,
      playerpassword,
      isHtml5,
      fadeDuration
    );

    this.data.push(s);
    return s;
  }

  remove(session) {
    this.data.splice(this.data.indexOf(session), 1);

    const sessionCachePath = `${SERVER_STATE_DIR}/${session.id}.json`;
    if (fs.existsSync(sessionCachePath)) {
      fs.rmSync(sessionCachePath);
    }
  }

  getById(id) {
    return this.data.find((e) => e.id == id);
  }

  getBySessionName(name) {
    return this.data.find((e) => e.sessionName.trim() == name);
  }

  forceSessionStop(session) {
    session.forceReset();

    this.sessionTable.remove(session);
    console.log("session stopped...");
  }
}

class BMDatabase {
  constructor({ hostaddress }) {
    this.admin = new BMAdminTable();
    this.sessionTable = new BMSessionTable();
    this.shouldAutoRedirect = false;
    this.autoRedirectSession = "";
    this.autoRedirectPassword = "";

    this.adminUsername = "admin";
    this.adminPassword = "g3tn3st3d";

    this.wsPort = process.env.WS_PORT;
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
