import {
  ButtonBuilder, ButtonStyle, InteractionContextType, PermissionFlagsBits, SlashCommandBuilder,
} from 'discord.js';
import { all, get, getSetting, run } from '../db.js';
import { COLORS, card, clip, edit, ephemeral, isStaff, mentionSafe, notice, row, translateButton, voteBar } from '../ui.js';

const NUMBERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

async function tally(survey) {
  const options = JSON.parse(survey.options);
  const counts = options.map(() => 0);
  for (const r of await all('SELECT `option`, COUNT(*) AS n FROM survey_votes WHERE survey_id = ? GROUP BY `option`', survey.id)) {
    counts[r.option] = r.n;
  }
  return { options, counts, total: counts.reduce((a, b) => a + b, 0) };
}

export async function renderSurvey(survey, guild) {
  const { options, counts, total } = await tally(survey);
  const closed = Boolean(survey.closed);
  const top = Math.max(...counts);

  const results = options.map((text, n) => {
    const pct = total ? counts[n] / total : 0;
    const crown = closed && total && counts[n] === top ? ' 👑' : '';
    return `${NUMBERS[n]} **${text}**${crown}\n${voteBar(pct, guild)} **${Math.round(pct * 100)}%** · ${counts[n]} vote${counts[n] === 1 ? '' : 's'}`;
  }).join('\n\n');

  const footer = closed
    ? `🏁 **Closed** · ${total} total vote${total === 1 ? '' : 's'}`
    : `🗳️ **${total}** vote${total === 1 ? '' : 's'}${survey.ends_at ? ` · ends <t:${Math.floor(survey.ends_at / 1000)}:R>` : ''}\n-# Click an option to vote. Click it again to remove your vote, or pick another to change it.`;

  const buttons = options.map((text, n) =>
    new ButtonBuilder()
      .setCustomId(`sv:${survey.id}:${n}`)
      .setLabel(clip(text, 40))
      .setEmoji(NUMBERS[n])
      .setStyle(closed ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(closed));

  return card({
    banner: 'surveys',
    color: closed ? COLORS.gray : COLORS.blue,
    parts: [
      `## ${survey.question}\n-# Community survey #${survey.id}`,
      results,
      footer,
      row(...buttons),
      row(translateButton()),
    ],
  });
}

export async function closeSurvey(client, id, guild) {
  await run('UPDATE surveys SET closed = 1 WHERE id = ?', id);
  const survey = await get('SELECT * FROM surveys WHERE id = ?', id);
  if (!survey?.channel || !survey.message) return survey;
  try {
    const targetGuild = guild ?? await client.guilds.fetch(survey.guild);
    const channel = await client.channels.fetch(survey.channel);
    const message = await channel.messages.fetch(survey.message);
    await message.edit(edit(await renderSurvey(survey, targetGuild)));
  } catch (err) {
    console.error('[survey] could not update closed survey', err.message);
  }
  return survey;
}

async function vote(i, [id, idx]) {
  const survey = await get('SELECT * FROM surveys WHERE id = ?', Number(id));
  if (!survey) return i.reply(notice('This survey no longer exists.', 'error'));
  if (survey.closed || (survey.ends_at && survey.ends_at < Date.now())) {
    await closeSurvey(i.client, survey.id, i.guild);
    return i.reply(notice('This survey is closed.', 'error'));
  }

  const option = Number(idx);
  const existing = await get('SELECT `option` FROM survey_votes WHERE survey_id = ? AND user_id = ?', survey.id, i.user.id);
  if (existing?.option === option) {
    await run('DELETE FROM survey_votes WHERE survey_id = ? AND user_id = ?', survey.id, i.user.id);
  } else {
    await run(
      'INSERT INTO survey_votes (survey_id, user_id, `option`) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `option` = VALUES(`option`)',
      survey.id, i.user.id, option,
    );
  }
  return i.update(edit(await renderSurvey(survey, i.guild)));
}

const command = {
  data: new SlashCommandBuilder()
    .setName('survey')
    .setDescription('Community surveys')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => {
      s.setName('create').setDescription('Create a survey (staff)')
        .addStringOption((o) => o.setName('question').setDescription('The question').setRequired(true).setMaxLength(200))
        .addStringOption((o) => o.setName('option1').setDescription('Option 1').setRequired(true).setMaxLength(80))
        .addStringOption((o) => o.setName('option2').setDescription('Option 2').setRequired(true).setMaxLength(80));
      for (let n = 3; n <= 5; n++) {
        s.addStringOption((o) => o.setName(`option${n}`).setDescription(`Option ${n}`).setMaxLength(80));
      }
      return s
        .addIntegerOption((o) => o.setName('hours').setDescription('Auto-close after this many hours').setMinValue(1).setMaxValue(720))
        .addChannelOption((o) => o.setName('channel').setDescription('Where to post (default: surveys channel)'));
    })
    .addSubcommand((s) =>
      s.setName('close').setDescription('Close a survey now (staff)')
        .addIntegerOption((o) => o.setName('id').setDescription('Survey ID').setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('Show active surveys')),

  async execute(i) {
    const sub = i.options.getSubcommand();

    if (sub === 'list') {
      const active = await all('SELECT * FROM surveys WHERE guild = ? AND closed = 0 AND message IS NOT NULL ORDER BY id DESC LIMIT 15', i.guildId);
      if (!active.length) return i.reply(notice('There are no active surveys right now.', 'info'));
      const lines = await Promise.all(active.map(async (s) => {
        const { total } = await tally(s);
        return `📊 **#${s.id}** [${clip(s.question, 70)}](https://discord.com/channels/${s.guild}/${s.channel}/${s.message}) · ${total} votes`;
      }));
      return i.reply(ephemeral(card({ parts: ['## 🗳️ Active surveys', lines.join('\n')], color: COLORS.blue })));
    }

    if (!(await isStaff(i.member))) return i.reply(notice('Staff only.', 'error'));

    if (sub === 'close') {
      const id = i.options.getInteger('id', true);
      const survey = await get('SELECT * FROM surveys WHERE id = ? AND guild = ?', id, i.guildId);
      if (!survey) return i.reply(notice('No survey with that ID.', 'error'));
      await closeSurvey(i.client, id);
      return i.reply(notice(`Survey #${id} closed.`, 'ok'));
    }

    const options = [1, 2, 3, 4, 5].map((n) => i.options.getString(`option${n}`)?.trim()).filter(Boolean);
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) {
      return i.reply(notice('Options must be different from each other.', 'error'));
    }
    const channelId = i.options.getChannel('channel')?.id ?? (await getSetting(i.guildId, 'channel_surveys')) ?? i.channelId;
    const hours = i.options.getInteger('hours');
    const { lastInsertRowid } = await run(
      'INSERT INTO surveys (guild, channel, question, options, author, ends_at) VALUES (?, ?, ?, ?, ?, ?)',
      i.guildId, channelId, i.options.getString('question', true).trim(), JSON.stringify(options), i.user.id,
      hours ? Date.now() + hours * 3600_000 : null,
    );
    const survey = await get('SELECT * FROM surveys WHERE id = ?', Number(lastInsertRowid));

    try {
      const channel = await i.client.channels.fetch(channelId);
      const sent = await channel.send({ ...(await renderSurvey(survey, i.guild)), allowedMentions: mentionSafe });
      await run('UPDATE surveys SET message = ? WHERE id = ?', sent.id, survey.id);
    } catch (err) {
      await run('DELETE FROM surveys WHERE id = ?', survey.id);
      console.error('[survey]', err.message);
      return i.reply(notice('I could not post the survey there. Check my permissions in that channel.', 'error'));
    }
    return i.reply(notice(`Survey #${survey.id} posted in <#${channelId}>.`, 'ok'));
  },
};

function onReady(client) {
  setInterval(async () => {
    try {
      const due = await all('SELECT id FROM surveys WHERE closed = 0 AND ends_at IS NOT NULL AND ends_at < ?', Date.now());
      for (const { id } of due) await closeSurvey(client, id);
    } catch (err) {
      console.error('[survey] auto-close failed', err.message);
    }
  }, 30_000).unref();
}

export default { commands: [command], handlers: { sv: vote }, onReady };
