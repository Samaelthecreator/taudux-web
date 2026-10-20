\set ON_ERROR_STOP on

-- Destructive by design: run only in the isolated database named below.
do $guard$
begin
  if current_database() <> 'taudux_qr_renombrar_0052_test' then
    raise exception 'Refusing to run outside taudux_qr_renombrar_0052_test';
  end if;
end
$guard$;

do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$roles$;

-- Lo que Supabase concede por su cuenta: TODO a anon/authenticated en tablas y
-- funciones nuevas de public. Sin reproducirlo, un `revoke` olvidado en la
-- migración pasaría esta prueba y abriría la función en producción.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  email text,
  email_confirmed_at timestamptz
);

-- Mismo stand-in de auth.uid() que 0046.test: lee el GUC que PostgREST fija por
-- request, así la función corre por el camino real bajo `set role`.
create function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

create table public.perfiles (
  id uuid primary key references auth.users (id) on delete cascade,
  nombre text,
  apellidos text,
  rol text not null default 'usuario'
);

create function public.es_admin()
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select exists (
    select 1 from public.perfiles
    where id = auth.uid() and rol = 'admin'
  );
$$;

-- u1: dueño · u2: otra cuenta · u3: cuenta bloqueada para QR.
insert into auth.users (id, email, email_confirmed_at) values
  ('52000000-0000-4000-8000-000000000001', 'uno@example.com', now()),
  ('52000000-0000-4000-8000-000000000002', 'dos@example.com', now()),
  ('52000000-0000-4000-8000-000000000003', 'tres@example.com', now());
insert into public.perfiles (id, nombre, rol) values
  ('52000000-0000-4000-8000-000000000001', 'Uno', 'usuario'),
  ('52000000-0000-4000-8000-000000000002', 'Dos', 'usuario'),
  ('52000000-0000-4000-8000-000000000003', 'Tres', 'usuario');

-- 0045 (pg_cron/pg_net/vault) se omite a propósito: 0052 no depende de ella y
-- esas extensiones no existen en la base desechable.
\ir ../migrations/0044_qr_codigos.sql
\ir ../migrations/0052_qr_renombrar.sql

create function pg_temp.assert_true(condition boolean, message text)
returns void language plpgsql as $assert$
begin
  if condition is distinct from true then
    raise exception 'assertion failed: %', message;
  end if;
end
$assert$;

-- Prepara: u1 con A (vigente), B (vencido), C (eliminado), D (bloqueado);
-- u3 con E, y después se le bloquea la cuenta.
select (public.qr_crear('52000000-0000-4000-8000-000000000001', 'https://forms.gle/a', 'A', true, true)).codigo;
select (public.qr_crear('52000000-0000-4000-8000-000000000001', 'https://forms.gle/b', 'B', true, true)).codigo;
select (public.qr_crear('52000000-0000-4000-8000-000000000001', 'https://forms.gle/c', 'C', true, true)).codigo;
select (public.qr_crear('52000000-0000-4000-8000-000000000001', 'https://forms.gle/d', 'D', true, true)).codigo;
select (public.qr_crear('52000000-0000-4000-8000-000000000003', 'https://forms.gle/e', 'E', true, true)).codigo;
update public.qr_codigos set vence_en = now() - interval '1 day' where titulo = 'B';
update public.qr_codigos set eliminado_en = now(), eliminado_por = 'usuario' where titulo = 'C';
update public.qr_codigos
   set bloqueado_en = now(), bloqueo_motivo = 'prueba', bloqueado_por = 'administracion'
 where titulo = 'D';
insert into public.qr_acceso (user_id, bloqueado, bloqueo_motivo)
values ('52000000-0000-4000-8000-000000000003', true, 'prueba');

create temp table ids as
select titulo, id from public.qr_codigos;
grant select on ids to anon, authenticated;

-- 1. anon no ejecuta.
select set_config('request.jwt.claim.sub', '', false);
set role anon;
do $anon$
begin
  begin
    perform public.qr_renombrar((select id from ids where titulo = 'A'), 'X');
    raise exception 'anon no debió poder ejecutar';
  exception
    when insufficient_privilege then null;
  end;
end
$anon$;
reset role;

-- 2. Otra cuenta no renombra lo ajeno: false y nada cambia.
select set_config('request.jwt.claim.sub', '52000000-0000-4000-8000-000000000002', false);
set role authenticated;
select pg_temp.assert_true(
  public.qr_renombrar((select id from ids where titulo = 'A'), 'Ajeno') = false,
  'otra cuenta recibe false'
);
reset role;
select pg_temp.assert_true(
  (select titulo = 'A' from public.qr_codigos where id = (select id from ids where titulo = 'A')),
  'el intento ajeno no cambió el nombre'
);

-- 3. El dueño renombra: recorta espacios; vacío quita el nombre; 81 falla.
select set_config('request.jwt.claim.sub', '52000000-0000-4000-8000-000000000001', false);
set role authenticated;
select pg_temp.assert_true(
  public.qr_renombrar((select id from ids where titulo = 'A'), '  Menú del café  '),
  'el dueño renombra su QR'
);
select pg_temp.assert_true(
  public.qr_renombrar((select id from ids where titulo = 'B'), 'Vencido renombrado'),
  'un QR vencido también se renombra'
);
do $largo$
begin
  begin
    perform public.qr_renombrar((select id from ids where titulo = 'B'), repeat('x', 81));
    raise exception 'un nombre de 81 caracteres no debió guardarse';
  exception
    when check_violation then null;
  end;
end
$largo$;
select pg_temp.assert_true(
  public.qr_renombrar((select id from ids where titulo = 'B'), '   '),
  'vacío quita el nombre'
);
select pg_temp.assert_true(
  public.qr_renombrar((select id from ids where titulo = 'C'), 'Eliminado') = false,
  'un QR eliminado no se renombra'
);
select pg_temp.assert_true(
  public.qr_renombrar((select id from ids where titulo = 'D'), 'Bloqueado') = false,
  'un QR bloqueado no se renombra'
);
reset role;

select pg_temp.assert_true(
  (select titulo = 'Menú del café' from public.qr_codigos where id = (select id from ids where titulo = 'A')),
  'el nombre se guarda recortado'
);
select pg_temp.assert_true(
  (select titulo is null from public.qr_codigos where id = (select id from ids where titulo = 'B')),
  'el vencido quedó sin nombre'
);
select pg_temp.assert_true(
  (select titulo = 'C' from public.qr_codigos where id = (select id from ids where titulo = 'C')),
  'el eliminado conserva su nombre'
);
select pg_temp.assert_true(
  (select titulo = 'D' from public.qr_codigos where id = (select id from ids where titulo = 'D')),
  'el bloqueado conserva su nombre'
);

-- 4. Con la cuenta bloqueada para QR, tampoco.
select set_config('request.jwt.claim.sub', '52000000-0000-4000-8000-000000000003', false);
set role authenticated;
select pg_temp.assert_true(
  public.qr_renombrar((select id from ids where titulo = 'E'), 'Otro') = false,
  'una cuenta bloqueada no renombra'
);
reset role;
select set_config('request.jwt.claim.sub', '', false);

\echo 'OK 0052_qr_renombrar'
