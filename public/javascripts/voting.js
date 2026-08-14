document.addEventListener("DOMContentLoaded", () => {
  const style = document.createElement("style");
  style.textContent = `
      .vote-indicator {
        transform: translate(-50%, -50%) scale(${votingSize ?? 100}%);
      }
    `;
  document.head.appendChild(style);
});

const debounce = (func, delay) => {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), delay);
  };
};

window.addEventListener(
  "resize",
  debounce(() => {
    clearVotingIndicator();
    window.countDic && showVotingIndicator(window.countDic);
  }, 200)
);

// The destination frame's `holding`, addressed by the frame's UNIQUE element id
// rather than by its `file="<name>"` attribute.
//
// Main frames (`id="svg<N>"`) and sub frames (`id="sub-<score>-<N>"`) both carry
// a bare `file=`, every visited sub is injected into the same container, and the
// main frames come first in the page — so a `[file="…"]` lookup from inside a
// sub silently returned the MAIN namesake's holding time. Every score and every
// sub ships a START.svg, so that collision is present in every score.
//
// `voteIdx` indexes the ACTIVE frame list (window.listFiles is swapped to the
// sub's frameList on dive), which is exactly the index each id was built from.
// getElementById also needs no escaping, so score names with spaces or quotes
// are safe here in a way the old attribute selector was not.
function getFrameHoldingDur(voteIdx) {
  const ctx = window.frameContext || { type: "main" };
  const id =
    ctx.type === "sub" ? `sub-${ctx.name}-${voteIdx}` : `svg${voteIdx}`;
  return document.getElementById(id)?.getAttribute("holding");
}

function handleSelectLink(aElement) {
  // Don't allow tap when in SESSION_MODES.PLAY mode
  if (
    window.sessionInstance?.mode === window.SESSION_MODES.PLAY ||
    window.isHolding ||
    !window.staffCode
  ) {
    return;
  }

  // element ID should follow format: nextVoteId#currFileName#aEleIndex
  const [nextId] = aElement.id.split("#");

  if (!nextId) {
    return;
  }

  const nextVoteIdx = nextId === "stay" ? "stay" : Number(nextId);

  const currFrame = window.sessionInstance.getCurrentPlayingFrame();
  const frameVotingDur = currFrame.frameElement.getAttribute("voting");

  const nextFrameHoldingDur =
    nextVoteIdx === "stay"
      ? currFrame.frameElement.getAttribute("holding")
      : getFrameHoldingDur(nextVoteIdx);

  window.currVoteId = aElement.id;

  sendToServer(MSG_TAP, {
    selectedId: aElement.id,
    frameVotingDur,
    nextFrameHoldingDur,
  });
}

window.votingIndicatorMap = new Map();

function clearVotingIndicator() {
  // Remove stay voting
  updateStayButtonState(0);
  document.getElementById("stay")?.classList.remove("visible");

  // Remove all voting indicator
  for (const [voteId, indicatorEle] of window.votingIndicatorMap.entries()) {
    indicatorEle?.remove();
    window.votingIndicatorMap.delete(voteId);
  }
  window.votingIndicatorMap.clear();
  const votingContainer = document.getElementById("votingContainer");
  if (votingContainer) {
    votingContainer.innerHTML = "";
  }
}

function showVotingIndicator(voteDic) {
  window.winningVoteId = voteDic.winningVoteId;
  const { votingIndicatorMap, currVoteId, winningVoteId } = window;

  const removedWinningDic = { ...voteDic };
  delete removedWinningDic.winningVoteId;

  const dicEntries = Object.entries(removedWinningDic);
  if (dicEntries.length > 0) {
    document.getElementById("stay").classList.add("visible");
  } else {
    document.getElementById("stay").classList.remove("visible");
  }

  for (const [voteId, voteCount] of dicEntries) {
    if (votingIndicatorMap.has(voteId)) {
      const indicatorEle = votingIndicatorMap.get(voteId);
      if (!indicatorEle) {
        continue;
      }

      indicatorEle.innerHTML = voteCount;

      if (voteId === winningVoteId) {
        indicatorEle.classList.add("winning");
      } else {
        indicatorEle.classList.remove("winning");
      }

      if (currVoteId === voteId) {
        indicatorEle.classList.add("current-vote");
      } else {
        indicatorEle.classList.remove("current-vote");
      }
      continue;
    }

    if (voteId === "stay") {
      updateStayButtonState(voteCount);
      continue;
    }

    const injectedIndicator = injectVoteIndicator(voteId, voteCount);
    if (injectedIndicator) {
      votingIndicatorMap.set(voteId, injectedIndicator);
    }
  }

  if (!Object.hasOwn(removedWinningDic, "stay")) {
    updateStayButtonState(0);
  }

  // Remove all voting indicator element that not in dic
  for (const [voteId, indicatorEle] of votingIndicatorMap.entries()) {
    if (Object.hasOwn(removedWinningDic, voteId)) {
      continue;
    }

    indicatorEle?.remove();
    votingIndicatorMap.delete(voteId);
  }
}

function injectVoteIndicator(voteId, voteCount) {
  const { currVoteId, winningVoteId } = window;
  const containerElement = document.getElementById(voteId);
  if (!containerElement) {
    console.error("Not found element for clicked link");
    return null;
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
  indicatorBtn.style.top = indicatorPosition.top;
  indicatorBtn.style.left = indicatorPosition.left;
  indicatorBtn.innerHTML = voteCount;

  if (voteId === currVoteId) {
    indicatorBtn.classList.add("current-vote");
  }

  if (voteId === winningVoteId) {
    indicatorBtn.classList.add("winning");
  }

  document.getElementById("votingContainer").appendChild(indicatorBtn);
  return indicatorBtn;
}

function updateStayButtonState(voteCount) {
  const { winningVoteId, currVoteId } = window;
  const stayBtnEle = document.getElementById("stay");
  const indicatorEle = stayBtnEle.querySelector(".stay-indicator");

  if (voteCount > 0) {
    stayBtnEle.classList.add("voting");
    indicatorEle.innerHTML = voteCount;
  } else {
    stayBtnEle.classList.remove("voting");
    indicatorEle.innerHTML = "";
  }

  if (winningVoteId === "stay") {
    stayBtnEle.classList.add("winning");
  } else {
    stayBtnEle.classList.remove("winning");
  }

  if (currVoteId === "stay") {
    stayBtnEle.classList.add("current-vote");
  } else {
    stayBtnEle.classList.remove("current-vote");
  }
}
