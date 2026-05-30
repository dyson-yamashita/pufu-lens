FROM apache/age:release_PG18_1.7.0

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-18-pgvector \
  && rm -rf /var/lib/apt/lists/*
