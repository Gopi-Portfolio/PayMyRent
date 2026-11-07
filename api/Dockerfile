FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
# Fonts + Pango/HarfBuzz so PDF statements shape Tamil/Hindi/Telugu/Kannada/Malayalam/Marathi/Bengali correctly.
RUN apt-get update && apt-get install -y --no-install-recommends \
      fonts-noto-core libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz0b postgresql-client \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY requirements.txt .
RUN pip install -r requirements.txt weasyprint==62.3 "pydyf==0.10.0"
COPY . .
RUN useradd --system --uid 10001 paymyrent && chown -R paymyrent /srv
USER paymyrent
EXPOSE 8000
# FORWARDED_ALLOW_IPS = the load balancer / proxy address(es) only (uvicorn reads it); never '*' in production.
ENV FORWARDED_ALLOW_IPS=127.0.0.1 WEB_CONCURRENCY=2
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health',timeout=4).status==200 else 1)" || exit 1
CMD ["sh", "-c", "alembic upgrade head && python -m app.db.provision && uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --no-server-header --limit-concurrency 200 --timeout-keep-alive 10"]
