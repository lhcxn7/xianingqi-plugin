// Keyword tokeniser for recall. Chinese has no spaces, so CJK runs are
// indexed as overlapping bigrams plus the full run when it is short;
// latin/digit runs are indexed as lower-cased words. Query and entries
// are tokenised the same way, so a query containing "查岗" matches an
// entry containing "每周五查岗". CJK coverage includes the BMP, kana
// (hiragana/katakana) and the CJK extension planes (astral planes need
// the `u` flag); bigrams are sliced by UTF-16 code units, which is
// consistent between query and entries, so astral characters still
// match even if a bigram splits a surrogate pair.

const CJK_RUN =
  /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u{2b740}-\u{2b81f}\u{2b820}-\u{2ceaf}\u{2ceb0}-\u{2ebef}\u{30000}-\u{3134a}]+/gu;
const WORD_RUN = /[a-z0-9]+(?:[.'-][a-z0-9]+)*/g;

// High-frequency grammatical characters (particles, pronouns,
// common verbs/prepositions). As SINGLE tokens they match almost
// every chat line ("不" is in half of all sentences), so an unrelated
// query containing one would recall unrelated memories. They are
// therefore never emitted as single-character tokens — but they still
// match through bigrams and whole runs, so "不许忘" and "怎么说"
// keep working. Content characters (汤、琴、岗、查…) are unaffected.
// Exported (0.5.1 item 13) for the review topic filter, which needs
// the same stop set.
export const CJK_SINGLE_STOP = new Set([
  "的", "了", "在", "是", "有", "和", "就", "都", "也", "还",
  "不", "没", "很", "这", "那", "我", "你", "他", "她", "它", "们",
  "个", "一", "上", "下", "来", "去", "吗", "呢", "吧", "啊", "哦",
  "嗯", "呀", "么",
]);

export function tokenize(text: string): string[] {
  // Defensive (audit B2): a non-string must never poison the index or
  // crash recall — it yields no tokens instead of throwing.
  if (typeof text !== "string") return [];
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(WORD_RUN)) {
    out.add(m[0]);
  }
  for (const m of text.matchAll(CJK_RUN)) {
    const run = m[0];
    if (run.length > 1 && run.length <= 6) out.add(run);
    // Single characters too (audit m4): without them a one-character
    // query such as "汤" cannot match "酸梅汤" (the bigram 梅汤 does
    // not contain a lone "汤"). Stopwords are excluded (above): a
    // lone "不" or "的" must not recall every line that contains it.
    for (const ch of run) {
      if (!CJK_SINGLE_STOP.has(ch)) out.add(ch);
    }
    for (let i = 0; i + 1 < run.length; i++) {
      out.add(run.slice(i, i + 2));
    }
  }
  return [...out];
}

/** Rough token estimate for budgeting injected context. CJK characters
 *  count as ~1 token each, latin words as ~1.3. Deliberately on the
 *  generous side: overestimating only injects slightly less. */
export function estimateTokens(text: string): number {
  if (typeof text !== "string") return 0;
  const cjk = (text.match(CJK_RUN) ?? []).reduce(
    (n, run) => n + run.length,
    0,
  );
  const words = (text.toLowerCase().match(WORD_RUN) ?? []).length;
  return Math.ceil(cjk + words * 1.3);
}
