// 终版 WP1 — window boundary tests.
//
// Run: node test/window-test.ts
//
// Pure-function level (no DSH, no data dir). The shell wiring is
// covered by the mock test; these cases pin the classification table
// and the two persistence shapes.

import assert from "node:assert/strict";
import {
  classifyAssistantReply,
  classifyContent,
  countCodePoints,
  hasWorkArtifact,
  isBareTrigger,
  matchDeclaration,
  parsePersonaSessions,
  serializePersonaSessions,
} from "../src/window.ts";

const TRIGGERS = ["夏柠柒", "柠柒"];
let passed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`FAIL ${name}`);
  }
}

// 1. Today's real message: a work task that happens to mention her
//    name must not be classified as chat.
check("1 today's task line is task-shaped / skipped in task mode", () => {
  const text =
    "夏柠柒agent工作版……这是别的ai给的建议，结合我的插件本身，讲讲你的看法？";
  assert.equal(matchDeclaration(text, TRIGGERS), null);
  assert.equal(isBareTrigger(text, TRIGGERS), false);
  assert.equal(classifyContent(text, "task", TRIGGERS), "task");
  assert.equal(classifyContent(text, "persona", TRIGGERS), "task");
});

// 1b. Ambiguous chat words are not technical signals.
check("1b '你是什么版本' stays chat", () => {
  assert.equal(
    classifyContent("夏柠柒，你是什么版本", "persona", TRIGGERS),
    "persona",
  );
});

// 2. Trigger + a real work request: the session is persona (she is
//    addressed), but this turn is task content.
check("2 trigger + work request -> task turn", () => {
  const text = "夏柠柒，帮我把这段文字改得像你说话的口气";
  assert.equal(matchDeclaration(text, TRIGGERS), null);
  assert.equal(classifyContent(text, "persona", TRIGGERS), "task");
});

// 3. Work inside a persona session.
check("3 work inside persona session -> task", () => {
  assert.equal(classifyContent("帮我整理这份文档", "persona", TRIGGERS), "task");
});

// 4. Bare trigger: a call, not a message.
check("4 bare trigger -> greeting", () => {
  assert.equal(isBareTrigger("夏柠柒", TRIGGERS), true);
  assert.equal(classifyContent("夏柠柒", "task", TRIGGERS), "greeting");
  assert.equal(classifyContent("夏柠柒，柠柒。", "task", TRIGGERS), "greeting");
});

// 5. A greeting after the call is chat.
check("5 greeting after call -> persona", () => {
  assert.equal(classifyContent("在吗", "persona", TRIGGERS), "persona");
});

// 6. Feelings are chat.
check("6 feeling -> persona", () => {
  assert.equal(classifyContent("我今天好累", "persona", TRIGGERS), "persona");
});

// 7/8. Declarations switch the mode, exact phrase only.
check("7/8 declarations", () => {
  assert.equal(matchDeclaration("任务窗口", TRIGGERS), "task");
  assert.equal(matchDeclaration("夏柠柒，任务窗口", TRIGGERS), "task");
  assert.equal(matchDeclaration("人设窗口", TRIGGERS), "persona");
  assert.equal(matchDeclaration("夏柠柒，切回人设", TRIGGERS), "persona");
  assert.equal(classifyContent("任务窗口", "persona", TRIGGERS), "skip");
});

// 9. A sentence that merely contains the phrase does not switch.
check("9 phrase inside a sentence does not switch", () => {
  assert.equal(matchDeclaration("我们按任务处理这件事吧", TRIGGERS), null);
  assert.equal(
    classifyContent("我们按任务处理这件事吧", "persona", TRIGGERS),
    "persona",
  );
});

// 10. The撒娇 counter-example: "帮我" alone is not work.
check("10 '帮我看看我今天美不美' stays chat", () => {
  const text = "夏柠柒，帮我看看我今天美不美";
  assert.equal(classifyContent(text, "persona", TRIGGERS), "persona");
});

// 11. Assistant reply: 800 boundary, persona turns exempt, artifacts.
check("11 assistant reply classification", () => {
  assert.equal(classifyAssistantReply("task", "字".repeat(799)), "persona");
  assert.equal(classifyAssistantReply("task", "字".repeat(801)), "task");
  assert.equal(classifyAssistantReply("persona", "字".repeat(1200)), "persona");
  assert.equal(
    classifyAssistantReply("task", "改好了：\n```\nconst a = 1;\n```"),
    "task",
  );
  assert.equal(
    classifyAssistantReply("task", "1. a\n2. b\n3. c\n4. d\n5. e"),
    "task",
  );
  assert.equal(classifyAssistantReply("greeting", "在。"), "greeting");
  assert.equal(countCodePoints("😀"), 1);
});

// 12. Old array shape, new map shape, round-trip, corrupt input.
check("12 persona-sessions persistence shapes", () => {
  const old = parsePersonaSessions('["s1","s2"]');
  assert.equal(old.get("s1"), "persona");
  assert.equal(old.get("s2"), "persona");

  const map = new Map<string, "persona" | "task">([
    ["s1", "persona"],
    ["s2", "task"],
  ]);
  const json = serializePersonaSessions(map);
  const back = parsePersonaSessions(json);
  assert.equal(back.get("s1"), "persona");
  assert.equal(back.get("s2"), "task");

  assert.equal(parsePersonaSessions("not json").size, 0);
  assert.equal(parsePersonaSessions('{"s3":true}').get("s3"), "persona");
});

// 13. Artifact helper directly.
check("13 artifact helper", () => {
  assert.equal(hasWorkArtifact("普通的一句话"), false);
  assert.equal(hasWorkArtifact("| a | b |\n| --- | --- |"), true);
  assert.equal(hasWorkArtifact("- 1\n- 2\n- 3\n- 4\n- 5"), true);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
