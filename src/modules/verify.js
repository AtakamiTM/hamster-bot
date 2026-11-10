import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, InteractionContextType, ModalBuilder,
  PermissionFlagsBits, SectionBuilder, SlashCommandBuilder, TextDisplayBuilder, TextInputBuilder,
  TextInputStyle, ThumbnailBuilder,
} from 'discord.js';
import { get, getSetting, run } from '../db.js';
import { COLORS, SEP, card, edit, ephemeral, farmEmoji, isStaff, notice, row, translateButton, uiHeading } from '../ui.js';
import { findUser, getHeadshot, getProfile, isValidUsername } from '../roblox.js';

const WORDS = [
  'apple', 'river', 'sunny', 'acorn', 'maple', 'cloud', 'seed', 'meadow', 'barley', 'honey',
  'pebble', 'clover', 'walnut', 'sprout', 'amber', 'willow', 'pumpkin', 'cheddar', 'hazel', 'poppy',
];
const pick = () => WORDS[Math.floor(Math.random() * WORDS.length)];
const makeCode = () => `hamster ${pick()} ${pick()} ${pick()}`;
const PENDING_MS = 15 * 60 * 1000;

async function grantRole(member) {
  const roleId = await getSetting(member.guild.id, 'role_verified');
  if (!roleId) return 'no-role';
  try {
    await member.roles.add(roleId, 'Roblox verification');
    return 'ok';
  } catch {
    return 'failed';
  }
}

async function start(i) {
  const linked = await get('SELECT * FROM roblox_links WHERE discord_id = ?', i.user.id);
  if (linked) {
    await grantRole(i.member);
    return i.reply(notice(`You are already verified as **${linked.roblox_name}**. Your role has been re-applied if it was missing.`, 'ok'));
  }
  if (!(await getSetting(i.guildId, 'role_verified'))) {
    return i.reply(notice('Verification is not configured yet. Please tell an admin to run `/config role type:verified`.', 'error'));
  }
  const modal = new ModalBuilder()
    .setCustomId('verify:modal')
    .setTitle('Roblox verification')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('username')
          .setLabel('Your Roblox username')
          .setStyle(TextInputStyle.Short)
          .setMinLength(3)
          .setMaxLength(20)
          .setPlaceholder('e.g. Builderman')
          .setRequired(true),
      ),
    );
  return i.showModal(modal);
}

async function modal(i) {
  const username = i.fields.getTextInputValue('username').trim();
  if (!isValidUsername(username)) {
    return i.reply(notice('That does not look like a valid Roblox username (3-20 letters, numbers or underscores).', 'error'));
  }
  await i.deferReply({ flags: 64 });

  let user;
  try {
    user = await findUser(username);
  } catch {
    return i.editReply(edit(notice('Roblox is not responding right now. Please try again in a moment.', 'error')));
  }
  if (!user) return i.editReply(edit(notice(`I could not find a Roblox user named **${username}**.`, 'error')));

  const taken = await get('SELECT discord_id FROM roblox_links WHERE roblox_id = ?', user.id);
  if (taken) {
    return i.editReply(edit(notice('That Roblox account is already linked to another Discord user. Contact staff if this is a mistake.', 'error')));
  }

  const code = makeCode();
  await run(
    'REPLACE INTO roblox_pending (discord_id, roblox_id, roblox_name, code, expires) VALUES (?, ?, ?, ?, ?)',
    i.user.id, user.id, user.name, code, Date.now() + PENDING_MS,
  );

  const avatar = await getHeadshot(user.id);
  return i.editReply(edit(renderVerification(user, code, avatar, i.guild)));
}

export function renderVerification(user, code, avatar, guild) {
  const intro = `${uiHeading(`${farmEmoji(guild, 'sprout')} One last step`)}\nLet’s confirm that **@${user.name}** belongs to you.`;
  const head = avatar
    ? new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(intro))
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(avatar))
    : intro;

  return card({
    color: COLORS.brand,
    parts: [
      head,
      SEP,
      [
        '**1. Open your profile**',
        'Go to your [Roblox profile](https://www.roblox.com/my/profile) and edit **About**.',
        '',
        '**2. Add your personal phrase**',
        'Paste the phrase below into your description, then save.',
        `\`\`\`\n${code}\n\`\`\``,
        '**3. Confirm your account**',
        'Come back here and press **Verify**.',
        '',
        '-# The phrase expires in 15 minutes. We only read your public profile and never ask for your password. You can remove the phrase afterwards.',
      ].join('\n'),
      row(
        new ButtonBuilder().setCustomId('verify:check').setLabel('Verify').setEmoji(farmEmoji(guild, 'check')).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('verify:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      ),
      row(
        translateButton(),
      ),
    ],
  });
}

async function check(i) {
  const pending = await get('SELECT * FROM roblox_pending WHERE discord_id = ?', i.user.id);
  if (!pending || pending.expires < Date.now()) {
    return i.reply(notice('Your verification request expired. Press **Verify with Roblox** in the verification channel to start again.', 'error'));
  }
  await i.deferReply({ flags: 64 });

  let profile;
  try {
    profile = await getProfile(pending.roblox_id);
  } catch {
    return i.editReply(edit(notice('Roblox is not responding right now. Please try again in a moment.', 'error')));
  }
  if (!profile.description?.toLowerCase().includes(pending.code)) {
    return i.editReply(edit(notice(`I could not find the phrase in the **About** section of **@${pending.roblox_name}**. Make sure you saved it, then press **Verify** again.`, 'error')));
  }

  const clash = await get('SELECT discord_id FROM roblox_links WHERE roblox_id = ?', pending.roblox_id);
  if (clash) {
    return i.editReply(edit(notice('That Roblox account is already linked to another Discord user.', 'error')));
  }

  await run(
    'REPLACE INTO roblox_links (discord_id, roblox_id, roblox_name, verified_at) VALUES (?, ?, ?, ?)',
    i.user.id, pending.roblox_id, profile.name, Date.now(),
  );
  await run('DELETE FROM roblox_pending WHERE discord_id = ?', i.user.id);

  const result = await grantRole(i.member);
  const roleNote = result === 'ok' ? '' : '\n-# ⚠️ I could not assign the verified role. Please ask staff for help (my role must be above the verified role).';
  return i.editReply(edit(card({
    color: COLORS.green,
    parts: [`## ${farmEmoji(i.guild, 'check')} You’re part of the farm\nWelcome, **${profile.displayName}** (@${profile.name}).\n\nYour Roblox account is linked. You can now remove the phrase from your profile.${roleNote}`],
  })));
}

async function cancel(i) {
  await run('DELETE FROM roblox_pending WHERE discord_id = ?', i.user.id);
  return i.update(edit(card({ color: COLORS.gray, parts: ['Verification cancelled.'] })));
}

const handlers = {
  verify: (i, [action]) => ({ start, modal, check, cancel, noop: () => {} })[action]?.(i),
};

const robloxCommand = {
  data: new SlashCommandBuilder()
    .setName('roblox')
    .setDescription('Roblox account links (staff)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s.setName('whois').setDescription('Show the Roblox account linked to a member')
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('unlink').setDescription('Remove a member\'s Roblox link and verified role')
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))),

  async execute(i) {
    if (!(await isStaff(i.member))) return i.reply(notice('Staff only.', 'error'));
    const user = i.options.getUser('user', true);
    const linked = await get('SELECT * FROM roblox_links WHERE discord_id = ?', user.id);

    if (i.options.getSubcommand() === 'whois') {
      if (!linked) return i.reply(ephemeral(notice(`${user} has not verified a Roblox account.`, 'info')));
      return i.reply(notice(`${user} → **${linked.roblox_name}** (ID \`${linked.roblox_id}\`)\n[Profile](https://www.roblox.com/users/${linked.roblox_id}/profile) · verified <t:${Math.floor(linked.verified_at / 1000)}:R>`, 'info'));
    }

    if (!linked) return i.reply(notice(`${user} has no linked account.`, 'error'));
    await run('DELETE FROM roblox_links WHERE discord_id = ?', user.id);
    const roleId = await getSetting(i.guildId, 'role_verified');
    if (roleId) {
      const member = await i.guild.members.fetch(user.id).catch(() => null);
      await member?.roles.remove(roleId, `Unlinked by ${i.user.tag}`).catch(() => {});
    }
    return i.reply(notice(`Unlinked **${linked.roblox_name}** from ${user}.`, 'ok'));
  },
};

export default { commands: [robloxCommand], handlers };
