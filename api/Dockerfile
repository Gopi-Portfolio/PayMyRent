FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
# Fonts + Pango/HarfBuzz so PDF statements shape Tamil/Hindi/Telugu/Kannada/Malayalam/Marathi/Bengali correctly.
RUN apt-get update && apt-get install -y --no-install-recommends \
      fonts-noto-core libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz0b postgresql-client \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-tam tesseract-ocr-hin libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
# Face detection + comparison models for the automatic owner document check (OpenCV model zoo, Apache-2.0), pinned by checksum.
RUN mkdir -p /srv/models && python - <<'PY'
import hashlib, time, urllib.request
bases = ("https://github.com/opencv/opencv_zoo/raw/main/models", "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models")
for path, sha in (
    ("face_detection_yunet/face_detection_yunet_2023mar.onnx", "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"),
    ("face_recognition_sface/face_recognition_sface_2021dec.onnx", "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79"),
):
    for attempt in range(8):                       # GitHub's file server answers 503 now and then: try both addresses a few times
        try:
            data = urllib.request.urlopen(f"{bases[attempt % 2]}/{path}", timeout=120).read()
            if hashlib.sha256(data).hexdigest() == sha:
                open("/srv/models/" + path.rsplit("/", 1)[1], "wb").write(data)
                break
            print("checksum mismatch, retrying", path)
        except Exception as e:                     # noqa: BLE001
            print("download failed, retrying:", e)
        time.sleep(5 * (attempt + 1))
    else:
        raise SystemExit("could not download " + path)
PY
WORKDIR /srv
COPY requirements.txt .
RUN pip install -r requirements.txt weasyprint==62.3 "pydyf==0.10.0"
COPY . .
RUN useradd --system --uid 10001 paymyrent && chown -R paymyrent /srv
USER paymyrent
EXPOSE 8000
# The health check sends the first RG_ALLOWED_HOSTS name as its Host header (otherwise the host allow-list answers 400).
# FORWARDED_ALLOW_IPS = the load balancer / proxy address(es) only (uvicorn reads it); never '*' in production.
ENV FORWARDED_ALLOW_IPS=127.0.0.1 WEB_CONCURRENCY=2
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD python -c "import json,os,sys,urllib.request as u; h=(json.loads(os.environ.get('RG_ALLOWED_HOSTS') or '[]') or ['127.0.0.1'])[0]; r=u.Request('http://127.0.0.1:8000/api/v1/health',headers={'Host':h}); sys.exit(0 if u.urlopen(r,timeout=4).status==200 else 1)" || exit 1
CMD ["sh", "-c", "alembic upgrade head && python -m app.db.provision && uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --no-server-header --limit-concurrency 200 --timeout-keep-alive 10"]
