const { MESSAGES } = require("./constants");
const fs = require("fs");

const HREF_REGX = /(?<=href=")(.*?)(?=")/;
const LINK_REGEX = /((xlink:href)|(href))="(.*?)"/;

const DATA_DIR = "./data";

class BMAdmin {
  constructor(id, name, password, isActive) {
    this.id = id;
    this.name = name;
    this.password = password;
    this.isActive = isActive;
  }
}

class BMSession {
  history = [];
  historyIndex = 0;

  constructor(
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
    this.votingDuration = 0;

    this.selectedScoreIndex = -1;
    this.selectedCooldownTimeIndex = -1;
    this.selectedHoldTimeIndex = -1;

    this.currentEndTimeStamp = 0;
    this.currentVotingDuration = 0;

    this.currentEndHoldTimeStamp = 0;
    this.currentHoldingDuration = 0;

    this.currentIndex = 0;

    this.isHolding = false;
    this.isPause = false;
    this.holdingTimer = null;

    this.synTimeInterval = 0.5;
    this.standbyDuration = 3;
    this.holdDuration = 0;
    this.votingDuration = 10;

    this.isHtml5 = isHtml5;
    this.fadeDuration = fadeDuration;

    this.folder = folder;

    this.hasSounds = this.checkScoreHasSounds(folder);
    this.soundList = this.hasSounds ? this.getSoundList(folder) : [];

    this.buildSVGContent();
    this.initState();
  }

  checkScoreHasSounds(score) {
    const dir = `${DATA_DIR}/${score}`;

    if (!fs.existsSync(dir)) {
      return;
    }

    const fileList = fs.readdirSync(dir);
    return fileList.includes("Sounds") && fileList.includes("Frames");
  }

  //this use listFiles generate from buildSVGContent. So run it after that method
  initState() {
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

    console.log("finish building svg content...");
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

class BMSessionTable {
  constructor() {
    this.data = [];
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
    if (fs.existsSync(dir)) {
      const s = new BMSession(
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
    return null;
  }

  remove(session) {
    this.data.splice(this.data.indexOf(session), 1);
  }

  getById(id) {
    return this.data.find((e) => e.id == id);
  }

  getByAdminId(id) {
    return this.data.find((e) => e.adminId.trim() == id);
  }

  getBySessionName(name) {
    return this.data.find((e) => e.sessionName.trim() == name);
  }

  saveDataToJsonFile() {}
}

class BMDatabase {
  constructor({ hostaddress }) {
    this.admin = new BMAdminTable();
    this.session = new BMSessionTable();
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
