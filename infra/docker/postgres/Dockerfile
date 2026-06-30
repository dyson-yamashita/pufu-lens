FROM apache/age:release_PG18_1.7.0

USER root

# apache/age uses PGDG PostgreSQL 18. The PGroonga package must be
# postgresql-18-pgdg-pgroonga (PGDG build), not postgresql-18-pgroonga
# (Debian default postgresql-* packages). See PGroonga install docs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates wget \
  && . /etc/os-release \
  && wget "https://packages.groonga.org/debian/groonga-apt-source-latest-${VERSION_CODENAME}.deb" \
  && apt-get install -y --no-install-recommends "./groonga-apt-source-latest-${VERSION_CODENAME}.deb" \
  && rm -f "./groonga-apt-source-latest-${VERSION_CODENAME}.deb" \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-18-pgvector postgresql-18-pgdg-pgroonga \
  && rm -rf /var/lib/apt/lists/*
