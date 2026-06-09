FROM python:3.11-slim

WORKDIR /app

# System deps for numpy/pandas builds
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ libffi-dev libssl-dev curl \
    && rm -rf /var/lib/apt/lists/*

# Install OpenBB Platform + provider extensions
# Core + the providers FinSurfing actually uses
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy startup script and settings template
COPY start.sh .
COPY user_settings.template.json .

RUN chmod +x start.sh

# OpenBB stores API keys in ~/.openbb_platform/user_settings.json
# We generate it at startup from env vars
ENV PYTHONUNBUFFERED=1
ENV OPENBB_HOST=0.0.0.0
ENV OPENBB_PORT=6900

EXPOSE 6900

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:6900/api/v1/user || exit 1

CMD ["./start.sh"]
