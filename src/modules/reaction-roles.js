import {
  ChannelType, Events, InteractionContextType, PermissionFlagsBits, RESTJSONErrorCodes, SlashCommandBuilder,
} from 'discord.js';
import { all, get, run } from '../db.js';
import { card, edit, farmEmoji, mentionSafe, notice, row, translateButton } from '../ui.js';

const MAX_OPTIONS = 20;
const updates = new Map();
const segments = new Intl.Segmenter('en', { granularity: 'grapheme' });

export function resolveReactionEmoji(value, guild) {
  const input = value.trim();
  const custom = input.match(/^<a?:\w+:(\d+)>$/);
  if (custom || /^\d+$/.test(input)) {
    const emoji = guild.emojis.cache.get(custom?.[1] ?? input);
    if (!emoji || emoji.available === false) throw new Error('Choose an available custom emoji from this server.');
    return { key: emoji.id, emoji: emoji.toString() };
  }
  if ([...segments.segment(input)].length !== 1 ||
      !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(input)) {
    throw new Error('Provide one emoji, such as 🇵🇱, or a custom emoji from this server.');
  }
  return { key: input.replace(/\ufe0f/g, ''), emoji: input };
}

function roleProblem(role, guild, actor) {
  if (!role || role.id === guild.id || role.managed) return 'Choose a normal server role, not @everyone or a managed role.';
  if (!guild.members.me.permissions.has(PermissionFlagsBits.ManageRoles) || !role.editable) {
    return 'I need Manage Roles and my highest role must be above the selected role.';
  }
  if (actor && actor.id !== guild.ownerId && actor.roles.highest.comparePositionTo(role) <= 0) {
    return 'Your highest role must be above the selected role.';
  }
  return null;
}

export function renderReactionRoles(panel, guild) {
  const options = JSON.parse(panel.options);
  const sections = [
    `## ${farmEmoji(guild, 'sprout')} ${panel.title}`,
    panel.description,
    options.length ? options.map((option) => `${option.emoji} **${option.label}**`).join('\n') : '*No roles added yet.*',
    '-# React below to get a role. Remove your reaction to remove it. You can choose multiple roles.',
  ];
  if (sections.join('\n\n').length > 3900) {
    throw new RangeError('This panel is too long. Shorten its labels or use fewer reaction roles.');
  }
  return card({
    parts: [
      ...sections,
      row(translateButton()),
    ],
  });
}

const command = {
  data: new SlashCommandBuilder()
    .setName('reaction-role')
    .setDescription('Create and configure reaction-role panels')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageRoles)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName('create').setDescription('Create a draft panel')
      .addStringOption((o) => o.setName('title').setDescription('Panel heading').setRequired(true).setMaxLength(100))
      .addStringOption((o) => o.setName('description').setDescription('Panel text, e.g. choose your languages').setRequired(true).setMaxLength(1000)))
    .addSubcommand((s) => s.setName('add').setDescription('Add an emoji and role to a draft')
      .addIntegerOption((o) => o.setName('id').setDescription('Panel ID').setRequired(true).setMinValue(1))
      .addStringOption((o) => o.setName('emoji').setDescription('One Unicode or server emoji').setRequired(true).setMaxLength(100))
      .addRoleOption((o) => o.setName('role').setDescription('Role to assign').setRequired(true))
      .addStringOption((o) => o.setName('label').setDescription('Display label, e.g. Polski').setMaxLength(80)))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove an emoji from a draft')
      .addIntegerOption((o) => o.setName('id').setDescription('Panel ID').setRequired(true).setMinValue(1))
      .addStringOption((o) => o.setName('emoji').setDescription('Emoji to remove').setRequired(true)))
    .addSubcommand((s) => s.setName('post').setDescription('Publish a draft panel')
      .addIntegerOption((o) => o.setName('id').setDescription('Panel ID').setRequired(true).setMinValue(1))
      .addChannelOption((o) => o.setName('channel').setDescription('Destination (default: here)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand((s) => s.setName('list').setDescription('List panel IDs'))
    .addSubcommand((s) => s.setName('delete').setDescription('Delete a panel and its message; keep assigned roles')
      .addIntegerOption((o) => o.setName('id').setDescription('Panel ID').setRequired(true).setMinValue(1))),

  async execute(i) {
    if (!i.member.permissions.has(PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageRoles)) {
      return i.reply(notice('You need Manage Server and Manage Roles to configure reaction roles.', 'error'));
    }
    await i.deferReply({ flags: 64 });
    const sub = i.options.getSubcommand();
    const respond = (text, kind = 'ok') => i.editReply(edit(notice(text, kind)));
    if (sub === 'create') {
      const title = i.options.getString('title', true).trim();
      const description = i.options.getString('description', true).trim();
      if (!title || !description) return respond('Title and description cannot be blank.', 'error');
      const result = await run(
        'INSERT INTO reaction_role_panels (guild, title, description, options) VALUES (?, ?, ?, ?)',
        i.guildId, title, description, '[]',
      );
      return respond(`Draft **#${result.lastInsertRowid}** created. Use \`/reaction-role add\`, then \`/reaction-role post\`.`);
    }
    if (sub === 'list') {
      const panels = await all('SELECT * FROM reaction_role_panels WHERE guild = ? ORDER BY id DESC LIMIT 20', i.guildId);
      return respond(panels.length ? panels.map((panel) =>
        `**#${panel.id}** ${panel.title} · ${panel.message ? `[Published](https://discord.com/channels/${panel.guild}/${panel.channel}/${panel.message})` : 'Draft'}`,
      ).join('\n') : 'No reaction-role panels yet.', 'info');
    }
    const id = i.options.getInteger('id', true);
    const panel = await get('SELECT * FROM reaction_role_panels WHERE id = ? AND guild = ?', id, i.guildId);
    if (!panel) return respond('No panel with that ID on this server.', 'error');
    const options = JSON.parse(panel.options);
    if (sub === 'delete') {
      if (panel.message) {
        try {
          const channel = await i.guild.channels.fetch(panel.channel);
          const message = await channel.messages.fetch({ message: panel.message, force: true });
          await message.delete();
        } catch (err) {
          if (![RESTJSONErrorCodes.UnknownMessage, RESTJSONErrorCodes.UnknownChannel].includes(err.code)) throw err;
        }
      }
      await run('DELETE FROM reaction_role_panels WHERE id = ? AND guild = ?', id, i.guildId);
      return respond('Panel deleted. Previously assigned roles were kept.');
    }
    if (panel.message) return respond('This panel is already published. Create a new draft to change its mappings.', 'error');
    if (sub === 'add' || sub === 'remove') {
      let emoji;
      try {
        emoji = resolveReactionEmoji(i.options.getString('emoji', true), i.guild);
      } catch (err) {
        return respond(err.message, 'error');
      }
      const next = options.filter((option) => option.key !== emoji.key);
      if (sub === 'add') {
        const role = i.options.getRole('role', true);
        const problem = roleProblem(role, i.guild, i.member);
        if (problem) return respond(problem, 'error');
        if (options.some((option) => option.role === role.id && option.key !== emoji.key)) {
          return respond('Each role can appear only once in a panel.', 'error');
        }
        const label = (i.options.getString('label') ?? role.name).trim();
        if (!label) return respond('The display label cannot be blank.', 'error');
        next.push({ ...emoji, role: role.id, label });
        if (next.length > MAX_OPTIONS) return respond('A panel can have at most 20 reactions.', 'error');
      } else if (next.length === options.length) {
        return respond('That emoji is not configured in this panel.', 'error');
      }
      try {
        renderReactionRoles({ ...panel, options: JSON.stringify(next) }, i.guild);
      } catch (err) {
        if (err instanceof RangeError) return respond(err.message, 'error');
        throw err;
      }
      const result = await run(
        'UPDATE reaction_role_panels SET options = ? WHERE id = ? AND guild = ? AND message IS NULL AND options = ?',
        JSON.stringify(next), id, i.guildId, panel.options,
      );
      if (!result.changes) return respond('The panel changed meanwhile. Please try again.', 'error');
      return respond(`Draft **#${id}** updated. It now has **${next.length}** reaction roles.`);
    }
    if (!options.length) return respond('Add at least one emoji and role before publishing.', 'error');
    for (const option of options) {
      const role = await i.guild.roles.fetch(option.role);
      const problem = roleProblem(role, i.guild, i.member);
      if (problem) return respond(problem, 'error');
    }
    const channel = i.options.getChannel('channel') ?? i.channel;
    const permissions = channel.permissionsFor(i.guild.members.me);
    if (!permissions?.has([
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AddReactions,
    ])) return respond('I need View Channel, Send Messages, Read Message History and Add Reactions there.', 'error');
    const sent = await channel.send({ ...renderReactionRoles(panel, i.guild), allowedMentions: mentionSafe });
    try {
      const result = await run(
        'UPDATE reaction_role_panels SET channel = ?, message = ? WHERE id = ? AND guild = ? AND message IS NULL AND options = ?',
        channel.id, sent.id, id, i.guildId, panel.options,
      );
      if (!result.changes) throw new Error('Panel changed or was published meanwhile. Please try again.');
      for (const option of options) await sent.react(option.emoji);
    } catch (err) {
      await run('UPDATE reaction_role_panels SET channel = NULL, message = NULL WHERE id = ? AND message = ?', id, sent.id);
      try {
        await sent.delete();
      } catch (cleanupError) {
        console.error('[reaction-role] could not remove failed publication:', cleanupError);
      }
      throw err;
    }
    return respond(`Panel published: ${sent.url}`);
  },
};

async function applyReaction(reaction, user, added) {
  const panel = await get(
    'SELECT * FROM reaction_role_panels WHERE message = ? AND guild = ?',
    reaction.message.id, reaction.message.guildId,
  );
  if (!panel) return;
  const key = reaction.emoji.id ?? reaction.emoji.name?.replace(/\ufe0f/g, '');
  const option = JSON.parse(panel.options).find((item) => item.key === key);
  if (!option) return;
  const guild = reaction.message.guild ?? await reaction.client.guilds.fetch(panel.guild);
  const role = await guild.roles.fetch(option.role);
  const problem = roleProblem(role, guild);
  if (problem) throw new Error(`Panel #${panel.id}: ${problem}`);
  let member;
  try {
    member = await guild.members.fetch({ user: user.id, force: true });
  } catch (err) {
    if (err.code === RESTJSONErrorCodes.UnknownMember) return;
    throw err;
  }
  if (added) await member.roles.add(role.id, `Reaction-role panel #${panel.id}`);
  else await member.roles.remove(role.id, `Reaction-role panel #${panel.id}`);
}

export function handleReaction(reaction, user, added) {
  if (user.bot || !reaction.message.guildId) return Promise.resolve();
  const key = `${reaction.message.id}:${user.id}`;
  const previous = updates.get(key) ?? Promise.resolve();
  const next = previous.then(() => applyReaction(reaction, user, added), () => applyReaction(reaction, user, added));
  updates.set(key, next);
  return next.finally(() => {
    if (updates.get(key) === next) updates.delete(key);
  });
}

function register(client) {
  client.on(Events.MessageReactionAdd, (reaction, user) => {
    handleReaction(reaction, user, true).catch((err) => console.error('[reaction-role] could not assign role:', err));
  });
  client.on(Events.MessageReactionRemove, (reaction, user) => {
    handleReaction(reaction, user, false).catch((err) => console.error('[reaction-role] could not remove role:', err));
  });
}

export default { commands: [command], register };
