const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const readline = require('readline')
const fs = require('fs')
const path = require('path')
const config = require('./config')
const { createAI, checkOllama } = require('./ai')
const { createActions, posStr, isNear, sleep, log } = require('./actions')

let bot = null
let ready = false
let actions = null
let ai = null

function startBot () {
  ready = false
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
  bot.pathfinder.thinkTimeout = 30000

  const ctl = createActions(bot)
  actions = ctl
  ai = createAI(ctl.actions)

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

  checkOllama()
  ready = true
  log('Жду команды. Напиши help — список действий')
}

function botState () {
  const p = bot.entity.position
  const players = Object.keys(bot.players).filter(u => u !== bot.username).slice(0, 10).join(', ') || 'none'
  const t = actions.currentTask()
  return `position ${posStr(p)}, health ${Math.round(bot.health)}, food ${bot.food}, held ${bot.heldItem ? bot.heldItem.name : 'nothing'}, players online: ${players}, current task: ${t ? t.name : 'none'}`
}

const HELP = `Команды (пиши как хочешь, ИИ поймёт):
  portal 1-8                 — идти в портал
  иди 77 71 -194             — идти на координаты
  иди за <ник>               — следовать за игроком
  подойди к <ник>            — подойти к игроку
  убей <ник/зомби/nearest>   — атаковать, пока не умрёт (таргет)
  ударь <ник/моб>            — ударить один раз
  охраняй                    — бить мобов рядом
  посмотри на <ник>          — посмотреть на игрока
  повернись на север/юг/...  — повернуться
  напиши в чат <текст>       — написать в чат
  выбрось 5 dirt / выбрось всё
  возьми в руку <предмет>    — взять/надеть
  инвентарь | поешь | подбери вещи | погуляй
  сломай <блок>              — найти и сломать блок
  прыгни 3 раза | присядь | встань | используй предмет | иди спать
  кто онлайн | где ты | статус | stop | exit`

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

async function onConsoleLine (line) {
  const text = line.trim()
  if (!text) return
  if (/^(exit|выход)$/i.test(text)) { config.autoReconnect = false; bot && bot.quit(); process.exit(0) }
  if (/^(help|помощь|команды)$/i.test(text)) return console.log(HELP)
  if (!ready) return log('Ещё не готов, подожди вход на сервер')
  if (/^(stop|стоп)$/i.test(text)) return actions.actions.stop.run({})

  log('Думаю (ИИ)...')
  const d = await ai.decide(text, botState())
  const { action, source, ...args } = d
  log(`[${source}] решение: ${JSON.stringify({ action, ...args })}`)
  try {
    await actions.actions[action].run(args)
  } catch (e) {
    log(`Ошибка действия ${action}: ${e.message}`)
  }
}

async function main () {
  await loadSettings()
  rl.on('line', line => { onConsoleLine(line) })
  startBot()
}

main()
