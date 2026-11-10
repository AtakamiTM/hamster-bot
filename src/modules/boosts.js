import {
  Events, InteractionContextType, MessageType, PermissionFlagsBits, SlashCommandBuilder,
} from 'discord.js';
import { getSetting } from '../db.js';
import { SEP, card, farmEmoji, mentionSafe, notice, row, translateButton } from '../ui.js';

const BOOST_TYPES = new Set([
  MessageType.GuildBoost,
  MessageType.GuildBoostTier1,
  MessageType.GuildBoostTier2,
  MessageType.GuildBoostTier3,
]);

async function sendBoostNotice(guild, booster, fallbackChannel) {
  const channelId = await getSetting(guild.id, 'channel_boosts');
  const channel = channelId ? await guild.channels.fetch(channelId).catch(() => null) : fallbackChannel;
  if (!channel) return null;

  const tier = guild.premiumTier;
  const boosts = guild.premiumSubscriptionCount ?? 0;

  return channel.send({
    ...card({
      banner: 'boost',
      parts: [
        `## ${farmEmoji(guild, 'heart')} A little extra sparkle\n${booster} just boosted **${guild.name}**.\nThank you for helping our community grow!`,
        SEP,
        `**${boosts}** boosts · **Level ${tier}**\n-# Your support unlocks perks for the whole community.`,
        row(translateButton()),
      ],
    }),
    allowedMentions: { ...mentionSafe, users: [booster.id] },
  });
}

async function onMessage(message) {
  if (!message.inGuild() || !BOOST_TYPES.has(message.type)) return;
  await sendBoostNotice(message.guild, message.author, message.channel);
}

const command = {
  data: new SlashCommandBuilder()
    .setName('boosttest')
    .setDescription('Send a fake boost notification to test the boosts channel (admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  async execute(i) {
    const sent = await sendBoostNotice(i.guild, i.user, i.channel);
    if (!sent) return i.reply(notice('I could not find a channel to post in. Set one with `/config channel type:boosts`.', 'error'));
    return i.reply(notice(`Test notification sent: ${sent.url}`, 'ok'));
  },
};

function register(client) {
  client.on(Events.MessageCreate, (m) => onMessage(m).catch((e) => console.error('[boosts]', e.message)));
}

export default { commands: [command], register };
