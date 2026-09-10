CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS destination_photos (
    id SERIAL PRIMARY KEY,
    image_url TEXT NOT NULL UNIQUE,
    location_name TEXT NOT NULL,
    image_vector vector(512)
);

-- Add an index only once the table is large enough and the index type is tuned.
-- For small datasets a full scan with `ORDER BY image_vector <=> query` is correct and fast.
