#!/bin/sh
# Runs once, when the bundled PostgreSQL initialises an empty data directory.
# Creates the read-only role the query engine connects with (DB_QUERY_URL).
# It can log in and nothing else: the app grants SELECT on the tables the
# query engine may read after it has migrated.
set -eu
psql -v ON_ERROR_STOP=1 -v pw="$QUERY_DB_PASSWORD" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE tvn_query LOGIN PASSWORD :'pw';
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO tvn_query;
SQL
