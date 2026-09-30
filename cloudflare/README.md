# TubeMind — Cloudflare deployment

This directory is the production deployment path for TubeMind.

Architecture:

Chrome Extension / web demo
→ Cloudflare Worker
→ Supadata (YouTube transcript)
→ Gemini File Search
→ Gemini 3.1 Flash-Lite

The deployment path intentionally removes the heavyweight local ML runtime used by the original FastAPI server: PyTorch, BGE-M3, CrossEncoder, FAISS, and BM25.

## 1. Install Wrangler

From this directory:

    npm install
    npx wrangler login

Cloudflare Workers Free is the target plan.

## 2. Create the KV namespace

Run:

    npx wrangler kv namespace create TUBEMIND_CACHE

Copy the production namespace ID into wrangler.toml:

    [[kv_namespaces]]
    binding = "TUBEMIND_CACHE"
    id = "YOUR_REAL_NAMESPACE_ID"

Do not commit API keys.

## 3. Create the Gemini File Search store

Create a Gemini API key in Google AI Studio.

Then, in PowerShell:

    $env:GEMINI_API_KEY="YOUR_GEMINI_KEY"
    node scripts/create-file-search-store.mjs

Copy the printed fileSearchStores/... value.

## 4. Add Worker secrets

Run:

    npx wrangler secret put GEMINI_API_KEY
    npx wrangler secret put SUPADATA_API_KEY
    npx wrangler secret put FILE_SEARCH_STORE_NAME

Paste each corresponding value when prompted.

Supadata's current Basic/Free plan provides 100 credits/month and does not require a credit card.

## 5. Deploy

Run:

    npm run deploy

The Worker and the recruiter-facing static web demo are deployed together.

Open the workers.dev URL printed by Wrangler.

Health check:

    https://YOUR-WORKER.workers.dev/api/health

## 6. Chrome extension

Open:

    chrome-extension/popup/popup.js

Change:

    const API_BASE_URL = "https://YOUR-WORKER.workers.dev";

Then reload the extension in chrome://extensions.

The extension now sends both video_id and video_url to the cloud API. It no longer expects localhost:8000.

## 7. Recommended first test

Open the deployed web demo and use a YouTube video with captions.

Click Analyze video.

The first use of a new video:
1. fetches its transcript from Supadata;
2. indexes that transcript into the shared Gemini File Search store;
3. caches the video ID → store mapping in KV for 30 days.

Later questions about the same video do not fetch the transcript again.

## 8. Important limits

Cloudflare Workers Free currently allows 100,000 Worker requests/day, with 10 ms CPU/request, 128 MB memory, and 50 external subrequests per invocation.

TubeMind is designed so the Worker mostly validates JSON, reads KV, and waits on external APIs. It does not run ML models locally.

Gemini 3.1 Flash-Lite is currently free-tier priced for standard input/output and supports File Search.

Supadata Basic/Free currently provides 100 credits/month. One transcript costs one credit.

The Worker has a soft 10 requests/minute/client guard to reduce accidental Gemini quota exhaustion. This is an in-memory convenience guard, not a globally distributed security boundary.

## 9. Keep the Python backend

Do not delete the existing backend yet.

It remains useful for local development and for preserving the original BGE/FAISS RAG implementation.

The cloud deployment is intentionally a separate production path.

## 10. Secrets

Never put these into web-demo JavaScript or the Chrome extension:

    GEMINI_API_KEY
    SUPADATA_API_KEY

Only FILE_SEARCH_STORE_NAME is safe to treat as non-sensitive. It is still configured server-side here.
