import { ChannelType, InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { getSetting, setSetting } from '../db.js';
import { notice } from '../ui.js';

export const CHANNELS = [
  ['suggestions', 'Suggestions (typed text becomes a vote)'],
  ['bugs', 'Bug reports'],
  ['screenshots', 'Screenshots showcase'],
  ['clips', 'Clips showcase'],
  ['fanarts', 'Fan-arts showcase'],
  ['codes', 'Game codes'],
  ['notifications', 'New content notifications'],
  ['surveys', 'Default survey channel'],
  ['giveaways', 'Giveaway announcements'],
  ['boosts', 'Server boost notifications'],
];

export const ROLES = [
  ['verified', 'Role given after Roblox verification'],
  ['staff', 'Staff role (bug reports, suggestions, surveys, giveaways)'],
  ['content', 'Role allowed to use /content'],
  ['ping', 'Role pinged for new content and codes'],
];

const choices = (list) => list.map(([value, name]) => ({ name: `${value} - ${name}`.slice(0, 100), value }));

const command = {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configure the bot for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s.setName('channel').setDescription('Set (or clear) a feature channel')
        .addStringOption((o) => o.setName('type').setDescription('Feature').setRequired(true).addChoices(...choices(CHANNELS)))
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Channel (omit to clear)')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand((s) =>
      s.setName('role').setDescription('Set (or clear) a role')
        .addStringOption((o) => o.setName('type').setDescription('Purpose').setRequired(true).addChoices(...choices(ROLES)))
        .addRoleOption((o) => o.setName('role').setDescription('Role (omit to clear)')))
    .addSubcommand((s) => s.setName('show').setDescription('Show the current configuration')),

  async execute(i) {
    const sub = i.options.getSubcommand();

    if (sub === 'show') {
      const line = async (prefix, key, label, fmt) => {
        const v = await getSetting(i.guildId, `${prefix}_${key}`);
        return `${label}: ${v ? fmt(v) : '*not set*'}`;
      };
      const text = [
        '**Channels**',
        ...await Promise.all(CHANNELS.map(([k]) => line('channel', k, `• \`${k}\``, (v) => `<#${v}>`))),
        '',
        '**Roles**',
        ...await Promise.all(ROLES.map(([k]) => line('role', k, `• \`${k}\``, (v) => `<@&${v}>`))),
      ].join('\n');
      return i.reply(notice(text, 'info'));
    }

    const type = i.options.getString('type', true);
    if (sub === 'channel') {
      const ch = i.options.getChannel('channel');
      await setSetting(i.guildId, `channel_${type}`, ch?.id ?? null);
      return i.reply(notice(ch ? `\`${type}\` channel set to ${ch}.` : `\`${type}\` channel cleared.`, 'ok'));
    }
    const role = i.options.getRole('role');
    await setSetting(i.guildId, `role_${type}`, role?.id ?? null);
    return i.reply(notice(role ? `\`${type}\` role set to ${role}.` : `\`${type}\` role cleared.`, 'ok'));
  },
};

export default { commands: [command] };
