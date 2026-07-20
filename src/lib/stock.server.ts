// Stock footage provider interface + Pexels implementation.
// Server-only: PEXELS_API_KEY never touches the client.

export type StockVideoFile = {
  url: string;
  width: number;
  height: number;
};

export type StockVideo = {
  provider: "pexels" | "pixabay";
  provider_clip_id: string;
  duration_sec: number;
  width: number;
  height: number;
  thumbnail_url: string | null;
  files: StockVideoFile[];
};

export type Orientation = "landscape" | "portrait" | "square";

export interface StockProvider {
  readonly name: "pexels" | "pixabay";
  search(query: string, orientation: Orientation, page: number): Promise<StockVideo[]>;
}

const PEXELS_URL = "https://api.pexels.com/videos/search";

export const pexelsProvider: StockProvider = {
  name: "pexels",
  async search(query, orientation, page) {
    const key = process.env.PEXELS_API_KEY;
    if (!key) throw new Error("PEXELS_API_KEY is not configured.");
    const params = new URLSearchParams({
      query,
      orientation,
      per_page: "20",
      page: String(page),
    });
    const res = await fetch(`${PEXELS_URL}?${params.toString()}`, {
      headers: { authorization: key },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`Pexels search failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      videos?: Array<{
        id: number;
        width: number;
        height: number;
        duration: number;
        image?: string;
        video_files?: Array<{ link: string; width: number; height: number }>;
      }>;
    };
    return (json.videos ?? []).map((v) => ({
      provider: "pexels" as const,
      provider_clip_id: String(v.id),
      duration_sec: v.duration,
      width: v.width,
      height: v.height,
      thumbnail_url: v.image ?? null,
      files: (v.video_files ?? [])
        .filter((f) => f.link && f.width && f.height)
        .map((f) => ({ url: f.link, width: f.width, height: f.height })),
    }));
  },
};

export function getStockProvider(): StockProvider {
  return pexelsProvider;
}

export function orientationForAspect(aspect: string): Orientation {
  if (aspect === "portrait") return "portrait";
  if (aspect === "square") return "square";
  return "landscape";
}

export function targetWidthForAspect(aspect: string): number {
  if (aspect === "portrait") return 1080;
  if (aspect === "square") return 1080;
  return 1920;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Search stock footage, dedup against usedIds, filter by minimum duration
 * (with fallback), and randomly pick from the top candidates. Selects the
 * video_file whose width is closest to targetWidth. Uses 24h response cache
 * keyed by (provider, normalized query, orientation) and increments
 * provider_usage on real (non-cached) calls.
 */
export async function searchStockFootage(opts: {
  query: string;
  orientation: Orientation;
  minDurationSec: number;
  targetWidth: number;
  usedIds: string[];
}): Promise<{ pick: StockVideo; chosenFile: StockVideoFile; candidates: StockVideo[] } | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const provider = getStockProvider();
  const normQuery = opts.query.trim().toLowerCase();
  if (!normQuery) return null;

  // 1. Cache lookup
  const { data: cached } = await supabaseAdmin
    .from("stock_search_cache")
    .select("results, cached_at")
    .eq("provider", provider.name)
    .eq("query", normQuery)
    .eq("orientation", opts.orientation)
    .maybeSingle();

  let results: StockVideo[] | null = null;
  const fresh = cached && Date.now() - new Date(cached.cached_at).getTime() < CACHE_TTL_MS;
  if (fresh) {
    results = cached!.results as unknown as StockVideo[];
    await bumpUsage(provider.name, { cache_hit: true });
  } else {
    // 2. Fresh call — random page 1..3 for variety
    const page = 1 + Math.floor(Math.random() * 3);
    results = await provider.search(normQuery, opts.orientation, page);
    await bumpUsage(provider.name, { cache_hit: false });
    // Upsert cache
    await supabaseAdmin
      .from("stock_search_cache")
      .upsert(
        {
          provider: provider.name,
          query: normQuery,
          orientation: opts.orientation,
          results: results as unknown as never,
          cached_at: new Date().toISOString(),
        },
        { onConflict: "provider,query,orientation" },
      );
  }

  if (!results || results.length === 0) return null;

  // 3. Dedup against usedIds
  const used = new Set(opts.usedIds);
  let pool = results.filter((v) => !used.has(v.provider_clip_id) && v.files.length > 0);
  if (pool.length === 0) pool = results.filter((v) => v.files.length > 0);
  if (pool.length === 0) return null;

  // 4. Duration filter, with full-pool fallback
  const longEnough = pool.filter((v) => v.duration_sec >= opts.minDurationSec);
  const candidates = longEnough.length > 0 ? longEnough : pool;

  // 5. Random pick from top 5 for variety
  const topN = candidates.slice(0, Math.min(5, candidates.length));
  const pick = topN[Math.floor(Math.random() * topN.length)];

  // 6. Choose file with width closest to target
  const chosenFile = pick.files.reduce((best, f) =>
    Math.abs(f.width - opts.targetWidth) < Math.abs(best.width - opts.targetWidth) ? f : best,
  );

  return { pick, chosenFile, candidates };
}

async function bumpUsage(provider: string, opts: { cache_hit: boolean }) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const today = new Date().toISOString().slice(0, 10);
  const column = opts.cache_hit ? "cache_hit_count" : "request_count";
  // Try increment via RPC-less pattern: fetch existing row, upsert.
  const { data: existing } = await supabaseAdmin
    .from("provider_usage")
    .select("id, request_count, cache_hit_count")
    .eq("provider", provider)
    .eq("usage_date", today)
    .maybeSingle();
  if (existing) {
    await supabaseAdmin
      .from("provider_usage")
      .update({
        request_count: existing.request_count + (opts.cache_hit ? 0 : 1),
        cache_hit_count: existing.cache_hit_count + (opts.cache_hit ? 1 : 0),
      })
      .eq("id", existing.id);
  } else {
    await supabaseAdmin.from("provider_usage").insert({
      provider,
      usage_date: today,
      request_count: opts.cache_hit ? 0 : 1,
      cache_hit_count: opts.cache_hit ? 1 : 0,
    });
    void column;
  }
}
