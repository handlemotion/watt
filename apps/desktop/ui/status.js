const status = document.querySelector(".status");
const text = document.querySelector("#status-text");

async function refreshStatus() {
  let delay = 1000;
  try {
    const next = await window.__TAURI__.core.invoke("desktop_status");
    status.dataset.state = next.state;
    text.textContent = next.message;
    if (next.state === "starting") delay = 250;
  } catch {
    status.dataset.state = "error";
    text.textContent = "Local host unavailable";
  } finally {
    setTimeout(refreshStatus, delay);
  }
}

refreshStatus();
