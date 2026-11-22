// POST /api/ai：非 WS 的备用入口。本卡只要求「存在且鉴权」，实现为 501。
// 真正的 AI 链路走 WS 的 ai.ask / ai.reply。

export function handleAiPost(req, res) {
  res.writeHead(501, { "content-type": "application/json; charset=utf-8" });
  res.end(
    JSON.stringify({
      code: "AI_USE_WEBSOCKET",
      userText: "请通过终端页右侧的 AI 栏使用该功能（WebSocket 通道）。",
    }),
  );
}
