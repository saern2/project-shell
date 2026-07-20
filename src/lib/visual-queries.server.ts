// Server-only helper for turning scene sentences into concrete, visually
// searchable stock-footage phrases via Lovable AI Gateway.

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL = "google/gemini-2.5-flash";

const SYSTEM_PROMPT = `You convert narration sentences into short, CONCRETE, visually-searchable stock-footage phrases (3-6 words each).

Rules:
- Each phrase must describe something a camera can literally film: people, places, objects, actions, weather, scenery.
- Never output abstract nouns alone (e.g. "freedom", "success", "growth"). Ground abstractions in a concrete visual metaphor.
- Prefer everyday, common footage terms that would match stock libraries (Pexels, Pixabay).
- No punctuation, no quotes, no leading articles ("the", "a"), lowercase preferred.
- 3-6 words. Never a full sentence.

Examples:
- "Success requires patience and discipline." -> "runner training empty stadium"
- "Our economy is entering a period of uncertainty." -> "stock market screens red charts"
- "She never gave up on her dream." -> "young woman painting late night"
- "The whole team celebrated the launch." -> "office team high five laptops"
- "Time slips away faster than we realize." -> "clock hands spinning close up"

Return STRICT JSON matching this schema: {"queries": ["phrase1", "phrase2", ...]}. The queries array MUST have exactly one entry per input sentence, in the same order.`;

export async function generateVisualQueries(sentences: string[]): Promise<string[]> {
  if (sentences.length === 0) return [];
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY is not configured.");

  const numbered = sentences.map((s, i) => `${i + 1}. ${s.replace(/\s+/g, " ").trim()}`).join("\n");
  const userPrompt = `Convert each of the following ${sentences.length} narration sentences into a concrete visual stock-footage phrase. Return exactly ${sentences.length} phrases in order, as JSON.\n\nSentences:\n${numbered}`;

  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    if (res.status === 429) throw new Error("AI rate limit reached. Please retry in a moment.");
    if (res.status === 402) throw new Error("AI credits exhausted. Add credits to continue.");
    throw new Error(`Visual query generation failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI response was empty.");

  let parsed: { queries?: unknown };
  try {
    parsed = JSON.parse(content) as { queries?: unknown };
  } catch {
    throw new Error("AI returned invalid JSON for visual queries.");
  }
  const queries = parsed.queries;
  if (!Array.isArray(queries) || queries.length !== sentences.length) {
    throw new Error(
      `AI returned ${Array.isArray(queries) ? queries.length : "no"} queries but expected ${sentences.length}.`,
    );
  }
  return queries.map((q, i) => {
    if (typeof q !== "string" || !q.trim()) {
      throw new Error(`Empty visual query at index ${i}.`);
    }
    return q.trim().toLowerCase();
  });
}
