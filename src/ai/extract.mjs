// 从模型回复里抽取 {"command":"…","reason":"…"}。
// 容错：剥 ```json 围栏、取第一个平衡的 {...}。永不抛。

export function extractCommand(text) {
  try {
    if (typeof text !== "string" || text.trim().length === 0) {
      return { ok: false, command: "", reason: "" };
    }

    let source = text.trim();

    // 剥掉 Markdown 代码围栏。
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source);
    if (fenced && fenced[1]) source = fenced[1].trim();

    const candidate = firstBalancedObject(source);
    if (!candidate) {
      return { ok: false, command: "", reason: "" };
    }

    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      return { ok: false, command: "", reason: "" };
    }

    const command = parsed && typeof parsed.command === "string" ? parsed.command.trim() : "";
    const reason = parsed && typeof parsed.reason === "string" ? parsed.reason.trim() : "";
    if (!command) {
      return { ok: false, command: "", reason };
    }
    return { ok: true, command, reason };
  } catch {
    return { ok: false, command: "", reason: "" };
  }
}

function firstBalancedObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return "";
  let depth = 0;
  let quote = "";
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return "";
}
