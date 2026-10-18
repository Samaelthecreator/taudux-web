\set ON_ERROR_STOP on

-- Destructive by design: run only in the isolated database named below.
do $guard$
begin
  if current_database() <> 'taudux_qr_aviso_vencimiento_0053_test' then
    raise exception 'Refusing to run outside taudux_qr_aviso_vencimiento_0053_test';
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
-- migración pasaría esta prueba y abriría las funciones en producción.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
-- deleted_at: lo usa la selección de destinatarios (como 0015).
create table auth.users (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  email text,
  email_confirmed_at timestamptz,
  deleted_at timestamptz
);

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

-- u1: cuenta normal · u2: sin confirmar · u3: bloqueada para QR · u4: borrada.
insert into auth.users (id, email, email_confirmed_at, deleted_at) values
  ('53000000-0000-4000-8000-000000000001', 'uno@example.com', now(), null),
  ('53000000-0000-4000-8000-000000000002', 'dos@example.com', null, null),
  ('53000000-0000-4000-8000-000000000003', 'tres@example.com', now(), null),
  ('53000000-0000-4000-8000-000000000004', 'cuatro@example.com', now(), now());
insert into public.perfiles (id, nombre) values
  ('53000000-0000-4000-8000-000000000001', 'Uno'),
  ('53000000-0000-4000-8000-000000000002', 'Dos'),
  ('53000000-0000-4000-8000-000000000003', 'Tres'),
  ('53000000-0000-4000-8000-000000000004', 'Cuatro');

-- 0045 (pg_cron/pg_net/vault) y 0054 se omiten a propósito: 0053 no depende de
-- ellas y esas extensiones no existen en la base desechable.
\ir ../migrations/0044_qr_codigos.sql
\ir ../migrations/0053_qr_aviso_vencimiento.sql

insert into public.qr_acceso (user_id, bloqueado, bloqueo_motivo)
values ('53000000-0000-4000-8000-000000000003', true, 'prueba');

-- Directo a la tabla (no qr_crear): lo que se prueba es la selección, no el
-- cupo del plan. A..G de u1; H, I, J de u2, u3, u4.
insert into public.qr_codigos (codigo, destino, titulo, usuario_id, dominio_confiable, vence_en)
select public.qr_generar_codigo(), 'https://forms.gle/' || t, t, u::uuid, true, now() + v
from (values
  ('A', '53000000-0000-4000-8000-000000000001', interval '12 hours'),
  ('B', '53000000-0000-4000-8000-000000000001', interval '30 hours'),
  ('C', '53000000-0000-4000-8000-000000000001', interval '-1 hour'),
  ('E', '53000000-0000-4000-8000-000000000001', interval '10 hours'),
  ('F', '53000000-0000-4000-8000-000000000001', interval '10 hours'),
  ('G', '53000000-0000-4000-8000-000000000001', interval '20 hours'),
  ('K', '53000000-0000-4000-8000-000000000001', interval '2 hours'),
  ('H', '53000000-0000-4000-8000-000000000002', interval '5 hours'),
  ('I', '53000000-0000-4000-8000-000000000003', interval '5 hours'),
  ('J', '53000000-0000-4000-8000-000000000004', interval '5 hours')
) as datos (t, u, v);
insert into public.qr_codigos (codigo, destino, titulo, usuario_id, dominio_confiable, vence_en)
values (public.qr_generar_codigo(), 'https://forms.gle/D', 'D', '53000000-0000-4000-8000-000000000001', true, null);
update public.qr_codigos set eliminado_en = now(), eliminado_por = 'usuario' where titulo = 'E';
update public.qr_codigos
   set bloqueado_en = now(), bloqueo_motivo = 'prueba', bloqueado_por = 'administracion'
 where titulo = 'F';
update public.qr_codigos set aviso_vencimiento_para = vence_en where titulo = 'G';

create function pg_temp.assert_true(condition boolean, message text)
returns void language plpgsql as $assert$
begin
  if condition is distinct from true then
    raise exception 'assertion failed: %', message;
  end if;
end
$assert$;

-- 1. Privilegios: anon y authenticated no ejecutan ninguna de las dos.
do $privilegios$
declare
  r text;
  f text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    foreach f in array array[
      'public.qr_avisos_vencimiento_pendientes(integer)',
      'public.qr_marcar_aviso_vencimiento(bigint,timestamp with time zone)'
    ] loop
      if has_function_privilege(r, f, 'execute') then
        raise exception '% no debió poder ejecutar %', r, f;
      end if;
    end loop;
  end loop;
  if not has_function_privilege('service_role', 'public.qr_avisos_vencimiento_pendientes(integer)', 'execute')
     or not has_function_privilege('service_role', 'public.qr_marcar_aviso_vencimiento(bigint,timestamp with time zone)', 'execute') then
    raise exception 'service_role debe poder ejecutar ambas';
  end if;
end
$privilegios$;

set role anon;
do $anon$
begin
  begin
    perform public.qr_avisos_vencimiento_pendientes(10);
    raise exception 'anon no debió poder leer correos';
  exception
    when insufficient_privilege then null;
  end;
end
$anon$;
reset role;

-- 2. Selección: sólo lo que vence en las próximas 24 h y no se avisó, de
-- cuentas vivas, confirmadas y no bloqueadas; el más próximo primero.
set role service_role;
select pg_temp.assert_true(
  (select array_agg(titulo order by orden) from (
     select titulo, row_number() over () as orden from public.qr_avisos_vencimiento_pendientes(100)
   ) p) = array['K', 'A'],
  'pendientes: K (2 h) y A (12 h); no B (30 h), C (vencido), D (sin vencimiento), E (eliminado), '
  'F (bloqueado), G (ya avisado), H (sin confirmar), I (cuenta bloqueada), J (cuenta borrada)'
);
select pg_temp.assert_true(
  (select email = 'uno@example.com' and codigo ~ '^[2-9a-hjkmnp-z]{6}$' and vence_en is not null
     from public.qr_avisos_vencimiento_pendientes(100) where titulo = 'A'),
  'cada pendiente trae el correo del creador, el código y el vencimiento'
);
select pg_temp.assert_true(
  (select count(*) = 1 from public.qr_avisos_vencimiento_pendientes(1)),
  'p_limite acota el lote'
);

-- 3. Marcar: sólo con el vencimiento vigente; después ya no sale.
select pg_temp.assert_true(
  public.qr_marcar_aviso_vencimiento(
    (select id from public.qr_codigos where titulo = 'A'),
    (select vence_en from public.qr_codigos where titulo = 'A')),
  'marca A con su vencimiento'
);
select pg_temp.assert_true(
  public.qr_marcar_aviso_vencimiento(
    (select id from public.qr_codigos where titulo = 'K'),
    (select vence_en - interval '1 day' from public.qr_codigos where titulo = 'K')) = false,
  'con un vencimiento que ya no es el vigente no marca nada'
);
select pg_temp.assert_true(
  (select array_agg(titulo) from public.qr_avisos_vencimiento_pendientes(100)) = array['K'],
  'A ya no sale; K sigue pendiente'
);
reset role;

-- 4. Si el admin cambia el vencimiento de un QR ya avisado, el aviso se rearma.
update public.qr_codigos set vence_en = now() + interval '6 hours' where titulo = 'G';
set role service_role;
select pg_temp.assert_true(
  (select array_agg(titulo order by vence_en) from public.qr_avisos_vencimiento_pendientes(100)) = array['K', 'G'],
  'G vuelve a salir con su vencimiento nuevo'
);
reset role;

\echo 'OK 0053_qr_aviso_vencimiento'
