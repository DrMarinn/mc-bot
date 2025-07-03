const mineflayer = require('mineflayer');

function startBot() {
  const bot = mineflayer.createBot({
    host: 'mc.masedworld.net',
    port: 25565,
    username: 'bot_biko1',
    version: '1.8.9',
    auth: 'offline',
  });

  bot.once('spawn', () => {
    console.log(`[${bot.username}] вошёл`);
    setTimeout(() => {
      bot.chat('/login biko');
    }, 500);
    setTimeout(() => {
      bot.chat('/s6');
    }, 9000);
    setInterval(() => {
      const player = Object.values(bot.players).find(p => p.username !== bot.username && p.entity);
      if (player && player.entity) {
        bot.lookAt(player.entity.position.offset(0, 1.6, 0));
      }
    }, 2000);
  });

  bot.on('chat', (username, message) => {
    if (username !== bot.username) bot.chat(message);
  });

  bot.on('kicked', r => console.log(`[${bot.username}] кикнут: ${r}`));
  bot.on('end', () => {
    console.log(`[${bot.username}] отключён. Перезапуск через 10 секунд...`);
    setTimeout(startBot, 10000);
  });
}

startBot();
