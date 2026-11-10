FROM python:3.13-slim
# ffmpeg: voice; Pango/HarfBuzz: WeasyPrint for the КП PDF (week 14; fonts are packaged)
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ffmpeg     libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz0b libharfbuzz-subset0     && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .
COPY alembic.ini ./
COPY migrations ./migrations
ENV PYTHONUNBUFFERED=1
