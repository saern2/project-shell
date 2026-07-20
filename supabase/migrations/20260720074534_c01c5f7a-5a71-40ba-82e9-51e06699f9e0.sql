create or replace function public.increment_provider_usage(
  p_provider  text,
  p_date      date,
  p_cache_hit boolean
) returns void as $$
begin
  insert into public.provider_usage (provider, usage_date, request_count, cache_hit_count)
  values (
    p_provider,
    p_date,
    case when p_cache_hit then 0 else 1 end,
    case when p_cache_hit then 1 else 0 end
  )
  on conflict (provider, usage_date)
  do update set
    request_count   = public.provider_usage.request_count + excluded.request_count,
    cache_hit_count = public.provider_usage.cache_hit_count + excluded.cache_hit_count,
    updated_at      = now();
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function public.increment_provider_usage(text, date, boolean) to service_role;