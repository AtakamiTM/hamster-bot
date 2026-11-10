import 'dotenv/config';
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { notice } from './ui.js';
import { initDb } from './db.js';

import config from './modules/config.js';
import translate from './modules/translate.js';
import verify from './modules/verify.js';
import panels from './modules/panels.js';
import surveys from './modules/surveys.js';
import giveaways from './modules/giveaways.js';
import links from './modules/links.js';
import codes from './modules/codes.js';
import suggestions from './modules/suggestions.js';
import bugs from './modules/bugs.js';
import showcase from './modules/showcase.js';
import content from './modules/content.js';
import boosts from './modules/boosts.js';
import reactionRoles from './modules/reaction-roles.js';

const modules = [config, translate, verify, panels, surveys, giveaways, links, codes, suggestions, bugs, showcase, content, boosts, reactionRoles];

if (!process.env.DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
  // Nothing the bot reposts can ever ping @everyone, roles or users unless a feature explicitly allows it.
  allowedMentions: { parse: [] },
});

const commands = new Map();
const handlers = new Map();
for (const m of modules) {
  for (const c of m.commands ?? []) commands.set(c.data.name, c);
  for (const [prefix, fn] of Object.entries(m.handlers ?? {})) handlers.set(prefix, fn);
  m.register?.(client);
}

client.once(Events.ClientReady, async (c) => {
  const body = [...commands.values()].map((cmd) => cmd.data.toJSON());
  await c.application.commands.set(body, process.env.GUILD_ID || undefined);
  console.log(`Logged in as ${c.user.tag} · ${body.length} commands registered ${process.env.GUILD_ID ? 'for the test guild' : 'globally'}`);
  for (const m of modules) await m.onReady?.(c);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await commands.get(interaction.commandName)?.execute(interaction);
    } else if (interaction.isButton() || interaction.isModalSubmit() || interaction.isAnySelectMenu()) {
      const [prefix, ...args] = interaction.customId.split(':');
      await handlers.get(prefix)?.(interaction, args);
    }
  } catch (err) {
    console.error(`[interaction ${interaction.customId ?? interaction.commandName}]`, err);
    const payload = notice('Something went wrong. Please try again later.', 'error');
    try {
      if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
      else await interaction.reply(payload);
    } catch { /* interaction expired */ }
  }
});

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

try {
  await initDb();
  console.log('Database connected.');
} catch (err) {
  console.error('Could not connect to the database:', err.message);
  process.exit(1);
}
await client.login(process.env.DISCORD_TOKEN);
