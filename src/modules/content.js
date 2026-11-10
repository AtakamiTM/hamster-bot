import {
  ButtonBuilder, ButtonStyle, InteractionContextType, MediaGalleryBuilder, MediaGalleryItemBuilder, SlashCommandBuilder,
} from 'discord.js';
import { getSetting } from '../db.js';
import { COLORS, SEP, card, clip, edit, farmEmoji, mentionSafe, notice, row, translateButton } from '../ui.js';

const PLATFORMS = [
  [/(youtube\.com|youtu\.be)/i, 'YouTube', '▶️', 'https://www.youtube.com/oembed?format=json&url='],
  [/tiktok\.com/i, 'TikTok', '🎵', 'https://www.tiktok.com/oembed?url='],
  [/twitch\.tv/i, 'Twitch', '🟣'],
  [/roblox\.com/i, 'Roblox', '🎮'],
  [/(x\.com|twitter\.com)/i, 'X (Twitter)', '🐦'],
  [/instagram\.com/i, 'Instagram', '📷'],
];

async function describe(url) {
  const host = new URL(url).hostname;
  const platform = PLATFORMS.find(([re]) => re.test(host));
  const info = { name: platform?.[1] ?? 'the web', emoji: platform?.[2] ?? '🔗', title: null, author: null, thumbnail: null };
  if (platform?.[3]) {
    try {
      const res = await fetch(platform[3] + encodeURIComponent(url), { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        info.title = data.title ?? null;
        info.author = data.author_name ?? null;
        info.thumbnail = data.thumbnail_url ?? null;
      }
    } catch { /* fall back to the plain link */ }
  }
  return info;
}

const command = {
  data: new SlashCommandBuilder()
    .setName('content')
    .setDescription('Announce new content in the notifications channel')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('link').setDescription('Link to the video / post').setRequired(true).setMaxLength(300))
    .addStringOption((o) => o.setName('message').setDescription('Optional short message').setMaxLength(300)),

  async execute(i) {
    const roleId = await getSetting(i.guildId, 'role_content');
    const allowed = i.member.permissions.has('ManageGuild') || (roleId && i.member.roles.cache.has(roleId));
    if (!allowed) return i.reply(notice('You need the content creator role to use this command.', 'error'));

    const channelId = await getSetting(i.guildId, 'channel_notifications');
    if (!channelId) return i.reply(notice('Set the notifications channel first: `/config channel type:notifications`.', 'error'));

    let url;
    try {
      url = new URL(i.options.getString('link', true).trim());
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('protocol');
    } catch {
      return i.reply(notice('Please provide a valid link starting with `https://`.', 'error'));
    }

    await i.deferReply({ flags: 64 });
    const info = await describe(url.href);
    const pingRole = await getSetting(i.guildId, 'role_ping');
    const note = i.options.getString('message');

    const parts = [
      pingRole ? `<@&${pingRole}>` : null,
      `## ${farmEmoji(i.guild, 'water')} Fresh from the farm\nNew on **${info.name}**`,
      info.title ? `**${clip(info.title, 200)}**` : null,
      [
        note ? `${note}\n` : null,
        info.author ? `${info.emoji} **${info.author}**` : null,
        `-# Shared by ${i.user}`,
      ].filter(Boolean).join('\n'),
      info.thumbnail ? new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(info.thumbnail)) : null,
      SEP,
      row(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url.href).setLabel(`Open on ${info.name}`).setEmoji(info.emoji),
        translateButton(),
      ),
    ];

    try {
      const channel = await i.client.channels.fetch(channelId);
      const sent = await channel.send({
        ...card({ color: COLORS.brand, banner: 'content', parts }),
        allowedMentions: pingRole ? { roles: [pingRole], users: [] } : mentionSafe,
      });
      return i.editReply(edit(notice(`Announcement posted: ${sent.url}`, 'ok')));
    } catch (err) {
      console.error('[content]', err.message);
      return i.editReply(edit(notice('I could not post in the notifications channel. Check my permissions.', 'error')));
    }
  },
};

export default { commands: [command] };
