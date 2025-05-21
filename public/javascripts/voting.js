document.addEventListener("DOMContentLoaded", () => {
  const style = document.createElement("style");
  style.textContent = `
      .vote-indicator {
        transform: translate(-50%, -50%) scale(${votingSize ?? 100}%);
      }
      .stay-btn {
        transform: scale(${votingSize ?? 100}%);
        transform-origin: left;
      }
    `;
  document.head.appendChild(style);
});

function getFrameHoldingDur(voteIdx) {
  const nextSvgFile = window.listFiles[voteIdx];
  const nextSvgEle = document.querySelector(`[file="${nextSvgFile}"]`);
  return nextSvgEle?.getAttribute("holding");
}

function tapOn(nextVoteIdx) {
  // Don't allow tap when in SESSION_MODES.PLAY mode
  if (
    window.sessionInstance?.mode === window.SESSION_MODES.PLAY ||
    window.isHolding ||
    !window.staffCode
  ) {
    return;
  }

  const currFrame = window.sessionInstance.getCurrentPlayingFrame();
  const frameVotingDur = currFrame.frameElement.getAttribute("voting");

  const nextFrameHoldingDur =
    nextVoteIdx === "stay"
      ? currFrame.frameElement.getAttribute("holding")
      : getFrameHoldingDur(nextVoteIdx);
  highlightInnerRingText(`${window.currentIndex}-${nextVoteIdx}`);

  window.currVoteIndex = nextVoteIdx;

  sendToServer(MSG_TAP, {
    selectedIdx: nextVoteIdx,
    frameVotingDur,
    nextFrameHoldingDur,
  });
}

window.votingIndicatorMap = new Map();

function showVotingIndicator(voteDic) {
  window.winningVoteIdx =
    voteDic.winningVoteIdx && voteDic.winningVoteIdx === "stay"
      ? voteDic.winningVoteIdx
      : Number(voteDic.winningVoteIdx);
  const { votingIndicatorMap, currVoteIndex, winningVoteIdx } = window;

  const removedWinningDic = { ...voteDic };
  delete removedWinningDic.winningVoteIdx;

  const dicEntries = Object.entries(removedWinningDic);
  if (dicEntries.length > 0) {
    document.getElementById("stayBtn").classList.add("visible");
  } else {
    document.getElementById("stayBtn").classList.remove("visible");
  }

  for (const [voteIdx, voteCount] of dicEntries) {
    const parseVoteIdx = voteIdx === "stay" ? voteIdx : Number(voteIdx);
    if (votingIndicatorMap.has(parseVoteIdx)) {
      const indicatorEle = votingIndicatorMap.get(parseVoteIdx);
      indicatorEle.innerHTML = voteCount;

      if (parseVoteIdx === winningVoteIdx) {
        indicatorEle.classList.add("winning");
      } else {
        indicatorEle.classList.remove("winning");
      }

      if (currVoteIndex === parseVoteIdx) {
        indicatorEle.classList.add("current-vote");
      } else {
        indicatorEle.classList.remove("current-vote");
      }
      continue;
    }

    if (parseVoteIdx === "stay") {
      updateStayButtonState(voteCount);
      continue;
    }

    injectVoteIndicator(parseVoteIdx, voteCount);
  }

  if (!removedWinningDic["stay"]) {
    updateStayButtonState(0);
  }

  // Remove all voting indicator element that not in dic
  for (const [voteIdx, indicatorEle] of votingIndicatorMap.entries()) {
    if (Object.hasOwn(removedWinningDic, voteIdx)) {
      continue;
    }

    indicatorEle.remove();
    votingIndicatorMap.delete(voteIdx);
  }
}

function injectVoteIndicator(voteIdx, voteCount) {
  const { votingIndicatorMap, currVoteIndex, sessionInstance, winningVoteIdx } =
    window;
  const currFrame = sessionInstance.getCurrentPlayingFrame();
  const containerElement = currFrame.frameElement.querySelector(
    `a[href="javascript:tapOn(${voteIdx});"]`
  );
  if (!containerElement) {
    console.error("Not found element for clicked link");
    return;
  }

  const voteMagnet = containerElement.querySelector(".votemagnet");

  const { top, left, width, height } = voteMagnet
    ? voteMagnet.getBoundingClientRect()
    : containerElement.getBoundingClientRect();
  const indicatorPosition = {
    top: top + height / 2,
    left: left + width / 2,
  };

  const indicatorBtn = document.createElement("div");
  indicatorBtn.classList.add("vote-indicator");
  indicatorBtn.setAttribute("vote-idx", voteIdx);
  indicatorBtn.style.top = indicatorPosition.top;
  indicatorBtn.style.left = indicatorPosition.left;
  indicatorBtn.innerHTML = voteCount;

  if (currVoteIndex === voteIdx) {
    indicatorBtn.classList.add("current-vote");
  }

  if (voteIdx === winningVoteIdx) {
    indicatorBtn.classList.add("winning");
  }

  document.getElementById("votingContainer").appendChild(indicatorBtn);
  votingIndicatorMap.set(voteIdx, indicatorBtn);
}

function updateStayButtonState(voteCount) {
  const { winningVoteIdx, currVoteIndex } = window;
  const stayBtnEle = document.getElementById("stayBtn");
  const indicatorEle = stayBtnEle.querySelector(".stay-indicator");

  if (voteCount > 0) {
    stayBtnEle.classList.add("voting");
    indicatorEle.innerHTML = voteCount;
  } else {
    stayBtnEle.classList.remove("voting");
    indicatorEle.innerHTML = "";
  }

  if (winningVoteIdx === "stay") {
    stayBtnEle.classList.add("winning");
  } else {
    stayBtnEle.classList.remove("winning");
  }

  if (currVoteIndex === "stay") {
    stayBtnEle.classList.add("current-vote");
  } else {
    stayBtnEle.classList.remove("current-vote");
  }
}
