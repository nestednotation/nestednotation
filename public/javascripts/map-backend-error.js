const serachParams = new URLSearchParams(window.location.search);
const message = serachParams.get("msg");
if (message) {
  document.getElementById("alerts").innerText = message;
}
