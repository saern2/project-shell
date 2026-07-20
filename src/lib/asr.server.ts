// ASR (Automatic Speech Recognition) provider interface.
// Server-only. New providers (Groq-hosted Whisper, etc.) implement this
// interface so the calling code in pipeline.functions.ts stays untouched.

export type AsrWord = {
  text: string;
  start_ms: number;
  end_ms: number;
  confidence?: number;
};

export type AsrSentence = {
  text: string;
  start_ms: number;
  end_ms: number;
};

export type AsrJobStatus =
  | { state: "queued" | "processing" }
  | {
      state: "completed";
      full_text: string;
      language: string | null;
      words: AsrWord[];
      sentences: AsrSentence[];
      duration_sec: number | null;
    }
  | { state: "failed"; error: string };

export interface AsrProvider {
  readonly name: string;
  /** Submit audio for transcription. Returns provider-side job id. */
  submit(audioUrl: string): Promise<{ jobId: string }>;
  /** Poll the job. When complete returns full transcript + sentences. */
  poll(jobId: string): Promise<AsrJobStatus>;
}

// --- AssemblyAI implementation --------------------------------------------

const ASSEMBLYAI_BASE = "https://api.assemblyai.com/v2";

function requireAssemblyKey(): string {
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) throw new Error("ASSEMBLYAI_API_KEY is not configured.");
  return key;
}

export const assemblyAiProvider: AsrProvider = {
  name: "assemblyai",

  async submit(audioUrl: string) {
    const key = requireAssemblyKey();
    const res = await fetch(`${ASSEMBLYAI_BASE}/transcript`, {
      method: "POST",
      headers: {
        authorization: key,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        audio_url: audioUrl,
        punctuate: true,
        format_text: true,
        // word-level timestamps come by default; ensure defaults.
      }),
    });
    if (!res.ok) {
      const detail = await safeText(res);
      throw new Error(`AssemblyAI submit failed (${res.status}): ${detail}`);
    }
    const json = (await res.json()) as { id: string };
    if (!json.id) throw new Error("AssemblyAI submit returned no id.");
    return { jobId: json.id };
  },

  async poll(jobId: string): Promise<AsrJobStatus> {
    const key = requireAssemblyKey();
    const res = await fetch(`${ASSEMBLYAI_BASE}/transcript/${jobId}`, {
      headers: { authorization: key },
    });
    if (!res.ok) {
      const detail = await safeText(res);
      throw new Error(`AssemblyAI poll failed (${res.status}): ${detail}`);
    }
    const json = (await res.json()) as {
      status: "queued" | "processing" | "completed" | "error";
      text?: string | null;
      language_code?: string | null;
      error?: string | null;
      words?: Array<{ text: string; start: number; end: number; confidence?: number }> | null;
    };

    if (json.status === "queued" || json.status === "processing") {
      return { state: json.status === "queued" ? "queued" : "processing" };
    }
    if (json.status === "error") {
      return { state: "failed", error: json.error ?? "Unknown AssemblyAI error." };
    }

    // Completed — fetch sentences separately.
    const sentencesRes = await fetch(`${ASSEMBLYAI_BASE}/transcript/${jobId}/sentences`, {
      headers: { authorization: key },
    });
    if (!sentencesRes.ok) {
      const detail = await safeText(sentencesRes);
      throw new Error(`AssemblyAI sentences fetch failed (${sentencesRes.status}): ${detail}`);
    }
    const sentencesJson = (await sentencesRes.json()) as {
      sentences?: Array<{ text: string; start: number; end: number }>;
    };
    const sentences: AsrSentence[] = (sentencesJson.sentences ?? []).map((s) => ({
      text: s.text,
      start_ms: s.start,
      end_ms: s.end,
    }));
    const words: AsrWord[] = (json.words ?? []).map((w) => ({
      text: w.text,
      start_ms: w.start,
      end_ms: w.end,
      confidence: w.confidence,
    }));
    return {
      state: "completed",
      full_text: json.text ?? "",
      language: json.language_code ?? null,
      words,
      sentences,
    };
  },
};

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return res.statusText;
  }
}

/** Default provider — swap this to change the entire pipeline. */
export function getAsrProvider(): AsrProvider {
  return assemblyAiProvider;
}
