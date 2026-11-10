import { MessageFlags } from 'discord.js';
import { card, edit, notice } from '../ui.js';

const cooldown = new Map();
const cache = new Map();

// Names that must never be translated or declined.
const KEEP = /\b(Roblox|Robux|Discord|Hamster|TikTok|YouTube|Twitch|Translate|Verify|About|Premium|Nitro)\b/g;
// Markdown line prefixes that are kept as-is and re-attached after translation.
const PREFIX = /^(\s*(?:#{1,3} |-# |> |[-•] |\d+\. ))/;

async function google(text) {
  const res = await fetch(
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=pl&dt=t',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ q: text }),
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!res.ok) throw new Error(`Translation failed (${res.status})`);
  const data = await res.json();
  return data[0].map((s) => s[0]).join('');
}

function tidy(line) {
  return line
    .replace(/\*\*\s+([^*\n]+?)\s+\*\*/g, '**$1**')
    .replace(/(.)?\*\*([^*\n]+?)\*\*(.)?/gu, (m, before, inner, after) => {
      const pre = before && !/[\s(\[{"'«>]/.test(before) ? `${before} ` : (before ?? '');
      const post = after && !/[\s)\]}.,;:!?"'»…]/.test(after) ? ` ${after}` : (after ?? '');
      return `${pre}**${inner}**${post}`;
    })
    .replace(/ {2,}/g, ' ')
    .replace(/ +([,.;:!?])/g, '$1');
}

// Runs async work over a list with a small concurrency limit, keeping the order.
async function mapLimit(list, limit, fn) {
  const results = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const n = next++;
      results[n] = await fn(list[n], n);
    }
  }));
  return results;
}

export async function translateToPolish(text) {
  const saved = [];
  const hold = (m) => {
    saved.push(m);
    return `{{${saved.length - 1}}}`;
  };

  // Protect code, mentions, timestamps, URLs and brand names.
  const guarded = text.replace(/```[\s\S]*?```|`[^`\n]*`|<[^>\n]+>|https?:\/\/\S+/g, hold).replace(KEEP, hold);

  // Line by line: Google moves line breaks around in bulk requests, which breaks headings and lists.
  const lines = guarded.split('\n');
  const done = await mapLimit(lines, 5, async (line) => {
    const prefix = line.match(PREFIX)?.[1] ?? '';
    const body = line.slice(prefix.length);
    if (!/\p{L}/u.test(body.replace(/\{\{\d+\}\}/g, ''))) return line;
    return `${prefix}${(await google(body)).trim()}`;
  });

  return done
    .map((l) => tidy(l.replace(/\{\s*\{\s*(\d+)\s*\}\s*\}/g, (_, i) => saved[Number(i)] ?? '')))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function collect(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach((n) => collect(n, out));
  if (node.type === 10 && typeof node.content === 'string') out.push(node.content);
  if (node.components) collect(node.components, out);
  if (node.accessory) collect(node.accessory, out);
}

function extract(message) {
  const texts = [];
  for (const component of message.components ?? []) {
    collect(JSON.parse(JSON.stringify(component)), texts);
  }
  for (const embed of message.embeds ?? []) {
    if (embed.title) texts.push(`# ${embed.title}`);
    if (embed.description) texts.push(embed.description);
    for (const f of embed.fields) texts.push(`**${f.name}**\n${f.value}`);
  }
  const text = texts
    .join('\n\n')
    .replace(/^-# .*$/gm, '')
    .replace(/^<@&?\d+>\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

async function onTranslate(interaction) {
  const last = cooldown.get(interaction.user.id) ?? 0;
  if (Date.now() - last < 4000) {
    return interaction.reply(notice('Please wait a few seconds before translating again.', 'error'));
  }
  cooldown.set(interaction.user.id, Date.now());

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const text = extract(interaction.message);
  if (!text) return interaction.editReply(edit(notice('There is nothing to translate here.', 'error')));

  const key = `${interaction.message.id}:${interaction.message.editedTimestamp ?? 0}`;
  let translated = cache.get(key);
  try {
    if (!translated) {
      translated = await translateToPolish(text);
      cache.set(key, translated);
      if (cache.size > 200) cache.delete(cache.keys().next().value);
    }
  } catch (err) {
    console.error('[translate]', err.message);
    return interaction.editReply(edit(notice('The translation service is unavailable right now. Please try again later.', 'error')));
  }

  const payload = card({
    parts: [
      translated.slice(0, 3500),
      '-# 🌐 Tłumaczenie automatyczne na język polski · dotyczy wyłącznie tej wiadomości bota. Twoje wiadomości nigdy nie są wysyłane do tłumaczenia.',
    ],
  });
  return interaction.editReply(edit(payload));
}

export default { handlers: { tr: onTranslate } };
