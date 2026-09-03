import os
from pathlib import Path

from dotenv import load_dotenv

from youtube import get_transcript

from langchain_huggingface import HuggingFaceEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.vectorstores import FAISS
from langchain_core.prompts import PromptTemplate
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.documents import Document

from sentence_transformers import CrossEncoder
from rank_bm25 import BM25Okapi

load_dotenv()

gemini_key = os.getenv("GEMINI_API_KEY")

if not gemini_key:
    raise RuntimeError("GEMINI_API_KEY is not set.")


INDEX_DIR = Path("indexes")
INDEX_DIR.mkdir(exist_ok=True)


CHUNK_SIZE = 1000
CHUNK_OVERLAP = 200

EMBEDDING_MODEL = "BAAI/bge-m3"
RERANKER_MODEL = "BAAI/bge-reranker-v2-m3"

LLM_MODEL = "gemini-3.5-flash-lite"

embedding = HuggingFaceEmbeddings(
    model_name=EMBEDDING_MODEL,
    encode_kwargs={
        "normalize_embeddings": True
    }
)

reranker = CrossEncoder(
    RERANKER_MODEL
)

llm = ChatGoogleGenerativeAI(
    model=LLM_MODEL,
    temperature=0
)

def create_vector_store(video_id):
    print("Creating vector store...")
    transcript = get_transcript(video_id)
    if not transcript:
        raise RuntimeError(
            "Transcript is empty."
        )

    full_text_parts = []
    segments = []
    current_position = 0
    for item in transcript:
        text = item.text.strip()
        if not text:
            continue

        start_time = float(item.start)
        end_time = float(
            item.start + item.duration
        )
        segments.append({
            "position": current_position,
            "start_time": start_time,
            "end_time": end_time,
            "text": text
        })

        full_text_parts.append(text)
        current_position += len(text) + 1

    full_text = " ".join(
        full_text_parts
    )

    print(
        f"Transcript length: {len(full_text)} characters"
    )

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=CHUNK_SIZE,
        chunk_overlap=CHUNK_OVERLAP,
        separators=[
            "\n\n",
            "\n",
            ". ",
            "? ",
            "! ",
            " ",
            ""
        ],
        add_start_index=True
    )

    chunks = splitter.create_documents(
        [full_text]
    )

    print(
        f"Total chunks created: {len(chunks)}"
    )
    if not chunks:
        raise RuntimeError(
            "No chunks were created."
        )

    for i, chunk in enumerate(chunks):
        chunk_start_index = chunk.metadata[
            "start_index"
        ]
        chunk_end_index = (
            chunk_start_index
            + len(chunk.page_content)
        )
        chunk_segments = []
        for segment in segments:
            segment_start = segment["position"]
            segment_end = (
                segment["position"]
                + len(segment["text"])
            )

            if (segment_end > chunk_start_index and segment_start < chunk_end_index):
                chunk_segments.append({
                    "text": segment["text"],
                    "start_time": segment["start_time"],
                    "end_time": segment["end_time"]
                })

        if chunk_segments:
            chunk_start_time = (
                chunk_segments[0]["start_time"]
            )
            chunk_end_time = (
                chunk_segments[-1]["end_time"]
            )
        else:
            chunk_start_time = 0
            chunk_end_time = 0

        chunk.metadata = {
            "video_id": video_id,
            "start_time": chunk_start_time,
            "end_time": chunk_end_time,
            "segments": chunk_segments
        }
        print(
            f"Chunk {i}: "
            f"{chunk_start_time:.2f}s "
            f"→ "
            f"{chunk_end_time:.2f}s"
        )

        print(
            chunk.page_content[:120]
        )

        print(
            f"Segments in chunk: "
            f"{len(chunk_segments)}"
        )

        print()

    vector_store = FAISS.from_documents(
        chunks,
        embedding
    )
    print(
        "Vector store created."
    )
    return vector_store


def save_vector_store(vector_store,video_id):
    path = INDEX_DIR / video_id
    vector_store.save_local(
        str(path)
    )
    print(
        f"Vector store saved: {path}"
    )

def load_vector_store(video_id):
    path = INDEX_DIR / video_id
    vector_store = FAISS.load_local(
        str(path),
        embedding,
        allow_dangerous_deserialization=True
    )
    print(
        f"Vector store loaded: {path}"
    )
    return vector_store

def get_vector_store(video_id):
    path = INDEX_DIR / video_id
    index_file = path / "index.faiss"
    if index_file.exists():
        print(
            "Existing vector store found."
        )
        return load_vector_store(
            video_id
        )

    print(
        "Vector store not found."
    )
    vector_store = create_vector_store(
        video_id
    )

    save_vector_store(
        vector_store,
        video_id
    )
    return vector_store

def hybrid_search(vector_store, question, vector_k=10, keyword_k=10):
    vector_docs = vector_store.similarity_search(
        question,
        k=vector_k
    )

    print(
        f"\nFAISS retrieved: {len(vector_docs)} documents"
    )

    all_docs = list(
        vector_store.docstore._dict.values()
    )

    if not all_docs:
        return []

    tokenized_docs = [
        doc.page_content.lower().split()
        for doc in all_docs
    ]

    bm25 = BM25Okapi(
        tokenized_docs
    )

    tokenized_question = (
        question.lower().split()
    )

    bm25_scores = bm25.get_scores(
        tokenized_question
    )

    top_indices = sorted(
        range(len(bm25_scores)),
        key=lambda i: bm25_scores[i],
        reverse=True
    )[:keyword_k]

    keyword_docs = [
        all_docs[i]
        for i in top_indices
    ]
    print(
        f"BM25 retrieved: {len(keyword_docs)} documents"
    )

    combined_docs = []
    seen = set()
    for doc in vector_docs + keyword_docs:
        doc_id = (
            doc.metadata.get("start_time"),
            doc.page_content
        )
        if doc_id not in seen:
            seen.add(doc_id)
            combined_docs.append(doc)

    print(
        f"Combined candidates: {len(combined_docs)}"
    )

    pairs = [
        [
            question,
            doc.page_content
        ]
        for doc in combined_docs
    ]

    scores = reranker.predict(
        pairs
    )

    ranked_docs = sorted(
        zip(scores, combined_docs),
        key=lambda x: x[0],
        reverse=True
    )

    print("\nHYBRID RERANK SCORES")
    for score, doc in ranked_docs:
        print(
            f"{score:.4f}","→",doc.metadata.get("start_time"),"→",doc.page_content[:100])

    return [
        doc
        for score, doc in ranked_docs[:3]
    ]


query_rewrite_prompt = PromptTemplate(

    template="""
You are a query rewriting assistant for a YouTube video chatbot.

Rewrite the user's latest question into a standalone question
that can be understood without the conversation history.

Use the conversation history only to resolve references such as:
"it", "this", "that", "they", "their", etc.

If the question is already standalone, return it unchanged.

Do NOT answer the question.

Return ONLY the rewritten question.

Conversation history:
{history}

Latest question:
{question}

Standalone question:
""",

    input_variables=[
        "history",
        "question"
    ]
)


prompt = PromptTemplate(

    template="""
You are a question-answering assistant for a YouTube video.

Answer the user's question using ONLY the transcript
context provided below.

Give a clear and concise answer.

Use examples from the transcript when useful.

Do not use outside knowledge.

If the answer cannot be found in the provided context,
say:

"I don't know based on the provided transcript."

--- TRANSCRIPT CONTEXT ---

{context}

--- END CONTEXT ---

QUESTION:

{question}

ANSWER:
""",

    input_variables=[
        "context",
        "question"
    ]
)

def extract_text(response):
    content = response.content
    if isinstance(content, str):
        return content.strip()

    if isinstance(content, list):
        text_parts = []
        for item in content:
            if (isinstance(item, dict)and item.get("type") == "text"):
                text_parts.append(
                    item.get("text", "")
                )


        return "".join(
            text_parts
        ).strip()
    return str(content).strip()

def rewrite_question(question,history):
    if not history:
        return question

    history_text = "\n".join(
        f"{message.role}: {message.content}"
        for message in history[-6:]
    )

    final_prompt = query_rewrite_prompt.invoke({
        "history": history_text,
        "question": question
    })

    response = llm.invoke(
        final_prompt
    )
    return extract_text(
        response
    )


def find_relevant_segment(question, answer, docs):

    candidates = []

    for doc in docs:

        segments = doc.metadata.get(
            "segments",
            []
        )

        for segment in segments:
            candidates.append(segment)

    if not candidates:
        return None

    # Remove duplicate segments
    unique_segments = {}

    for segment in candidates:

        key = (
            segment["start_time"],
            segment["text"]
        )

        unique_segments[key] = segment

    candidates = list(
        unique_segments.values()
    )

    # Sort chronologically
    candidates.sort(
        key=lambda x: x["start_time"]
    )

    # ------------------------------------------------
    # IMPORTANT:
    # Use both the question AND generated answer
    # ------------------------------------------------

    grounding_query = (
        f"Question: {question}\n"
        f"Answer: {answer}"
    )

    pairs = []

    for segment in candidates:

        pairs.append([
            grounding_query,
            segment["text"]
        ])

    scores = reranker.predict(
        pairs
    )

    ranked_segments = sorted(
        zip(scores, candidates),
        key=lambda x: x[0],
        reverse=True
    )

    print("\nSEGMENT RERANK SCORES")

    for score, segment in ranked_segments[:10]:

        print(
            f"{score:.6f} "
            f"{segment['start_time']:.2f}s "
            f"{segment['text'][:120]}"
        )

    if not ranked_segments:
        return None

    best_score, best_segment = ranked_segments[0]

    print("\nBEST SEGMENT")

    print(
        f"{best_segment['start_time']:.2f}s "
        f"→ "
        f"{best_segment['end_time']:.2f}s"
    )

    print(
        best_segment["text"]
    )

    return best_segment
def ask_question(vector_store,question,history):

    standalone_question = rewrite_question(
        question,
        history
    )
    print(
        "Original question:",
        question
    )
    print(
        "Rewritten question:",
        standalone_question
    )
    docs = hybrid_search(
        vector_store,
        standalone_question,
        
    )
    if not docs:
        return {
            "answer":
                "I don't know based on the provided transcript.",
            "timestamp": None
        }

    context = "\n\n".join(

        doc.page_content

        for doc in docs
    )

    final_prompt = prompt.invoke({

        "context": context,

        "question": standalone_question
    })
    response = llm.invoke(
        final_prompt
    )
    answer = extract_text(
        response
    )

    relevant_segment = find_relevant_segment(
        standalone_question,
        answer,
        docs
    )
    if relevant_segment:
        timestamp = (
            relevant_segment["start_time"]
        )
    else:
        timestamp = (
            docs[0].metadata.get(
                "start_time"
            )
        )
    return {
        "answer": answer,
        "timestamp": timestamp
    }

def verify_timestamps(vector_store,question,k=5):
    docs = hybrid_search(
        vector_store,
        question,
        
    )
    print(
        "\n"
        + "=" * 80
    )
    print(
        "TIMESTAMP VERIFICATION"
    )
    print(
        "=" * 80
    )
    for i, doc in enumerate(docs,1):
        print(
            f"\nRESULT {i}"
        )
        print(
            "-" * 80
        )
        print(
            "Chunk start:",
            doc.metadata.get(
                "start_time"
            )
        )
        print(
            "Chunk end:",
            doc.metadata.get(
                "end_time"
            )
        )
        print(
            "\nSegments:"
        )
        segments = doc.metadata.get(
            "segments",
            []
        )

        for segment in segments:
            print(
                f"{segment['start_time']:.2f}s"
                f" → "
                f"{segment['end_time']:.2f}s"
            )
            print(
                segment["text"]
            )

        print(
            "\nChunk text:"
        )
        print(
            doc.page_content[:500]
        )
    print(
        "=" * 80
    )