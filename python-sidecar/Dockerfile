FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

ENV PYTHONUNBUFFERED=1

# gunicorn: 2 workers, 60s timeout (FMP calls can be slow)
CMD gunicorn --bind 0.0.0.0:${PORT:-5001} --workers 2 --timeout 60 app:app
