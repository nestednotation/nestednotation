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

window.currentIndex = 0;
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
window.isHolding = false;

let votingDataTimeStamp = 0;

document.addEventListener("DOMContentLoaded", onDOMContentLoaded, false);

function onDOMContentLoaded() {
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
  const searchParams = new URLSearchParams(window.location.search);
  const isAdmin = searchParams.get("t");
  if (isAdmin === "1") {
    console.log("This is Admin");
    const divhold = document.getElementById("divhold");
    divhold.style.display = "block";

    const divpause = document.getElementById("divpause");
    divpause.style.display = "block";

    const divfinish = document.getElementById("divfinish");
    divfinish.style.display = "block";

    const divhistory = document.getElementById("divhistory");
    divhistory.style.display = "block";

    const tablefooter = document.getElementById("tablefooter");
    tablefooter.style.display = "flex";
  }

  ws = new WebSocket(wsPath);

  ws.onopen = function () {
    sendToServer(MSG_PING, { clientTime: Date.now() });
  };

  ws.onmessage = function (event) {
    const data = JSON.parse(event.data);
    const timeOfJob = data.t;

    if (timeOfJob === 0) {
      parseMessage(data);
    } else {
      const serverTime = getServerTime();
      if (serverTime >= timeOfJob) {
        parseMessage(data);
      } else {
        const delay = timeOfJob - serverTime;
        setTimeout(parseMessage, delay, data);
      }
    }
  };
}

function getServerTime() {
  const currentTime = Date.now();
  const serverTime = Math.round(currentTime + timeStampOffset);
  return serverTime;
}

function viewDidLoad() {
  timeStampRate = 0.1;
  isReady = true;
  //start ping timer every 60s
  pingTimer = setInterval(pingCallback, 1000 * 60);
  //request window.currentIndex
  sendToServer(MSG_NEED_DISPLAY);
}

function pingCallback() {
  sendToServer(MSG_PING, { clientTime: Date.now() });
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

function sendToServer(message, payload) {
  if (ws.readyState !== ws.OPEN) {
    return;
  }

  ws.send(
    JSON.stringify({
      sig: window.staffCode,
      cid: window.currentIndex,
      sid: window.sessionId,
      msg: message,
      ...payload,
    })
  );
}

function parseMessage(data) {
  const msg = data.m;
  if (msg === MSG_PING) {
    const { serverTime, clientTime } = data;
    const timeBeginPing = clientTime;
    const timeEndPing = Date.now();
    const timeServer = serverTime;
    const ping = timeEndPing - timeBeginPing;
    timeStampOffset +=
      (timeServer + ping / 2.0 - timeEndPing - timeStampOffset) * timeStampRate;

    if (pingCountToReady > 0) {
      pingCountToReady--;
      sendToServer(MSG_PING, { clientTime: Date.now() });
      return;
    }

    if (pingCountToReady === 0) {
      pingCountToReady--;
      viewDidLoad();
    }
    return;
  }

  if (msg === MSG_SHOW) {
    const { showIdx } = data;
    window.currentIndex = showIdx;
    console.log("received show image at index " + window.currentIndex);
    if (window.currentIndex === -1) {
      console.log(data);
    } else {
      showImageAtIndex(window.currentIndex);
    }

    //reset all
    window.winningVoteId = null;
    window.currVoteId = null;
    setOverlay(window.isHolding);
    setOpacityForInnerRingText(window.currentIndex, 0.25);
    setInnerRingText(window.currentIndex, "");
    showVotingIndicator({});
    return;
  }

  if (msg === MSG_NEED_DISPLAY) {
    console.log("receive need to refresh");
    refreshScore();
    return;
  }

  if (msg === MSG_UPDATE_VOTING) {
    const { countDic, timestamp } = data;
    if (timestamp <= votingDataTimeStamp) {
      return;
    }

    showVotingIndicator(countDic);

    votingDataTimeStamp = timestamp;
    const listRingId = Object.keys(countDic);
    const svg = document.getElementById("svg" + window.currentIndex);
    const selector = `text[id^='ta-${window.currentIndex}']`;
    const listText = svg.querySelectorAll(selector);

    for (let i = 0; i < listText.length; i++) {
      const id = listText[i].id;
      const ringId = id.substring(id.lastIndexOf("-") + 1);

      setInnerRingText(
        `${window.currentIndex}-${ringId}`,
        listRingId.includes(ringId) ? countDic[ringId] : 0
      );
    }

    let mostVoteCount = 0;
    let mostVoteRingId = 0;
    for (let i = 0; i < listRingId.length; i++) {
      const id = listRingId[i];
      if (id == -1) {
        continue;
      }

      const count = countDic[id];
      if (count > mostVoteCount) {
        mostVoteCount = count;
        mostVoteRingId = id;
      }
    }
    showInnerRing(`${window.currentIndex}-${mostVoteRingId}`);
    return;
  }

  if (msg === MSG_BEGIN_VOTING) {
    const { endTime, duration } = data;
    cooldownEndTime = endTime;
    cooldownDuration = duration;
    cooldownStartTime = cooldownEndTime - cooldownDuration * 1000;
    const serverTime = getServerTime();
    setIndicatorCooldown(true);

    if (serverTime < cooldownEndTime) {
      if (cooldownTimer != null) {
        clearInterval(cooldownTimer);
        cooldownTimer = null;
      }

      cooldownTimer = setInterval(cooldownCallback, 100);
      isCooldowning = true;
    } else {
      // nothing we can do here. just wait for next signal
      hideAllCooldownCircles();
      setIndicatorCooldown(false);
    }
    return;
  }

  if (msg === MSG_BEGIN_HOLDING) {
    const { endTime, duration } = data;
    holdingEndTime = endTime;
    holdingDuration = duration;
    holdingStartTime = holdingEndTime - holdingDuration * 1000;

    const serverTime = getServerTime();
    setIndicatorHold(true);

    if (serverTime < holdingEndTime) {
      if (holdingTimer != null) {
        clearInterval(holdingTimer);
        holdingTimer = null;
      }

      holdingTimer = setInterval(holdingCallback, 100);
      window.isHolding = true;
    } else {
      // nothing we can do here. just wait for next signal
      if (holdingEndTime == 0) {
        if (holdingTimer != null) {
          setIndicatorHold(false);
          clearInterval(holdingTimer);
          holdingTimer = null;
          window.isHolding = false;
        }

        hideAllCooldownCircles();
        setIndicatorHold(holdingDuration !== 0);
      } else {
        hideAllCooldownCircles();
        setIndicatorHold(false);
      }
    }
    return;
  }

  if (msg === MSG_CHECK_HOLD) {
    const { isHold } = data;
    setCheckHold(isHold);
    setIndicatorHold(isHold);
    return;
  }

  if (msg === MSG_PAUSE) {
    const { isPause, showIdx } = data;
    setCheckPause(isPause);
    showImageAtIndex(isPause ? -1 : showIdx);
    return;
  }

  if (msg === MSG_FINISH) {
    window.location.href = "/finish";
    return;
  }

  if (msg === MSG_SELECT_HISTORY) {
    const { history, selectedIdx } = data;
    updateSelectHistory(history, selectedIdx);
    return;
  }

  if (msg === MSG_SHOW_NUMBER_CONNECTION) {
    const { playerCount, riderCount } = data;
    updateNumberOfConnection(playerCount, riderCount);
    return;
  }
}

function updateNumberOfConnection(numPlayer, numRider) {
  const player = document.getElementById("spanplayer");
  const rider = document.getElementById("spanrider");
  player.innerHTML = `${numPlayer}`;
  rider.innerHTML = `${numRider}`;
}

function updateSelectHistory(historyData, selectedIdx) {
  const select = document.getElementById("history");
  let content = "";
  for (let i = 0; i < historyData.length; i++) {
    content += `<option value="${i}">${historyData[i]}</option>`;
  }
  select.innerHTML = content;
  select.selectedIndex = selectedIdx;
}

function setCheckHold(value) {
  const check = document.getElementById("hold");
  check.checked = value;
}

function setCheckPause(value) {
  const check = document.getElementById("pause");
  check.checked = value;
}

function sendPause(check) {
  sendToServer(MSG_PAUSE, { isPause: check.checked });
}

function sendFinish() {
  const r = confirm("Are you sure you want to end ?");

  if (r) {
    sendToServer(MSG_FINISH);
  }
}

function sendHold(check) {
  sendToServer(MSG_CHECK_HOLD, { isHold: check.checked });
}

function sendHistory(select) {
  sendToServer(MSG_SELECT_HISTORY, { selectedIdx: select.selectedIndex });
}

function holdingCallback() {
  const now = getServerTime();
  if (now <= holdingEndTime) {
    const elapsedTime = now - holdingStartTime;
    if ((elapsedTime >= 0) & (elapsedTime <= holdingDuration * 1000)) {
      const second = Math.floor(elapsedTime / 1000);
      setHoldingTimeTo(second);
    }
  } else {
    hideAllCooldownCircles();
    setIndicatorHold(false);
    clearInterval(holdingTimer);
    holdingTimer = null;
    window.isHolding = false;
  }
}

function cooldownCallback() {
  const now = getServerTime();
  if (now <= cooldownEndTime) {
    const elapsedTime = now - cooldownStartTime;
    if ((elapsedTime >= 0) & (elapsedTime <= cooldownDuration * 1000)) {
      const second = Math.floor(elapsedTime / 1000);
      setCooldownTimeTo(second);
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
  const list = getCoundownCircleList();
  for (let i = 0; i < 10; i++) {
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
  let secondLeft = cooldownDuration - second; //7, 6, 5, 4, 3, 2, 1
  if (secondLeft > 0) {
    const list = getCoundownCircleList();
    secondLeft =
      cooldownDuration > 10
        ? Math.ceil((secondLeft * 10) / cooldownDuration)
        : secondLeft;
    for (let i = 0; i < 10; i++) {
      list[i].setAttribute(
        "class",
        i + 1 <= secondLeft ? "circle active" : "circle active filled"
      );
      if (i + 1 > cooldownDuration) {
        list[i].setAttribute("class", "hidden");
      }
    }
  }
}

function setHoldingTimeTo(second) {
  let secondLeft = holdingDuration - second; //7, 6, 5, 4, 3, 2, 1
  if (secondLeft > 0) {
    const list = getCoundownCircleList();
    secondLeft =
      holdingDuration > 10
        ? Math.ceil((secondLeft * 10) / holdingDuration)
        : secondLeft;
    for (let i = 0; i < 10; i++) {
      list[i].setAttribute(
        "class",
        i + 1 <= secondLeft ? "circle active" : "circle active filled"
      );
      if (i + 1 > holdingDuration) {
        list[i].setAttribute("class", "hidden");
      }
    }
  }
}

function getListSvg() {
  return document.querySelectorAll("#MainContent svg[id]");
}

function getCoundownCircleList() {
  const listCircle = [];
  for (let i = 1; i < 11; i++) {
    listCircle.push(document.getElementById("circle_" + i));
  }
  return listCircle;
}

function showInnerRing(index) {
  const array = index.split("-");
  const svgIndex = array[0];
  const svg = document.getElementById("svg" + svgIndex);
  const listEllipse = svg.querySelectorAll("ellipse[id]");
  for (let i = 0; i < listEllipse.length; i++) {
    let id = listEllipse[i].id;
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
    const array = index.split("-");
    const svgIndex = array[0];
    const svg = document.getElementById("svg" + svgIndex);
    const selector = `text[id^='ta-${index}']`;
    const listText = svg.querySelectorAll(selector);

    for (let i = 0; i < listText.length; i++) {
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
  const array = index.split("-");
  const svgIndex = array[0];
  const svg = document.getElementById("svg" + svgIndex);
  const selector = `text[id^='ta-${index}']`;
  const listText = svg.querySelectorAll(selector);

  for (let i = 0; i < listText.length; i++) {
    listText[i].style.opacity = value;
  }
}

function highlightInnerRingText(index) {
  const array = index.split("-");
  const svgIndex = array[0];
  const svg = document.getElementById("svg" + svgIndex);
  const selector = `text[id^='ta-${svgIndex}']`;
  const listText = svg.querySelectorAll(selector);

  for (let i = 0; i < listText.length; i++) {
    const id = listText[i].id;
    listText[i].style.opacity = id === "ta-" + index ? 1.0 : 0.25;
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
    const svg = document.getElementById("svg" + window.currentIndex);
    const fileName = svg.getAttribute("file");
    if (fileName.startsWith("PRE") || fileName.startsWith("START")) {
      const div = document.getElementById("divOverlay");
      div.style.display = "inline";
    } else {
      const div = document.getElementById("divOverlay");
      div.style.display = "none";
      const listDot = document.querySelectorAll(
        `ellipse[id=dot${window.currentIndex}]`
      );
      for (let i = 0; i < listDot.length; i++) {
        listDot[i].style.fill = "rgb(0,0,0)";
      }
    }
  } else {
    const div = document.getElementById("divOverlay");
    div.style.display = "none";
    const listDot = document.querySelectorAll(
      `ellipse[id=dot${window.currentIndex}]`
    );
    for (let i = 0; i < listDot.length; i++) {
      const dot = listDot[i];
      const r = dot.getAttribute("r");
      const g = dot.getAttribute("g");
      const b = dot.getAttribute("b");
      listDot[i].style.fill = `rgb(${r},${g},${b})`;
    }
  }
}

function refreshScore() {
  const xmlhttp = new XMLHttpRequest();

  xmlhttp.onreadystatechange = function () {
    if (this.readyState === 4 && this.status === 200) {
      const html = this.responseText;
      document.getElementById("MainSVGContent").innerHTML = html;

      sendToServer(MSG_NEED_DISPLAY);
    }
  };
  xmlhttp.open("GET", "svgcontent.html", true);
  xmlhttp.send();
}
