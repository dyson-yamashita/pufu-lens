FROM apache/age:release_PG18_1.7.0

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates wget \
  && . /etc/os-release \
  && wget "https://packages.groonga.org/debian/groonga-apt-source-latest-${VERSION_CODENAME}.deb" \
  && apt-get install -y --no-install-recommends "./groonga-apt-source-latest-${VERSION_CODENAME}.deb" \
  && rm -f "./groonga-apt-source-latest-${VERSION_CODENAME}.deb" \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-18-pgvector postgresql-18-pgdg-pgroonga \
  && rm -rf /var/lib/apt/lists/*
