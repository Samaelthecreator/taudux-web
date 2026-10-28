-- Regla «solo sesiones vivas» (S8): una sesión cerrada pierde el acceso a los
-- datos al instante, aunque su JWT siga valiendo hasta 10 min (S12).
--
-- public.sesion_viva() responde si la sesión del token sigue en auth.sessions
-- (y es de quien firma el token). Cada tabla de public con RLS recibe una
-- política `restrictive` sólo para `authenticated`; `anon` y `service_role`
-- no cambian. Restrictive se suma con AND a las políticas que ya había: no
-- abre nada, sólo cierra.
--
--   * tablas con datos de usuario: `for all` (leer, crear, editar, borrar);
--   * catálogos públicos (cursos, categorias, extractor_planes, qr_planes):
--     sólo insert/update/delete; leerlos sigue igual (L21);
--   * storage.objects: sólo insert/update/delete; ver archivos públicos sigue
--     igual (L21).
--
-- Las funciones `security definer` ignoran RLS. Sólo sesion_cerrar y
-- sesiones_cerrar_demas comprueban la sesión (L20/L21); las demás aceptan el
-- margen de ≤10 min del JWT (documentado en el runbook).
--
-- Una tabla nueva de public con RLS debe sumar su política aquí o en su
-- propia migración: el postflight de abajo sólo cubre lo que existe hoy.
--
-- Reaplicar es seguro: cada política se borra por nombre antes de crearse.

begin;

do $preflight$
begin
  if to_regprocedure('public.sesion_cerrar(uuid)') is null
     or to_regprocedure('public.sesiones_cerrar_demas()') is null then
    raise exception using
      errcode = 'P0001',
      message = '0057 preflight failed: 0055 and 0056 must be applied first';
  end if;

  if to_regclass('public.cursos') is null
     or to_regclass('public.categorias') is null
     or to_regclass('public.extractor_planes') is null
     or to_regclass('public.qr_planes') is null then
    raise exception using
      errcode = 'P0001',
      message = '0057 preflight failed: a public catalog table is missing';
  end if;

  if to_regclass('storage.objects') is null then
    raise exception using
      errcode = 'P0001',
      message = '0057 preflight failed: storage.objects is required';
  end if;

  if not has_table_privilege('auth.sessions', 'SELECT') then
    raise exception using
      errcode = 'P0001',
      message = '0057 preflight failed: current role needs SELECT on auth.sessions';
  end if;
end
$preflight$;

-- `stable` + `(select ...)` en las políticas: se evalúa una vez por sentencia.
create or replace function public.sesion_viva()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from auth.sessions s
     where s.id = nullif((select auth.jwt() ->> 'session_id'), '')::uuid
       and s.user_id = (select auth.uid())
  );
$$;

revoke all on function public.sesion_viva() from public, anon, authenticated;
grant execute on function public.sesion_viva() to authenticated;

do $politicas$
declare
  v_catalogos constant text[] := array['cursos', 'categorias', 'extractor_planes', 'qr_planes'];
  v_tabla text;
  v_cmd text;
begin
  for v_tabla in
    select c.relname
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p')
       and c.relrowsecurity
     order by c.relname
  loop
    if v_tabla = any (v_catalogos) then
      foreach v_cmd in array array['insert', 'update', 'delete'] loop
        execute format('drop policy if exists %I on public.%I',
                       v_tabla || '_' || v_cmd || '_sesion_viva', v_tabla);
        execute format(
          'create policy %I on public.%I as restrictive for %s to authenticated %s',
          v_tabla || '_' || v_cmd || '_sesion_viva', v_tabla, v_cmd,
          case v_cmd
            when 'insert' then 'with check ((select public.sesion_viva()))'
            when 'update' then 'using ((select public.sesion_viva())) with check ((select public.sesion_viva()))'
            else 'using ((select public.sesion_viva()))'
          end);
      end loop;
    else
      execute format('drop policy if exists %I on public.%I',
                     v_tabla || '_sesion_viva', v_tabla);
      execute format(
        'create policy %I on public.%I as restrictive for all to authenticated '
        'using ((select public.sesion_viva())) with check ((select public.sesion_viva()))',
        v_tabla || '_sesion_viva', v_tabla);
    end if;
  end loop;
end
$politicas$;

drop policy if exists objetos_insert_sesion_viva on storage.objects;
create policy objetos_insert_sesion_viva
  on storage.objects as restrictive for insert to authenticated
  with check ((select public.sesion_viva()));

drop policy if exists objetos_update_sesion_viva on storage.objects;
create policy objetos_update_sesion_viva
  on storage.objects as restrictive for update to authenticated
  using ((select public.sesion_viva()))
  with check ((select public.sesion_viva()));

drop policy if exists objetos_delete_sesion_viva on storage.objects;
create policy objetos_delete_sesion_viva
  on storage.objects as restrictive for delete to authenticated
  using ((select public.sesion_viva()));

-- Igual que en 0055, más la comprobación: un JWT de una sesión ya cerrada no
-- puede cerrar las demás (L20).
create or replace function public.sesion_cerrar(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actual uuid := nullif((select auth.jwt() ->> 'session_id'), '')::uuid;
  v_cerradas integer;
begin
  if v_actual is null or not public.sesion_viva() then
    return false;
  end if;

  with borrada as (
    delete from auth.sessions
     where id = p_id
       and user_id = (select auth.uid())
       and id <> v_actual
    returning id, user_id, created_at, updated_at, refreshed_at, user_agent
  ), historial as (
    insert into public.sesiones_presencia as d (
      session_id, user_id, iniciada_en, ultimo_latido, user_agent, cerrada_en, motivo_cierre
    )
    select b.id, b.user_id,
           coalesce(b.created_at, now()),
           coalesce(b.refreshed_at at time zone 'UTC', b.updated_at, b.created_at, now()),
           b.user_agent, now(), 'cerrada por ti'
      from borrada b
    on conflict (session_id) do update
      set cerrada_en = now(),
          motivo_cierre = 'cerrada por ti'
      where d.cerrada_en is null
  )
  select count(*) into v_cerradas from borrada;
  return v_cerradas > 0;
end;
$$;

-- Igual que en 0056, más la comprobación (L20).
create or replace function public.sesiones_cerrar_demas()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actual uuid := nullif((select auth.jwt() ->> 'session_id'), '')::uuid;
  v_cerradas integer;
begin
  if v_actual is null or not public.sesion_viva() then
    return 0;
  end if;

  with borrada as (
    delete from auth.sessions
     where user_id = (select auth.uid())
       and id <> v_actual
    returning id, user_id, created_at, updated_at, refreshed_at, user_agent
  ), historial as (
    insert into public.sesiones_presencia as d (
      session_id, user_id, iniciada_en, ultimo_latido, user_agent, cerrada_en, motivo_cierre
    )
    select b.id, b.user_id,
           coalesce(b.created_at, now()),
           coalesce(b.refreshed_at at time zone 'UTC', b.updated_at, b.created_at, now()),
           b.user_agent, now(), 'cerrada por ti'
      from borrada b
    on conflict (session_id) do update
      set cerrada_en = now(),
          motivo_cierre = 'cerrada por ti'
      where d.cerrada_en is null
  )
  select count(*) into v_cerradas from borrada;
  return v_cerradas;
end;
$$;

revoke all on function public.sesion_cerrar(uuid) from public, anon, authenticated;
revoke all on function public.sesiones_cerrar_demas() from public, anon, authenticated;
grant execute on function public.sesion_cerrar(uuid) to authenticated;
grant execute on function public.sesiones_cerrar_demas() to authenticated;

-- Postflight: ninguna tabla de public con RLS quedó sin la regla (por nombre
-- exacto: una por tabla de datos, tres por catálogo).
do $postflight$
declare
  v_faltan text;
begin
  with esperada as (
    select c.relname as tabla,
           unnest(case
             when c.relname in ('cursos', 'categorias', 'extractor_planes', 'qr_planes')
               then array[c.relname || '_insert_sesion_viva',
                          c.relname || '_update_sesion_viva',
                          c.relname || '_delete_sesion_viva']
             else array[c.relname || '_sesion_viva']
           end) as politica
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p')
       and c.relrowsecurity
  )
  select string_agg(e.politica, ', ' order by e.politica) into v_faltan
    from esperada e
   where not exists (
     select 1 from pg_catalog.pg_policies p
      where p.schemaname = 'public'
        and p.tablename = e.tabla
        and p.policyname = e.politica
        and p.permissive = 'RESTRICTIVE'
   );

  if v_faltan is not null then
    raise exception using
      errcode = 'P0001',
      message = '0057 postflight failed: missing live-session policies: ' || v_faltan;
  end if;
end
$postflight$;

commit;
