const { goals: { GoalBlock, GoalNear, GoalNearXZ, GoalFollow, GoalLookAtBlock } } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const config = require('./config')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const log = msg => console.log(`[Бот] ${msg}`)
const posStr = p => `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`
const isNear = (p, t, r = 2) => p.distanceTo(new Vec3(t.x + 0.5, t.y, t.z + 0.5)) <= r

const RU_MOBS = {
  зомби: 'zombie', скелет: 'skeleton', крипер: 'creeper', паук: 'spider', эндермен: 'enderman',
  ведьма: 'witch', корова: 'cow', свинья: 'pig', овца: 'sheep', курица: 'chicken', житель: 'villager',
  слизень: 'slime', утопленник: 'drowned', кадавр: 'husk', волк: 'wolf', лошадь: 'horse'
}

function createActions (bot) {
  let task = null
  let teleported = false

  bot.on('forcedMove', () => {
    if (task && isNear(bot.entity.position, config.afterPortal, 5)) {
      teleported = true
      bot.pathfinder.stop()
    }
  })

  function newTask (name) {
    stopTask(false)
    task = { name, cancelled: false, timers: [] }
    return task
  }

  function stopTask (announce = true) {
    if (task) {
      task.cancelled = true
      task.timers.forEach(clearInterval)
      if (announce) log(`Остановил: ${task.name}`)
    }
    task = null
    bot.pathfinder.stop()
    bot.pathfinder.setGoal(null)
    bot.clearControlStates()
  }

  function endTask (t) { if (task === t) { t.timers.forEach(clearInterval); task = null } }

  // ---------- поиск целей ----------
  function findPlayer (name) {
    if (!name) return null
    const n = String(name).toLowerCase()
    const names = Object.keys(bot.players).filter(u => u !== bot.username)
    const exact = names.find(u => u.toLowerCase() === n)
    const found = exact || names.find(u => u.toLowerCase().includes(n))
    return found ? bot.players[found] : null
  }

  function findEntity (target) {
    const t = String(target || 'nearest').toLowerCase().trim()
    const me = bot.entity
    const all = Object.values(bot.entities).filter(e => e !== me && e.position && e.name !== 'item')
    const nearest = list => list.sort((a, b) => me.position.distanceTo(a.position) - me.position.distanceTo(b.position))[0] || null
    if (['nearest', 'ближайший', 'ближайшего', 'any'].includes(t)) return nearest(all.filter(e => e.type === 'player' || e.type === 'hostile' || e.type === 'animal' || e.type === 'mob'))
    if (['mob', 'hostile', 'моб', 'монстр'].includes(t)) return nearest(all.filter(e => e.type === 'hostile'))
    if (['player', 'игрок'].includes(t)) return nearest(all.filter(e => e.type === 'player'))
    const p = findPlayer(t)
    if (p && p.entity) return p.entity
    const mob = RU_MOBS[t] || t.replace(/\s+/g, '_')
    return nearest(all.filter(e => e.name === mob || (e.displayName && e.displayName.toLowerCase() === t)))
  }

  function entityName (e) { return e.type === 'player' ? e.username : (e.displayName || e.name) }

  function findItem (name) {
    const items = bot.inventory.items()
    if (!name) return bot.heldItem || null
    const n = String(name).toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_')
    return items.find(i => i.name === n) ||
      items.find(i => i.name.includes(n) || (i.displayName && i.displayName.toLowerCase().includes(n.replace(/_/g, ' ')))) || null
  }

  // ---------- движение ----------
  async function goTo (target, label, t) {
    teleported = false
    log(`Цель: ${label} (${target.x} ${target.y} ${target.z})...`)
    let goal = new GoalBlock(target.x, target.y, target.z)
    let reached = false
    for (let attempt = 1; attempt <= 5 && !t.cancelled && !teleported; attempt++) {
      try {
        await bot.pathfinder.goto(goal)
        reached = true
        break
      } catch (err) {
        if (t.cancelled || teleported) break
        log(`Маршрут не удался (${err.message}), пробую ещё раз (${attempt}/5)`)
        if (attempt % 2 === 0) await jumpAside()
        // точная клетка недоступна — подходим как можно ближе
        goal = attempt === 1 ? new GoalNear(target.x, target.y, target.z, 1)
          : attempt === 2 ? new GoalNear(target.x, target.y, target.z, 2)
            : new GoalNearXZ(target.x, target.z, 2)
      }
    }
    const isPortal = label.startsWith('портал')
    if (reached && !teleported && !t.cancelled) {
      log(`Дошёл (${label}): ${posStr(bot.entity.position)}`)
      if (isPortal) {
        log('Жду телепорт...')
        for (let i = 0; i < 30 && !teleported && !t.cancelled; i++) await sleep(500)
      }
    }
    if (teleported) {
      await sleep(1000)
      const a = config.afterPortal
      log(`Появился на координатах ${a.x} ${a.y} ${a.z} (сейчас ${posStr(bot.entity.position)})`)
    } else if (t.cancelled) {
      // остановлено командой
    } else if (!reached) {
      log(`Не смог дойти (${label}). Сейчас на ${posStr(bot.entity.position)}`)
    } else if (isPortal) {
      log(`Портал не перенёс. Сейчас на ${posStr(bot.entity.position)}`)
    }
    endTask(t)
    return reached || teleported
  }

  async function jumpAside () {
    await bot.look(Math.random() * Math.PI * 2, 0, true)
    bot.setControlState('jump', true)
    bot.setControlState('forward', true)
    await sleep(700)
    bot.clearControlStates()
  }

  // Бить цель, пока не умрёт или пока не скажут stop
  function fightLoop (t, pickTarget, label, { once = false } = {}) {
    return new Promise(resolve => {
      let lastHit = 0
      let current = null
      const timer = setInterval(() => {
        if (t.cancelled) { clearInterval(timer); return resolve() }
        if (!current || !current.isValid) {
          if (current) log(`Цель ${entityName(current)} пропала/убита`)
          current = pickTarget()
          if (!current) {
            if (label !== 'охрана') { endTask(t); clearInterval(timer); log('Цель не найдена'); return resolve() }
            return
          }
          log(`Цель: ${entityName(current)}`)
          if (label !== 'охрана') { /* ждём */ }
        }
        const dist = bot.entity.position.distanceTo(current.position)
        if (label === 'охрана' && dist > 16) { current = null; return }
        if (dist > 3) {
          bot.pathfinder.setGoal(new GoalFollow(current, 1.5), true)
        } else if (Date.now() - lastHit > 650) {
          bot.lookAt(current.position.offset(0, current.height * 0.8, 0), true)
          bot.attack(current)
          lastHit = Date.now()
          if (once) { log(`Ударил ${entityName(current)}`); stopTask(false); clearInterval(timer); return resolve() }
        }
      }, 200)
      t.timers.push(timer)
    })
  }

  // ---------- список действий ----------
  const A = {}

  A.portal = {
    args: '{"number":N}', desc: 'walk to portal N (1..8)', example: ['portal 3', { number: 3 }],
    async run ({ number }) {
      const n = Number(number)
      if (!config.portals[n]) return log(`Нет портала ${number}. Есть 1-8`)
      return goTo(config.portals[n], `портал ${n}`, newTask(`портал ${n}`))
    }
  }

  A.goto = {
    args: '{"x":X,"y":Y,"z":Z}', desc: 'walk to coordinates', example: ['иди на координаты 77 71 -194', { x: 77, y: 71, z: -194 }],
    async run ({ x, y, z }) {
      const c = [x, y, z].map(Number)
      if (c.some(v => !Number.isFinite(v))) return log('Нет координат. Пример: иди 77 71 -194')
      const [tx, ty, tz] = c.map(Math.floor)
      return goTo({ x: tx, y: ty, z: tz }, `точка ${tx} ${ty} ${tz}`, newTask('идти к точке'))
    }
  }

  A.follow = {
    args: '{"player":"name"}', desc: 'follow a player until stop', example: ['иди за Steve', { player: 'Steve' }],
    async run ({ player }) {
      const p = findPlayer(player)
      if (!p || !p.entity) return log(`Не вижу игрока ${player || ''} рядом`)
      const name = p.username
      const t = newTask(`следовать за ${name}`)
      let followed = null
      const refresh = () => {
        if (t.cancelled) return
        const e = bot.players[name] && bot.players[name].entity
        if (e && e !== followed) {
          followed = e
          bot.pathfinder.setGoal(new GoalFollow(e, 2), true)
        } else if (!e) followed = null
      }
      refresh()
      t.timers.push(setInterval(refresh, 1000))
      log(`Иду за ${name}. Напиши stop, чтобы остановить`)
      return t
    }
  }

  A.come = {
    args: '{"player":"name"}', desc: 'come to a player once', example: ['подойди к Steve', { player: 'Steve' }],
    async run ({ player }) {
      const p = findPlayer(player)
      if (!p || !p.entity) return log(`Не вижу игрока ${player || ''} рядом`)
      const pos = p.entity.position.floored()
      const t = newTask(`подойти к ${p.username}`)
      log(`Иду к ${p.username}`)
      try { await bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, 2)); log(`Подошёл к ${p.username}`) } catch (e) { if (!t.cancelled) log(`Не смог подойти: ${e.message}`) }
      endTask(t)
    }
  }

  A.attack = {
    args: '{"target":"player name | mob name | nearest"}', desc: 'attack target until it dies (target / kill)', example: ['убей зомби', { target: 'zombie' }],
    async run ({ target }) {
      const first = findEntity(target)
      if (!first) return log(`Не вижу цель: ${target || 'nearest'}`)
      const t = newTask(`атаковать ${entityName(first)}`)
      log(`Атакую ${entityName(first)}`)
      let used = false
      return fightLoop(t, () => { if (!used) { used = true; return first } return null }, 'атака')
    }
  }

  A.hit = {
    args: '{"target":"player name | mob name | nearest"}', desc: 'hit target once', example: ['ударь Steve', { target: 'Steve' }],
    async run ({ target }) {
      const e = findEntity(target)
      if (!e) return log(`Не вижу цель: ${target || 'nearest'}`)
      let used = false
      return fightLoop(newTask(`ударить ${entityName(e)}`), () => { if (!used) { used = true; return e } return null }, 'удар', { once: true })
    }
  }

  A.guard = {
    args: '{}', desc: 'stay and protect: attack hostile mobs nearby until stop', example: ['охраняй', {}],
    async run () {
      const t = newTask('охрана')
      log('Охраняю: бью мобов рядом. Напиши stop, чтобы остановить')
      return fightLoop(t, () => {
        const e = findEntity('hostile')
        return e && bot.entity.position.distanceTo(e.position) < 16 ? e : null
      }, 'охрана')
    }
  }

  A.look = {
    args: '{"player":"name"}', desc: 'look at a player or mob', example: ['посмотри на Steve', { player: 'Steve' }],
    passive: true,
    async run ({ player, target }) {
      const e = findEntity(player || target)
      if (!e) return log(`Не вижу ${player || target || 'цель'}`)
      await bot.lookAt(e.position.offset(0, e.height || 1.6, 0))
      log(`Смотрю на ${entityName(e)}`)
    }
  }

  A.turn = {
    args: '{"direction":"north|south|east|west|around"}', desc: 'turn to a direction', example: ['повернись на север', { direction: 'north' }],
    passive: true,
    async run ({ direction }) {
      const d = String(direction || 'around').toLowerCase()
      const map = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0], север: [0, -1], юг: [0, 1], восток: [1, 0], запад: [-1, 0] }
      if (map[d]) {
        const [dx, dz] = map[d]
        await bot.lookAt(bot.entity.position.offset(dx, 1.62, dz), true)
      } else {
        await bot.look(bot.entity.yaw + Math.PI, 0, true)
      }
      log(`Повернулся: ${d}`)
    }
  }

  A.chat = {
    args: '{"text":"message"}', desc: 'write a message in game chat', example: ['напиши в чат привет всем', { text: 'привет всем' }],
    passive: true,
    async run ({ text }) {
      if (!text) return log('Что написать?')
      bot.chat(String(text).slice(0, 250))
      log(`Написал в чат: ${text}`)
    }
  }

  A.drop = {
    args: '{"item":"item id","count":N}', desc: 'throw away an item (count optional; no item = held item)', example: ['выбрось 5 dirt', { item: 'dirt', count: 5 }],
    passive: true,
    async run ({ item, count }) {
      const it = findItem(item)
      if (!it) return log(`Нет предмета: ${item || 'в руке пусто'}`)
      const n = Number(count) > 0 ? Math.min(Number(count), bot.inventory.count(it.type, null)) : it.count
      try { await bot.toss(it.type, null, n); log(`Выбросил ${n} ${it.name}`) } catch (e) { log(`Не смог выбросить: ${e.message}`) }
    }
  }

  A.drop_all = {
    args: '{}', desc: 'throw away the whole inventory', example: ['выбрось всё', {}],
    passive: true,
    async run () {
      const items = bot.inventory.items()
      if (!items.length) return log('Инвентарь пуст')
      for (const it of items) { try { await bot.tossStack(it) } catch {} await sleep(150) }
      log(`Выбросил всё (${items.length} стаков)`)
    }
  }

  A.equip = {
    args: '{"item":"item id"}', desc: 'take item in hand or put on armor', example: ['возьми в руку diamond_sword', { item: 'diamond_sword' }],
    passive: true,
    async run ({ item }) {
      const it = findItem(item)
      if (!it) return log(`Нет предмета: ${item}`)
      const dest = /helmet/.test(it.name) ? 'head' : /chestplate|elytra/.test(it.name) ? 'torso' : /leggings/.test(it.name) ? 'legs' : /boots/.test(it.name) ? 'feet' : /shield/.test(it.name) ? 'off-hand' : 'hand'
      try { await bot.equip(it, dest); log(`Надел/взял: ${it.name}`) } catch (e) { log(`Не смог взять: ${e.message}`) }
    }
  }

  A.inventory = {
    args: '{}', desc: 'show inventory', example: ['что в инвентаре', {}],
    passive: true,
    async run () {
      const items = bot.inventory.items()
      log(items.length ? `Инвентарь: ${items.map(i => `${i.name} x${i.count}`).join(', ')}` : 'Инвентарь пуст')
    }
  }

  A.eat = {
    args: '{}', desc: 'eat food from inventory', example: ['поешь', {}],
    passive: true,
    async run () {
      const foods = bot.registry.foodsByName || {}
      const food = bot.inventory.items().find(i => foods[i.name])
      if (!food) return log('Нет еды в инвентаре')
      try { await bot.equip(food, 'hand'); await bot.consume(); log(`Съел ${food.name}. Сытость: ${bot.food}/20`) } catch (e) { log(`Не смог поесть: ${e.message}`) }
    }
  }

  A.dig = {
    args: '{"block":"block id"}', desc: 'find nearest block of this type and break it', example: ['сломай oak_log', { block: 'oak_log' }],
    async run ({ block }) {
      const name = String(block || '').toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_')
      const ids = Object.values(bot.registry.blocksByName).filter(b => b.name === name || (name && b.name.includes(name))).map(b => b.id)
      if (!ids.length) return log(`Не знаю блок ${block}`)
      const target = bot.findBlock({ matching: ids, maxDistance: 32 })
      if (!target) return log(`Рядом нет блока ${block}`)
      const t = newTask(`сломать ${target.name}`)
      log(`Иду ломать ${target.name} на ${posStr(target.position)}`)
      try {
        await bot.pathfinder.goto(new GoalLookAtBlock(target.position, bot.world))
        if (t.cancelled) return
        await bot.dig(target, true)
        log(`Сломал ${target.name}`)
      } catch (e) { if (!t.cancelled) log(`Не смог сломать: ${e.message}`) }
      endTask(t)
    }
  }

  A.collect = {
    args: '{}', desc: 'pick up dropped items nearby', example: ['подбери вещи', {}],
    async run () {
      const t = newTask('подобрать вещи')
      let picked = 0
      for (let i = 0; i < 10 && !t.cancelled; i++) {
        const items = Object.values(bot.entities).filter(e => e.name === 'item' && bot.entity.position.distanceTo(e.position) < 16)
          .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))
        if (!items.length) break
        const p = items[0].position.floored()
        try { await bot.pathfinder.goto(new GoalBlock(p.x, p.y, p.z)); picked++ } catch { break }
        await sleep(300)
      }
      if (!t.cancelled) log(picked ? `Подобрал вещи (${picked})` : 'Рядом нет вещей')
      endTask(t)
    }
  }

  A.wander = {
    args: '{}', desc: 'walk around randomly until stop', example: ['погуляй', {}],
    async run () {
      const t = newTask('гулять')
      log('Гуляю. Напиши stop, чтобы остановить')
      while (!t.cancelled) {
        const p = bot.entity.position
        const x = Math.floor(p.x + (Math.random() * 20 - 10))
        const z = Math.floor(p.z + (Math.random() * 20 - 10))
        try { await bot.pathfinder.goto(new GoalNear(x, Math.floor(p.y), z, 2)) } catch {}
        await sleep(1000 + Math.random() * 2000)
      }
    }
  }

  A.jump = {
    args: '{"times":N}', desc: 'jump N times', example: ['прыгни 3 раза', { times: 3 }],
    passive: true,
    async run ({ times }) {
      const n = Math.min(Number(times) || 1, 20)
      for (let i = 0; i < n; i++) { bot.setControlState('jump', true); await sleep(450); bot.setControlState('jump', false); await sleep(150) }
      log(`Прыгнул ${n} раз`)
    }
  }

  A.sneak = {
    args: '{"on":true|false}', desc: 'start or stop sneaking (crouch)', example: ['присядь', { on: true }],
    passive: true,
    async run ({ on }) {
      const v = !(on === false || on === 'false')
      bot.setControlState('sneak', v)
      log(v ? 'Присел (shift)' : 'Встал')
    }
  }

  A.use = {
    args: '{}', desc: 'use (right click) the item in hand', example: ['используй предмет', {}],
    passive: true,
    async run () {
      if (!bot.heldItem) return log('В руке пусто')
      bot.activateItem()
      await sleep(1000)
      bot.deactivateItem()
      log(`Использовал ${bot.heldItem ? bot.heldItem.name : 'предмет'}`)
    }
  }

  A.sleep = {
    args: '{}', desc: 'go to nearest bed and sleep', example: ['иди спать', {}],
    async run () {
      const bed = bot.findBlock({ matching: b => bot.isABed(b), maxDistance: 32 })
      if (!bed) return log('Рядом нет кровати')
      const t = newTask('спать')
      try {
        await bot.pathfinder.goto(new GoalNear(bed.position.x, bed.position.y, bed.position.z, 2))
        await bot.sleep(bed)
        log('Сплю')
      } catch (e) { if (!t.cancelled) log(`Не могу спать: ${e.message}`) }
      endTask(t)
    }
  }

  A.players = {
    args: '{}', desc: 'list online players', example: ['кто онлайн', {}],
    passive: true,
    async run () {
      const list = Object.values(bot.players).filter(p => p.username !== bot.username).map(p => p.entity ? `${p.username} (${Math.round(bot.entity.position.distanceTo(p.entity.position))} бл.)` : p.username)
      log(list.length ? `Игроки: ${list.join(', ')}` : 'Кроме меня никого')
    }
  }

  A.position = {
    args: '{}', desc: 'tell current position', example: ['где ты', {}],
    passive: true,
    async run () { log(`Я на координатах ${posStr(bot.entity.position)}`) }
  }

  A.status = {
    args: '{}', desc: 'tell health, food, level, held item', example: ['как здоровье', {}],
    passive: true,
    async run () {
      log(`Здоровье ${Math.round(bot.health)}/20, сытость ${bot.food}/20, уровень ${bot.experience.level}, режим ${bot.game.gameMode}, в руке ${bot.heldItem ? bot.heldItem.name : 'ничего'}${task ? `, делаю: ${task.name}` : ''}`)
    }
  }

  A.stop = {
    args: '{}', desc: 'stop everything', example: ['стоп', {}],
    passive: true,
    async run () { if (task) stopTask(true); else { stopTask(false); log('Остановился') } }
  }

  A.none = {
    args: '{"reply":"text"}', desc: 'nothing to do, just answer the user', example: ['привет', { reply: 'Привет!' }],
    passive: true,
    async run ({ reply }) { log(reply || 'Не понял команду') }
  }

  return { actions: A, stopTask, currentTask: () => task }
}

module.exports = { createActions, posStr, isNear, sleep, log }
