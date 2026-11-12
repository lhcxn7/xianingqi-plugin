// Fact version chain (0.5.1 item 1, the 0.6.0 fact-version chain,
// pulled forward into 0.5.1 by user decision).
//
// One fact, many versions: entries that carry the same `factKey`
// are versions of one fact ("最喜欢的颜色", "喝咖啡", "住在哪里").
// The newest version (by ts) is current; every older version is
// superseded. Recall answers "now" with the current version and
// "before" with the history — a superseded version must never win
// a present-tense question just because it matches more keywords
// (the q15 case: "我不喝咖啡，喝了心慌" matches 喝/咖啡/不喝,
// "我最近开始喝美式了" only reaches the query through a graph
// walk, so keyword counting alone ranks the dead fact first).
//
// The chain is derived from the log at recall time — no separate
// store, no migration: an entry without a factKey is unversioned
// and scores exactly as before. `supersedes` is the explicit link
// (set by memory_remember / the admin correct path); the chain
// itself is factKey + ts order, so a missing or wrong supersedes
// can never corrupt the ranking.
//
// Factors (multiplied into the recall score, direct hits and
// graph hits alike — see factVersionFactor): the factor only
// fires when the query touches the fact. Present query: a
// superseded version scores 0.12x, a current version 1.5x — but
// only when a superseded version was matched (the conflict is
// live). History query: the mirror (superseded 1.5x, current
// 0.5x). A current version in a query that never touches its old
// version scores 1x: it is an ordinary hit, not a conflict
// answer.
//
// Paired with the factor is the fact-level match (in
// recallFromEntries): when a superseded version matches a present
// question, the current version joins the match set with the same
// tokens — the question is about the fact, and the current
// wording may share no keyword with it ("她现在喝不喝咖啡"
// matches 不喝咖啡; the answer is the current 喝美式). History
// mode mirrors it: a matched current version pulls in its
// superseded versions.

import type { MemoryEntry } from "./types.ts";

/** Words that turn a question into a history question — the
 *  asker wants the old version, not the current one. */
export const HISTORY_QUERY_WORDS = [
  "以前",
  "之前",
  "曾经",
  "过去",
  "原来",
  "当初",
  "那时候",
  "那时",
  "早先",
  "从前",
  "以前是",
  "之前是",
];

/** True when the query asks about the past ("她以前喝咖啡吗"),
 *  as opposed to the present ("她现在喝不喝咖啡"). */
export function isHistoryQuery(query: string): boolean {
  if (typeof query !== "string" || query.length === 0) return false;
  return HISTORY_QUERY_WORDS.some((w) => query.includes(w));
}

export interface FactVersion {
  factKey: string;
  /** Versions oldest-first (display order). */
  versions: MemoryEntry[];
  current: MemoryEntry;
  /** 0.5.5: true when the chain was built from explicit supersedes
   *  links (not just time order). */
  strict: boolean;
  /** 0.5.5: false when the explicit links branch, cycle, or leave
   *  more than one current version. Invalid chains are not scored. */
  valid: boolean;
  /** Human-readable reasons the strict chain is invalid. */
  issues: string[];
}

/** Group versioned entries into chains. Unversioned entries are
 *  not in the map. Single-version chains are kept (callers decide
 *  whether the factor applies — it only applies to 2+ versions).
 *
 *  0.5.5: when any version carries `supersedes`, the chain is
 *  validated as a version DAG:
 *    - every supersedes target must exist in the same factKey;
 *    - a version may be superseded by at most one newer version;
 *    - exactly one root (current) and no cycles.
 *  Entries without any supersedes keep the old time-order fallback.
 *  An invalid chain keeps a display `current` (newest by ts) but is
 *  marked invalid and contributes no ranking factor — a broken
 *  version graph must not silently decide "now". */
export function factChains(
  entries: MemoryEntry[],
): Map<string, FactVersion> {
  const byKey = new Map<string, MemoryEntry[]>();
  for (const e of entries) {
    if (typeof e.factKey !== "string" || e.factKey.length === 0) continue;
    const list = byKey.get(e.factKey) ?? [];
    list.push(e);
    byKey.set(e.factKey, list);
  }
  const out = new Map<string, FactVersion>();
  for (const [factKey, versions] of byKey) {
    const sorted = [...versions].sort(
      (a, b) => (a.validFrom ?? a.ts) - (b.validFrom ?? b.ts),
    );
    const hasLinks = versions.some(
      (e) => typeof e.supersedes === "string" && e.supersedes.length > 0,
    );
    if (!hasLinks) {
      out.set(factKey, {
        factKey,
        versions: sorted,
        current: sorted[sorted.length - 1],
        strict: false,
        valid: true,
        issues: [],
      });
      continue;
    }
    const byId = new Map(versions.map((e) => [e.id, e]));
    const successor = new Map<string, string>(); // old id -> new id
    const issues: string[] = [];
    for (const e of versions) {
      if (typeof e.supersedes !== "string" || e.supersedes.length === 0) continue;
      if (e.supersedes === e.id) {
        issues.push(`版本 ${e.id} 指向自己`);
        continue;
      }
      const target = byId.get(e.supersedes);
      if (!target) {
        issues.push(`版本 ${e.id} 的 supersedes 目标 ${e.supersedes} 不在该 factKey 内`);
        continue;
      }
      const prior = successor.get(e.supersedes);
      if (prior !== undefined && prior !== e.id) {
        issues.push(`版本 ${e.supersedes} 有多个后继（${prior}、${e.id}）`);
      }
      successor.set(e.supersedes, e.id);
    }
    const roots = versions.filter((e) => !successor.has(e.id));
    if (roots.length === 0) {
      issues.push("版本链成环，没有 current");
    } else if (roots.length > 1) {
      issues.push(`有 ${roots.length} 个 current（${roots.map((e) => e.id).join("、")}）`);
    }
    // Reachability from the single root: every version must follow
    // its successor links forward to that root (a cycle hanging off
    // a valid-looking root is caught here).
    if (roots.length === 1 && issues.length === 0) {
      const rootId = roots[0].id;
      for (const v of versions) {
        const seen = new Set<string>();
        let curId: string | undefined = v.id;
        while (curId !== undefined && successor.has(curId)) {
          if (seen.has(curId)) {
            issues.push("版本链含环");
            break;
          }
          seen.add(curId);
          curId = successor.get(curId);
        }
        if (issues.length > 0) break;
        if (curId !== rootId) {
          issues.push("版本链不连通");
          break;
        }
      }
    }
    const newest = sorted[sorted.length - 1];
    out.set(factKey, {
      factKey,
      versions: sorted,
      current: roots.length === 1 ? roots[0] : newest,
      strict: true,
      valid: issues.length === 0,
      issues,
    });
  }
  return out;
}

/** True when this entry is an older version of its fact — a newer
 *  version with the same factKey exists. */
export function isSuperseded(
  entry: MemoryEntry,
  chains: Map<string, FactVersion>,
): boolean {
  if (typeof entry.factKey !== "string" || entry.factKey.length === 0) {
    return false;
  }
  const chain = chains.get(entry.factKey);
  if (!chain || chain.versions.length < 2 || !chain.valid) return false;
  return chain.current.id !== entry.id;
}

/** Score factor for one entry under a fact chain. Unversioned and
 *  single-version entries score 1. The factor only fires when the
 *  query actually touches the fact — `touched` is the set of
 *  factKeys with at least one directly-matched version, and
 *  `supersededMatched` the set where a matched version is
 *  superseded:
 *  - superseded entry, fact touched: present 0.12x (a dead fact
 *    must not win on keyword count), history 1.5x (it IS the
 *    answer to a history question);
 *  - current entry: present 1.5x ONLY when a superseded version
 *    was matched (the query's evidence points at the old version,
 *    the answer is the new one); history 0.5x in the same case;
 *    otherwise 1 — a current version in a query that never touches
 *    its old version is just an ordinary hit, and boosting it
 *    would push it above unrelated answers (q10: 美式 matching
 *    每天/早上 must not outrank 跑步).
 *  See recallFromEntries for the fact-level match that pairs with
 *  this: when a superseded version matches a present question,
 *  the current version joins the match set with the same tokens. */
export function factVersionFactor(
  entry: MemoryEntry,
  chains: Map<string, FactVersion>,
  historyMode: boolean,
  touched: Set<string> = new Set(),
  supersededMatched: Set<string> = new Set(),
): number {
  if (typeof entry.factKey !== "string" || entry.factKey.length === 0) {
    return 1;
  }
  const chain = chains.get(entry.factKey);
  if (!chain || chain.versions.length < 2 || !chain.valid) return 1;
  if (!touched.has(entry.factKey)) return 1;
  const current = chain.current.id === entry.id;
  if (!current) return historyMode ? 1.5 : 0.12;
  if (!supersededMatched.has(entry.factKey)) return 1;
  return historyMode ? 0.5 : 1.5;
}

/** The current version of a fact, if the entry belongs to a chain
 *  and is not itself current. Used by the admin correct path and
 *  by tests; recall itself only needs the factor. */
export function currentVersionOf(
  entry: MemoryEntry,
  chains: Map<string, FactVersion>,
): MemoryEntry | null {
  if (typeof entry.factKey !== "string" || entry.factKey.length === 0) {
    return null;
  }
  const chain = chains.get(entry.factKey);
  if (!chain || chain.versions.length < 2 || !chain.valid) return null;
  return chain.current.id === entry.id ? null : chain.current;
}
