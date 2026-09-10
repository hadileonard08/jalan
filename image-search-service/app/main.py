import io
import logging
import os
from contextlib import asynccontextmanager
from typing import List, Optional

import anyio
import httpx
import numpy as np
import psycopg2
from fastapi import FastAPI, HTTPException, status
from PIL import Image
from pydantic import BaseModel, Field, HttpUrl
from sentence_transformers import SentenceTransformer

logger = logging.getLogger("image-search-service")
logging.basicConfig(level=logging.INFO)

MODEL_NAME = "clip-ViT-B-32"
VECTOR_DIMENSION = 512

model: Optional[SentenceTransformer] = None


class IngestRequest(BaseModel):
    image_url: HttpUrl
    location_name: str = Field(..., min_length=1)


class SearchRequest(BaseModel):
    search_term: str = Field(..., min_length=1)
    limit: int = Field(1, ge=1, le=50)


class SearchResult(BaseModel):
    image_url: str
    location_name: str
    similarity_score: float


class BatchIngestItem(BaseModel):
    image_url: HttpUrl
    location_name: str = Field(..., min_length=1)


class BatchIngestRequest(BaseModel):
    items: List[BatchIngestItem] = Field(..., min_length=1, max_length=16)


def vector_to_db_str(vector: np.ndarray) -> str:
    """Convert a 1-D float vector into pgvector text representation."""
    flat = np.asarray(vector, dtype=float).flatten()
    if flat.shape[0] != VECTOR_DIMENSION:
        raise ValueError(
            f"Expected vector dimension {VECTOR_DIMENSION}, got {flat.shape[0]}"
        )
    return "[" + ",".join(f"{v:.8f}" for v in flat) + "]"


def get_db_connection():
    """Open a synchronous psycopg2 connection using DATABASE_URL."""
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="DATABASE_URL environment variable is not set",
        )
    try:
        return psycopg2.connect(dsn)
    except psycopg2.Error as exc:
        logger.exception("Database connection error")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Database connection failed: {exc}",
        ) from exc


def _init_database():
    """Ensure the pgvector extension and destination_photos table exist."""
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("CREATE EXTENSION IF NOT EXISTS vector;")
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS destination_photos (
                    id SERIAL PRIMARY KEY,
                    image_url TEXT NOT NULL UNIQUE,
                    location_name TEXT NOT NULL,
                    image_vector vector(512)
                );
                """
            )
            conn.commit()
    finally:
        conn.close()


async def _load_model() -> SentenceTransformer:
    """Load CLIP into memory once at startup."""

    def _load() -> SentenceTransformer:
        return SentenceTransformer(MODEL_NAME, device="cpu")

    return await anyio.to_thread.run_sync(_load)


def _download_image(url: str) -> Image.Image:
    """Download an image from a URL and return a decoded RGB PIL image."""
    try:
        headers = {
            'User-Agent': 'Jalan Image Search/1.0 (https://jalan-ai.vercel.app)'
        }
        with httpx.Client(timeout=30.0, follow_redirects=True, headers=headers) as client:
            response = client.get(url)
            response.raise_for_status()
            image = Image.open(io.BytesIO(response.content)).convert("RGB")
            return image
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Image download returned HTTP {exc.response.status_code}",
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Image unreachable: {exc}",
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid or unsupported image: {exc}",
        ) from exc


def _encode_image(image: Image.Image) -> np.ndarray:
    """Encode a PIL image to a 512-D CLIP vector."""
    if model is None:
        raise RuntimeError("Model is not loaded")
    return model.encode([image], show_progress_bar=False)[0]


def _encode_text(text: str) -> np.ndarray:
    """Encode a text query to a 512-D CLIP vector."""
    if model is None:
        raise RuntimeError("Model is not loaded")
    return model.encode(text, show_progress_bar=False)


def _insert_image(image_url: str, location_name: str, vector: np.ndarray) -> int:
    """Insert or update an image record in pgvector."""
    vector_str = vector_to_db_str(vector)
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO destination_photos (image_url, location_name, image_vector)
                VALUES (%s, %s, %s::vector)
                ON CONFLICT (image_url) DO UPDATE SET
                    location_name = EXCLUDED.location_name,
                    image_vector = EXCLUDED.image_vector
                RETURNING id;
                """,
                (image_url, location_name, vector_str),
            )
            row = cur.fetchone()
            conn.commit()
            return row[0] if row else -1
    finally:
        conn.close()


def _ingest_batch(image_urls: List[str], location_names: List[str]) -> dict:
    """Download and vectorize a batch of images, then insert them into pgvector."""
    if model is None:
        raise RuntimeError("Model is not loaded")

    images: List[Image.Image] = []
    valid_urls: List[str] = []
    valid_locations: List[str] = []

    for url, location in zip(image_urls, location_names):
        try:
            img = _download_image(url)
            images.append(img)
            valid_urls.append(url)
            valid_locations.append(location)
        except Exception as exc:
            logger.warning("Skipping image %s: %s", url, exc)

    if not images:
        return {"ingested": 0, "failed": len(image_urls)}

    # Batch encoding is much faster than one-by-one.
    vectors = model.encode(images, show_progress_bar=False)
    vector_strs = [vector_to_db_str(v) for v in vectors]

    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO destination_photos (image_url, location_name, image_vector)
                VALUES (%s, %s, %s::vector)
                ON CONFLICT (image_url) DO UPDATE SET
                    location_name = EXCLUDED.location_name,
                    image_vector = EXCLUDED.image_vector;
                """,
                list(zip(valid_urls, valid_locations, vector_strs)),
            )
            conn.commit()
    finally:
        conn.close()

    return {"ingested": len(valid_urls), "failed": len(image_urls) - len(valid_urls)}


def _search_images(vector: np.ndarray, limit: int) -> List[SearchResult]:
    """Return the nearest images for a text vector using cosine distance."""
    vector_str = vector_to_db_str(vector)
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT image_url, location_name, image_vector <=> %s::vector AS distance
                FROM destination_photos
                ORDER BY distance
                LIMIT %s;
                """,
                (vector_str, limit),
            )
            rows = cur.fetchall()
    finally:
        conn.close()

    results: List[SearchResult] = []
    for image_url, location_name, distance in rows:
        # pgvector <=> returns cosine distance; convert to cosine similarity.
        similarity = max(0.0, min(1.0, 1.0 - float(distance)))
        results.append(
            SearchResult(
                image_url=image_url,
                location_name=location_name,
                similarity_score=similarity,
            )
        )
    return results


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load CLIP and initialize the database once at startup."""
    global model
    logger.info("Loading CLIP model %s...", MODEL_NAME)
    model = await _load_model()
    logger.info("CLIP model loaded.")

    logger.info("Initializing database...")
    await anyio.to_thread.run_sync(_init_database)
    logger.info("Database initialized.")

    yield

    logger.info("Shutting down.")


app = FastAPI(
    title="Jalan Image Search Service",
    description="Multimodal CLIP embedding service for destination images.",
    version="0.1.0",
    lifespan=lifespan,
)


@app.post("/ingest", status_code=status.HTTP_201_CREATED)
async def ingest(request: IngestRequest):
    """Vectorize an image and store it in the pgvector database."""
    image_url = str(request.image_url)
    image = await anyio.to_thread.run_sync(_download_image, image_url)
    vector = await anyio.to_thread.run_sync(_encode_image, image)
    inserted_id = await anyio.to_thread.run_sync(
        _insert_image, image_url, request.location_name, vector
    )
    return {"status": "success", "id": inserted_id, "image_url": image_url}


@app.post("/batch-ingest", status_code=status.HTTP_201_CREATED)
async def batch_ingest(request: BatchIngestRequest):
    """Vectorize a batch of images and store them in the pgvector database."""
    image_urls = [str(item.image_url) for item in request.items]
    location_names = [item.location_name for item in request.items]
    result = await anyio.to_thread.run_sync(_ingest_batch, image_urls, location_names)
    return {
        "status": "success",
        "ingested": result["ingested"],
        "failed": result["failed"],
    }


@app.post("/search", response_model=List[SearchResult])
async def search(request: SearchRequest):
    """Search stored images by semantic similarity to a text query."""
    vector = await anyio.to_thread.run_sync(_encode_text, request.search_term)
    results = await anyio.to_thread.run_sync(_search_images, vector, request.limit)
    return results


@app.get("/images")
async def list_images():
    """Return a list of all stored image URLs for client-side deduplication."""

    def _list() -> List[str]:
        conn = get_db_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT image_url FROM destination_photos;")
                return [row[0] for row in cur.fetchall()]
        finally:
            conn.close()

    return await anyio.to_thread.run_sync(_list)


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok"}
