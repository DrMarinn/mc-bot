const config = require('./config')

function buildPrompt (actions) {
  const list = Object.entries(actions).map(([name, a]) => `- ${name} ${a.args}: ${a.desc}`).join('\n')
  const examples = Object.entries(actions).map(([name, a]) =>
    `user: ${a.example[0]} -> ${JSON.stringify({ action: name, ...a.example[1] })}`).join('\n')
  return `You control a Minecraft bot. You decide ALL bot actions.
Reply ONLY with one JSON object: {"action":"<name>", ...arguments}. No other text.
Item and block names must be English Minecraft ids (dirt, cobblestone, oak_log, bread, diamond_sword).
Mob names in English (zombie, skeleton, cow). Player names exactly as written by the user.

Actions:
${list}

Examples:
${examples}`
}

async function askAI (systemPrompt, userText, context) {
  const res = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ollamaModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Bot state: ${context}\nuser: ${userText}` }
      ],
      stream: false,
      format: 'json',
      keep_alive: '30m',
      options: { temperature: 0 }
    }),
    signal: AbortSignal.timeout(config.aiTimeout)
  })
  if (!res.ok) throw new Error(`Ollama ответила ${res.status}`)
  const data = await res.json()
  return JSON.parse(data.message && data.message.content)
}

// Простой разбор без ИИ (если Ollama не запущена или ответила ерундой)
function fallbackParse (text) {
  const t = text.trim().toLowerCase()
  const nums = (t.match(/-?\d+/g) || []).map(Number)
  const word = re => { const m = t.match(re); return m ? m[1] : undefined }
  const rules = [
    [/(?:portal|портал)\s*([1-8])/, m => ({ action: 'portal', number: +m[1] })],
    [/^(stop|стоп|хватит|остановись)/, () => ({ action: 'stop' })],
    [/(коорд|goto|go to|иди|идти|пойди|^\s*-?\d+\s+-?\d+\s+-?\d+\s*$)/, () => nums.length >= 3 ? { action: 'goto', x: nums[0], y: nums[1], z: nums[2] } : null],
    [/(?:follow|иди за|следуй за|за мной)\s*(\S*)/, m => ({ action: 'follow', player: m[1] })],
    [/(?:come|подойди к|иди ко мне)\s*(\S*)/, m => ({ action: 'come', player: m[1] })],
    [/(?:attack|kill|убей|атакуй|таргет\S*|бей)\s+(\S+)/, m => ({ action: 'attack', target: m[1] })],
    [/(?:hit|ударь)\s+(\S+)/, m => ({ action: 'hit', target: m[1] })],
    [/(guard|охраня)/, () => ({ action: 'guard' })],
    [/(?:look|посмотри на|смотри на)\s+(\S+)/, m => ({ action: 'look', player: m[1] })],
    [/(?:turn|повернись)\s*(?:на|to)?\s*(\S*)/, m => ({ action: 'turn', direction: m[1] || 'around' })],
    [/^(?:say|chat|скажи|напиши)(?:\s+в\s+чат)?\s+(.+)$/, m => ({ action: 'chat', text: text.trim().replace(/^\S+(\s+в\s+чат)?\s+/i, '') })],
    [/(drop all|выбрось вс[её]|выкинь вс[её])/, () => ({ action: 'drop_all' })],
    [/(?:drop|toss|выбрось|выкинь)\s*(.*)$/, m => ({ action: 'drop', count: nums[0], item: (m[1].replace(/-?\d+/g, '').trim() || undefined) })],
    [/(?:equip|возьми|надень)\s+(?:в руку\s+)?(\S+)/, m => ({ action: 'equip', item: m[1] })],
    [/(inventory|инвентар)/, () => ({ action: 'inventory' })],
    [/(eat|поешь|съешь|ешь)/, () => ({ action: 'eat' })],
    [/(?:dig|mine|сломай|копай|выкопай)\s+(\S+)/, m => ({ action: 'dig', block: m[1] })],
    [/(collect|подбери|собери)/, () => ({ action: 'collect' })],
    [/(wander|погуляй|гуляй)/, () => ({ action: 'wander' })],
    [/(jump|прыг)/, () => ({ action: 'jump', times: nums[0] || 1 })],
    [/(встань|unsneak)/, () => ({ action: 'sneak', on: false })],
    [/(sneak|присядь|шифт|крадись)/, () => ({ action: 'sneak', on: true })],
    [/(use|используй|пкм)/, () => ({ action: 'use' })],
    [/(sleep|спать|поспи)/, () => ({ action: 'sleep' })],
    [/(players|онлайн|кто тут|игроки)/, () => ({ action: 'players' })],
    [/^(pos|где ты|координаты)$/, () => ({ action: 'position' })],
    [/(status|здоровье|статус|хп)/, () => ({ action: 'status' })]
  ]
  for (const [re, make] of rules) {
    const m = t.match(re)
    if (m) { const r = make(m); if (r) return r }
  }
  void word
  return null
}

// ИИ иногда путает числа — сверяем с тем, что написал пользователь
function sanitize (d, text) {
  const nums = (text.match(/-?\d+/g) || []).map(Number)
  if (d.action === 'goto') {
    if (Array.isArray(d.coordinates)) [d.x, d.y, d.z] = d.coordinates
    if (nums.length === 3) [d.x, d.y, d.z] = nums
  }
  if (d.action === 'portal') {
    const m = text.match(/(?:portal|портал)\s*([1-8])/i)
    if (m) d.number = Number(m[1])
  }
  return d
}

function createAI (actions) {
  const systemPrompt = buildPrompt(actions)
  return {
    async decide (userText, context) {
      if (config.useAI !== false) {
        try {
          const d = await askAI(systemPrompt, userText, context)
          if (d && actions[d.action]) return { ...sanitize(d, userText), source: 'ИИ' }
          console.log(`[ИИ] Непонятный ответ: ${JSON.stringify(d)}`)
        } catch (e) {
          console.log(`[ИИ] Ollama не ответила (${e.message}), использую простой разбор.`)
        }
      }
      const fb = fallbackParse(userText)
      return fb ? { ...fb, source: 'простой разбор' } : { action: 'none', reply: 'Не понял команду (напиши help)', source: 'простой разбор' }
    }
  }
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

module.exports = { createAI, checkOllama, fallbackParse }
