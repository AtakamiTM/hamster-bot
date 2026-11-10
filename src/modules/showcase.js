import { ChannelType, Events, InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { all, get, getSetting, run } from '../db.js';
import { COLORS, card, clip, ephemeral, notice, uiMessage } from '../ui.js';

const KINDS = {
  screenshots: { icon: '📸', singular: 'screenshot', reactions: ['❤️', '🔥', '😍'], needs: 'an **image**' },
  clips: { icon: '🎬', singular: 'clip', reactions: ['❤️', '🔥', '😂'], needs: 'a **video** or a link to one (YouTube, Twitch, TikTok, Medal, Streamable...)' },
  fanarts: { icon: '🎨', singular: 'fan-art', reactions: ['❤️', '🎨', '😍'], needs: 'an **image**' },
};
const LIKE = '❤️';
const TROPHY = '🏆';
const TROPHY_AT = 10;

const CLIP_HOSTS = /(?:^|\.)(youtube\.com|youtu\.be|twitch\.tv|tiktok\.com|medal\.tv|streamable\.com|outplayed\.tv|clips\.twitch\.tv|vimeo\.com|instagram\.com|x\.com|twitter\.com)$/i;

function hasClipLink(text) {
  for (const url of text.match(/https?:\/\/[^\s<>]+/g) ?? []) {
    try {
      if (CLIP_HOSTS.test(new URL(url).hostname)) return true;
    } catch { /* ignore */ }
  }
  return false;
}

function valid(kind, message) {
  const files = [...message.attachments.values()];
  const image = files.some((a) => a.contentType?.startsWith('image/'));
  const video = files.some((a) => a.contentType?.startsWith('video/'));
  if (kind === 'clips') return video || hasClipLink(message.content);
  return image;
}

async function kindOf(message) {
  for (const kind of Object.keys(KINDS)) {
    if (message.channelId === await getSetting(message.guildId, `channel_${kind}`)) return kind;
  }
  return null;
}

async function onMessage(message) {
  if (message.author.bot || !message.inGuild() || message.system) return;
  const kind = await kindOf(message);
  if (!kind) return;
  const info = KINDS[kind];

  if (!valid(kind, message)) {
    if (message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return;
    await message.delete().catch(() => {});
    const warn = await message.channel.send({
      content: uiMessage(`${message.author}, this channel is only for ${info.singular}s. Please attach ${info.needs}. Use the threads under posts to chat.`, '⚠️'),
      allowedMentions: { users: [message.author.id] },
    }).catch(() => null);
    setTimeout(() => warn?.delete().catch(() => {}), 9000);
    return;
  }

  await run(
    'INSERT IGNORE INTO submissions (message, guild, channel, kind, author, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    message.id, message.guildId, message.channelId, kind, message.author.id, Date.now(),
  );
  for (const emoji of info.reactions) await message.react(emoji).catch(() => {});
  await message.startThread({
    name: `${info.icon} ${message.member?.displayName ?? message.author.username}'s ${info.singular}`.slice(0, 100),
    autoArchiveDuration: 1440,
  }).catch(() => {});
}

async function onReaction(reaction, user, added) {
  if (user.bot || !reaction.message.guildId) return;
  const sub = await get('SELECT * FROM submissions WHERE message = ?', reaction.message.id);
  if (!sub) return;
  if (reaction.partial) reaction = await reaction.fetch().catch(() => reaction);

  // Authors cannot boost their own posts.
  if (added && user.id === sub.author && KINDS[sub.kind].reactions.includes(reaction.emoji.name)) {
    await reaction.users.remove(user.id).catch(() => {});
    return;
  }
  if (reaction.emoji.name !== LIKE) return;

  const likes = Math.max(0, reaction.count - (reaction.me ? 1 : 0));
  await run('UPDATE submissions SET likes = ? WHERE message = ?', likes, sub.message);
  if (likes >= TROPHY_AT && added) {
    const message = reaction.message.partial ? await reaction.message.fetch().catch(() => null) : reaction.message;
    await message?.react(TROPHY).catch(() => {});
  }
}

const command = {
  data: new SlashCommandBuilder()
    .setName('top')
    .setDescription('Most loved screenshots, clips and fan-arts of the last 30 days')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o.setName('type').setDescription('What to show').setRequired(true).addChoices(
        { name: '📸 Screenshots', value: 'screenshots' },
        { name: '🎬 Clips', value: 'clips' },
        { name: '🎨 Fan-arts', value: 'fanarts' },
      )),

  async execute(i) {
    const kind = i.options.getString('type', true);
    const since = Date.now() - 30 * 24 * 3600_000;
    const rows = await all(
      'SELECT * FROM submissions WHERE guild = ? AND kind = ? AND created_at > ? AND likes > 0 ORDER BY likes DESC LIMIT 5',
      i.guildId, kind, since,
    );
    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
    const text = rows.length
      ? rows.map((r, n) => `${medals[n]} <@${r.author}>\n**${r.likes}** ❤️ · [View post](https://discord.com/channels/${r.guild}/${r.channel}/${r.message})`).join('\n\n')
      : 'Nothing here yet. Be the first to post and collect some ❤️!';
    return i.reply({
      ...ephemeral(card({ color: COLORS.purple, parts: [`## ${KINDS[kind].icon} Community favourites\n-# Top ${clip(kind, 20)} · Last 30 days`, text] })),
      allowedMentions: { parse: [] },
    });
  },
};

function register(client) {
  client.on(Events.MessageCreate, (m) => onMessage(m).catch((e) => console.error('[showcase]', e.message)));
  client.on(Events.MessageReactionAdd, (r, u) => onReaction(r, u, true).catch((e) => console.error('[showcase]', e.message)));
  client.on(Events.MessageReactionRemove, (r, u) => onReaction(r, u, false).catch((e) => console.error('[showcase]', e.message)));
}

export default { commands: [command], register };
