const { MESSAGES } = require("./constants");
const fs = require("fs");

let prefixDir = ".";
const testPrefixFile = prefixDir + "/account/admin.dat";
if (!fs.existsSync(testPrefixFile)) {
  prefixDir = "..";
}

const dataDir = prefixDir + "/data";

class BMAdmin {
  constructor(id, name, password, isActive) {
    this.id = id;
    this.name = name;
    this.password = password;
    this.isActive = isActive;
  }
}

class BMSession {
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

    this.loadScoreAtFolder(folder);
  }

  checkScoreHasSounds(score) {
    const dir = `${dataDir}/${score}`;

    if (!fs.existsSync(dir)) {
      return;
    }

    const fileList = fs.readdirSync(dir);
    return fileList.includes("Sounds") && fileList.includes("Frames");
  }

  loadScoreAtFolder(folderName) {
    this.folder = folderName;
    this.hasSounds = this.checkScoreHasSounds(folderName);

    this.soundList = this.hasSounds ? this.getSoundList(folderName) : [];

    this.buildSVGContent();

    this.initState();
  }

  //this use listFiles generate from buildSVGContent. So run it after that method
  initState() {
    if (this.listFiles.length > 0) {
      //history
      this.history = [];
      this.historyIndex = 0;

      //random pick first index (files begin with Pre or Start)
      var listPreFile = this.listFiles.filter((o) => o.startsWith("PRE"));
      var listStartFile = this.listFiles.filter((o) => o.startsWith("START"));
      var startedFile =
        listStartFile.length > 0
          ? this.randomItem(listStartFile)
          : this.randomItem(listPreFile);
      this.setCurrentIndexTo(this.listFiles.indexOf(startedFile));
    }
  }

  setCurrentIndexTo(index) {
    this.currentIndex = parseInt(index);
    this.isVoting = false;
    this.isStandby = false;

    if (this.history.length > 0) {
      var countRemove = Math.max(
        0,
        this.history.length - (this.historyIndex + 1)
      );
      var indexRemove = Math.min(
        this.history.length - 1,
        this.historyIndex + 1
      );
      if (countRemove > 0) {
        this.history.splice(indexRemove - 1, countRemove + 1);
      }
    }
    var objectName = this.listFiles[index];

    this.history.push(objectName);
    this.historyIndex = this.history.length - 1;
  }

  getSoundList(folder) {
    const dir = `${dataDir}/${folder}/Sounds`;
    if (!fs.existsSync(dir)) {
      return [];
    }

    return fs.readdirSync(dir);
  }

  buildSVGContent() {
    const dir = this.hasSounds
      ? `${dataDir}/${this.folder}/Frames`
      : `${dataDir}/${this.folder}`;

    if (fs.existsSync(dir)) {
      this.listFiles = fs.readdirSync(dir);
      this.listFilesInLowerCase = this.listFiles.map((fileName) =>
        fileName.toLowerCase()
      );

      this.listPreImages = [];
      this.listMultiChooseImages = [];
      this.svgContent = "";

      if (this.listFiles.length > 0) {
        this.listFiles.forEach((filename) => {
          var filePath = `${dir}/${filename}`;
          var content = fs.readFileSync(filePath, "utf8");
          var svg = this.regexWithPattern(content, /<svg.*?<\/svg>/is, 0);
          var svgIndex = this.listFilesInLowerCase.indexOf(
            filename.toLowerCase()
          );
          if (filename.startsWith("PRE") || filename.startsWith("START")) {
            this.listPreImages.push(svgIndex);
          }
          svg = svg.replace(
            "<svg",
            `<svg id="svg${svgIndex}" class="hidden" file="${filename}" `
          );
          var listA = svg.match(/<a.*?>/g);
          if (listA != null) {
            if (listA.length > 1 && !filename.startsWith("PRE")) {
              this.listMultiChooseImages.push(svgIndex);
            }

            const HREF_REGX = /(?<=href=")(.*?)(?=")/;
            const LINK_REGEX = /((xlink:href)|(href))="(.*?)"/;
            listA.forEach((a) => {
              const matchedHref = HREF_REGX.exec(a)?.[0];
              const aIndex = this.listFilesInLowerCase.indexOf(
                matchedHref?.toLowerCase()
              );

              let newA = a.replace(
                LINK_REGEX,
                `href="javascript:tapOn(${aIndex});"`
              );
              svg = svg.replace(a, newA);
              if (!filename.startsWith("PRE")) {
                newA = newA.replace(" ", "\\s*");
                newA = newA.replace("(", "\\(");
                newA = newA.replace(")", "\\)");

                var pattern = `${newA}.*?serif:id="Ring and Background".*?>.*?<ellipse.*?/>.*?(<ellipse.*?/>)`;
                var ellipse = this.regexWithPattern(
                  svg,
                  new RegExp(pattern, "is"),
                  1
                );
                if (ellipse != null) {
                  //add elipse
                  var cx = parseFloat(
                    this.regexWithPattern(ellipse, /<ellipse.*?cx="(.*?)"/is, 1)
                  );
                  var cy = parseFloat(
                    this.regexWithPattern(ellipse, /<ellipse.*?cy="(.*?)"/is, 1)
                  );
                  var rx =
                    parseFloat(
                      this.regexWithPattern(
                        ellipse,
                        /<ellipse.*?rx="(.*?)"/is,
                        1
                      )
                    ) * 0.9126;
                  var ry =
                    parseFloat(
                      this.regexWithPattern(
                        ellipse,
                        /<ellipse.*?rx="(.*?)"/is,
                        1
                      )
                    ) * 0.9126;
                  var style = this.regexWithPattern(
                    ellipse,
                    /<ellipse.*?style="(.*?)"/is,
                    1
                  );
                  var ellipseId = `${svgIndex}-${aIndex}`;
                  ellipse = this.regexWithPattern(
                    svg,
                    new RegExp(pattern, "is"),
                    0
                  );

                  const newEllipse = `${ellipse}\r\n<ellipse id="${ellipseId}" class="hidden" cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" style="${style}"></ellipse>`;
                  svg = svg.replace(ellipse, newEllipse);

                  //add text area
                  pattern = `${newA}(.*?serif:id="Ring and Background".*?)<g id="Notes`;
                  var midGap = this.regexWithPattern(
                    svg,
                    new RegExp(pattern, "is"),
                    1
                  );
                  var textId = `ta-${svgIndex}-${aIndex}`;

                  const newTextArea = `${midGap}\r\n<g xmlns="http://www.w3.org/2000/svg" transform="matrix(-3.99305,0,0,-3.99305,0,0)">\r\n<text id="${textId}" x="-212.19" y="-231.138" style="font-family:\'ArialMT\', \'Arial\', sans-serif; font-size: 72px; fill-opacity: 1.0;"></text>\r\n</g>\r\n`;
                  svg = svg.replace(midGap, newTextArea);
                }
                pattern = `${newA}.*?<g[^>]*?id="Notes.*?>(.*?</g>[^<]*?</g>)`;
                var notesEllipse = this.regexWithPattern(
                  svg,
                  new RegExp(pattern, "is"),
                  1
                );
                if (notesEllipse != null) {
                  var listEllipse = this.regexFull(
                    notesEllipse,
                    "<ellipse[^>]*?>"
                  );
                  if (listEllipse != null) {
                    for (var i = 0; i < listEllipse.length; i++) {
                      var oldEllipse = listEllipse[i];
                      var part = oldEllipse.match(
                        /(<ellipse[^>]*?)(style=".*?fill:rgb\((.*?),(.*?),(.*?)\).*?")([^>]*?>)/is
                      );
                      if (part != null) {
                        const newEllipse = `${part[1]}id="dot${svgIndex}" r="${part[3]}" g="${part[4]}" b="${part[5]}" ${part[2]}${part[6]}`;
                        svg = svg.replace(oldEllipse, newEllipse);
                      }
                    }
                  }
                }
              }
            });
          }
          this.svgContent += svg;
          this.svgContent += "\n";
        });
        //final
      }
    }
    console.log("finish building svg content...");
  }

  regexWithPattern(str, pattern, groupId) {
    var match = str.match(pattern);
    if (match != null) {
      return match[groupId];
    }
    return null;
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
    this.count = 0;
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
    var dir = dataDir + "/" + folder;
    if (fs.existsSync(dir)) {
      this.count++;
      var s = new BMSession(
        this.count,
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
}

class BMDatabase {
  constructor({ hostaddress }) {
    this.admin = new BMAdminTable();
    this.session = new BMSessionTable();
    this.shouldAutoRedirect = false;
    this.autoRedirectSession = "";
    this.autoRedirectPassword = "";

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
    var listFiles = fs.readdirSync(dataDir);
    var scoreList = [];
    for (var i = 0; i < listFiles.length; i++) {
      var path = dataDir + "/" + listFiles[i];
      if (fs.lstatSync(path).isDirectory()) {
        scoreList.push(listFiles[i]);
      }
    }
    return scoreList;
  }
}

module.exports = BMDatabase;
