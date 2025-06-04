// Detect iPad device and add class to body
UAParser()
  .withFeatureCheck()
  .withClientHints()
  .then((uaRes) => {
    const { device } = uaRes;

    if (
      device.model === "iPad" ||
      (device.vendor === "Apple" && device.type === "tablet")
    ) {
      // have to setTimeout due to if it, document.body will not exists
      setTimeout(() => {
        document.body.classList.add("ipad");
      });
    }
  })
  .catch((e) => console.error(e));

function refreshSession() {
  window.location.reload();
}

function toggleSideMenu(e) {
  if (e) {
    e.stopPropagation();

    if (e.target !== e.currentTarget) {
      return;
    }
  }

  const sideMenu = document.getElementById("side-menu-container");
  if (sideMenu.dataset.show === "true") {
    sideMenu.dataset.show = "false";
    setTimeout(() => (sideMenu.style.display = "none"), 200);
  } else {
    sideMenu.style.display = "block";
    setTimeout(() => (sideMenu.dataset.show = "true"), 0);
  }
}

function getDefaultNNTitle() {
  return "START.svg";
}

function onChangeAboutNNPage(selectedPage) {
  const svgList = document.querySelectorAll('[id$="-about-nn"]');

  svgList.forEach((svgEl) => {
    const svgElFileName = svgEl.getAttribute("file");
    if (svgElFileName === selectedPage) {
      svgEl.classList.remove("hidden");
    } else {
      svgEl.classList.add("hidden");
    }
  });
}

function showAboutNestedNotationPage() {
  const aboutNestedNotationPage = document.getElementById(
    "about-nested-notation"
  );

  onChangeAboutNNPage(getDefaultNNTitle());
  aboutNestedNotationPage.classList.add("showing");
}

function closeOverlay() {
  const openingOverlay = document.querySelector(
    ".overlay-content-container.showing"
  );
  openingOverlay.classList.remove("showing");

  toggleSideMenu();
}

function getDefaultScoreTitle() {
  // Just to be safe, make it that it will pick the first svg in case START.svg is not found
  return document.querySelector('[id$="-about-score"][file="START.svg"]')
    ? "START.svg"
    : document.querySelector('[id$="-about-score"]')?.getAttribute("file");
}

function showAboutChordPage() {
  if (!window.showAboutChordPage) {
    return;
  }

  const aboutChordPage = document.getElementById("about-score");

  const selectedPage = getDefaultScoreTitle();
  if (!selectedPage) {
    return;
  }

  onChangeAboutChordPage(selectedPage);
  aboutChordPage.classList.add("showing");
}

function onChangeAboutChordPage(selectedPage) {
  const svgList = document.querySelectorAll('[id$="-about-score"]');

  svgList.forEach((svgEl) => {
    const svgElFileName = svgEl.getAttribute("file");
    if (svgElFileName === selectedPage) {
      svgEl.classList.remove("hidden");
    } else {
      svgEl.classList.add("hidden");
    }
  });
}

function showQRShare() {
  const aboutNestedNotationPage = document.getElementById("qr-code");
  aboutNestedNotationPage.classList.add("showing");

  const qrContainer = aboutNestedNotationPage.querySelector("#qr-container");
  // Render QR Code if not rendered yet
  if (!qrContainer.innerHTML) {
    new QRCode(qrContainer, {
      text: `${window.location.origin}${window.qrSharePath}`,
      width: 500,
      height: 500,
      colorDark: "#000",
      colorLight: "#fff",
      correctLevel: QRCode.CorrectLevel.H,
    });
  }
}
