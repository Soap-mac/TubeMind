const API_BASE_URL = "";

const videoUrlInput = document.getElementById("video-url");
const prepareButton = document.getElementById("prepare-button");
const statusEl = document.getElementById("status");

const chatCard = document.getElementById("chat-card");
const videoLabel = document.getElementById("video-label");
const openVideo = document.getElementById("open-video");
const messages = document.getElementById("messages");
const chatForm = document.getElementById("chat-form");
const questionInput = document.getElementById("question");
const sendButton = document.getElementById("send-button");

let currentVideoUrl = "";
let currentVideoId = "";
let history = [];

function extractVideoId(urlValue) {
  try {
    const url = new URL(urlValue);
    if (url.hostname === "youtu.be") {
      return url.pathname.slice(1).split("/")[0];
    }

    const id = url.searchParams.get("v");
    if (id) return id;

    const shorts = url.pathname.match(/^\/shorts\/([^/]+)/);
    return shorts ? shorts[1] : "";
  } catch {
    return "";
  }
}

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  statusEl.className = "status " + kind;
}

function addMessage(text, sender = "assistant", timestamp = null) {
  const bubble = document.createElement("div");
  bubble.className = "bubble " + sender;

  const name = document.createElement("div");
  name.className = "bubble-name";
  name.textContent = sender === "assistant" ? "TubeMind" : "You";

  const body = document.createElement("div");
  body.textContent = text;

  bubble.append(name, body);

  if (sender === "assistant" && Number.isFinite(timestamp) && timestamp >= 0) {
    const jump = document.createElement("a");
    jump.className = "timestamp";
    jump.href =
      "https://www.youtube.com/watch?v=" +
      encodeURIComponent(currentVideoId) +
      "&t=" +
      Math.floor(timestamp) +
      "s";
    jump.target = "_blank";
    jump.rel = "noreferrer";
    jump.textContent =
      "▶ Jump to " +
      Math.floor(timestamp / 60) +
      ":" +
      Math.floor(timestamp % 60).toString().padStart(2, "0");
    bubble.appendChild(jump);
  }

  messages.appendChild(bubble);
  messages.scrollTop = messages.scrollHeight;
}

async function api(path, options) {
  const response = await fetch(API_BASE_URL + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.error ||
      data.message ||
      "The request failed."
    );
  }

  return data;
}

async function prepareVideo() {
  const url = videoUrlInput.value.trim();

  if (!url) {
    setStatus("Paste a YouTube video URL first.", "error");
    return;
  }

  const id = extractVideoId(url);

  if (!id) {
    setStatus("That does not look like a supported YouTube video URL.", "error");
    return;
  }

  prepareButton.disabled = true;
  chatCard.classList.add("hidden");
  setStatus("Fetching the transcript and indexing it…", "loading");

  try {
    await api("/api/prepare", {
      method: "POST",
      body: JSON.stringify({ video_url: url })
    });

    currentVideoUrl = url;
    currentVideoId = id;
    history = [];

    videoLabel.textContent = id;
    openVideo.href = url;

    messages.innerHTML = "";
    addMessage("Ready. Ask me anything about this video.");

    chatCard.classList.remove("hidden");
    setStatus("Video ready.", "success");
    questionInput.focus();
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    prepareButton.disabled = false;
  }
}

async function askQuestion(event) {
  event.preventDefault();

  const question = questionInput.value.trim();

  if (!question || !currentVideoId) return;

  addMessage(question, "user");
  questionInput.value = "";
  sendButton.disabled = true;

  try {
    const result = await api("/api/ask", {
      method: "POST",
      body: JSON.stringify({
        video_id: currentVideoId,
        video_url: currentVideoUrl,
        question,
        history
      })
    });

    addMessage(result.answer, "assistant", result.timestamp);

    history.push({ role: "user", content: question });
    history.push({ role: "assistant", content: result.answer });
  } catch (error) {
    addMessage(error.message, "assistant");
  } finally {
    sendButton.disabled = false;
    questionInput.focus();
  }
}

prepareButton.addEventListener("click", prepareVideo);
chatForm.addEventListener("submit", askQuestion);
videoUrlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") prepareVideo();
});
