-- Renombrar UN QR propio desde "Mis QR".
--
-- Por qué: el nombre (titulo) sólo se fijaba al crear (qr_crear, 0044) y el
-- navegador no puede escribir qr_codigos (la RLS sólo deja leer). El destino
-- sigue sin poder cambiarse (0044: un QR impreso no debe llevar a otro lado);
-- el nombre sí, porque sólo lo ve el dueño.
--
-- Mismo patrón que qr_eliminar (0044): security definer, el dueño se comprueba
-- adentro con auth.uid(), devuelve si cambió algo, execute sólo para
-- authenticated. Vacío quita el nombre; el largo lo acota el check
-- qr_codigos_titulo_acotado (1 a 80). Un QR vencido se puede renombrar (sigue
-- visible como historial); uno eliminado o bloqueado, o de una cuenta
-- bloqueada para QR, no: el bloqueo es de moderación y el nombre es texto
-- libre.
--
-- Aplicar dos veces es seguro (create or replace).

begin;

do $preflight$
begin
  if to_regclass('public.qr_codigos') is null then
    raise exception using
      errcode = 'P0001',
      message = '0052 preflight failed: public.qr_codigos is required (apply 0044 first)';
  end if;

  if to_regclass('public.qr_acceso') is null then
    raise exception using
      errcode = 'P0001',
      message = '0052 preflight failed: public.qr_acceso is required (apply 0044 first)';
  end if;
end
$preflight$;

create or replace function public.qr_renombrar(p_id bigint, p_titulo text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.qr_codigos
     set titulo = nullif(pg_catalog.btrim(p_titulo), '')
   where id = p_id
     and usuario_id = (select auth.uid())
     and eliminado_en is null
     and bloqueado_en is null
     and not exists (
       select 1 from public.qr_acceso a
        where a.user_id = (select auth.uid()) and a.bloqueado
     );
  return found;
end;
$$;

revoke all on function public.qr_renombrar(bigint, text) from public, anon, authenticated;
grant execute on function public.qr_renombrar(bigint, text) to authenticated;

commit;
