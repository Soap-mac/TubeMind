const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.error("Missing GEMINI_API_KEY environment variable.");
  process.exit(1);
}

const response = await fetch(
  "https://generativelanguage.googleapis.com/v1beta/fileSearchStores",
  {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      displayName: "TubeMind YouTube transcripts",
      embeddingModel: "models/gemini-embedding-2"
    })
  }
);

const data = await response.json();

if (!response.ok) {
  console.error(JSON.stringify(data, null, 2));
  process.exit(1);
}

console.log(data.name);
console.log("\nSave the value above as the FILE_SEARCH_STORE_NAME Worker secret.");
