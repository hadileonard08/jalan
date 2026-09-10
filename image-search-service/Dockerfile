FROM python:3.11-slim

WORKDIR /app

# Install runtime libraries required by PyTorch and Pillow.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Copy and install Python dependencies.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the CLIP model so the container starts quickly and can run offline.
RUN python - <<'PY'
from sentence_transformers import SentenceTransformer
SentenceTransformer("clip-ViT-B-32", device="cpu")
PY

# Copy application source.
COPY . .

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
