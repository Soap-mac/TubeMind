from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from collections import OrderedDict
from rag import get_vector_store, ask_question
from fastapi.middleware.cors import CORSMiddleware




app = FastAPI(
    title="TubeMind API",
    description="AI-powered YouTube video assistant",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


MAX_CACHED_VIDEOS = 5

vector_store_cache = OrderedDict()


def get_cached_vector_store(video_id):
    if video_id in vector_store_cache:
        print(f"Cache HIT: {video_id}")
        vector_store_cache.move_to_end(video_id)
        return vector_store_cache[video_id]
    print(f"Cache MISS: {video_id}")
    vector_store = get_vector_store(video_id)
    vector_store_cache[video_id] = vector_store
    vector_store_cache.move_to_end(video_id)
    if len(vector_store_cache) > MAX_CACHED_VIDEOS:
        removed_video_id, _ = vector_store_cache.popitem(
            last=False
        )
        print(
            f"Evicted from cache: {removed_video_id}"
        )
    return vector_store

class ChatMessage(BaseModel):
    role: str
    content: str


class AskRequest(BaseModel):
    video_id: str
    question: str
    history: list[ChatMessage] = Field(
        default_factory=list
    )
    

class AskResponse(BaseModel):
    answer: str
    timestamp: float | None = None


@app.get("/health")
def health_check():
    return {
        "status": "ok"
    }


@app.post("/ask", response_model=AskResponse)
def ask(request: AskRequest):

    print("VIDEO:", request.video_id)
    print("QUESTION:", request.question)
    print("HISTORY:", request.history)

    try:
        vector_store = get_cached_vector_store(
            request.video_id
        )

        result = ask_question(
            vector_store,
            request.question,
            request.history
        )

        return result

    except ValueError as e:

        raise HTTPException(
            status_code=400,
            detail=str(e)
        )

    except Exception as e:

        print("ERROR:", e)

        raise HTTPException(
            status_code=500,
            detail="Failed to process the question."
        )