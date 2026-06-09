FROM python:3.10-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ libffi-dev libssl-dev curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY start.sh .
COPY user_settings.template.json .
RUN chmod +x start.sh

ENV PYTHONUNBUFFERED=1
ENV OPENBB_HOST=0.0.0.0
ENV OPENBB_PORT=6900

EXPOSE 6900

HEALTHCHECK --interval=30s --timeout=10s --start-period=240s --retries=5 \
  CMD curl -f http://localhost:6900/api/v1/user || exit 1

CMD ["./start.sh"]
