FROM python:3.12.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models \
    VOICE_MODEL=base \
    VOICE_COMPUTE_TYPE=int8

WORKDIR /app

COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --requirement requirements.txt

COPY app.py ./app.py

EXPOSE 8788

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8788", "--workers", "1", "--no-access-log"]
