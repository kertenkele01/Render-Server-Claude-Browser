FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    "fastapi>=0.110" \
    "uvicorn[standard]>=0.29" \
    "pydantic>=2.6" \
    "crawl4ai>=0.4"

RUN crawl4ai-setup

COPY crawl4ai_service.py .

# Set CRAWL4AI_API_TOKEN at run time; without it the service accepts
# unauthenticated requests, which is only appropriate on a private network.
ENV PORT=8000
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
    CMD curl -fsS http://127.0.0.1:8000/health || exit 1

CMD ["python", "crawl4ai_service.py"]
