# DentAcademy backend foundation

This folder starts the backend on Supabase (PostgreSQL + Supabase Auth + row-level security). It defines tenant-aware organizations, memberships, courses, lessons, tests, progress, certificates, conversations, webinars, library materials, saved materials, and notes.

## Files

- `config.toml` — Supabase local project settings.
- `migrations/20261013000100_initial_schema.sql` — versioned schema and access policies.
- `.env.example` — placeholders only; never commit a real `.env` or secret key.

## Apply the migration

1. Create a Supabase project and install the Supabase CLI, following the official setup docs.
2. From the repository root, authenticate with `supabase login`, then link the local project with `supabase link`.
3. Review the migration, then run `supabase db push` to apply it. Use a separate development project first; do not connect this starter to production data.
4. Create a test user through Supabase Auth. The database trigger creates its `profiles` row. Create an organization, then give its creator the initial `admin` membership. Subsequent role grants should be performed by an authorized administrator.
5. Keep schema changes in new timestamped files under `supabase/migrations/`; do not edit an already-applied migration.

Official references:

- [Database migrations](https://supabase.com/docs/guides/deployment/database-migrations)
- [Row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase CLI](https://supabase.com/docs/reference/cli/introduction)

## Important implementation notes

- The front end is not connected to this schema yet; the next implementation step is authentication and typed API calls.
- Files are represented by storage paths. A later migration must define private Storage buckets and matching `storage.objects` policies before accepting real documents.
- Test question `options` are visible to authenticated users for this demo foundation. Before real exams, separate answer keys from public question data and submit/score attempts through a trusted server-side function.
- This first migration is a development foundation, not a production security review. Review policies with test accounts for each role before loading real user or clinic data.
