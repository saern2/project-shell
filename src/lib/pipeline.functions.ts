import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const ProjectIdInput = z.object({ projectId: z.string().uuid() });

/**
 * Kick off the pipeline for a project that has an uploaded audio asset.
 * - Fetches the project's audio asset (RLS scopes this to the caller)
 * - Requests a signed download URL for the audio (60 minutes)
 * - Submits transcription to the ASR provider (AssemblyAI)
 * - Stores the provider job id and flips status to "transcribing"
 */
export const startPipeline = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ProjectIdInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const projectId = data.projectId;

    const { data: project, error: projectErr } = await supabase
      .from("projects")
      .select("id, status, user_id")
      .eq("id", projectId)
      .maybeSingle();
    if (projectErr) throw new Error(projectErr.message);
    if (!project) throw new Error("Project not found.");
    if (project.user_id !== userId) throw new Error("Forbidden.");

    // Idempotent: allow re-triggering only from draft/failed/uploading.
    if (!["draft", "failed", "uploading"].includes(project.status)) {
      return { ok: true, status: project.status };
    }

    const { data: asset, error: assetErr } = await supabase
      .from("audio_assets")
      .select("id, storage_path")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (assetErr) throw new Error(assetErr.message);
    if (!asset) throw new Error("No audio uploaded for this project.");

    const { data: signed, error: signedErr } = await supabase.storage
      .from("audio")
      .createSignedUrl(asset.storage_path, 60 * 60);
    if (signedErr || !signed?.signedUrl) {
      throw new Error(signedErr?.message ?? "Could not create signed download URL.");
    }

    try {
      const { getAsrProvider } = await import("@/lib/asr.server");
      const provider = getAsrProvider();
      const { jobId } = await provider.submit(signed.signedUrl);

      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { error: updErr } = await supabaseAdmin
        .from("projects")
        .update({
          status: "transcribing",
          provider_job_id: jobId,
          error_message: null,
        })
        .eq("id", projectId);
      if (updErr) throw new Error(updErr.message);

      return { ok: true, status: "transcribing" };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start pipeline.";
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin
        .from("projects")
        .update({ status: "failed", error_message: message })
        .eq("id", projectId);
      throw new Error(message);
    }
  });

/**
 * Drive the pipeline forward one step. Safe to call repeatedly:
 * - transcribing: poll ASR; on completion save transcript + scenes and advance
 * - generating_scenes: generate visual queries and advance to ready
 * - other states: return current state unchanged
 */
export const pollPipeline = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ProjectIdInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const projectId = data.projectId;

    const { data: project, error: projErr } = await supabase
      .from("projects")
      .select("id, status, user_id, provider_job_id, error_message")
      .eq("id", projectId)
      .maybeSingle();
    if (projErr) throw new Error(projErr.message);
    if (!project) throw new Error("Project not found.");
    if (project.user_id !== userId) throw new Error("Forbidden.");

    if (project.status === "transcribing") {
      return await advanceFromTranscribing(projectId, project.provider_job_id);
    }
    if (project.status === "generating_scenes") {
      return await advanceFromGeneratingScenes(projectId);
    }
    return {
      status: project.status,
      error_message: project.error_message,
    };
  });

async function advanceFromTranscribing(projectId: string, providerJobId: string | null) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  if (!providerJobId) {
    await supabaseAdmin
      .from("projects")
      .update({ status: "failed", error_message: "Missing transcription job id." })
      .eq("id", projectId);
    return { status: "failed", error_message: "Missing transcription job id." };
  }

  try {
    const { getAsrProvider } = await import("@/lib/asr.server");
    const provider = getAsrProvider();
    const result = await provider.poll(providerJobId);

    if (result.state === "queued" || result.state === "processing") {
      return { status: "transcribing", error_message: null };
    }
    if (result.state === "failed") {
      await supabaseAdmin
        .from("projects")
        .update({ status: "failed", error_message: `Transcription failed: ${result.error}` })
        .eq("id", projectId);
      return { status: "failed", error_message: result.error };
    }

    // Completed. Find audio asset id (for FK).
    const { data: asset } = await supabaseAdmin
      .from("audio_assets")
      .select("id")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: transcript, error: tErr } = await supabaseAdmin
      .from("transcripts")
      .insert({
        project_id: projectId,
        audio_asset_id: asset?.id ?? null,
        provider: provider.name,
        full_text: result.full_text,
        language: result.language,
        word_timestamps: result.words as unknown as never,
      })
      .select("id")
      .single();
    if (tErr || !transcript) throw new Error(tErr?.message ?? "Failed to save transcript.");

    // Fallback: if AssemblyAI returned no sentences for some reason, treat
    // the whole transcript as one scene rather than blocking the pipeline.
    const sentences = result.sentences.length
      ? result.sentences
      : [
          {
            text: result.full_text,
            start_ms: result.words[0]?.start_ms ?? 0,
            end_ms: result.words.at(-1)?.end_ms ?? 0,
          },
        ];

    const sceneRows = sentences.map((s, idx) => ({
      project_id: projectId,
      transcript_id: transcript.id,
      idx,
      text: s.text,
      start_ts: s.start_ms / 1000,
      end_ts: s.end_ms / 1000,
      status: "pending",
    }));
    if (sceneRows.length) {
      const { error: sErr } = await supabaseAdmin.from("scenes").insert(sceneRows);
      if (sErr) throw new Error(sErr.message);
    }

    await supabaseAdmin
      .from("projects")
      .update({ status: "generating_scenes", error_message: null })
      .eq("id", projectId);
    return { status: "generating_scenes", error_message: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Transcription step failed.";
    await supabaseAdmin
      .from("projects")
      .update({ status: "failed", error_message: message })
      .eq("id", projectId);
    return { status: "failed", error_message: message };
  }
}

async function advanceFromGeneratingScenes(projectId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  try {
    const { data: scenes, error } = await supabaseAdmin
      .from("scenes")
      .select("id, idx, text")
      .eq("project_id", projectId)
      .order("idx", { ascending: true });
    if (error) throw new Error(error.message);
    if (!scenes || scenes.length === 0) {
      await supabaseAdmin.from("projects").update({ status: "ready" }).eq("id", projectId);
      return { status: "ready", error_message: null };
    }

    const { generateVisualQueries } = await import("@/lib/visual-queries.server");
    const queries = await generateVisualQueries(scenes.map((s) => s.text));

    // Update each scene with its visual_query. Sequential is fine at this size.
    for (let i = 0; i < scenes.length; i++) {
      const { error: uErr } = await supabaseAdmin
        .from("scenes")
        .update({ visual_query: queries[i] })
        .eq("id", scenes[i].id);
      if (uErr) throw new Error(uErr.message);
    }

    await supabaseAdmin
      .from("projects")
      .update({ status: "ready", error_message: null })
      .eq("id", projectId);
    return { status: "ready", error_message: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Visual query generation failed.";
    await supabaseAdmin
      .from("projects")
      .update({ status: "failed", error_message: message })
      .eq("id", projectId);
    return { status: "failed", error_message: message };
  }
}
