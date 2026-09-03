const chatForm = document.getElementById("chat-form");
const questionInput = document.getElementById("question-input");
const chatContainer = document.getElementById("chat-container");
const sendButton = document.getElementById("send-button");
const contextTitle = document.getElementById("context-title");

let chatHistory = [];
let currentVideoId = null;


function formatTime(date) {

    return date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
    });
}


function formatVideoTime(seconds) {

    const mins = Math.floor(seconds / 60);

    const secs = Math.floor(seconds % 60)
        .toString()
        .padStart(2, "0");

    return `${mins}:${secs}`;
}

async function seekVideo(timestamp) {

    const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true
    });

    const tab = tabs[0];

    if (!tab || !tab.id) {
        return;
    }


    await chrome.scripting.executeScript({
        target: {
            tabId: tab.id
        },

        func: (time) => {

            const video = document.querySelector("video");

            if (video) {
                video.currentTime = time;
                video.play();
            }

        },

        args: [timestamp]
    });
}

function cleanVideoTitle(rawTitle) {

    if (!rawTitle) {
        return null;
    }

    // YouTube tab titles are usually "Video Title - YouTube"
    return rawTitle.replace(/\s*-\s*YouTube\s*$/, "").trim();
}


function clearChatMessages() {

    chatContainer.innerHTML = "";

    addWelcomeMessage();
}

function addWelcomeMessage() {

    addMessage(
        "Ask me anything about this video.",
        "assistant"
    );
}


async function getActiveTab() {

    const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true
    });

    return tabs[0] || null;
}


async function getCurrentVideoId() {

    const tab = await getActiveTab();

    if (!tab || !tab.url) {
        throw new Error("Could not find the current tab.");
    }

    const url = new URL(tab.url);

    if (url.hostname !== "www.youtube.com" &&
        url.hostname !== "youtube.com") {

        throw new Error("Please open a YouTube video.");
    }

    const videoId = url.searchParams.get("v");

    if (!videoId) {
        throw new Error("No YouTube video is currently open.");
    }

    return videoId;
}


async function updateContextBar() {

    try {

        const tab = await getActiveTab();

        const title = cleanVideoTitle(tab?.title);

        contextTitle.textContent = title || "Open a YouTube video";

    } catch (error) {

        contextTitle.textContent = "Open a YouTube video";
    }
}


async function checkVideoChange() {

    const videoId = await getCurrentVideoId().catch(() => null);

    if (!videoId) {
        return;
    }

    if (currentVideoId === null) {
        currentVideoId = videoId;
        updateContextBar();
        return;
    }

    if (currentVideoId !== videoId) {

        console.log(
            `Video changed: ${currentVideoId} → ${videoId}`
        );

        currentVideoId = videoId;

        // Remove previous conversation
        chatHistory = [];

        // Remove previous messages
        clearChatMessages();

        updateContextBar();
    }
}


function addThinkingMessage() {

    const messageElement = document.createElement("div");

    messageElement.classList.add(
        "message",
        "assistant",
        "thinking-message"
    );

    const body = document.createElement("div");
    body.className = "message-body";

    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.innerHTML = `<span class="sender-tag">TubeMind</span>`;

    const content = document.createElement("div");
    content.className = "message-content";

    const dots = document.createElement("div");
    dots.className = "thinking-dots";
    dots.innerHTML = "<span></span><span></span><span></span>";

    content.appendChild(dots);
    body.appendChild(meta);
    body.appendChild(content);
    messageElement.appendChild(body);

    chatContainer.appendChild(messageElement);

    chatContainer.scrollTop =
        chatContainer.scrollHeight;

    return messageElement;
}

function removeThinkingMessage(element) {

    if (element) {
        element.remove();
    }

}


function addMessage(message, sender, isError = false, timestamp = null) {

    const messageElement = document.createElement("div");

    messageElement.classList.add(
        "message",
        sender
    );

    if (isError) {
        messageElement.classList.add("error");
    }

    const senderName = sender === "assistant"
        ? "TubeMind"
        : "You";

    const timeLabel = formatTime(new Date());

    const body = document.createElement("div");
    body.className = "message-body";

    const meta = document.createElement("div");
    meta.className = "message-meta";

    const senderTag = document.createElement("span");
    senderTag.className = "sender-tag";
    senderTag.textContent = senderName;

    const timeTag = document.createElement("span");
    timeTag.className = "time-tag";
    timeTag.textContent = timeLabel;

    meta.appendChild(senderTag);
    meta.appendChild(timeTag);

    const content = document.createElement("div");
    content.className = "message-content";
    // textContent (not innerHTML) so the text renders exactly as given —
    // no stray whitespace from formatting, no raw HTML injection.
    content.textContent = message;

    if (sender === "assistant" && timestamp !== null) {

        const jumpButton = document.createElement("button");

        jumpButton.textContent =
            `▶ Jump to ${formatVideoTime(timestamp)}`;


        jumpButton.className = "timestamp-button";


        jumpButton.onclick = () => {
            seekVideo(timestamp);
        };


        content.appendChild(
            document.createElement("br")
        );

        content.appendChild(
            jumpButton
        );

    }

    body.appendChild(meta);
    body.appendChild(content);
    messageElement.appendChild(body);

    chatContainer.appendChild(messageElement);

    chatContainer.scrollTop =
        chatContainer.scrollHeight;
}


async function askBackend(question) {


    const videoId = await getCurrentVideoId();

    if (currentVideoId === null) {

        currentVideoId = videoId;

    } else if (currentVideoId !== videoId) {

        currentVideoId = videoId;
        chatHistory = [];
        clearChatMessages();
        updateContextBar();
    }

    const response = await fetch(
        "http://127.0.0.1:8000/ask",
        {
            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({
                video_id: videoId,
                question: question,
                history: chatHistory
            })
        }
    );


    const data = await response.json();


    if (!response.ok) {

        throw new Error(
            data.detail || "Something went wrong."
        );
    }


    return data;
}


chatForm.addEventListener(
    "submit",
    async function (event) {

        event.preventDefault();

        const question =
            questionInput.value.trim();


        if (!question) {
            return;
        }


        // Show user question
        addMessage(
            question,
            "user"
        );


        // Clear input
        questionInput.value = "";


        // Prevent multiple requests
        sendButton.disabled = true;


        // Show thinking indicator
        const thinkingMessage =
            addThinkingMessage();


        try {
            const result = await askBackend(question);
            removeThinkingMessage(thinkingMessage);
            addMessage(
                result.answer,
                "assistant",
                false,
                result.timestamp
            );

            chatHistory.push({
                role: "user",
                content: question
            });

            chatHistory.push({
                role: "assistant",
                content: result.answer
            });

        } catch (error) {

            removeThinkingMessage(thinkingMessage);

            addMessage(
                error.message,
                "assistant",
                true
            );

        } finally {

            sendButton.disabled = false;

        }

    }
);


// Initial context bar paint + periodic video-change check
updateContextBar();
setInterval(checkVideoChange, 1500);