const status = document.querySelector(".status");
const text = document.querySelector("#status-text");

async function refreshStatus() {
  try {
    const next = await window.__TAURI__.core.invoke("desktop_status");
    status.dataset.state = next.state;
    text.textContent = next.message;
    if (next.state === "starting") setTimeout(refreshStatus, 250);
  } catch {
    status.dataset.state = "error";
    text.textContent = "Local host unavailable";
  }
}

refreshStatus();
