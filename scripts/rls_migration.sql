-- ====================================================================
-- RLS password-gate migration.
--
-- Before this migration:
--   anyone holding the publishable key could INSERT / UPDATE / DELETE
--   on site_text, site_image, mural_tiles, and the murals storage
--   bucket. The edit token was checked client-side only.
--
-- After this migration:
--   reads stay open (visitors need to load content).
--   writes require the request to carry an `x-edit-token` header whose
--   SHA-256 matches EDIT_TOKEN_HASH (the same hash the JS editors
--   already validate). The token itself never reaches the server in
--   plaintext anywhere durable — only in the header on individual
--   write requests, scoped to that request's lifetime.
--
-- To rotate the token: change EDIT_TOKEN_HASH below + the constant in
-- the four editor scripts (murals-board / text-editor / image-editor /
-- edit-nav), then re-run this file.
--
-- Run in Supabase Studio → SQL Editor → New query → paste → Run.
-- ====================================================================

-- pgcrypto provides digest() for SHA-256.
create extension if not exists pgcrypto;

-- ---------- Token-check function ----------

create or replace function public.check_edit_token() returns boolean
language plpgsql
stable
as $$
declare
  tok text;
begin
  -- request.headers is set by PostgREST per-request. The cast-to-text
  -- option keeps this safe for builds where the GUC isn't set.
  begin
    tok := current_setting('request.headers', true)::json->>'x-edit-token';
  exception when others then
    tok := null;
  end;

  if tok is null or tok = '' then
    return false;
  end if;

  return encode(digest(tok, 'sha256'), 'hex')
    = '1b74c41ae62fd8c45c9c6b129291144bb67598d7ae3110b589e141428e95ef67';
end;
$$;

grant execute on function public.check_edit_token() to anon, authenticated;

-- ---------- site_text ----------

alter table public.site_text enable row level security;

drop policy if exists "site_text_anon_all" on public.site_text;
drop policy if exists "site_text_open" on public.site_text;
drop policy if exists "site_text_read" on public.site_text;
drop policy if exists "site_text_insert" on public.site_text;
drop policy if exists "site_text_update" on public.site_text;
drop policy if exists "site_text_delete" on public.site_text;

create policy "site_text_read"
  on public.site_text for select
  using (true);

create policy "site_text_insert"
  on public.site_text for insert
  with check (public.check_edit_token());

create policy "site_text_update"
  on public.site_text for update
  using (public.check_edit_token())
  with check (public.check_edit_token());

create policy "site_text_delete"
  on public.site_text for delete
  using (public.check_edit_token());

-- ---------- site_image ----------

alter table public.site_image enable row level security;

drop policy if exists "site_image_anon_all" on public.site_image;
drop policy if exists "site_image_open" on public.site_image;
drop policy if exists "site_image_read" on public.site_image;
drop policy if exists "site_image_insert" on public.site_image;
drop policy if exists "site_image_update" on public.site_image;
drop policy if exists "site_image_delete" on public.site_image;

create policy "site_image_read"
  on public.site_image for select
  using (true);

create policy "site_image_insert"
  on public.site_image for insert
  with check (public.check_edit_token());

create policy "site_image_update"
  on public.site_image for update
  using (public.check_edit_token())
  with check (public.check_edit_token());

create policy "site_image_delete"
  on public.site_image for delete
  using (public.check_edit_token());

-- ---------- mural_tiles ----------

alter table public.mural_tiles enable row level security;

drop policy if exists "mural_tiles_anon_all" on public.mural_tiles;
drop policy if exists "mural_tiles_open" on public.mural_tiles;
drop policy if exists "mural_tiles_read" on public.mural_tiles;
drop policy if exists "mural_tiles_insert" on public.mural_tiles;
drop policy if exists "mural_tiles_update" on public.mural_tiles;
drop policy if exists "mural_tiles_delete" on public.mural_tiles;

create policy "mural_tiles_read"
  on public.mural_tiles for select
  using (true);

create policy "mural_tiles_insert"
  on public.mural_tiles for insert
  with check (public.check_edit_token());

create policy "mural_tiles_update"
  on public.mural_tiles for update
  using (public.check_edit_token())
  with check (public.check_edit_token());

create policy "mural_tiles_delete"
  on public.mural_tiles for delete
  using (public.check_edit_token());

-- ---------- Storage bucket: murals ----------

-- The bucket itself is configured public from the dashboard so anyone
-- can read uploaded files via the public URL — that's how the live
-- site serves them. Uploads / overwrites / deletes go through the
-- objects table, so we gate those.

drop policy if exists "murals_anon_all" on storage.objects;
drop policy if exists "murals_open" on storage.objects;
drop policy if exists "murals_read" on storage.objects;
drop policy if exists "murals_insert" on storage.objects;
drop policy if exists "murals_update" on storage.objects;
drop policy if exists "murals_delete" on storage.objects;

create policy "murals_read"
  on storage.objects for select
  using (bucket_id = 'murals');

create policy "murals_insert"
  on storage.objects for insert
  with check (bucket_id = 'murals' and public.check_edit_token());

create policy "murals_update"
  on storage.objects for update
  using (bucket_id = 'murals' and public.check_edit_token())
  with check (bucket_id = 'murals' and public.check_edit_token());

create policy "murals_delete"
  on storage.objects for delete
  using (bucket_id = 'murals' and public.check_edit_token());

-- ---------- Done ----------

-- Smoke-test (uncomment to verify after running):
--   set local request.headers = '{"x-edit-token":"80nl4NHCW-cUk-3GL1P8zg"}';
--   select public.check_edit_token();   -- expect true
--   set local request.headers = '{"x-edit-token":"wrong"}';
--   select public.check_edit_token();   -- expect false
