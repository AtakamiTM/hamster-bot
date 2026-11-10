import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { get, run } from '../db.js';
import { getSetting } from '../db.js';
import { COLORS, SEP, card, clip, edit, farmEmoji, isStaff, mentionSafe, notice, pad, quote, row, translateButton, uiMessage } from '../ui.js';

const STATUS = {
  open: { label: 'Open', emoji: '🟠', color: COLORS.brand },
  progress: { label: 'In progress', emoji: '🔵', color: COLORS.blue },
  resolved: { label: 'Resolved', emoji: '🟢', color: COLORS.green },
  rejected: { label: 'Rejected', emoji: '🔴', color: COLORS.red },
};
const cooldown = new Map();

export function renderBug(b, guild) {
  const st = STATUS[b.status];
  const lines = [
    `## ${farmEmoji(guild, 'bug')} ${b.title}\n-# Bug report BUG-${pad(b.id)}`,
    `${st.emoji} **${st.label}**${b.handler ? ` · handled by <@${b.handler}>` : ''}\n**Reported by** <@${b.author}>\n**Platform** ${b.platform || 'not specified'}\n-# Submitted <t:${Math.floor(b.created_at / 1000)}:R>`,
  ];
  const parts = [
    lines[0], SEP, lines[1], SEP,
    `**What happened**\n${quote(b.description)}`,
    b.steps ? `**Steps to reproduce**\n${quote(b.steps)}` : null,
    SEP,
    row(
      new ButtonBuilder().setCustomId(`bug:set:${b.id}:progress`).setLabel('In progress').setEmoji('🔧').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`bug:set:${b.id}:resolved`).setLabel('Resolved').setEmoji(farmEmoji(guild, 'check')).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`bug:set:${b.id}:rejected`).setLabel('Reject').setEmoji('🚫').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`bug:set:${b.id}:open`).setLabel('Reopen').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
    ),
    row(translateButton()),
    '-# Staff controls: the buttons above update the status for everyone. Add screenshots or videos in the thread.',
  ];
  return card({ color: st.color, parts });
}

const input = (id, label, style, max, required = true, placeholder) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setMaxLength(max).setRequired(required);
  if (placeholder) t.setPlaceholder(placeholder);
  return new ActionRowBuilder().addComponents(t);
};

async function openForm(i) {
  if (!(await getSetting(i.guildId, 'channel_bugs'))) {
    return i.reply(notice('Bug reports are not configured yet. Please tell an admin.', 'error'));
  }
  const wait = 60_000 - (Date.now() - (cooldown.get(i.user.id) ?? 0));
  if (wait > 0) return i.reply(notice(`Please wait ${Math.ceil(wait / 1000)}s before sending another report.`, 'error'));

  return i.showModal(new ModalBuilder()
    .setCustomId('bug:modal')
    .setTitle('Report a bug')
    .addComponents(
      input('title', 'Short title', TextInputStyle.Short, 100, true, 'e.g. Cannot collect daily reward'),
      input('description', 'What happened? What did you expect?', TextInputStyle.Paragraph, 1000),
      input('steps', 'Steps to reproduce', TextInputStyle.Paragraph, 800, false, '1. Open the shop\n2. Click ...'),
      input('platform', 'Platform / device', TextInputStyle.Short, 60, false, 'PC, Mobile, Console'),
    ));
}

async function submit(i) {
  const channelId = await getSetting(i.guildId, 'channel_bugs');
  await i.deferReply({ flags: 64 });
  const { lastInsertRowid } = await run(
    'INSERT INTO bug_reports (guild, channel, author, title, description, steps, platform, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    i.guildId, channelId, i.user.id,
    i.fields.getTextInputValue('title').trim(),
    i.fields.getTextInputValue('description').trim(),
    i.fields.getTextInputValue('steps').trim() || null,
    i.fields.getTextInputValue('platform').trim() || null,
    Date.now(),
  );
  const id = Number(lastInsertRowid);
  const report = await get('SELECT * FROM bug_reports WHERE id = ?', id);

  try {
    const channel = await i.client.channels.fetch(channelId);
    const sent = await channel.send({ ...renderBug(report, i.guild), allowedMentions: mentionSafe });
    await run('UPDATE bug_reports SET message = ? WHERE id = ?', sent.id, id);
    const thread = await sent.startThread({ name: `BUG-${pad(id)} · ${clip(report.title, 60)}`, autoArchiveDuration: 10080 }).catch(() => null);
    if (thread) {
      await run('UPDATE bug_reports SET thread = ? WHERE id = ?', thread.id, id);
      await thread.send({
        content: uiMessage(`<@${i.user.id}> thanks for the report! Add screenshots, videos or extra details here. Staff will update the status above.`, '🐞'),
        allowedMentions: { users: [i.user.id] },
      }).catch(() => {});
    }
    cooldown.set(i.user.id, Date.now());
    return i.editReply(edit(notice(`Report **BUG-${pad(id)}** submitted. Follow it here: ${sent.url}`, 'ok')));
  } catch (err) {
    console.error('[bugs]', err.message);
    await run('DELETE FROM bug_reports WHERE id = ?', id);
    return i.editReply(edit(notice('I could not post your report. Please tell an admin.', 'error')));
  }
}

async function setStatus(i, [id, status]) {
  if (!(await isStaff(i.member))) return i.reply(notice('Only staff can change a report status.', 'error'));
  const report = await get('SELECT * FROM bug_reports WHERE id = ?', Number(id));
  if (!report || !STATUS[status]) return i.reply(notice('Report not found.', 'error'));

  await run('UPDATE bug_reports SET status = ?, handler = ? WHERE id = ?', status, status === 'open' ? null : i.user.id, report.id);
  const fresh = await get('SELECT * FROM bug_reports WHERE id = ?', report.id);
  await i.update(edit(renderBug(fresh, i.guild)));

  if (report.thread) {
    const thread = await i.client.channels.fetch(report.thread).catch(() => null);
    await thread?.send({
      content: uiMessage(`<@${report.author}>, the status of **BUG-${pad(report.id)}** is now **${STATUS[status].label}** (by ${i.user}).`, STATUS[status].emoji),
      allowedMentions: { users: [report.author] },
    }).catch(() => {});
  }
}

export default {
  handlers: {
    bug: (i, [action, ...rest]) => ({ new: openForm, modal: submit, set: (x) => setStatus(x, rest) })[action]?.(i),
  },
};
