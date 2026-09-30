const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_UPLOAD_BASE = "https://generativelanguage.googleapis.com/upload/v1beta";
const SUPADATA_BASE = "https://api.supadata.ai/v1";

const MODEL = "gemini-3.1-flash-lite";
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

const rateBuckets = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_PER_WINDOW = 10;

function json(data, status = 200, request) {
  const origin = request?.headers.get("Origin");
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
    "Cache-Control": "no-store"
  };

  return new Response(JSON.stringify(data), { status, headers });
}

function cleanVideoId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{6,20}$/.test(value)
    ? value
    : null;
}

function extractVideoId(videoUrl) {
  try {
    const url = new URL(videoUrl);
    const host = url.hostname.toLowerCase();

    if (host === "youtu.be") {
      return cleanVideoId(url.pathname.slice(1).split("/")[0]);
    }

    if (
      host === "youtube.com" ||
      host === "www.youtube.com" ||
      host.endsWith(".youtube.com")
    ) {
      const id = url.searchParams.get("v");
      if (id) return cleanVideoId(id);

      const match = url.pathname.match(/^\/shorts\/([^/]+)/);
      if (match) return cleanVideoId(match[1]);
    }
  } catch {
    // Return null below.
  }

  return null;
}

function formatTimestamp(ms) {
  const seconds = Math.max(0, Number(ms || 0)) / 1000;
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, "0");
  return "[" + mins + ":" + secs + "]";
}

function normalizeTranscript(data) {
  if (Array.isArray(data?.content)) {
    return data.content
      .filter(
        (segment) =>
          segment &&
          typeof segment.text === "string" &&
          segment.text.trim()
      )
      .map((segment) => {
        const start = Number(segment.offset || 0);
        const end = start + Number(segment.duration || 0);
        return (
          formatTimestamp(start) +
          " " +
          segment.text.trim() +
          " [" +
          formatTimestamp(end).slice(1)
        );
      })
      .join("\n");
  }

  if (typeof data?.content === "string") {
    return data.content.trim();
  }

  return "";
}

async function getCachedRecord(env, videoId) {
  if (!env.TUBEMIND_CACHE) return null;

  const raw = await env.TUBEMIND_CACHE.get("video:" + videoId);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function putCachedRecord(env, videoId, record) {
  if (!env.TUBEMIND_CACHE) return;

  await env.TUBEMIND_CACHE.put(
    "video:" + videoId,
    JSON.stringify(record),
    { expirationTtl: CACHE_TTL_SECONDS }
  );
}

async function geminiRequest(path, env, init = {}) {
  const url = new URL(GEMINI_BASE + path);
  url.searchParams.set("key", env.GEMINI_API_KEY);

  return fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      "Content-Type": "application/json"
    }
  });
}

async function ensureFileSearchStore(env) {
  if (!env.FILE_SEARCH_STORE_NAME) {
    throw new Error(
      "FILE_SEARCH_STORE_NAME is not configured. Create the store with the setup script and add it as a Worker secret."
    );
  }

  return env.FILE_SEARCH_STORE_NAME;
}

async function fetchTranscript(videoUrl, env) {
  const url = new URL(SUPADATA_BASE + "/transcript");
  url.searchParams.set("url", videoUrl);
  url.searchParams.set("lang", "en");

  const response = await fetch(url, {
    headers: {
      "x-api-key": env.SUPADATA_API_KEY
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data?.message ||
      data?.error ||
      "Supadata returned HTTP " + response.status + "."
    );
  }

  const transcript = normalizeTranscript(data);

  if (!transcript) {
    throw new Error("No usable transcript was returned for this YouTube video.");
  }

  return {
    transcript,
    language: data?.lang || null,
    availableLanguages: Array.isArray(data?.availableLangs)
      ? data.availableLangs
      : []
  };
}

async function uploadTranscriptToFileSearchStore(
  storeName,
  videoId,
  videoUrl,
  transcript,
  env
) {
  const bodyBytes = new TextEncoder().encode(transcript);

  const startUrl = new URL(
    GEMINI_UPLOAD_BASE + "/" + storeName + ":uploadToFileSearchStore"
  );
  startUrl.searchParams.set("key", env.GEMINI_API_KEY);

  const startResponse = await fetch(startUrl, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bodyBytes.byteLength),
      "X-Goog-Upload-Header-Content-Type": "text/plain",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      displayName: "TubeMind YouTube " + videoId,
      mimeType: "text/plain",
      customMetadata: [
        { key: "video_id", stringValue: videoId },
        { key: "source_url", stringValue: videoUrl }
      ]
    })
  });

  if (!startResponse.ok) {
    const data = await startResponse.json().catch(() => ({}));
    throw new Error(
      data?.error?.message ||
      "Gemini upload initialization failed (HTTP " +
        startResponse.status +
        ")."
    );
  }

  const uploadUrl = startResponse.headers.get("X-Goog-Upload-URL");
  if (!uploadUrl) {
    throw new Error("Gemini did not return a resumable upload URL.");
  }

  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(bodyBytes.byteLength),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
      "Content-Type": "text/plain"
    },
    body: bodyBytes
  });

  const operation = await uploadResponse.json().catch(() => ({}));

  if (!uploadResponse.ok) {
    throw new Error(
      operation?.error?.message ||
      "Gemini transcript upload failed (HTTP " +
        uploadResponse.status +
        ")."
    );
  }

  return waitForGeminiOperation(operation, env);
}

async function waitForGeminiOperation(operation, env) {
  if (!operation?.name || operation.done) {
    if (operation?.error) {
      throw new Error(
        operation.error.message || "Gemini File Search indexing failed."
      );
    }
    return operation;
  }

  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const response = await geminiRequest(
      "/" + operation.name,
      env,
      { method: "GET" }
    );

    const current = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        current?.error?.message ||
        "Gemini operation polling failed (HTTP " +
          response.status +
          ")."
      );
    }

    if (current.done) {
      if (current.error) {
        throw new Error(
          current.error.message || "Gemini File Search indexing failed."
        );
      }
      return current;
    }
  }

  throw new Error(
    "The transcript is still being indexed. Please retry in a few seconds."
  );
}

async function prepareVideo(videoUrl, videoId, env) {
  const cached = await getCachedRecord(env, videoId);

  if (cached?.status === "ready" && cached.storeName) {
    return cached;
  }

  const storeName = await ensureFileSearchStore(env);
  const result = await fetchTranscript(videoUrl, env);

  await uploadTranscriptToFileSearchStore(
    storeName,
    videoId,
    videoUrl,
    result.transcript,
    env
  );

  const record = {
    status: "ready",
    storeName,
    videoId,
    sourceUrl: videoUrl,
    language: result.language,
    availableLanguages: result.availableLanguages,
    indexedAt: new Date().toISOString()
  };

  await putCachedRecord(env, videoId, record);
  return record;
}

function extractInteractionText(data) {
  const interaction = data?.interaction || data;

  const steps = Array.isArray(interaction?.steps)
    ? interaction.steps
    : Array.isArray(interaction?.outputs)
      ? interaction.outputs
      : [];

  for (const step of steps) {
    if (step?.type === "model_output" && Array.isArray(step.content)) {
      const texts = step.content
        .filter(
          (item) =>
            item?.type === "text" &&
            typeof item.text === "string"
        )
        .map((item) => item.text);

      if (texts.length) return texts.join("\n").trim();
    }
  }

  if (typeof interaction?.output_text === "string") {
    return interaction.output_text.trim();
  }

  return "";
}

function parseAnswer(raw) {
  if (!raw) {
    return {
      answer: "I don't know based on the provided transcript.",
      timestamp: null
    };
  }

  try {
    const parsed = JSON.parse(raw);

    const answer =
      typeof parsed.answer === "string"
        ? parsed.answer.trim()
        : "I don't know based on the provided transcript.";

    const timestampNumber = Number(parsed.timestamp_seconds);

    return {
      answer,
      timestamp:
        Number.isFinite(timestampNumber) && timestampNumber >= 0
          ? timestampNumber
          : null
    };
  } catch {
    return {
      answer: raw.trim(),
      timestamp: null
    };
  }
}

async function askGemini(storeName, videoId, question, history, env) {
  const historyText = Array.isArray(history)
    ? history
        .slice(-6)
        .map((message) => {
          const role =
            message?.role === "assistant" ? "TubeMind" : "You";
          return role + ": " + String(message?.content || "");
        })
        .join("\n")
    : "";

  const input =
    "You are TubeMind, an AI assistant for a YouTube video's transcript.\n\n" +
    "Use ONLY information retrieved from the File Search tool.\n" +
    "Do NOT use outside knowledge.\n" +
    'If the transcript does not contain enough information to answer, return the exact answer: "I don\'t know based on the provided transcript."\n' +
    "The indexed transcript contains timestamp markers like [2:14] before transcript segments.\n" +
    "For timestamp_seconds, return the start time in seconds of the most relevant transcript segment used for the answer.\n" +
    "If you cannot identify a relevant timestamp, return -1.\n\n" +
    "Conversation history:\n" +
    (historyText || "(none)") +
    "\n\nCurrent question:\n" +
    question;

  const response = await geminiRequest("/interactions", env, {
    method: "POST",
    headers: {
      "x-goog-api-key": env.GEMINI_API_KEY
    },
    body: JSON.stringify({
      model: MODEL,
      input,
      tools: [
        {
          type: "file_search",
          file_search_store_names: [storeName],
          metadata_filter: 'video_id = "' + videoId + '"'
        }
      ],
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: {
          type: "object",
          properties: {
            answer: {
              type: "string",
              description: "The answer grounded only in the retrieved transcript."
            },
            timestamp_seconds: {
              type: "number",
              description:
                "Start timestamp in seconds of the most relevant transcript segment, or -1."
            }
          },
          required: ["answer", "timestamp_seconds"]
        }
      }
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      "Gemini returned HTTP " +
        response.status +
        "."
    );
  }

  return parseAnswer(extractInteractionText(data));
}

function getClientKey(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For") ||
    "unknown"
  );
}

function enforceSoftRateLimit(request) {
  const now = Date.now();
  const key = getClientKey(request);
  const existing = rateBuckets.get(key);

  if (!existing || now - existing.startedAt >= RATE_WINDOW_MS) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    return true;
  }

  existing.count += 1;

  return existing.count <= RATE_LIMIT_PER_WINDOW;
}

async function handleApi(request, env) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return json({ ok: true }, 200, request);
  }

  if (url.pathname === "/api/health" && request.method === "GET") {
    return json(
      {
        status: "ok",
        service: "TubeMind",
        model: MODEL
      },
      200,
      request
    );
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405, request);
  }

  if (!enforceSoftRateLimit(request)) {
    return json(
      {
        error: "Too many demo requests. Please wait a minute and try again."
      },
      429,
      request
    );
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON request." }, 400, request);
  }

  const videoUrl =
    typeof body?.video_url === "string"
      ? body.video_url.trim()
      : "";

  const videoId =
    cleanVideoId(body?.video_id) ||
    extractVideoId(videoUrl);

  if (!videoId) {
    return json(
      { error: "Please provide a valid YouTube video URL." },
      400,
      request
    );
  }

  if (!env.GEMINI_API_KEY || !env.SUPADATA_API_KEY) {
    return json(
      {
        error:
          "The TubeMind Worker is missing an AI/transcript API secret."
      },
      500,
      request
    );
  }

  try {
    if (url.pathname === "/api/prepare") {
      if (!videoUrl) {
        return json(
          { error: "video_url is required when preparing a video." },
          400,
          request
        );
      }

      const record = await prepareVideo(
        videoUrl,
        videoId,
        env
      );

      return json(
        {
          ready: true,
          video_id: videoId,
          language: record.language
        },
        200,
        request
      );
    }

    if (url.pathname === "/api/ask") {
      const question =
        typeof body?.question === "string"
          ? body.question.trim()
          : "";

      if (!question) {
        return json(
          { error: "question is required." },
          400,
          request
        );
      }

      let record = await getCachedRecord(env, videoId);

      if ((!record || record.status !== "ready") && videoUrl) {
        record = await prepareVideo(
          videoUrl,
          videoId,
          env
        );
      }

      if (!record || record.status !== "ready") {
        return json(
          {
            error:
              "This video is not prepared yet. Send video_url with the request to prepare it."
          },
          409,
          request
        );
      }

      const result = await askGemini(
        record.storeName,
        videoId,
        question,
        body?.history,
        env
      );

      return json(
        {
          answer: result.answer,
          timestamp: result.timestamp,
          video_id: videoId
        },
        200,
        request
      );
    }

    return json(
      { error: "Unknown API route." },
      404,
      request
    );
  } catch (error) {
    console.error(
      "TubeMind API error:",
      error?.message || error
    );

    return json(
      {
        error:
          error?.message ||
          "Failed to process the request."
      },
      500,
      request
    );
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};
