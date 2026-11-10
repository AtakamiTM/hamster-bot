import {
  AttachmentBuilder, ButtonBuilder, ButtonStyle, Events, InteractionContextType, MediaGalleryBuilder,
  MediaGalleryItemBuilder, SectionBuilder, SlashCommandBuilder, TextDisplayBuilder, ThumbnailBuilder,
} from 'discord.js';
import { get, getSetting, run } from '../db.js';
import { COLORS, card, clip, edit, farmEmoji, isStaff, mentionSafe, notice, pad, quote, row, translateButton, uiHeading, uiMessage, voteBar } from '../ui.js';

const MAX_LENGTH = 1500;
const STATUS = {
  pending: { label: 'Open for voting', emoji: '🗳️', color: COLORS.purple },
  approved: { label: 'Approved', emoji: '✅', color: COLORS.green },
  considered: { label: 'Under consideration', emoji: '🤔', color: COLORS.blue },
  denied: { label: 'Denied', emoji: '❌', color: COLORS.red },
};

async function votes(id) {
  const rows = await get(
    'SELECT SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END) AS up, SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END) AS down FROM suggestion_votes WHERE suggestion_id = ?',
    id,
  );
  return { up: rows.up ?? 0, down: rows.down ?? 0 };
}

function bossBar(up, down, guild) {
  const total = up + down;
  return voteBar(total ? up / total : 0, guild);
}

export async function renderSuggestion(s, guild) {
  const status = STATUS[s.status];
  const { up, down } = await votes(s.id);
  const total = up + down;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  const finished = s.status === 'approved' || s.status === 'denied';

  const head = new SectionBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `${uiHeading(`${farmEmoji(guild, 'idea')} Suggestion #${pad(s.id)}`)}\n${s.status === 'approved' ? farmEmoji(guild, 'check') : status.emoji} ${status.label}\n-# Shared by ${s.author_name}`,
    ));
  if (s.author_avatar) head.setThumbnailAccessory(new ThumbnailBuilder().setURL(s.author_avatar));
  else head.setButtonAccessory(new ButtonBuilder().setCustomId('sg:noop').setLabel('Idea').setStyle(ButtonStyle.Secondary).setDisabled(true));

  const parts = [head, quote(s.content)];
  if (s.image) {
    parts.push(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${s.image}`)));
  }
  parts.push(
    `**Community votes**\n${bossBar(up, down, guild)}\n${farmEmoji(guild, 'heart')} **${up}** · ${pct(up)}%   /   👎 **${down}** · ${pct(down)}%\n-# ${total} voter${total === 1 ? '' : 's'}`,
  );
  if (s.reason) parts.push(`-# ${status.emoji} Staff: ${clip(s.reason, 600)}`);
  parts.push(row(
    new ButtonBuilder().setCustomId(`sg:up:${s.id}`).setLabel(`Support · ${up}`).setEmoji(farmEmoji(guild, 'heart')).setStyle(ButtonStyle.Success).setDisabled(finished),
    new ButtonBuilder().setCustomId(`sg:down:${s.id}`).setLabel(`Oppose · ${down}`).setEmoji('👎').setStyle(ButtonStyle.Secondary).setDisabled(finished),
  ));
  parts.push(row(translateButton()));

  return card({ color: status.color, parts });
}

async function warn(channel, text) {
  const m = await channel.send({ content: uiMessage(text, '⚠️'), allowedMentions: mentionSafe }).catch(() => null);
  setTimeout(() => m?.delete().catch(() => {}), 8000);
}

async function onMessage(message) {
  if (message.author.bot || !message.inGuild() || message.system) return;
  if (message.channelId !== await getSetting(message.guildId, 'channel_suggestions')) return;

  const text = message.content.trim();
  const image = [...message.attachments.values()].find((a) => a.contentType?.startsWith('image/'));
  if (!text && !image) return;
  if (text.length > MAX_LENGTH) {
    return warn(message.channel, `${message.author}, your suggestion is too long (max ${MAX_LENGTH} characters). Please shorten it and send it again.`);
  }

  const ext = image ? (image.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') : null;
  const member = message.member;
  const { lastInsertRowid } = await run(
    'INSERT INTO suggestions (guild, channel, author, author_name, author_avatar, content, image) VALUES (?, ?, ?, ?, ?, ?, ?)',
    message.guildId, message.channelId, message.author.id,
    member?.displayName ?? message.author.username,
    member?.displayAvatarURL({ extension: 'png', size: 128 }) ?? message.author.displayAvatarURL({ extension: 'png', size: 128 }),
    text || '*(image only)*', image ? `suggestion-${Date.now()}.${ext}` : null,
  );
  const id = Number(lastInsertRowid);
  const suggestion = await get('SELECT * FROM suggestions WHERE id = ?', id);

  try {
    const payload = await renderSuggestion(suggestion, message.guild);
    if (image) payload.files.push(new AttachmentBuilder(image.url, { name: suggestion.image }));
    const sent = await message.channel.send({ ...payload, allowedMentions: mentionSafe });
    await run('UPDATE suggestions SET message = ? WHERE id = ?', sent.id, id);
    await message.delete().catch(() => {});
    await sent.startThread({ name: `💬 Suggestion #${pad(id)}`.slice(0, 100), autoArchiveDuration: 1440 }).catch(() => {});
  } catch (err) {
    console.error('[suggestions]', err.message);
    await run('DELETE FROM suggestions WHERE id = ?', id);
  }
}

async function vote(i, [kind, id]) {
  if (kind === 'noop') return;
  const s = await get('SELECT * FROM suggestions WHERE id = ?', Number(id));
  if (!s) return i.reply(notice('This suggestion no longer exists.', 'error'));
  if (s.status === 'approved' || s.status === 'denied') {
    return i.reply(notice('Voting on this suggestion is closed.', 'error'));
  }
  const value = kind === 'up' ? 1 : -1;
  const existing = await get('SELECT vote FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?', s.id, i.user.id);
  if (existing?.vote === value) {
    await run('DELETE FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?', s.id, i.user.id);
  } else {
    await run(
      'INSERT INTO suggestion_votes (suggestion_id, user_id, vote) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE vote = VALUES(vote)',
      s.id, i.user.id, value,
    );
  }
  return i.update(edit(await renderSuggestion(s, i.guild)));
}

const command = {
  data: new SlashCommandBuilder()
    .setName('suggestion')
    .setDescription('Review a suggestion (staff)')
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((o) => o.setName('id').setDescription('Suggestion number').setRequired(true))
    .addStringOption((o) =>
      o.setName('status').setDescription('Decision').setRequired(true).addChoices(
        { name: '✅ Approved', value: 'approved' },
        { name: '🤔 Under consideration', value: 'considered' },
        { name: '❌ Denied', value: 'denied' },
        { name: '🗳️ Reopen voting', value: 'pending' },
      ))
    .addStringOption((o) => o.setName('reason').setDescription('Public explanation').setMaxLength(600)),

  async execute(i) {
    if (!(await isStaff(i.member))) return i.reply(notice('Staff only.', 'error'));
    const s = await get('SELECT * FROM suggestions WHERE id = ? AND guild = ?', i.options.getInteger('id', true), i.guildId);
    if (!s) return i.reply(notice('No suggestion with that number.', 'error'));

    const status = i.options.getString('status', true);
    const reason = i.options.getString('reason');
    await run('UPDATE suggestions SET status = ?, reason = ?, reviewer = ? WHERE id = ?', status, status === 'pending' ? null : reason, i.user.id, s.id);

    try {
      const channel = await i.client.channels.fetch(s.channel);
      const message = await channel.messages.fetch(s.message);
      await message.edit(edit(await renderSuggestion(await get('SELECT * FROM suggestions WHERE id = ?', s.id), i.guild)));
    } catch {
      return i.reply(notice('Saved, but I could not update the original message.', 'error'));
    }
    return i.reply(notice(`Suggestion #${pad(s.id)} → **${STATUS[status].label}**.`, 'ok'));
  },
};

function register(client) {
  client.on(Events.MessageCreate, (m) => onMessage(m).catch((e) => console.error('[suggestions]', e.message)));
}

export default { commands: [command], handlers: { sg: vote }, register };
