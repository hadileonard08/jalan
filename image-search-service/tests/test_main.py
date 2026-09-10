import os

# Set DATABASE_URL before importing the application module.
os.environ.setdefault(
    "DATABASE_URL",
    "postgresql://postgres:postgres@db:5432/jalan_vectors",
)

import pytest
from fastapi.testclient import TestClient

from app.main import app

SAMPLE_IMAGES = [
    {
        "image_url": "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=640&q=80",
        "location_name": "tropical beach",
    },
    {
        "image_url": "https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?w=640&q=80",
        "location_name": "city skyline",
    },
    {
        "image_url": "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=640&q=80",
        "location_name": "mountain range",
    },
]


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        yield test_client


def test_health(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_ingest_and_search_coastal_vacation(client):
    # Ingest three sample images with descriptive labels.
    for payload in SAMPLE_IMAGES:
        response = client.post("/ingest", json=payload)
        assert response.status_code == 201, response.text
        data = response.json()
        assert data["status"] == "success"
        assert isinstance(data["id"], int)
        assert data["image_url"] == payload["image_url"]

    # Search for a coastal vacation concept.
    response = client.post(
        "/search",
        json={"search_term": "coastal vacation", "limit": 3},
    )
    assert response.status_code == 200, response.text
    results = response.json()
    assert isinstance(results, list)
    assert len(results) == 3

    # The beach image should be the most semantically similar result.
    top = results[0]
    assert "beach" in top["location_name"].lower()
    assert 0.0 <= top["similarity_score"] <= 1.0
    assert top["image_url"].startswith("https://")

    # All returned results must contain the expected fields.
    for result in results:
        assert "image_url" in result
        assert "location_name" in result
        assert "similarity_score" in result
        assert isinstance(result["similarity_score"], float)
