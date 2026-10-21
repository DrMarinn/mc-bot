const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals: { GoalBlock, GoalNear } } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const readline = require('readline')
const fs = require('fs')
const path = require('path')
const config = require('./config')
const ai = require('./ai')

let bot = null
let ready = false
let busy = false
let teleported = false

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const log = msg => console.log(`[Бот] ${msg}`)
const posStr = p => `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`
const isNear = (p, t, r = 2) => p.distanceTo(new Vec3(t.x + 0.5, t.y, t.z + 0.5)) <= r

function startBot () {
  ready = false
  busy = false
  log(`Подключаюсь к ${config.host}:${config.port} (версия ${config.version})...`)
  bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    version: config.version,
    auth: 'offline'
  })
  bot.loadPlugin(pathfinder)

  bot.once('spawn', onFirstSpawn)
  bot.on('messagestr', (msg, position) => {
    if (position !== 'game_info' && msg.trim()) console.log(`[Чат] ${msg}`)
  })
  bot.on('forcedMove', onForcedMove)
  bot.on('death', () => log('Бот умер'))
  bot.on('kicked', reason => log(`Кикнули с сервера: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`))
  bot.on('error', err => log(`Ошибка: ${err.message}`))
  bot.on('end', reason => {
    log(`Отключён от сервера (${reason})`)
    ready = false
    if (config.autoReconnect) {
      log('Переподключение через 10 секунд...')
      setTimeout(startBot, 10000)
    }
  })
}

async function onFirstSpawn () {
  log('Зашёл на сервер')
  const moves = new Movements(bot)
  moves.canDig = config.canDig
  moves.allowParkour = true
  moves.allowSprinting = true
  bot.pathfinder.setMovements(moves)

  const reg = config.regCommand.replace('{password}', config.password)
  const login = config.loginCommand.replace('{password}', config.password)

  await sleep(1000)
  bot.chat(reg)
  log(`Написал: ${reg}`)

  await sleep(config.delayBeforeLogin)
  bot.chat(login)
  log(`Написал: ${login}`)

  await sleep(config.delayAfterLogin)
  const p = bot.entity.position
  const s = config.spawnPoint
  if (isNear(p, s, 3)) {
    log(`Попал на координаты ${s.x} ${s.y} ${s.z} после регистрации/входа`)
  } else {
    log(`После регистрации/входа я на координатах ${posStr(p)} (ожидалось ${s.x} ${s.y} ${s.z})`)
  }

  ai.checkOllama()
  ready = true
  log('Жду команды: portal 1-8 | pos | stop | exit (или любой текст — его разберёт ИИ)')
}

// Сервер переместил бота (портал / телепорт)
function onForcedMove () {
  if (!busy) return
  const p = bot.entity.position
  if (isNear(p, config.afterPortal, 5)) {
    teleported = true
    bot.pathfinder.stop()
  }
}

function botState () {
  const p = bot.entity.position
  return `position ${posStr(p)}, health ${bot.health}, moving ${busy}`
}

async function goTo (target, name) {
  busy = true
  teleported = false
  log(`Цель: ${name} (${target.x} ${target.y} ${target.z})...`)

  const maxAttempts = 5
  let goal = new GoalBlock(target.x, target.y, target.z)
  let reached = false

  for (let attempt = 1; attempt <= maxAttempts && busy && !teleported; attempt++) {
    try {
      await bot.pathfinder.goto(goal)
      reached = true
      break
    } catch (err) {
      if (teleported || !busy) break
      log(`Маршрут не удался (${err.message}), спрашиваю ИИ что делать...`)
      const d = await ai.decide(
        'The route failed. Choose one action: retry, jump_and_retry or stop.',
        `${botState()}, target ${name} ${target.x} ${target.y} ${target.z}, error "${err.message}", attempt ${attempt}/${maxAttempts}`
      )
      log(`[${d.source}] решение: ${d.action}`)
      if (d.action === 'stop') break
      if (d.action === 'jump_and_retry') await jumpAside()
      if (/no ?path/i.test(err.message)) goal = new GoalNear(target.x, target.y, target.z, 1)
    }
  }

  if (reached && !teleported) {
    log(`Дошёл (${name}): ${posStr(bot.entity.position)}`)
    if (name.startsWith('портал')) {
      log('Жду телепорт...')
      for (let i = 0; i < 30 && !teleported; i++) await sleep(500)
    }
  }

  if (teleported) {
    await sleep(1000)
    const a = config.afterPortal
    log(`Появился на координатах ${a.x} ${a.y} ${a.z} (сейчас ${posStr(bot.entity.position)})`)
  } else if (!reached) {
    log(`Не смог дойти (${name}). Сейчас на ${posStr(bot.entity.position)}`)
  } else if (name.startsWith('портал')) {
    log(`Портал не перенёс. Сейчас на ${posStr(bot.entity.position)}`)
  }
  busy = false
}

async function jumpAside () {
  const yaw = Math.random() * Math.PI * 2
  await bot.look(yaw, 0, true)
  bot.setControlState('jump', true)
  bot.setControlState('forward', true)
  await sleep(700)
  bot.clearControlStates()
}

function stopMoving () {
  busy = false
  bot.pathfinder.stop()
  bot.clearControlStates()
  log('Остановился')
}

async function execute (d, rawText) {
  switch (d.action) {
    case 'portal': {
      let n = Number(d.number)
      const typed = rawText.match(/(?:portal|портал)\s*([1-8])/i)
      if (typed && Number(typed[1]) !== n) n = Number(typed[1])
      if (!config.portals[n]) return log(`Нет портала ${d.number}. Есть 1-8`)
      return goTo(config.portals[n], `портал ${n}`)
    }
    case 'goto':
      if ([d.x, d.y, d.z].some(v => typeof v !== 'number')) return log('ИИ не дал координаты')
      return goTo({ x: Math.floor(d.x), y: Math.floor(d.y), z: Math.floor(d.z) }, 'точке')
    case 'stop':
      return stopMoving()
    case 'position':
      return log(`Я на координатах ${posStr(bot.entity.position)}`)
    default:
      return log(d.reply || 'Не понял команду')
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const SETTINGS_FILE = path.join(__dirname, 'settings.json')

async function loadSettings () {
  let s = {}
  if (fs.existsSync(SETTINGS_FILE)) s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
  const ask = q => new Promise(resolve => rl.question(q, a => resolve(a.trim())))
  if (!s.host) {
    const [host, port] = (await ask('Адрес сервера (например play.server.ru или play.server.ru:25565): ')).split(':')
    s.host = host || 'localhost'
    s.port = Number(port) || 25565
  }
  if (!s.username) s.username = (await ask('Ник бота (Enter = bikobiko): ')) || 'bikobiko'
  while (!s.password) s.password = await ask('Пароль для /reg и /l: ')
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2))
  Object.assign(config, s)
  log('Настройки в settings.json (чтобы поменять — удали этот файл)')
}

async function main () {
  await loadSettings()
  rl.on('line', onConsoleLine)
  startBot()
}

async function onConsoleLine (line) {
  const text = line.trim()
  if (!text) return
  if (/^(exit|выход)$/i.test(text)) { config.autoReconnect = false; bot && bot.quit(); process.exit(0) }
  if (!ready) return log('Ещё не готов, подожди вход на сервер')
  if (/^(stop|стоп)$/i.test(text)) return stopMoving()
  if (/^(pos|где ты)$/i.test(text)) return log(`Я на координатах ${posStr(bot.entity.position)}`)
  if (busy) return log('Я сейчас иду. Напиши stop, чтобы остановить')

  log('Думаю (ИИ)...')
  const d = await ai.decide(text, botState())
  log(`[${d.source}] решение: ${JSON.stringify({ ...d, source: undefined })}`)
  await execute(d, text)
}

main()
