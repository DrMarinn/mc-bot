const config = require('./config')

const SYSTEM_PROMPT = `You control a Minecraft bot. You decide ALL bot movement.
Reply ONLY with one JSON object, no text.

Available actions:
{"action":"portal","number":N}            - walk to portal N (1..8)
{"action":"goto","x":X,"y":Y,"z":Z}       - walk to coordinates
{"action":"retry"}                        - try the same route again
{"action":"jump_and_retry"}               - jump, step aside and try again
{"action":"stop"}                         - stop moving
{"action":"position"}                     - tell current position
{"action":"none","reply":"text"}          - nothing to do, answer with text

Examples:
user: portal 3            -> {"action":"portal","number":3}
user: иди в портал 5      -> {"action":"portal","number":5}
user: go to 10 64 -5      -> {"action":"goto","x":10,"y":64,"z":-5}
user: стоп                -> {"action":"stop"}
user: где ты              -> {"action":"position"}`

async function askAI (userText, context = '') {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: (context ? `Bot state: ${context}\n` : '') + `user: ${userText}` }
  ]
  const res = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ollamaModel,
      messages,
      stream: false,
      format: 'json',
      keep_alive: '30m',
      options: { temperature: 0 }
    }),
    signal: AbortSignal.timeout(config.aiTimeout)
  })
  if (!res.ok) throw new Error(`Ollama ответила ${res.status}`)
  const data = await res.json()
  const text = data.message && data.message.content
  return JSON.parse(text)
}

// Запасной разбор, если Ollama недоступна
function fallbackParse (text) {
  const t = text.trim().toLowerCase()
  let m = t.match(/(?:portal|портал)\s*([1-8])/) || t.match(/^([1-8])$/)
  if (m) return { action: 'portal', number: Number(m[1]) }
  m = t.match(/(?:goto|иди)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/)
  if (m) return { action: 'goto', x: +m[1], y: +m[2], z: +m[3] }
  if (/^(stop|стоп)$/.test(t)) return { action: 'stop' }
  if (/^(pos|где ты|координаты)$/.test(t)) return { action: 'position' }
  return null
}

async function decide (userText, context) {
  try {
    const result = await askAI(userText, context)
    if (result && result.action) return { ...result, source: 'ИИ' }
  } catch (e) {
    console.log(`[ИИ] Ollama недоступна (${e.message}), использую простой разбор.`)
  }
  const fb = fallbackParse(userText)
  return fb ? { ...fb, source: 'запасной разбор' } : { action: 'none', reply: 'Не понял команду', source: 'запасной разбор' }
}

async function checkOllama () {
  try {
    const res = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) })
    const data = await res.json()
    const names = (data.models || []).map(m => m.name)
    if (!names.some(n => n.startsWith(config.ollamaModel))) {
      console.log(`[ИИ] Ollama работает, но модели ${config.ollamaModel} нет. Выполни: ollama pull ${config.ollamaModel}`)
      return false
    }
    console.log(`[ИИ] Ollama подключена, модель ${config.ollamaModel}`)
    return true
  } catch {
    console.log('[ИИ] Ollama не запущена. Запусти Ollama, иначе будет простой разбор команд.')
    return false
  }
}

module.exports = { decide, checkOllama }
