import { randomInt } from 'node:crypto';
import {
  ButtonBuilder, ButtonStyle, InteractionContextType, RESTJSONErrorCodes, SlashCommandBuilder,
} from 'discord.js';
import { all, get, getSetting, run } from '../db.js';
import { SEP, card, clip, edit, ephemeral, farmEmoji, isStaff, mentionSafe, notice, row, translateButton } from '../ui.js';

const HOUR = 60 * 60 * 1000;
const MAX_HOURS = 30 * 24;
const MAX_WINNERS = 20;
const MEMBER_ROLE_ID = '1551331551546056845';
const PARTICIPANTS_PER_PAGE = 20;
const postUpdates = new Map();

function chooseWinners(users, count) {
  const shuffled = [...users];
  for (let n = 0; n < Math.min(count, shuffled.length); n++) {
    const pick = n + randomInt(shuffled.length - n);
    [shuffled[n], shuffled[pick]] = [shuffled[pick], shuffled[n]];
  }
  return shuffled.slice(0, count);
}

export function renderGiveaway(giveaway, winners = [], entryCount = 0, guild) {
  const scheduled = giveaway.status === 'scheduled';
  const finished = giveaway.status === 'ended' || giveaway.status === 'cancelled';
  const winChance = entryCount
    ? Math.min(giveaway.winner_count, entryCount) / entryCount * 100
    : null;
  const state = giveaway.status === 'cancelled'
    ? '🚫 **Cancelled**'
    : giveaway.status === 'ended'
      ? '🏁 **Giveaway ended**'
      : scheduled
        ? `**Starts** <t:${Math.floor(giveaway.starts_at / 1000)}:F>\n**Ends** <t:${Math.floor(giveaway.ends_at / 1000)}:F>`
        : giveaway.status === 'active'
          ? `**Ends** <t:${Math.floor(giveaway.ends_at / 1000)}:R>\n-# <t:${Math.floor(giveaway.ends_at / 1000)}:F>`
          : '🏁 **Giveaway ended**';
  const result = giveaway.status === 'ended'
    ? winners.length
      ? `🏆 **Winner${winners.length === 1 ? '' : 's'}:** ${winners.slice(0, 20).map((id) => `<@${id}>`).join(', ')}${winners.length > 20 ? ` · and ${winners.length - 20} more` : ''}`
      : 'No eligible entries, so no winner was drawn.'
    : giveaway.status === 'cancelled'
      ? '-# No winner was drawn.'
      : null;

  return card({
    banner: 'giveaways',
    parts: [
      `## ${farmEmoji(guild, 'gift')} ${clip(giveaway.prize, 200)}\n-# Community giveaway #${giveaway.id}`,
      giveaway.description ? `> ${clip(giveaway.description, 300)}` : null,
      SEP,
      state,
      `**${giveaway.winner_count}** winner${giveaway.winner_count === 1 ? '' : 's'} · **${entryCount}** entries${winChance === null ? '' : ` · ~**${Number(winChance.toFixed(1))}%** chance`}\n-# Hosted by <@${giveaway.host}> · Requires <@&${MEMBER_ROLE_ID}> at entry and draw`,
      result,
      row(new ButtonBuilder()
        .setCustomId(`gw:join:${giveaway.id}`)
        .setLabel(scheduled ? 'Starts soon' : finished ? 'Giveaway ended' : 'Join giveaway')
        .setEmoji(farmEmoji(guild, 'gift'))
        .setStyle(finished ? ButtonStyle.Secondary : ButtonStyle.Primary)
        .setDisabled(scheduled || finished),
      new ButtonBuilder()
        .setCustomId(`gw:participants:${giveaway.id}`)
        .setLabel('Participants')
        .setEmoji('👥')
        .setStyle(ButtonStyle.Secondary)),
      row(translateButton()),
    ],
  });
}

export async function updatePost(client, giveaway, winners = []) {
  const previous = postUpdates.get(giveaway.id) ?? Promise.resolve();
  const update = previous.then(
    () => updatePostNow(client, giveaway, winners),
    () => updatePostNow(client, giveaway, winners),
  );
  postUpdates.set(giveaway.id, update);
  try {
    return await update;
  } finally {
    if (postUpdates.get(giveaway.id) === update) postUpdates.delete(giveaway.id);
  }
}

async function updatePostNow(client, giveaway, winners) {
  try {
    const channel = await client.channels.fetch(giveaway.channel);
    const message = await channel.messages.fetch({ message: giveaway.message, force: true });
    const entryCount = (await get(
      `SELECT COUNT(*) AS count
       FROM giveaway_entries e
       WHERE e.giveaway_id = ?`,
      giveaway.id,
    )).count;
    const payload = renderGiveaway(giveaway, winners, entryCount, message.guild);
    if (message.attachments?.some((attachment) => attachment.name === 'giveaways.png')) {
      payload.files = [];
    }
    await message.edit({
      ...edit(payload),
      allowedMentions: { ...mentionSafe, users: winners.slice(0, 20) },
    });
    return true;
  } catch (err) {
    if (err.code === RESTJSONErrorCodes.UnknownMessage) {
      await run(
        `DELETE g, e, w FROM giveaways g
         LEFT JOIN giveaway_entries e ON e.giveaway_id = g.id
         LEFT JOIN giveaway_winners w ON w.giveaway_id = g.id
         WHERE g.id = ?`,
        giveaway.id,
      );
      console.warn(`[giveaway #${giveaway.id}] message ${giveaway.message} no longer exists; removed giveaway, entries and winners from the database.`);
      return false;
    }
    console.error(`[giveaway #${giveaway.id}] could not update its message:`, err.message);
    return false;
  }
}

async function startScheduled(client, giveaway) {
  const claimed = await run(
    "UPDATE giveaways SET status = 'starting' WHERE id = ? AND status = 'scheduled'",
    giveaway.id,
  );
  if (!claimed.changes) return;

  try {
    const opening = { ...giveaway, status: 'active' };
    if (!(await updatePost(client, opening))) throw new Error('Could not update the scheduled giveaway message.');
    await run("UPDATE giveaways SET status = 'active' WHERE id = ? AND status = 'starting'", giveaway.id);
  } catch (err) {
    await run("UPDATE giveaways SET status = 'scheduled' WHERE id = ? AND status = 'starting'", giveaway.id);
    console.error(`[giveaway #${giveaway.id}] could not start:`, err.message);
  }
}

async function hasMemberRole(guild, userId) {
  try {
    const member = await guild.members.fetch({ user: userId, force: true });
    return member.roles.cache.has(MEMBER_ROLE_ID);
  } catch (err) {
    if (err.code === RESTJSONErrorCodes.UnknownMember) return false;
    throw err;
  }
}

async function eligibleEntries(client, id, guildId) {
  const entries = await all(
    `SELECT e.user_id FROM giveaway_entries e
     WHERE e.giveaway_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM giveaway_winners w
         WHERE w.giveaway_id = e.giveaway_id AND w.user_id = e.user_id
       )`,
    id,
  );
  const guild = await client.guilds.fetch(guildId);
  const eligible = [];
  for (let offset = 0; offset < entries.length; offset += 10) {
    const batch = entries.slice(offset, offset + 10);
    const checks = await Promise.all(batch.map((entry) => hasMemberRole(guild, entry.user_id)));
    batch.forEach((entry, index) => {
      if (checks[index]) eligible.push(entry.user_id);
    });
  }
  return eligible;
}

async function endGiveaway(client, id, guildId) {
  const claimed = await run(
    "UPDATE giveaways SET status = 'ending' WHERE id = ? AND guild = ? AND status = 'active'",
    id, guildId,
  );
  if (!claimed.changes) return { ended: false };

  try {
    const giveaway = await get('SELECT * FROM giveaways WHERE id = ?', id);
    const users = chooseWinners(await eligibleEntries(client, id, guildId), giveaway.winner_count);
    for (const userId of users) {
      await run(
        'INSERT INTO giveaway_winners (giveaway_id, user_id, round, selected_at) VALUES (?, ?, 1, ?)',
        id, userId, Date.now(),
      );
    }
    await run("UPDATE giveaways SET status = 'ended' WHERE id = ? AND status = 'ending'", id);
    const posted = await updatePost(client, { ...giveaway, status: 'ended' }, users);
    return { ended: true, posted, winners: users };
  } catch (err) {
    await run("UPDATE giveaways SET status = 'active' WHERE id = ? AND status = 'ending'", id);
    throw err;
  }
}

async function rerollGiveaway(client, id, guildId) {
  const claimed = await run(
    'UPDATE giveaways SET rerolling = 1 WHERE id = ? AND guild = ? AND status = ? AND rerolling = 0',
    id, guildId, 'ended',
  );
  if (!claimed.changes) return { rerolled: false };

  try {
    const giveaway = await get('SELECT * FROM giveaways WHERE id = ?', id);
    const candidates = await eligibleEntries(client, id, guildId);
    if (!candidates.length) return { rerolled: false, noCandidates: true };

    const [winner] = chooseWinners(candidates, 1);
    const round = await get('SELECT COALESCE(MAX(round), 0) + 1 AS nextRound FROM giveaway_winners WHERE giveaway_id = ?', id);
    await run(
      'INSERT INTO giveaway_winners (giveaway_id, user_id, round, selected_at) VALUES (?, ?, ?, ?)',
      id, winner, round.nextRound, Date.now(),
    );
    const winners = (await all(
      'SELECT user_id FROM giveaway_winners WHERE giveaway_id = ? ORDER BY round, selected_at',
      id,
    )).map((entry) => entry.user_id);
    const posted = await updatePost(client, giveaway, winners);
    return { rerolled: true, posted, winner };
  } finally {
    await run('UPDATE giveaways SET rerolling = 0 WHERE id = ?', id);
  }
}

async function refreshDue(client) {
  const scheduled = await all(
    "SELECT * FROM giveaways WHERE status = 'scheduled' AND starts_at <= ? ORDER BY starts_at LIMIT 50",
    Date.now(),
  );
  for (const giveaway of scheduled) await startScheduled(client, giveaway);

  const due = await all(
    "SELECT id, guild FROM giveaways WHERE status = 'active' AND ends_at <= ? ORDER BY ends_at LIMIT 50",
    Date.now(),
  );
  for (const giveaway of due) {
    try {
      await endGiveaway(client, giveaway.id, giveaway.guild);
    } catch (err) {
      console.error(`[giveaway #${giveaway.id}] automatic draw failed:`, err.message);
    }
  }
}

async function join(i, id) {
  await i.deferReply({ flags: 64 });
  const giveaway = await get('SELECT * FROM giveaways WHERE id = ? AND guild = ?', Number(id), i.guildId);
  if (!giveaway) return i.editReply(edit(notice('This giveaway no longer exists.', 'error')));
  if (giveaway.status !== 'active' || giveaway.starts_at > Date.now() || giveaway.ends_at <= Date.now()) {
    return i.editReply(edit(notice('This giveaway is not open for entries.', 'error')));
  }

  const existing = await get(
    'SELECT user_id FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?',
    giveaway.id, i.user.id,
  );
  if (existing) {
    await run('DELETE FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?', giveaway.id, i.user.id);
    const posted = await updatePost(i.client, giveaway);
    return i.editReply(edit(notice(
      posted ? 'You left the giveaway.' : 'You left the giveaway, but I could not refresh its message. Please tell staff.',
      posted ? 'info' : 'error',
    )));
  }

  if (!(await hasMemberRole(i.guild, i.user.id))) {
    return i.editReply({
      ...edit(notice(`You need the <@&${MEMBER_ROLE_ID}> role to enter this giveaway.`, 'error')),
      allowedMentions: mentionSafe,
    });
  }

  const inserted = await run(
    'INSERT IGNORE INTO giveaway_entries (giveaway_id, user_id, joined_at) VALUES (?, ?, ?)',
    giveaway.id, i.user.id, Date.now(),
  );
  const posted = await updatePost(i.client, giveaway);
  if (!posted) {
    return i.editReply(edit(notice('Your entry was saved, but I could not refresh the giveaway message. Please tell staff.', 'error')));
  }
  return i.editReply(edit(notice(
    inserted.changes ? 'You entered the giveaway! Click again to leave.' : 'You are already entered.',
    inserted.changes ? 'ok' : 'info',
  )));
}

const command = {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Create and manage giveaways')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName('create').setDescription('Create a giveaway')
      .addStringOption((o) => o.setName('prize').setDescription('What is being given away?').setRequired(true).setMaxLength(200))
      .addIntegerOption((o) => o.setName('hours').setDescription('How many hours entries stay open').setRequired(true).setMinValue(1).setMaxValue(MAX_HOURS))
      .addStringOption((o) => o.setName('description').setDescription('Short details about the giveaway').setMaxLength(300))
      .addIntegerOption((o) => o.setName('winners').setDescription('Number of winners (default 1)').setMinValue(1).setMaxValue(MAX_WINNERS))
      .addIntegerOption((o) => o.setName('starts_in').setDescription('Start after this many hours (default: now)').setMinValue(1).setMaxValue(MAX_HOURS)))
    .addSubcommand((s) => s.setName('list').setDescription('List active and scheduled giveaways'))
    .addSubcommand((s) => s.setName('end').setDescription('End a giveaway and draw its winners')
      .addIntegerOption((o) => o.setName('id').setDescription('Giveaway ID').setRequired(true)))
    .addSubcommand((s) => s.setName('reroll').setDescription('Draw a replacement winner')
      .addIntegerOption((o) => o.setName('id').setDescription('Giveaway ID').setRequired(true)))
    .addSubcommand((s) => s.setName('cancel').setDescription('Cancel a giveaway without drawing')
      .addIntegerOption((o) => o.setName('id').setDescription('Giveaway ID').setRequired(true)))
    .addSubcommand((s) => s.setName('edit').setDescription('Change the prize or remaining duration')
      .addIntegerOption((o) => o.setName('id').setDescription('Giveaway ID').setRequired(true))
      .addStringOption((o) => o.setName('prize').setDescription('New prize').setMaxLength(200))
      .addStringOption((o) => o.setName('description').setDescription('New short description (blank to clear)').setMaxLength(300))
      .addIntegerOption((o) => o.setName('hours').setDescription('New remaining hours (or duration if scheduled)').setMinValue(1).setMaxValue(MAX_HOURS))),

  async execute(i) {
    if (!(await isStaff(i.member))) return i.reply(notice('Staff only.', 'error'));
    const sub = i.options.getSubcommand();

    if (sub === 'create') {
      const channelId = await getSetting(i.guildId, 'channel_giveaways');
      if (!channelId) return i.reply(notice('Configure the giveaway channel first with `/config channel type:giveaways`.', 'error'));

      await i.deferReply({ flags: 64 });
      const startsAt = Date.now() + (i.options.getInteger('starts_in') ?? 0) * HOUR;
      const hours = i.options.getInteger('hours', true);
      const { lastInsertRowid } = await run(
        `INSERT INTO giveaways
          (guild, channel, prize, description, host, winner_count, eligibility, starts_at, ends_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'member', ?, ?, ?, ?)`,
        i.guildId, channelId, i.options.getString('prize', true).trim(), i.options.getString('description')?.trim() || null, i.user.id,
        i.options.getInteger('winners') ?? 1, startsAt, startsAt + hours * HOUR,
        startsAt > Date.now() ? 'scheduled' : 'active', Date.now(),
      );
      const giveaway = await get('SELECT * FROM giveaways WHERE id = ?', Number(lastInsertRowid));

      try {
        const channel = await i.client.channels.fetch(channelId);
        const sent = await channel.send({ ...renderGiveaway(giveaway, [], 0, channel.guild), allowedMentions: mentionSafe });
        await run('UPDATE giveaways SET message = ? WHERE id = ?', sent.id, giveaway.id);
        return i.editReply(edit(notice(`Giveaway #${giveaway.id} posted in <#${channelId}>.`, 'ok')));
      } catch (err) {
        await run('DELETE FROM giveaways WHERE id = ?', giveaway.id);
        console.error(`[giveaway #${giveaway.id}] could not be posted:`, err.message);
        return i.editReply(edit(notice('I could not post the giveaway in the configured channel.', 'error')));
      }
    }

    if (sub === 'list') {
      const giveaways = await all(
        "SELECT id, channel, message, prize, starts_at, ends_at, status, winner_count FROM giveaways WHERE guild = ? AND status IN ('active', 'scheduled') ORDER BY starts_at LIMIT 20",
        i.guildId,
      );
      const lines = giveaways.map((g) =>
        `• **#${g.id} · ${clip(g.prize, 80)}** · ${g.status === 'scheduled' ? `starts <t:${Math.floor(g.starts_at / 1000)}:R>` : `ends <t:${Math.floor(g.ends_at / 1000)}:R>`} · [open](https://discord.com/channels/${i.guildId}/${g.channel}/${g.message})`,
      );
      return i.reply(ephemeral(card({
        parts: [`**🎉 Giveaways**\n${lines.length ? lines.join('\n') : 'No active or scheduled giveaways.'}`],
      })));
    }

    const id = i.options.getInteger('id', true);
    const giveaway = await get('SELECT * FROM giveaways WHERE id = ? AND guild = ?', id, i.guildId);
    if (!giveaway) return i.reply(notice('No giveaway with that ID.', 'error'));

    if (sub === 'end') {
      await i.deferReply({ flags: 64 });
      let result;
      try {
        result = await endGiveaway(i.client, id, i.guildId);
      } catch (err) {
        console.error(`[giveaway #${id}] manual draw failed:`, err.message);
        return i.editReply(edit(notice('The draw failed. The giveaway remains open; please try again.', 'error')));
      }
      if (!result.ended) return i.editReply(edit(notice('This giveaway is not active.', 'error')));
      return i.editReply(edit(notice(
        result.posted ? `Giveaway #${id} ended.` : `Giveaway #${id} ended, but I could not update its message.`,
        result.posted ? 'ok' : 'error',
      )));
    }

    if (sub === 'reroll') {
      if (giveaway.status !== 'ended') return i.reply(notice('Only ended giveaways can be rerolled.', 'error'));
      await i.deferReply({ flags: 64 });
      let result;
      try {
        result = await rerollGiveaway(i.client, id, i.guildId);
      } catch (err) {
        console.error(`[giveaway #${id}] reroll failed:`, err.message);
        return i.editReply(edit(notice('The reroll failed. Please try again.', 'error')));
      }
      if (!result.rerolled) {
        return i.editReply(edit(notice(result.noCandidates ? 'There are no remaining eligible entrants to reroll.' : 'A reroll is already in progress.', 'error')));
      }
      return i.editReply(edit(notice(
        result.posted ? `Replacement winner: <@${result.winner}>.` : `Replacement winner: <@${result.winner}>. I could not update the giveaway message.`,
        result.posted ? 'ok' : 'error',
      )));
    }

    if (sub === 'cancel') {
      if (!['active', 'scheduled'].includes(giveaway.status)) {
        return i.reply(notice('Only active or scheduled giveaways can be cancelled.', 'error'));
      }
      const cancelled = { ...giveaway, status: 'cancelled' };
      const result = await run(
        "UPDATE giveaways SET status = 'cancelled' WHERE id = ? AND guild = ? AND status IN ('active', 'scheduled')",
        id, i.guildId,
      );
      if (!result.changes) return i.reply(notice('This giveaway is already being processed.', 'error'));
      const posted = await updatePost(i.client, cancelled);
      return i.reply(notice(
        posted ? `Giveaway #${id} cancelled.` : `Giveaway #${id} cancelled, but I could not update its message.`,
        posted ? 'ok' : 'error',
      ));
    }

    const prize = i.options.getString('prize')?.trim();
    const description = i.options.getString('description');
    const hours = i.options.getInteger('hours');
    if (!prize && description === null && !hours) {
      return i.reply(notice('Provide a new prize, description, or duration.', 'error'));
    }
    if (!['active', 'scheduled'].includes(giveaway.status)) {
      return i.reply(notice('Only active or scheduled giveaways can be edited.', 'error'));
    }

    const nextPrize = prize || giveaway.prize;
    const nextDescription = description === null ? giveaway.description : description.trim() || null;
    const nextEndsAt = hours
      ? (giveaway.status === 'scheduled' ? giveaway.starts_at : Date.now()) + hours * HOUR
      : giveaway.ends_at;
    if (nextEndsAt <= Date.now()) return i.reply(notice('The new end time must be in the future.', 'error'));
    await run(
      'UPDATE giveaways SET prize = ?, description = ?, ends_at = ? WHERE id = ? AND guild = ? AND status IN (?, ?)',
      nextPrize, nextDescription, nextEndsAt, id, i.guildId, 'active', 'scheduled',
    );
    const updated = { ...giveaway, prize: nextPrize, description: nextDescription, ends_at: nextEndsAt };
    const posted = await updatePost(i.client, updated);
    return i.reply(notice(
      posted ? `Giveaway #${id} updated.` : `Giveaway #${id} updated, but I could not refresh its message.`,
      posted ? 'ok' : 'error',
    ));
  },
};

async function participants(i, id, requestedPage) {
  const giveawayId = Number(id);
  const pageNumber = requestedPage === undefined ? 0 : Number(requestedPage);
  if (!Number.isSafeInteger(giveawayId) || giveawayId <= 0 ||
      !Number.isSafeInteger(pageNumber) || pageNumber < 0) {
    return i.reply(notice('Invalid giveaway or participant page.', 'error'));
  }
  if (requestedPage === undefined) await i.deferReply({ flags: 64 });
  else await i.deferUpdate();

  const giveaway = await get('SELECT * FROM giveaways WHERE id = ? AND guild = ?', giveawayId, i.guildId);
  if (!giveaway) return i.editReply(edit(notice('This giveaway no longer exists.', 'error')));

  const { count } = await get(
    `SELECT COUNT(*) AS count FROM giveaway_entries e
     WHERE e.giveaway_id = ?`,
    giveawayId,
  );
  const pages = Math.max(1, Math.ceil(count / PARTICIPANTS_PER_PAGE));
  const page = Math.min(pageNumber, pages - 1);
  const offset = page * PARTICIPANTS_PER_PAGE;
  const entries = await all(
    `SELECT e.user_id FROM giveaway_entries e
     WHERE e.giveaway_id = ?
     ORDER BY e.joined_at, e.user_id LIMIT ? OFFSET ?`,
    giveawayId, PARTICIPANTS_PER_PAGE, offset,
  );
  const payload = card({
    parts: [
      `## Participants\n**${clip(giveaway.prize, 200)}** · Giveaway #${giveaway.id}`,
      entries.length
        ? entries.map((entry, index) => `${offset + index + 1}. <@${entry.user_id}>`).join('\n')
        : 'No participants yet.',
      `-# ${count} participants · Page ${page + 1} of ${pages}`,
      pages > 1 ? row(
        new ButtonBuilder().setCustomId(`gw:participants:${giveawayId}:${Math.max(0, page - 1)}`)
          .setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId(`gw:participants:${giveawayId}:${page + 1}`)
          .setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page === pages - 1),
      ) : null,
    ],
  });
  return i.editReply({ ...edit(payload), allowedMentions: mentionSafe });
}

async function button(i, [action, id, page]) {
  if (action === 'join') return join(i, id);
  if (action === 'participants') return participants(i, id, page);
}

function onReady(client) {
  void (async () => {
    await run(
      `DELETE w FROM giveaway_winners w
       INNER JOIN giveaways g ON g.id = w.giveaway_id
       WHERE g.status = 'ending'`,
    );
    await run("UPDATE giveaways SET status = 'active' WHERE status = 'ending'");
    await run("UPDATE giveaways SET status = 'scheduled' WHERE status = 'starting'");
    await run('UPDATE giveaways SET rerolling = 0 WHERE rerolling = 1');
    await refreshDue(client);
  })().catch((err) => console.error('[giveaway] startup recovery failed:', err.message));

  setInterval(() => {
    refreshDue(client).catch((err) => console.error('[giveaway] scheduler failed:', err.message));
  }, 15_000).unref();
}

export default { commands: [command], handlers: { gw: button }, onReady };
