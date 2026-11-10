import {
  ButtonBuilder, ButtonStyle, InteractionContextType, PermissionFlagsBits, SlashCommandBuilder,
} from 'discord.js';
import { all, get, getSetting, run, setSetting } from '../db.js';
import { COLORS, SEP, card, clip, edit, farmEmoji, notice, row, translateButton } from '../ui.js';

const MAX_LINKS = 15;

export async function buildLinksPanel(guildId, guild) {
  const links = await all('SELECT * FROM links WHERE guild = ? ORDER BY id', guildId);
  const list = links.length
    ? links.map((l) => `${l.emoji ?? '🔗'} **${l.label}**${l.description ? `: ${l.description}` : ''}`).join('\n')
    : '*No links yet. Staff can add them with `/link add`.*';

  const rows = [];
  for (let n = 0; n < links.length; n += 5) {
    rows.push(row(...links.slice(n, n + 5).map((l) => {
      const b = new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(l.url).setLabel(clip(l.label, 40));
      if (l.emoji) b.setEmoji(l.emoji);
      return b;
    })));
  }

  return card({
    banner: 'links',
    color: COLORS.blue,
    parts: [
      `## ${farmEmoji(guild, 'paw')} Around the farm\nPlay, follow along and stay connected. All our official links in one place.\n-# Only trust links shared here.`,
      SEP,
      list,
      SEP,
      ...rows,
      row(translateButton()),
    ],
  });
}

export async function refreshLinksPanel(client, guildId) {
  const ref = await getSetting(guildId, 'links_panel');
  if (!ref) return;
  const [channelId, messageId] = ref.split('/');
  try {
    const channel = await client.channels.fetch(channelId);
    const message = await channel.messages.fetch(messageId);
    await message.edit(edit(await buildLinksPanel(guildId, message.guild)));
  } catch {
    await setSetting(guildId, 'links_panel', null);
  }
}

const command = {
  data: new SlashCommandBuilder()
    .setName('link')
    .setDescription('Manage the Official Links panel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s.setName('add').setDescription('Add a link')
        .addStringOption((o) => o.setName('label').setDescription('Button label, e.g. TikTok').setRequired(true).setMaxLength(40))
        .addStringOption((o) => o.setName('url').setDescription('https:// link').setRequired(true).setMaxLength(300))
        .addStringOption((o) => o.setName('emoji').setDescription('Emoji, e.g. 🎬').setMaxLength(60))
        .addStringOption((o) => o.setName('description').setDescription('Short description').setMaxLength(80)))
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Remove a link')
        .addIntegerOption((o) => o.setName('id').setDescription('Link ID (see /link list)').setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('List links with IDs')),

  async execute(i) {
    const sub = i.options.getSubcommand();

    if (sub === 'list') {
      const links = await all('SELECT * FROM links WHERE guild = ? ORDER BY id', i.guildId);
      return i.reply(notice(links.length ? links.map((l) => `\`${l.id}\` ${l.emoji ?? '🔗'} ${l.label} · <${l.url}>`).join('\n') : 'No links yet.', 'info'));
    }

    if (sub === 'add') {
      const url = i.options.getString('url', true).trim();
      let parsed;
      try { parsed = new URL(url); } catch { /* handled below */ }
      if (!parsed || parsed.protocol !== 'https:') {
        return i.reply(notice('The link must be a valid `https://` URL.', 'error'));
      }
      if ((await get('SELECT COUNT(*) AS n FROM links WHERE guild = ?', i.guildId)).n >= MAX_LINKS) {
        return i.reply(notice(`You can have at most ${MAX_LINKS} links.`, 'error'));
      }
      const emoji = i.options.getString('emoji');
      if (emoji) {
        try { new ButtonBuilder().setEmoji(emoji.trim()); } catch {
          return i.reply(notice('That is not a valid emoji.', 'error'));
        }
      }
      await run(
        'INSERT INTO links (guild, label, url, emoji, description) VALUES (?, ?, ?, ?, ?)',
        i.guildId, i.options.getString('label', true), parsed.href,
        emoji?.trim() || null, i.options.getString('description'),
      );
    } else {
      const res = await run('DELETE FROM links WHERE guild = ? AND id = ?', i.guildId, i.options.getInteger('id', true));
      if (!res.changes) return i.reply(notice('No link with that ID.', 'error'));
    }

    await refreshLinksPanel(i.client, i.guildId);
    return i.reply(notice(sub === 'add' ? 'Link added and the panel was refreshed.' : 'Link removed and the panel was refreshed.', 'ok'));
  },
};

export default { commands: [command] };
