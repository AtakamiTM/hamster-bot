import {
  ButtonBuilder, ButtonStyle, ChannelType, InteractionContextType, PermissionFlagsBits, SlashCommandBuilder,
} from 'discord.js';
import { setSetting } from '../db.js';
import { COLORS, SEP, card, farmEmoji, notice, row, translateButton } from '../ui.js';
import { buildLinksPanel } from './links.js';

const RULES = `## Community rules
Welcome! To keep this place friendly and safe for everyone, please follow these rules. By staying in this server you agree to them.

**1 · Follow Discord's rules**
You must follow the [Discord Terms of Service](https://discord.com/terms) and [Community Guidelines](https://discord.com/guidelines). You must be at least 13 years old (or the minimum age in your country).

**2 · Be respectful**
No harassment, bullying, hate speech, discrimination or threats. Disagree politely and keep arguments out of the chat.

**3 · Keep it safe for everyone**
No NSFW, gore or shocking content. Nothing that promotes self-harm, violence or illegal activity. Never share anything that involves minors in an unsafe way.

**4 · Protect privacy**
Do not share personal information (yours or others'): real names, addresses, phone numbers, passwords or login cookies. No doxxing, ever.

**5 · No scams, cheats or exploits**
Follow the [Roblox Terms of Use](https://www.roblox.com/info/terms) and [Community Standards](https://en.help.roblox.com/hc/en-us/articles/203313410). No exploit scripts, account trading or selling, phishing, "free Robux" links or malicious files. Never ask anyone for their account details.

**6 · No spam or advertising**
No flooding, mass mentions, invite links, or self-promotion without staff approval. Do not impersonate staff or other members.

**7 · Language**
English is the main language so everyone can understand each other. Use the 🌐 **Polski** button on bot messages for a Polish translation.

**8 · Use channels properly**
Post in the right channel. Only share your **own** content in showcases and credit the original artist where required. Do not abuse codes, votes, surveys or giveaways (alt accounts, bots, vote farming).

**9 · Listen to staff**
Staff decisions are final. Ban evasion is not allowed. If something is wrong, report it to staff instead of reacting yourself.

-# Breaking the rules may lead to a warning, timeout, kick or ban depending on severity. Rules may change; staying in the server means you accept the current version.`;

const PANELS = {
  rules: (guild) => card({
    banner: 'rules',
    parts: [RULES.replace('## Community rules', `## ${farmEmoji(guild, 'paw')} Community rules`), SEP, row(translateButton())],
  }),

  verify: (guild) => card({
    banner: 'verify',
    color: COLORS.green,
    parts: [
      `## ${farmEmoji(guild, 'sprout')} Welcome to the farm\nLink your **Roblox account** to unlock the rest of the community.`,
      SEP,
      [
        '**Three simple steps**',
        '1. Enter your Roblox username.',
        '2. Add your personal phrase to your profile’s **About** section.',
        '3. Come back and confirm. You’re in!',
        '',
        '-# We only read your public profile, never ask for your password and only store your Roblox username and ID. Ask staff to unlink at any time.',
      ].join('\n'),
      row(
        new ButtonBuilder().setCustomId('verify:start').setLabel('Verify with Roblox').setEmoji(farmEmoji(guild, 'sprout')).setStyle(ButtonStyle.Success),
        translateButton(),
      ),
    ],
  }),

  bugs: (guild) => card({
    banner: 'bugs',
    color: COLORS.red,
    parts: [
      `## ${farmEmoji(guild, 'bug')} Help the farm grow\nSomething not working? Send a report so we can take a look.`,
      SEP,
      [
        '**A great report includes**',
        '- A short, clear title',
        '- What happened and what you expected',
        '- Steps to reproduce the issue',
        '- Your platform: PC, mobile or console',
        '',
        'Each report gets its own ID, status and discussion thread. You can add screenshots or videos in the thread.',
        '-# Please do not report cheaters or exploits here. Contact staff privately instead.',
      ].join('\n'),
      row(
        new ButtonBuilder().setCustomId('bug:new').setLabel('Report a bug').setEmoji(farmEmoji(guild, 'bug')).setStyle(ButtonStyle.Danger),
        translateButton(),
      ),
    ],
  }),

  suggestions: (guild) => card({
    banner: 'suggestions',
    color: COLORS.purple,
    parts: [
      `## ${farmEmoji(guild, 'idea')} Plant an idea\nHave something in mind for the game or community? Write it in this channel.`,
      SEP,
      [
        `Your message becomes a community vote. Choose ${farmEmoji(guild, 'heart')} **Support** or 👎 **Oppose** and see the results live. Staff will review the best ideas.`,
        '',
        '- One idea per message',
        '- Check existing suggestions first',
        '- Keep it constructive and specific',
      ].join('\n'),
      row(translateButton()),
    ],
  }),

  screenshots: (guild) => card({
    banner: 'screenshots',
    color: COLORS.blue,
    parts: [
      `## ${farmEmoji(guild, 'heart')} Moments worth keeping\nShare your favourite views, builds and little discoveries.`,
      SEP,
      [
        'Post an **image** in this channel. I will add reactions, open a thread and track the most loved shots (see `/top`).',
        '',
        '- Share only your own screenshots',
        '- Keep images safe and free of personal information',
        '- Chat in the threads; text-only posts are removed',
      ].join('\n'),
      row(translateButton()),
    ],
  }),

  clips: (guild) => card({
    banner: 'clips',
    color: COLORS.red,
    parts: [
      `## ${farmEmoji(guild, 'paw')} A little farm cinema\nAn amazing play or a moment that made you laugh? Let’s see it.`,
      SEP,
      [
        'Upload a **video** or paste a link from YouTube, Twitch, TikTok, Medal, Streamable and similar. I will add reactions, open a thread and track the best clips (see `/top`).',
        '',
        '- Share only your own clips',
        '- Keep videos safe and free of personal information',
        '- Chat in the threads; text-only posts are removed',
      ].join('\n'),
      row(translateButton()),
    ],
  }),

  fanarts: (guild) => card({
    banner: 'fanarts',
    color: COLORS.purple,
    parts: [
      `## ${farmEmoji(guild, 'water')} Made with love\nDrawings, paintings, sculptures or builds. Give your creativity a home.`,
      SEP,
      [
        'Post your artwork as an **image**. The community can react, and the most loved pieces appear in `/top`.',
        '',
        '- Post only art you made yourself',
        '- Tell us about your tools or process if you like',
        '- Keep it safe and friendly',
      ].join('\n'),
      row(translateButton()),
    ],
  }),
};

const command = {
  data: new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Post an info panel with a banner image')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o.setName('type').setDescription('Which panel').setRequired(true)
        .addChoices(...['rules', 'verify', 'links', 'bugs', 'suggestions', 'screenshots', 'clips', 'fanarts'].map((v) => ({ name: v, value: v }))))
    .addChannelOption((o) =>
      o.setName('channel').setDescription('Where to post (default: here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),

  async execute(i) {
    const type = i.options.getString('type', true);
    const channel = i.options.getChannel('channel') ?? i.channel;
    const payload = type === 'links' ? await buildLinksPanel(i.guildId, i.guild) : PANELS[type](i.guild);

    try {
      const sent = await channel.send({ ...payload, allowedMentions: { parse: [] } });
      if (type === 'links') await setSetting(i.guildId, 'links_panel', `${channel.id}/${sent.id}`);
    } catch (err) {
      console.error('[panel]', err.message);
      return i.reply(notice(`I could not post in ${channel}. Check that I can view the channel, send messages and attach files.`, 'error'));
    }
    return i.reply(notice(`Panel \`${type}\` posted in ${channel}.`, 'ok'));
  },
};

export default { commands: [command] };
