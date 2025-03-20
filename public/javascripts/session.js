let ws;
let noSleep = new NoSleep();
let noSleepTimer;
let noSleepTimerCount;
let pingTimer;

let isReady = false;
let pingCountToReady = 3;
let lblVotingTime = null;
let btnSleep = null;

let divMainContent = null;

let currentIndex = 0;
let timeStampOffset = 0;
let timeStampRate = 1.0;

let cooldownTimer = null;
let cooldownDuration = 11;
let cooldownEndTime = 0;
let cooldownStartTime = 0;
let isCooldowning = false;

let holdingTimer = null;
let holdingDuration = 11;
let holdingEndTime = 0;
let holdingStartTime = 0;
let isHolding = false;

let votingData = null;
let votingDataTimeStamp = 0;

document.addEventListener("DOMContentLoaded", fn, false);
function fn() {
  lblVotingTime = document.getElementById("VotingTime");
  divMainContent = document.getElementById("MainContent");
  btnSleep = document.getElementById("SleepActivate");

  //sleep wake lock
  btnSleep.addEventListener(
    "click",
    function () {
      noSleepTimerCount = 0;
      noSleepTimer = setInterval(noSleepCallback, 500);
      btnSleep.setAttribute("class", "hidden");
    },
    false
  );

  var qs = (function (a) {
    if (a == "") return {};
    var b = {};
    for (var i = 0; i < a.length; ++i) {
      var p = a[i].split("=", 2);
      if (p.length == 1) b[p[0]] = "";
      else b[p[0]] = decodeURIComponent(p[1].replace(/\+/g, " "));
    }
    return b;
  })(window.location.search.substr(1).split("&"));

  var isAdmin = qs["t"];
  if (isAdmin != null && isAdmin == "1") {
    console.log("This is Admin");
    var divhold = document.getElementById("divhold");
    divhold.style.display = "block";

    var divpause = document.getElementById("divpause");
    divpause.style.display = "block";

    var divfinish = document.getElementById("divfinish");
    divfinish.style.display = "block";

    var divhistory = document.getElementById("divhistory");
    divhistory.style.display = "block";

    var tablefooter = document.getElementById("tablefooter");
    tablefooter.style.display = "flex";
  }

  ws = new WebSocket(wsPath);
  ws.onopen = function (event) {
    var currentTime = getClientTime();
    sendToServer(MSG_PING, currentTime);
  };
  ws.onmessage = function (event) {
    var data = JSON.parse(event.data);
    var timeOfJob = data.t;
    if (timeOfJob == 0) {
      parseMessage(data);
    } else {
      var serverTime = getServerTime();
      if (serverTime >= timeOfJob) {
        parseMessage(data);
      } else {
        var delay = timeOfJob - serverTime;
        setTimeout(parseMessage, delay, data);
      }
    }
  };
  ws.onerror = function (event) {
    //location.reload();
  };
}

function getServerTime() {
  var currentTime = getClientTime();
  var serverTime = Math.round(currentTime + timeStampOffset);
  return serverTime;
}

function getClientTime() {
  return new Date().getTime();
}

function viewDidLoad() {
  timeStampRate = 0.1;
  isReady = true;
  //start ping timer every 60s
  pingTimer = setInterval(pingCallback, 1000 * 60);
  //request currentIndex
  sendToServer(MSG_NEED_DISPLAY, 0);
}

function pingCallback() {
  sendToServer(MSG_PING, getClientTime());
}

function noSleepCallback() {
  if (noSleepTimerCount == 0) {
    noSleep.enable();
  } else if (noSleepTimerCount == 1) {
    noSleep.disable();
  } else if (noSleepTimerCount == 2 * CONST_NO_SLEEP_DURATION) {
    noSleepTimerCount = -1;
  }
  noSleepTimerCount++;
}

function sendToServer(message, value) {
  if (ws.readyState === ws.OPEN) {
    var obj = {
      sig: staffCode,
      cid: currentIndex,
      sid: sessionId,
      msg: message,
      val: value,
    };
    ws.send(JSON.stringify(obj));
  } else {
    //location.reload();
  }
}

function parseMessage(data) {
  var msg = data.m;
  var val1 = data.v1;
  var val2 = data.v2;
  var time = data.t;
  if (msg == MSG_PING) {
    var timeBeginPing = val2;
    var timeEndPing = getClientTime();
    var timeServer = val1;
    var ping = timeEndPing - timeBeginPing;
    timeStampOffset +=
      (timeServer + ping / 2.0 - timeEndPing - timeStampOffset) * timeStampRate;
    if (pingCountToReady > 0) {
      pingCountToReady--;
      sendToServer(MSG_PING, getClientTime());
    } else if (pingCountToReady == 0) {
      pingCountToReady--;
      viewDidLoad();
    }
  } else if (msg == MSG_SHOW) {
    currentIndex = val1;
    console.log("received show image at index " + currentIndex);
    if (currentIndex == -1) {
      console.log(data);
    } else {
      showImageAtIndex(currentIndex);
    }

    //reset all
    setOverlay(isHolding);
    setOpacityForInnerRingText(currentIndex, 0.25);
    setInnerRingText(currentIndex, "");
  } else if (msg == MSG_NEED_DISPLAY) {
    console.log("receive need to refresh");
    refreshScore();
  } else if (msg == MSG_UPDATE_VOTING) {
    var timestamp = val2;
    if (timestamp > votingDataTimeStamp) {
      votingDataTimeStamp = timestamp;
      votingData = val1;
      var listRingId = Object.keys(votingData);

      var svg = document.getElementById("svg" + currentIndex);
      var selector = "text[id^='ta-" + currentIndex + "']";
      var listText = svg.querySelectorAll(selector);
      for (var i = 0; i < listText.length; i++) {
        var id = listText[i].id;
        var ringId = id.substring(id.lastIndexOf("-") + 1);
        if (listRingId.includes(ringId)) {
          var count = votingData[ringId];
          setInnerRingText(currentIndex + "-" + ringId, count);
        } else {
          setInnerRingText(currentIndex + "-" + ringId, 0);
        }
      }

      var mostVoteCount = 0;
      var mostVoteRingId = 0;
      for (var i = 0; i < listRingId.length; i++) {
        var id = listRingId[i];
        if (id != -1) {
          var count = votingData[id];
          if (count > mostVoteCount) {
            mostVoteCount = count;
            mostVoteRingId = id;
          }
        }
      }
      showInnerRing(currentIndex + "-" + mostVoteRingId);
    }
  } else if (msg == MSG_BEGIN_VOTING) {
    cooldownEndTime = val1;
    cooldownDuration = val2;
    cooldownStartTime = cooldownEndTime - cooldownDuration * 1000;
    var serverTime = getServerTime();
    setIndicatorCooldown(true);

    if (serverTime < cooldownEndTime) {
      if (cooldownTimer != null) {
        clearInterval(cooldownTimer);
        cooldownTimer = null;
      }
      cooldownTimer = setInterval(cooldownCallback, 10);
      isCooldowning = true;
    } else {
      // nothing we can do here. just wait for next signal
      hideAllCooldownCircles();
      setIndicatorCooldown(false);
    }
  } else if (msg == MSG_BEGIN_HOLDING) {
    holdingEndTime = val1;
    holdingDuration = val2;
    holdingStartTime = holdingEndTime - holdingDuration * 1000;
    var serverTime = getServerTime();
    setIndicatorHold(true);

    if (serverTime < holdingEndTime) {
      if (holdingTimer != null) {
        clearInterval(holdingTimer);
        holdingTimer = null;
      }
      holdingTimer = setInterval(holdingCallback, 10);
      isHolding = true;
    } else {
      // nothing we can do here. just wait for next signal
      if (holdingEndTime == 0) {
        if (holdingTimer != null) {
          setIndicatorHold(false);
          clearInterval(holdingTimer);
          holdingTimer = null;
          isHolding = false;
        }
        hideAllCooldownCircles();
        setIndicatorHold(holdingDuration == 0 ? false : true);
      } else {
        hideAllCooldownCircles();
        setIndicatorHold(false);
      }
    }
  } else if (msg == MSG_BEGIN_STANDBY) {
  } else if (msg == MSG_CHECK_HOLD) {
    console.log("check hold");
    setCheckHold(val1);
    setIndicatorHold(val1);
  } else if (msg == MSG_PAUSE) {
    setCheckPause(val1);
    if (val1) {
      showImageAtIndex(-1);
    } else {
      showImageAtIndex(val2);
    }
  } else if (msg == MSG_FINISH) {
    window.location.href = "/finish";
  } else if (msg == MSG_SELECT_HISTORY) {
    updateSelectHistory(val1, val2);
  } else if (msg == MSG_SHOW_NUMBER_CONNECTION) {
    updateNumberOfConnection(val1, val2);
  }
}

function updateNumberOfConnection(numPlayer, numRider) {
  var player = document.getElementById("spanplayer");
  var rider = document.getElementById("spanrider");
  player.innerHTML = "" + numPlayer;
  rider.innerHTML = "" + numRider;
}

function updateSelectHistory(data, index) {
  var select = document.getElementById("history");
  var content = "";
  for (var i = 0; i < data.length; i++) {
    content += '<option value="' + i + '">' + data[i] + "</option>";
  }
  select.innerHTML = content;
  select.selectedIndex = index;
}

function setCheckHold(value) {
  var check = document.getElementById("hold");
  check.checked = value;
}

function setCheckPause(value) {
  var check = document.getElementById("pause");
  check.checked = value;
}

function sendPause(check) {
  sendToServer(MSG_PAUSE, check.checked);
}

function sendFinish(obj) {
  var r = confirm("Are you sure you want to end ?");
  if (r == true) {
    sendToServer(MSG_FINISH, 0);
  }
}

function sendHold(check) {
  sendToServer(MSG_CHECK_HOLD, check.checked);
}

function sendHistory(select) {
  sendToServer(MSG_SELECT_HISTORY, select.selectedIndex);
}

function holdingCallback() {
  var now = getServerTime();
  if (now <= holdingEndTime) {
    var elapsedTime = now - holdingStartTime;
    if (elapsedTime < 0) {
      //we do nothing here
    } else if (elapsedTime <= holdingDuration * 1000) {
      var second = Math.floor(elapsedTime / 1000);
      setHoldingTimeTo(second);
    } else {
      //end
    }
  } else {
    hideAllCooldownCircles();
    setIndicatorHold(false);
    clearInterval(holdingTimer);
    holdingTimer = null;
    isHolding = false;
  }
}

function cooldownCallback() {
  var now = getServerTime();
  if (now <= cooldownEndTime) {
    var elapsedTime = now - cooldownStartTime;
    if (elapsedTime < 0) {
      //we do nothing here
    } else if (elapsedTime <= cooldownDuration * 1000) {
      var second = Math.floor(elapsedTime / 1000);
      setCooldownTimeTo(second);
    } else {
      //end
    }
  } else {
    hideAllCooldownCircles();
    setIndicatorCooldown(false);
    clearInterval(cooldownTimer);
    cooldownTimer = null;
    isCooldowning = false;
  }
}

function hideAllCooldownCircles() {
  var list = getListCooldownCircle();
  for (var i = 0; i < 10; i++) {
    list[i].setAttribute("class", "circle");
  }
}

function showImageAtIndex(index) {
  const listImg = getListSvg();
  for (let i = 0; i < listImg.length; i++) {
    const id = parseInt(listImg[i].id.substr(3));
    if (id == index) {
      listImg[i].setAttribute("class", "");

      const listEllipse = listImg[i].querySelectorAll("ellipse[id]");
      for (let j = 0; j < listEllipse.length; j++) {
        let ellipseId = listEllipse[j].id;

        if (/^\d+-\d+$/.test(ellipseId)) {
          listEllipse[j].setAttribute("class", "hidden");
        }
      }
    } else {
      listImg[i].setAttribute("class", "hidden");
    }
  }

  const updateView = new CustomEvent("update-view", {
    detail: {
      newIndex: index,
    },
  });

  window.dispatchEvent(updateView);
}

function setCooldownTimeTo(second) {
  second = cooldownDuration - second; //7, 6, 5, 4, 3, 2, 1
  if (second > 0) {
    var list = getListCooldownCircle();
    second =
      cooldownDuration > 10
        ? Math.ceil((second * 10) / cooldownDuration)
        : second;
    for (var i = 0; i < 10; i++) {
      list[i].setAttribute(
        "class",
        i + 1 <= second ? "circle active" : "circle active filled"
      );
      if (i + 1 > cooldownDuration) {
        list[i].setAttribute("class", "hidden");
      }
    }
  }
}

function setHoldingTimeTo(second) {
  second = holdingDuration - second; //7, 6, 5, 4, 3, 2, 1
  if (second > 0) {
    var list = getListCooldownCircle();
    second =
      holdingDuration > 10
        ? Math.ceil((second * 10) / holdingDuration)
        : second;
    for (var i = 0; i < 10; i++) {
      list[i].setAttribute(
        "class",
        i + 1 <= second ? "circle active" : "circle active filled"
      );
      if (i + 1 > holdingDuration) {
        list[i].setAttribute("class", "hidden");
      }
    }
  }
}

function tapOn(nextId) {
  // Don't allow tap when in NEW_SESSION_MODES.PLAY mode
  if (window.sessionInstance?.newMode === "PLAY") {
    return;
  }

  if (!isHolding) {
    if (staffCode.length > 0) {
      highlightInnerRingText(currentIndex + "-" + nextId);
      sendToServer(MSG_TAP, nextId);
    }
  }
}

function getListSvg() {
  return document.querySelectorAll("#MainContent svg[id]");
}

function getListCooldownCircle() {
  var listCircle = [];
  for (var i = 1; i < 11; i++) {
    listCircle.push(document.getElementById("circle_" + i));
  }
  return listCircle;
}

function showInnerRing(index) {
  var array = index.split("-");
  var svgIndex = array[0];
  var svg = document.getElementById("svg" + svgIndex);
  var listEllipse = svg.querySelectorAll("ellipse[id]");
  for (var i = 0; i < listEllipse.length; i++) {
    var id = listEllipse[i].id;
    if (/^\d+-\d+$/.test(id)) {
      listEllipse[i].setAttribute("class", id == index ? "" : "hidden");
    }
  }
}

function setInnerRingText(index, text) {
  index = index + "";
  text = text + "";
  if (text.length <= 3) {
    const X = [-212.19, -232.023, -251.04];
    const Y = [-231.138, -230.697, -230.787];
    var array = index.split("-");
    var svgIndex = array[0];
    var svg = document.getElementById("svg" + svgIndex);
    var selector = "text[id^='ta-" + index + "']";
    var listText = svg.querySelectorAll(selector);

    for (var i = 0; i < listText.length; i++) {
      listText[i].innerHTML = text == "0" ? "" : text;
      if (text.length > 0 && text.length <= 3) {
        listText[i].setAttribute("x", X[text.length - 1]);
        listText[i].setAttribute("y", Y[text.length - 1]);
      }
    }
  }
}

function setOpacityForInnerRingText(index, value) {
  index = index + "";
  var array = index.split("-");
  var svgIndex = array[0];
  var svg = document.getElementById("svg" + svgIndex);
  var selector = "text[id^='ta-" + index + "']";
  var listText = svg.querySelectorAll(selector);

  for (var i = 0; i < listText.length; i++) {
    listText[i].style.opacity = value;
  }
}

function highlightInnerRingText(index) {
  var array = index.split("-");
  var svgIndex = array[0];
  var svg = document.getElementById("svg" + svgIndex);
  var selector = "text[id^='ta-" + svgIndex + "']";
  var listText = svg.querySelectorAll(selector);

  for (var i = 0; i < listText.length; i++) {
    var id = listText[i].id;
    listText[i].style.opacity = id == "ta-" + index ? 1.0 : 0.25;
  }
}

function setIndicatorCooldown(value) {
  const cooldownIconClass = document.getElementById("cooldown-icon").classList;
  if (value) {
    cooldownIconClass.add("active");
  } else {
    cooldownIconClass.remove("active");
  }
}

function setIndicatorHold(value) {
  const holdIconClass = document.getElementById("hold-icon").classList;
  if (value) {
    holdIconClass.add("active");
  } else {
    holdIconClass.remove("active");
  }

  document.body.classList.toggle("holding", value);
  setOverlay(value);
}

function setOverlay(value) {
  if (value) {
    var svg = document.getElementById("svg" + currentIndex);
    var fileName = svg.getAttribute("file");
    if (fileName.startsWith("PRE") || fileName.startsWith("START")) {
      var div = document.getElementById("divOverlay");
      div.style.display = "inline";
    } else {
      var div = document.getElementById("divOverlay");
      div.style.display = "none";
      var listDot = document.querySelectorAll(
        "ellipse[id=dot" + currentIndex + "]"
      );
      for (var i = 0; i < listDot.length; i++) {
        listDot[i].style.fill = "rgb(0,0,0)";
      }
    }
  } else {
    var div = document.getElementById("divOverlay");
    div.style.display = "none";
    var listDot = document.querySelectorAll(
      "ellipse[id=dot" + currentIndex + "]"
    );
    for (var i = 0; i < listDot.length; i++) {
      var dot = listDot[i];
      var r = dot.getAttribute("r");
      var g = dot.getAttribute("g");
      var b = dot.getAttribute("b");
      listDot[i].style.fill = "rgb(" + r + "," + g + "," + b + ")";
    }
  }
}

function refreshScore() {
  //location.reload(true);
  var xmlhttp = new XMLHttpRequest();
  var url = "svgcontent.html";

  xmlhttp.onreadystatechange = function () {
    if (this.readyState == 4 && this.status == 200) {
      var html = this.responseText;
      document.getElementById("MainSVGContent").innerHTML = html;

      sendToServer(MSG_NEED_DISPLAY, 0);
    }
  };
  xmlhttp.open("GET", url, true);
  xmlhttp.send();
}
