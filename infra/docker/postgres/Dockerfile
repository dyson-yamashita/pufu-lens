FROM apache/age:release_PG18_1.7.0

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates lsb-release wget \
  && wget "https://packages.groonga.org/debian/groonga-apt-source-latest-$(lsb_release --codename --short).deb" \
  && apt-get install -y --no-install-recommends "./groonga-apt-source-latest-$(lsb_release --codename --short).deb" \
  && rm -f "groonga-apt-source-latest-$(lsb_release --codename --short).deb" \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-18-pgvector postgresql-18-pgdg-pgroonga \
  && rm -rf /var/lib/apt/lists/*
