# supabase/

SQL for the A.I.R. project. Read this before running anything.

## The migrations in `migrations/` are archival

There is no `supabase/config.toml` in this repo, so nothing here is driven by
`supabase db push` or the Supabase CLI. The files in `migrations/` record what
the schema is *meant* to be, and they are the source of truth for a fresh
install.

The live `air-project` database is **not** managed by them. The migrations that
have already run there are recorded in the `supabase_migrations` table, and that
the live project is **not** managed by them. The migrations that
have already run there are recorded in the `supabase_migrations` table, and that
list no longer matches this directory — some were applied out of band, and
`20260911000000_thresholds_table.sql` (the `platform_thresholds` table) was never
applied at all. So:

- Editing an existing file in `migrations/` changes nothing on the live project.
  `supabase db push` would skip it as already applied.
- New schema on the live project comes from pasting, not from pushing.

To see what the live project actually believes was applied:

```sql
select version, name from supabase_migrations order by version;
```

## Canonical deploy path: paste `DEPLOY-ALL.sql`

`DEPLOY-ALL.sql` is the script that actually reaches the live database. Paste it
into the Supabase SQL editor and run it. It is written to be order-independent
and re-runnable: policies are dropped before they are created, predicates are
`create or replace`, and objects use `if not exists`.

**The editor runs the whole batch as one transaction.** A single failed
statement rolls back everything that came before it, which is how a partial
deploy ends up looking successful. So check the results pane actually reports
`Success` with no rollback, and read the `raise notice`/`raise warning` lines in
the Notices tab — a section that skipped itself says so there.

The file ends with a `VERIFICATION` block of SELECTs. Each has a trailing
`-- want:` comment stating the expected value; read the returned rows against
those.

### Other scripts

| File | Use |
| --- | --- |
| `DEPLOY-ALL.sql` | Canonical. Everything, plus verification at the end. |
| `PASTE-IN-SUPABASE.sql` | Smaller guarded subset. Each section no-ops with a `raise warning` if the object it needs is missing. |
| `RESUME-PART-6-8.sql` | Resume block. Use when a paste aborted before `public.is_approved_account()` / `public.is_active_admin()` existed — PART 7 and 8 policies reference them and cannot be applied alone. |
| `REPAIR-BOOTSTRAP-ADMIN.sql` | One-off. Promotes `kiararagodo@gmail.com` to active approved admin. |
| `DEPLOY-MONTHLY-REPORTING.md` | Monthly reporting job notes. |

`platform_thresholds` must contain its single configuration row. An empty table
makes every SQL report function raise `No threshold configuration found` while
the dashboard silently falls back to built-in defaults. The seed only inserts
when absent, so re-running never overwrites an admin's saved edits.

## Types

`profiles.id` is `uuid` on this project. Some of the older SQL assumed `text`
and raised `operator does not exist: uuid = text`, which PostgreSQL reports at
runtime — meaning the statement failed *inside an RLS policy*, so every read
silently returned nothing and the admin gate was never applied.

Policy comparisons therefore cast the column rather than `auth.uid()`:

```sql
p.id::text = auth.uid()::text      -- correct whether the column is uuid or text
user_id::text = auth.uid()::text
```

Keep that form. `auth.uid()::text = p.id` is the version that breaks.

`profiles.approved_by` is still `text` while `profiles.id` is `uuid`. It works
because uuid→text is an assignment cast, but any future query comparing the two
directly will hit the same class of error.

`notifications.user_id` is `uuid` from `20260911010000`, but that migration used
`create table if not exists`, so where the table already existed the declaration
was a no-op and the live column stayed `text`. `20260916010000` converges it on
`uuid`; it is inlined as section 5a of `DEPLOY-ALL.sql`.

## Type safety in the app

`src/types/database.types.ts` is hand-written and only covers `readings` and
`rooms`. There is no generated type for `profiles` or `notifications`, so
`supabase.from("notifications")` is untyped and the column types are not checked
at build time. Regenerate with `npx supabase gen types typescript` when
convenient.