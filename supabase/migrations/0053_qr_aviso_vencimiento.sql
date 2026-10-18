-- Aviso por correo al creador cuando a su QR le falta un día para vencer.
--
-- Esta migración sólo deja la parte de la base: qué QR toca avisar y cómo se
-- marca uno como avisado. El correo lo manda la edge function
-- avisar-vencimiento-qr y la programa pg_cron cada hora (0054).
--
-- Por qué una columna y no una tabla de envíos: alcanza con recordar QUÉ
-- vencimiento se avisó. aviso_vencimiento_para = el vence_en del aviso enviado.
-- Si un admin cambia el vencimiento (qr_cambiar_vencimiento, 0046), vence_en
-- deja de coincidir y el aviso se rearma solo, sin limpiar nada.
--
-- Funciones sólo para service_role: devuelven correos de usuarios.
--
-- Aplicar dos veces es seguro (add column if not exists, create or replace).

begin;

do $preflight$
begin
  if to_regclass('public.qr_codigos') is null then
    raise exception using
      errcode = 'P0001',
      message = '0053 preflight failed: public.qr_codigos is required (apply 0044 first)';
  end if;

  if to_regclass('public.qr_acceso') is null then
    raise exception using
      errcode = 'P0001',
      message = '0053 preflight failed: public.qr_acceso is required (apply 0044 first)';
  end if;
end
$preflight$;

alter table public.qr_codigos
  add column if not exists aviso_vencimiento_para timestamptz;

comment on column public.qr_codigos.aviso_vencimiento_para is
  'El vence_en para el que ya se mandó el aviso de "vence mañana". null = nunca '
  'se avisó. Si vence_en cambia, deja de coincidir y el aviso se rearma.';

-- Los QR que vencen en las próximas 24 h y no se avisaron, con el correo del
-- creador. Afuera: sin vencimiento, eliminados, bloqueados, cuentas bloqueadas
-- para QR, y cuentas borradas o sin correo confirmado (mismo criterio que
-- destinatarios_curso_anuncio, 0015). El más próximo a vencer primero: si el
-- lote no alcanza, el que queda espera una hora, no el que vence antes.
create or replace function public.qr_avisos_vencimiento_pendientes(p_limite integer default 100)
returns table (id bigint, codigo text, titulo text, vence_en timestamptz, email text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.codigo, c.titulo, c.vence_en, u.email::text
    from public.qr_codigos c
    join auth.users u on u.id = c.usuario_id
   where c.vence_en > now()
     and c.vence_en <= now() + interval '24 hours'
     and c.aviso_vencimiento_para is distinct from c.vence_en
     and c.eliminado_en is null
     and c.bloqueado_en is null
     and u.email is not null
     and u.email_confirmed_at is not null
     and u.deleted_at is null
     and not exists (
       select 1 from public.qr_acceso a
        where a.user_id = c.usuario_id and a.bloqueado
     )
   order by c.vence_en, c.id
   limit greatest(coalesce(p_limite, 0), 0);
$$;

-- Marca el aviso SÓLO si vence_en sigue siendo el que se avisó: si un admin lo
-- cambió entre la lectura y el envío, no se marca y el aviso nuevo sale igual.
create or replace function public.qr_marcar_aviso_vencimiento(p_id bigint, p_vence_en timestamptz)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.qr_codigos
     set aviso_vencimiento_para = p_vence_en
   where id = p_id
     and vence_en = p_vence_en;
  return found;
end;
$$;

revoke all on function public.qr_avisos_vencimiento_pendientes(integer) from public, anon, authenticated;
revoke all on function public.qr_marcar_aviso_vencimiento(bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.qr_avisos_vencimiento_pendientes(integer) to service_role;
grant execute on function public.qr_marcar_aviso_vencimiento(bigint, timestamptz) to service_role;

commit;
