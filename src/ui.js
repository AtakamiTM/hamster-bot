import { fileURLToPath } from 'node:url';
import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, MediaGalleryBuilder, MessageFlags, PermissionFlagsBits,
  SectionBuilder, TextDisplayBuilder,
} from 'discord.js';
import { getSetting } from './db.js';

export const COLORS = {
  brand: 0xf59e0b,
  green: 0x57c84d,
  red: 0xe5484d,
  blue: 0x4c8dff,
  purple: 0xf47fff,
  gray: 0x8b8f98,
};

export const SEP = Symbol('separator');

export const uiHeading = (text) => `## ${text}`;
export const uiMessage = (text, icon = '🤖') => `${icon} ${text}`;

const FARM_EMOJIS = {
  sprout: '🌱', heart: '❤️', paw: '🐾', idea: '💡',
  check: '✅', bug: '🐞', gift: '🎁', water: '🌿',
};
const missingFarmEmojis = new Set();

export function farmEmoji(guild, kind) {
  if (!Object.hasOwn(FARM_EMOJIS, kind)) throw new Error(`Unknown farm emoji: ${kind}`);
  const name = `farm_${kind}`;
  const emoji = guild?.emojis.cache.find((item) => item.name === name && item.available !== false);
  if (emoji) return emoji.toString();
  if (guild) {
    const key = `${guild.id}:${name}`;
    if (!missingFarmEmojis.has(key)) {
      console.warn(`[ui] Missing or unavailable emoji "${name}" in guild ${guild.id}; using standard emoji.`);
      missingFarmEmojis.add(key);
    }
  }
  return FARM_EMOJIS[kind];
}

/**
 * Builds a compact plain (non-embed) Components V2 message with text and buttons.
 * `parts` accepts strings, SEP, ActionRowBuilder, SectionBuilder or MediaGalleryBuilder.
 * Adjacent text sections use blank lines; SEP is a whitespace-only section break.
 */
export function card({ parts = [], banner }) {
  const components = [];
  const files = [];
  let text = '';
  const flushText = () => {
    if (!text) return;
    components.push(new TextDisplayBuilder().setContent(text));
    text = '';
  };

  if (banner) {
    if (!/^[a-z]+$/.test(banner)) throw new Error(`Invalid banner name: ${banner}`);
    files.push(new AttachmentBuilder(fileURLToPath(new URL(`../img/${banner}.png`, import.meta.url)), { name: `${banner}.png` }));
    components.push(new MediaGalleryBuilder().addItems({
      media: { url: `attachment://${banner}.png` },
      description: `${banner} - Hamster community`,
    }));
  }

  for (const part of parts) {
    if (!part) continue;
    if (typeof part === 'string') {
      if (part.length > 3900) throw new RangeError('Message text section exceeds 3900 characters.');
      if (text.length + part.length + 2 > 3900) flushText();
      text += `${text ? '\n\n' : ''}${part}`;
    } else if (part === SEP) {
      continue;
    } else if (
      part instanceof ActionRowBuilder || part instanceof SectionBuilder || part instanceof MediaGalleryBuilder
    ) {
      flushText();
      components.push(part);
    }
  }
  flushText();

  return { components, files, flags: MessageFlags.IsComponentsV2 };
}

/** Banner edits replace the banner; other edits keep existing attachments. */
export const edit = ({ components, files = [] }) => ({
  components,
  flags: MessageFlags.IsComponentsV2,
  ...(files.length ? { files, attachments: [] } : {}),
});

export const ephemeral = (payload) => ({ ...payload, flags: payload.flags | MessageFlags.Ephemeral });

/** Small status message (success / error / info). */
export function notice(text, kind = 'info') {
  const emoji = { ok: '✅', error: '⛔', info: 'ℹ️' }[kind];
  return ephemeral(card({ parts: [uiMessage(text, emoji)] }));
}

export const translateButton = () =>
  new ButtonBuilder()
    .setCustomId('tr')
    .setLabel('Polski')
    .setEmoji('🌐')
    .setStyle(ButtonStyle.Secondary);

export const row = (...buttons) => new ActionRowBuilder().addComponents(...buttons);

export const mentionSafe = { parse: [] };

export async function isStaff(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const staffRole = await getSetting(member.guild.id, 'role_staff');
  return Boolean(staffRole && member.roles.cache.has(staffRole));
}

export const bar = (fraction, size = 10) => {
  const filled = Math.max(0, Math.min(size, Math.round(fraction * size)));
  return '▰'.repeat(filled) + '▱'.repeat(size - filled);
};

const VOTE_BAR_EMOJIS = ['bar_yes1', 'bar_yes2', 'bar_yes3', 'bar_no1', 'bar_no2', 'bar_no3'];
const VOTE_BAR_SIZE = 10;

export function voteBar(fraction, guild) {
  const emojis = guild
    ? Object.fromEntries(VOTE_BAR_EMOJIS.map((name) => {
      const emoji = guild.emojis.cache.find((item) => item.name === name);
      if (!emoji) throw new Error(`Missing required vote bar emoji "${name}" in guild ${guild.id}.`);
      return [name, emoji.toString()];
    }))
    : {
      bar_yes1: '🟩', bar_yes2: '🟩', bar_yes3: '🟩',
      bar_no1: '🟥', bar_no2: '🟥', bar_no3: '🟥',
    };
  const filled = Math.max(0, Math.min(VOTE_BAR_SIZE, Math.round(fraction * VOTE_BAR_SIZE)));

  if (filled === 0) return emojis.bar_no1 + emojis.bar_no2.repeat(VOTE_BAR_SIZE - 2) + emojis.bar_no3;
  if (filled === VOTE_BAR_SIZE) return emojis.bar_yes1 + emojis.bar_yes2.repeat(VOTE_BAR_SIZE - 2) + emojis.bar_yes3;
  return emojis.bar_yes1
    + emojis.bar_yes2.repeat(filled - 1)
    + emojis.bar_no2.repeat(VOTE_BAR_SIZE - filled - 1)
    + emojis.bar_no3;
}

export const pad = (n, len = 4) => String(n).padStart(len, '0');
export const quote = (text) => text.split('\n').map((l) => `> ${l}`).join('\n');
export const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
