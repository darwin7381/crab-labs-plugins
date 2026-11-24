// Onsen (WO-139): the chat_history tool's definition, shared by the main's Telegram server (server.ts) and every lane (lanes.ts LANE_TOOLS).
// A definition only: the query itself is onsen-client.ts (OnsenClient.queryHistory), handed to lanes.ts through LanesDeps.chatHistory.

export const CHAT_HISTORY_TOOL = {
  name: 'chat_history',
  description: '查之前講過什麼：你和 Joey 在這裡的每一則問答（他說的、你回的、分身推的）都在 Onsen。不帶參數是最新 20 則；limit 指定幾則；since／until 看一段時間；q 搜內容；id 取某一則全文（Onsen 編號或 Telegram 編號都可以）。先查這裡，查不到才去翻 session 紀錄。不用請 Joey 再貼一次。',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: '幾則（預設 20，最多 200）' },
      since: { type: 'string', description: '從什麼時候起：ISO 時間，或往回算的相對時間（30m、2h、3d）' },
      until: { type: 'string', description: '到什麼時候：ISO 時間或相對時間' },
      q: { type: 'string', description: '搜內容（文字）' },
      id: { type: 'string', description: '取某一則全文：Onsen 編號，或 Telegram 編號（tg:2166 或 2166）' },
      chat: { type: 'string', description: '哪個聊天（Telegram chat id）；不填 = 你和 Joey 的私聊' },
    },
  },
}
