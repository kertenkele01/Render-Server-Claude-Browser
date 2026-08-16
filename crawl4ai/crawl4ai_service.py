"""
Crawl4AI markdown microservice for the Android MCP bridge.

The bridge already has the rendered DOM from a real WebView, so this service
normally converts that HTML rather than fetching the page itself — the page may
sit behind a login that only the device's session can reach.

Contract with server.js (processCrawl4AIEngine):
  POST /crawl
  Headers: Authorization: Bearer <CRAWL4AI_API_TOKEN>   (also accepts X-API-Key)
  Body:    { "url": "...", "html": "<!doctype html>...", "word_count_threshold": 10 }
  Reply:   { "success": true,
             "results": [ { "url": ..., "markdown": { "fit_markdown": "...",
                                                      "raw_markdown": "..." } } ] }

The bridge walks the reply looking for fit_markdown / markdown / raw_markdown,
so this shape stays compatible with the upstream Crawl4AI server too.
"""

import os
import secrets
from typing import Any, Dict, List, Optional

import uvicorn
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from crawl4ai import AsyncWebCrawler

# Optional across crawl4ai versions: without these we still return raw markdown.
try:
    from crawl4ai.content_filter_strategy import PruningContentFilter
    from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator

    HAS_FIT_MARKDOWN = True
except ImportError:  # pragma: no cover - depends on installed version
    HAS_FIT_MARKDOWN = False

API_TOKEN = (os.getenv("CRAWL4AI_API_TOKEN") or os.getenv("CRAWL4AI_TOKEN") or "").strip()
PORT = int(os.getenv("PORT", "8000"))

app = FastAPI(title="Crawl4AI Markdown Service", version="1.0.0")


class CrawlRequest(BaseModel):
    url: Optional[str] = None
    urls: Optional[List[str]] = None
    html: Optional[str] = None
    raw_html: Optional[str] = None
    word_count_threshold: int = 10
    # Accepted for compatibility with clients that put the token in the body.
    api_key: Optional[str] = None
    token: Optional[str] = None


def authorize(authorization: Optional[str], api_key_header: Optional[str], body: CrawlRequest) -> None:
    """Constant-time token check. An unset token means local/dev mode."""
    if not API_TOKEN:
        return

    presented = ""
    if authorization:
        presented = authorization[7:].strip() if authorization.lower().startswith("bearer ") else authorization.strip()
    if not presented and api_key_header:
        presented = api_key_header.strip()
    if not presented:
        presented = (body.api_key or body.token or "").strip()

    if not presented or not secrets.compare_digest(presented, API_TOKEN):
        raise HTTPException(status_code=401, detail="Geçersiz veya eksik API anahtarı.")


def build_markdown_generator():
    """fit_markdown needs a content filter; without one we return raw markdown."""
    if not HAS_FIT_MARKDOWN:
        return None
    return DefaultMarkdownGenerator(
        content_filter=PruningContentFilter(threshold=0.45, threshold_type="dynamic")
    )


def extract_markdown(result: Any) -> Dict[str, str]:
    """Normalises the several shapes crawl4ai has used for markdown output."""
    md = getattr(result, "markdown", None)
    if md is None:
        md = getattr(result, "markdown_v2", None)

    if isinstance(md, str):
        return {"raw_markdown": md, "fit_markdown": md}

    raw = getattr(md, "raw_markdown", "") or ""
    fit = getattr(md, "fit_markdown", "") or ""
    if not raw and not fit:
        text = str(md) if md is not None else ""
        raw = fit = text
    return {"raw_markdown": raw, "fit_markdown": fit or raw}


@app.get("/health")
async def health() -> Dict[str, Any]:
    return {
        "status": "ok",
        "auth_required": bool(API_TOKEN),
        "fit_markdown_available": HAS_FIT_MARKDOWN,
    }


@app.post("/crawl")
@app.post("/md")
@app.post("/")
async def crawl(
    body: CrawlRequest,
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
) -> Dict[str, Any]:
    authorize(authorization, x_api_key, body)

    page_url = body.url or (body.urls[0] if body.urls else "") or "https://local.page"
    html = body.html or body.raw_html or ""

    # Prefer the HTML the device already rendered. Only fall back to fetching
    # the URL ourselves when no HTML was supplied — a fetch from here has none
    # of the user's cookies and will miss anything behind a login.
    if html:
        target = f"raw://{html}"
        fetched_directly = False
    else:
        if not body.url and not body.urls:
            raise HTTPException(status_code=400, detail="'html' veya 'url' alanlarından biri zorunlu.")
        target = page_url
        fetched_directly = True

    generator = build_markdown_generator()

    try:
        async with AsyncWebCrawler(verbose=False) as crawler:
            kwargs: Dict[str, Any] = {"url": target, "word_count_threshold": body.word_count_threshold}
            if generator is not None:
                kwargs["markdown_generator"] = generator
            result = await crawler.arun(**kwargs)
    except Exception as exc:  # surfaced to the bridge, which falls back to its local converter
        raise HTTPException(status_code=502, detail=f"Crawl4AI dönüşümü başarısız: {exc}") from exc

    markdown = extract_markdown(result)
    if not markdown["fit_markdown"] and not markdown["raw_markdown"]:
        raise HTTPException(status_code=422, detail="Sayfadan markdown çıkarılamadı.")

    return {
        "success": True,
        "engine": "crawl4ai",
        "fetched_directly": fetched_directly,
        "results": [
            {
                "url": page_url,
                "markdown": markdown,
                "word_count_threshold": body.word_count_threshold,
            }
        ],
    }


if __name__ == "__main__":
    if not API_TOKEN:
        print("[crawl4ai] UYARI: CRAWL4AI_API_TOKEN tanımlı değil — servis kimlik doğrulaması yapmayacak.")
    uvicorn.run(app, host="0.0.0.0", port=PORT)
