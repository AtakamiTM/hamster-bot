import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { all, get, getSetting, run, setSetting } from '../db.js';
import { COLORS, SEP, bar, card, clip, edit, notice, row, translateButton } from '../ui.js';

const EMOJI = '🎉';
const timers = new Map();
const busy = new Set();

const goalFor = async (guildId) => {
  const base = Number(await getSetting(guildId, 'codes_goal', 25));
  const step = Number(await getSetting(guildId, 'codes_step', 10));
  const done = (await get("SELECT COUNT(*) AS n FROM codes WHERE guild = ? AND status IN ('revealed', 'expired')", guildId)).n;
  return base + step * done;
};

function lockedCard(code, count) {
  const shown = Math.min(count, code.goal);
  return card({
    banner: 'codes',
    color: COLORS.brand,
    parts: [
      '## A little reward is growing\nReact with 🎉 to help the community unlock the next in-game code.',
      SEP,
      `**Community progress**\n${bar(shown / code.goal)}\n**${shown} / ${code.goal}** reactions`,
      `-# Unlocks automatically when the goal is reached. One reaction per person, alt accounts do not count.`,
      row(translateButton()),
    ],
  });
}

function unlockedCard(code) {
  return card({
    banner: 'codes',
    color: COLORS.green,
    parts: [
      `## Ready to harvest 🎉\nYou reached **${code.goal}** reactions together. Find your code below.`,
      `**Community progress**\n${bar(1)}\n**${code.goal} / ${code.goal}** reactions`,
    ],
  });
}

function revealCard(code, pingRole) {
  const expired = code.status === 'expired';
  return card({
    banner: 'codes',
    color: expired ? COLORS.gray : COLORS.green,
    parts: [
      !expired && pingRole ? `<@&${pingRole}>` : null,
      expired ? '## This code has expired' : '## Your reward is here 🎁',
      `${expired ? '~~' : ''}\`${code.code}\`${expired ? '~~' : ''}`,
      SEP,
      [
        code.reward ? `**Reward** · ${code.reward}` : null,
        `**Available to** · ${expired ? 'no longer available' : `the first **${code.uses}** players`}`,
        '',
        '-# Redeem it in-game from the Codes menu. Codes are case-sensitive and may expire without notice.',
      ].filter((l) => l !== null).join('\n'),
      row(translateButton()),
    ],
  });
}

async function fetchMessage(client, channelId, messageId) {
  try {
    const channel = await client.channels.fetch(channelId);
    return await channel.messages.fetch({ message: messageId, force: true });
  } catch {
    return null;
  }
}

const ensuring = new Set();

export async function ensureLocked(client, guildId) {
  if (ensuring.has(guildId)) return;
  ensuring.add(guildId);
  try {
    await ensureLockedInner(client, guildId);
  } finally {
    ensuring.delete(guildId);
  }
}

async function ensureLockedInner(client, guildId) {
  if (await get("SELECT id FROM codes WHERE guild = ? AND status = 'locked'", guildId)) return;
  const next = await get("SELECT * FROM codes WHERE guild = ? AND status = 'queued' ORDER BY id LIMIT 1", guildId);
  if (!next) return;
  const channelId = await getSetting(guildId, 'channel_codes');
  if (!channelId) return;

  try {
    const channel = await client.channels.fetch(channelId);
    const goal = await goalFor(guildId);
    const draft = { ...next, goal };
    const sent = await channel.send({ ...lockedCard(draft, 0), allowedMentions: { parse: [] } });
    await sent.react(EMOJI).catch(() => {});
    await run("UPDATE codes SET status = 'locked', goal = ?, channel = ?, message = ?, progress = 0 WHERE id = ?", goal, channelId, sent.id, next.id);
  } catch (err) {
    console.error('[codes] could not post locked message:', err.message);
  }
}

async function reveal(client, code) {
  const pingRole = await getSetting(code.guild, 'role_ping');
  try {
    const channel = await client.channels.fetch(code.channel);
    await run("UPDATE codes SET status = 'revealed' WHERE id = ?", code.id);
    const fresh = await get('SELECT * FROM codes WHERE id = ?', code.id);
    const sent = await channel.send({
      ...revealCard(fresh, pingRole),
      allowedMentions: pingRole ? { roles: [pingRole] } : { parse: [] },
    });
    await run('UPDATE codes SET reveal_message = ? WHERE id = ?', sent.id, code.id);
    const locked = await fetchMessage(client, code.channel, code.message);
    await locked?.edit(edit(unlockedCard(fresh))).catch(() => {});
  } catch (err) {
    console.error('[codes] reveal failed:', err.message);
    await run("UPDATE codes SET status = 'locked' WHERE id = ?", code.id);
    return;
  }
  await ensureLocked(client, code.guild);
}

async function refresh(client, id) {
  if (busy.has(id)) return;
  busy.add(id);
  try {
    const code = await get("SELECT * FROM codes WHERE id = ? AND status = 'locked'", id);
    if (!code) return;
    const message = await fetchMessage(client, code.channel, code.message);
    if (!message) return;
    const reaction = message.reactions.cache.get(EMOJI);
    const count = reaction ? Math.max(0, reaction.count - (reaction.me ? 1 : 0)) : 0;

    if (count >= code.goal) return await reveal(client, code);
    if (count !== code.progress) {
      await run('UPDATE codes SET progress = ? WHERE id = ?', count, id);
      await message.edit(edit(lockedCard(code, count)));
    }
  } catch (err) {
    console.error('[codes] refresh failed:', err.message);
  } finally {
    busy.delete(id);
  }
}

async function onReaction(client, reaction) {
  if (reaction.emoji.name !== EMOJI) return;
  const code = await get("SELECT id FROM codes WHERE message = ? AND status = 'locked'", reaction.message.id);
  if (!code) return;
  clearTimeout(timers.get(code.id));
  timers.set(code.id, setTimeout(() => { timers.delete(code.id); refresh(client, code.id); }, 1500));
}

async function onReady(client) {
  for (const { id } of await all("SELECT id FROM codes WHERE status = 'locked'")) await refresh(client, id);
  for (const guild of client.guilds.cache.values()) await ensureLocked(client, guild.id);
}

function register(client) {
  const handler = (reaction) => onReaction(client, reaction).catch((e) => console.error('[codes]', e.message));
  client.on('messageReactionAdd', handler);
  client.on('messageReactionRemove', handler);
}

const command = {
  data: new SlashCommandBuilder()
    .setName('code')
    .setDescription('Manage in-game codes')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s.setName('add').setDescription('Queue a new code')
        .addStringOption((o) => o.setName('code').setDescription('The code').setRequired(true).setMaxLength(60))
        .addIntegerOption((o) => o.setName('uses').setDescription('How many players can redeem it').setRequired(true).setMinValue(1).setMaxValue(10_000_000))
        .addStringOption((o) => o.setName('reward').setDescription('Reward, e.g. 500 Coins').setMaxLength(100)))
    .addSubcommand((s) => s.setName('list').setDescription('List codes and their status'))
    .addSubcommand((s) =>
      s.setName('uses').setDescription('Change the number of uses of a code')
        .addIntegerOption((o) => o.setName('id').setDescription('Code ID').setRequired(true))
        .addIntegerOption((o) => o.setName('uses').setDescription('New number of uses').setRequired(true).setMinValue(1)))
    .addSubcommand((s) =>
      s.setName('expire').setDescription('Mark a revealed code as expired')
        .addIntegerOption((o) => o.setName('id').setDescription('Code ID').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Delete a queued or locked code')
        .addIntegerOption((o) => o.setName('id').setDescription('Code ID').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('goal').setDescription('Set the reaction goal: base + step for every code already unlocked')
        .addIntegerOption((o) => o.setName('base').setDescription('Reactions needed for the next code').setRequired(true).setMinValue(1).setMaxValue(100000))
        .addIntegerOption((o) => o.setName('step').setDescription('Extra reactions added after each unlocked code').setMinValue(0).setMaxValue(100000))),

  async execute(i) {
    const sub = i.options.getSubcommand();
    const guildId = i.guildId;

    if (sub === 'add') {
      if (!(await getSetting(guildId, 'channel_codes'))) {
        return i.reply(notice('Set the codes channel first: `/config channel type:codes`.', 'error'));
      }
      await i.deferReply({ flags: 64 });
      const { lastInsertRowid } = await run(
        'INSERT INTO codes (guild, code, uses, reward, created_by) VALUES (?, ?, ?, ?, ?)',
        guildId, i.options.getString('code', true).trim(), i.options.getInteger('uses', true),
        i.options.getString('reward'), i.user.id,
      );
      await ensureLocked(i.client, guildId);
      return i.editReply(edit(notice(`Code #${lastInsertRowid} queued. It will be posted as soon as the community unlocks it.`, 'ok')));
    }

    if (sub === 'list') {
      const rows = await all("SELECT * FROM codes WHERE guild = ? ORDER BY id DESC LIMIT 20", guildId);
      const icon = { queued: '🕒', locked: '🔒', revealed: '🔓', expired: '⌛' };
      return i.reply(notice(
        rows.length
          ? rows.map((c) => `${icon[c.status]} \`${c.id}\` **${clip(c.code, 30)}** · ${c.uses} uses · ${c.status}${c.status === 'locked' ? ` (${c.progress}/${c.goal})` : ''}`).join('\n')
          : 'No codes yet. Add one with `/code add`.',
        'info',
      ));
    }

    if (sub === 'goal') {
      await setSetting(guildId, 'codes_goal', i.options.getInteger('base', true));
      const step = i.options.getInteger('step');
      if (step !== null) await setSetting(guildId, 'codes_step', step);
      return i.reply(notice(`Goal for the next lock is now **${i.options.getInteger('base')}** reactions${step !== null ? `, +${step} after each unlocked code` : ''}. The current locked message keeps its goal.`, 'ok'));
    }

    const id = i.options.getInteger('id', true);
    const code = await get('SELECT * FROM codes WHERE id = ? AND guild = ?', id, guildId);
    if (!code) return i.reply(notice('No code with that ID.', 'error'));

    if (sub === 'remove') {
      if (code.status === 'revealed' || code.status === 'expired') {
        return i.reply(notice('That code was already revealed. Use `/code expire` instead.', 'error'));
      }
      await run('DELETE FROM codes WHERE id = ?', id);
      if (code.status === 'locked') {
        const msg = await fetchMessage(i.client, code.channel, code.message);
        await msg?.delete().catch(() => {});
        await ensureLocked(i.client, guildId);
      }
      return i.reply(notice(`Code #${id} removed.`, 'ok'));
    }

    // uses / expire edit the public message
    if (sub === 'uses') await run('UPDATE codes SET uses = ? WHERE id = ?', i.options.getInteger('uses', true), id);
    if (sub === 'expire') await run("UPDATE codes SET status = 'expired' WHERE id = ? AND status = 'revealed'", id);
    const fresh = await get('SELECT * FROM codes WHERE id = ?', id);
    if (sub === 'expire' && fresh.status !== 'expired') return i.reply(notice('Only revealed codes can expire.', 'error'));
    if (fresh.reveal_message) {
      const msg = await fetchMessage(i.client, fresh.channel, fresh.reveal_message);
      await msg?.edit(edit(revealCard(fresh, null))).catch(() => {});
    }
    return i.reply(notice(sub === 'uses' ? `Code #${id} now has **${fresh.uses}** uses.` : `Code #${id} marked as expired.`, 'ok'));
  },
};

export default { commands: [command], register, onReady };
