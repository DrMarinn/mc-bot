module.exports = {
  // Адрес сервера, ник и пароль бот спросит при первом запуске
  // и сохранит в settings.json (чтобы поменять — удали settings.json)
  version: '1.21.4',

  // Регистрация / вход ({password} заменится на пароль)
  regCommand: '/reg {password}',
  loginCommand: '/l {password}',
  delayBeforeLogin: 2000,   // 2 секунды между /reg и /l
  delayAfterLogin: 6000,    // ждать 6 секунд после /l

  // Где бот должен появиться после входа
  spawnPoint: { x: 0, y: 70, z: 0 },

  // Порталы
  portals: {
    1: { x: 24, y: 64, z: 32 },
    2: { x: 18, y: 64, z: 33 },
    3: { x: 12, y: 64, z: 34 },
    4: { x: 6, y: 64, z: 35 },
    5: { x: 0, y: 64, z: 35 },
    6: { x: -5, y: 64, z: 35 },
    7: { x: -11, y: 65, z: 34 },
    8: { x: -17, y: 64, z: 33 }
  },

  // Куда портал переносит бота
  afterPortal: { x: 54, y: 72, z: -200 },

  // Локальный ИИ (Ollama)
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'deepseek-coder:6.7b',
  aiTimeout: 120000,        // сколько ждать ответ ИИ (мс)

  // Ломать блоки по пути? (на серверах обычно запрещено)
  canDig: false,
  // Переподключаться при вылете
  autoReconnect: true
}
