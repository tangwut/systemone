FROM python:3.12-slim-bookworm

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    LAYA_MODEL_ROOT=/app/models \
    LAYA_MODELS=english,multilingual,typed-decisions \
    LAYA_DEVICE=cpu \
    LAYA_HOST=0.0.0.0 \
    LAYA_PORT=8000

COPY requirements.txt ./
RUN python -m pip install --no-cache-dir \
        --index-url https://download.pytorch.org/whl/cpu \
        --extra-index-url https://pypi.org/simple \
        torch==2.14.0+cpu \
    && python -m pip install --no-cache-dir -r requirements.txt

COPY main.py ./
COPY models/ ./models/

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10m \
    CMD python -c 'from urllib.request import urlopen; urlopen("http://127.0.0.1:8000/health", timeout=3)' || exit 1

CMD ["python", "main.py"]
