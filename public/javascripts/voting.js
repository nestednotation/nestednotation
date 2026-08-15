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

// The circle's content: the link's vote count, plus an "auto" label when the
// SERVER placed this device here rather than the performer choosing it.
//
// Whether the label is legible is left to CSS, not decided here: play mode
// renders the marker as a bare glow (`color: transparent`), so the label is
// invisible there without any JS involvement. That matters because switching
// modes never re-renders these indicators — a mode test in JS would go stale
// the moment the performer toggled guide mode.
function setIndicatorContent(indicatorEle, voteCount, isAuto) {
  const count = voteCount == null ? "" : String(voteCount);
  if (!isAuto) {
    indicatorEle.textContent = count;
    return;
  }

  indicatorEle.textContent = "";
  if (count !== "") {
    const countEle = document.createElement("span");
    countEle.className = "vote-count";
    countEle.textContent = count;
    indicatorEle.appendChild(countEle);
  }
  const label = document.createElement("span");
  label.className = "auto-label";
  label.textContent = "auto";
  indicatorEle.appendChild(label);
}

function showVotingIndicator(voteDic) {
  window.winningVoteId = voteDic.winningVoteId;
  const { votingIndicatorMap, currVoteId, winningVoteId } = window;
  // This device's own destination out of a `session-split` frame (null on every
  // other frame, where the shared winner is marked instead). A split has no
  // winner — the line divides — so the server hands each device the child it is
  // going to, and this marker answers "where do I arrive?" for the whole window.
  //
  // It is marked even once it IS the device's own vote. Suppressing it then
  // (the first cut of this) was wrong in practice: the marker visibly vanished
  // the moment a performer guided their device, which reads as the app losing
  // track of them. It now just stacks with `current-vote` — same link, one
  // marker saying both "my choice" and "where I land".
  const destinationVoteId = window.splitDestinationVoteId || null;
  // …but the two cases are still told apart by colour: a destination the device
  // did NOT choose was assigned by the server's balancing, so it renders BLUE
  // with an "auto" label, while a path the performer tapped keeps the orange of
  // an ordinary vote. Every play-mode device is in the auto case (it cannot
  // tap), as is a guide-mode device that has not chosen yet.
  const autoAssigned = !!destinationVoteId && destinationVoteId !== currVoteId;

  const removedWinningDic = { ...voteDic };
  delete removedWinningDic.winningVoteId;

  const dicEntries = Object.entries(removedWinningDic);
  if (dicEntries.length > 0) {
    document.getElementById("stay").classList.add("visible");
  } else {
    document.getElementById("stay").classList.remove("visible");
  }

  // The destination is marked even when nobody voted for that path — it is an
  // assignment, not a tally — so it gets a countless indicator of its own.
  const renderEntries = [...dicEntries];
  if (
    destinationVoteId &&
    destinationVoteId !== "stay" &&
    !Object.hasOwn(removedWinningDic, destinationVoteId)
  ) {
    renderEntries.push([destinationVoteId, ""]);
  }

  for (const [voteId, voteCount] of renderEntries) {
    const isDestination = voteId === destinationVoteId;
    const isAuto = isDestination && autoAssigned;

    if (votingIndicatorMap.has(voteId)) {
      const indicatorEle = votingIndicatorMap.get(voteId);
      if (!indicatorEle) {
        continue;
      }

      setIndicatorContent(indicatorEle, voteCount, isAuto);

      indicatorEle.classList.toggle("destination", isDestination);
      indicatorEle.classList.toggle("auto", isAuto);
      // The destination reuses the winning marker's look: on a split frame it
      // takes the winner's place, so it must read the same in both modes.
      if (voteId === winningVoteId || isDestination) {
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

    const injectedIndicator = injectVoteIndicator(voteId, voteCount, {
      isDestination,
      isAuto,
    });
    if (injectedIndicator) {
      votingIndicatorMap.set(voteId, injectedIndicator);
    }
  }

  if (!Object.hasOwn(removedWinningDic, "stay")) {
    updateStayButtonState(0);
  }

  // Remove all voting indicator element that not in dic (the destination marker
  // is kept — it survives on zero votes).
  for (const [voteId, indicatorEle] of votingIndicatorMap.entries()) {
    if (
      Object.hasOwn(removedWinningDic, voteId) ||
      voteId === destinationVoteId
    ) {
      continue;
    }

    indicatorEle?.remove();
    votingIndicatorMap.delete(voteId);
  }
}

function injectVoteIndicator(voteId, voteCount, marks = {}) {
  const { isDestination, isAuto } = marks;
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
  // Units required: assigning a bare number to a CSS length is an invalid
  // declaration, which the CSSOM silently DROPS — every indicator then fell
  // back to the stylesheet's `top/left: 0` and piled up in the viewport's
  // top-left corner instead of sitting on its link.
  indicatorBtn.style.top = `${indicatorPosition.top}px`;
  indicatorBtn.style.left = `${indicatorPosition.left}px`;
  setIndicatorContent(indicatorBtn, voteCount, isAuto);

  if (voteId === currVoteId) {
    indicatorBtn.classList.add("current-vote");
  }

  if (isDestination) {
    indicatorBtn.classList.add("destination");
  }

  if (isAuto) {
    indicatorBtn.classList.add("auto");
  }

  if (voteId === winningVoteId || isDestination) {
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
