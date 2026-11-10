import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { after, before, mock, test } from 'node:test';
import mysql from 'mysql2/promise';
import { ButtonStyle, ComponentType, MessageFlags } from 'discord.js';
import { closeDb } from '../src/db.js';
import { SEP, card, edit, farmEmoji, notice, row, translateButton, uiHeading, uiMessage } from '../src/ui.js';
import panels from '../src/modules/panels.js';
import { renderVerification } from '../src/modules/verify.js';
import { renderBug } from '../src/modules/bugs.js';
import { renderGiveaway } from '../src/modules/giveaways.js';
import { renderSurvey } from '../src/modules/surveys.js';
import { renderSuggestion } from '../src/modules/suggestions.js';
import { buildLinksPanel } from '../src/modules/links.js';
import boosts from '../src/modules/boosts.js';
import content from '../src/modules/content.js';
import { ensureLocked } from '../src/modules/codes.js';
import translate from '../src/modules/translate.js';

const originalEnv = {};
const farmKinds = ['sprout', 'heart', 'paw', 'idea', 'check', 'bug', 'gift', 'water'];
const customEmojis = [...farmKinds.map((kind) => `farm_${kind}`),
  'bar_yes1', 'bar_yes2', 'bar_yes3', 'bar_no1', 'bar_no2', 'bar_no3',
].map((name, index) => ({
  name, id: `${100000000000000000n + BigInt(index)}`, available: true,
  toString() { return `<:${this.name}:${this.id}>`; },
}));
const guild = { id: 'emoji-test', emojis: { cache: { find: (predicate) => customEmojis.find(predicate) } } };
before(() => {
  for (const key of ['DB_HOST', 'DB_USER', 'DB_NAME']) {
    originalEnv[key] = process.env[key];
    process.env[key] = 'ui-test';
  }
  mock.method(mysql, 'createPool', () => ({
    async query(sql) {
      if (sql.includes('FROM survey_votes')) return [[{ option: 0, n: 2 }]];
      if (sql.includes('FROM suggestion_votes')) return [[{ up: 3, down: 1 }]];
      if (sql.includes('FROM links')) return [[{ id: 1, label: 'Play', url: 'https://www.roblox.com/', description: 'Our game' }]];
      if (sql.includes('FROM settings')) return [[{ value: '123' }]];
      if (sql.startsWith('SELECT id FROM codes')) return [[]];
      if (sql.includes("status = 'queued'")) return [[{ id: 1, code: 'FARM', status: 'queued' }]];
      if (sql.includes('COUNT(*) AS n FROM codes')) return [[{ n: 0 }]];
      if (sql.startsWith('UPDATE codes')) return [{ affectedRows: 1 }];
      throw new Error(`Unexpected UI test query: ${sql}`);
    },
    async end() {},
  }));
});
after(async () => {
  await closeDb();
  mock.restoreAll();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function inspect(payload) {
  const components = payload.components.map((component) => component.toJSON());
  const texts = [];
  const buttons = [];
  let count = 0;
  function visit(component) {
    count++;
    assert.notEqual(component.type, ComponentType.Container);
    assert.notEqual(component.type, ComponentType.Separator);
    if (component.type === ComponentType.TextDisplay) {
      assert(component.content.length <= 3900);
      assert.doesNotMatch(component.content, /〔|〕|〢/);
      texts.push(component.content);
    }
    if (component.type === ComponentType.Button) buttons.push(component);
    if (component.type === ComponentType.ActionRow) assert(component.components.length <= 5);
    component.components?.forEach(visit);
    if (component.accessory) visit(component.accessory);
  }
  components.forEach(visit);
  assert(count <= 40);
  assert(texts.join('').length <= 4000);
  assert.equal(payload.flags & MessageFlags.IsComponentsV2, MessageFlags.IsComponentsV2);
  return { components, text: texts.join('\n\n'), buttons };
}

test('shared layout preserves Markdown and uses blank lines instead of decorations', () => {
  const phrase = '```\nhamster apple river sunny\n```';
  const payload = card({ parts: [uiHeading('Welcome'), SEP, '**Steps**\n1. Start here.', phrase, row(translateButton()), 'Footer'] });
  const { components, buttons } = inspect(payload);
  assert.equal(components[0].content, '## Welcome\n\n**Steps**\n1. Start here.\n\n' + phrase);
  assert.equal(components[1].type, ComponentType.ActionRow);
  assert.equal(components[2].content, 'Footer');
  assert.equal(buttons[0].custom_id, 'tr');
  assert.equal(buttons[0].label, 'Polski');
  assert.equal(uiMessage('Saved', '✅'), '✅ Saved');
});

test('long text sections are not silently truncated', () => {
  const payload = card({ parts: ['a'.repeat(2000), 'b'.repeat(1900)] });
  assert.equal(payload.components.length, 2);
  assert.equal(payload.components[1].toJSON().content.length, 1900);
  assert.throws(() => card({ parts: ['x'.repeat(3901)] }), RangeError);
});

test('notices remain ephemeral and banner edits retain the upload', async () => {
  for (const kind of ['ok', 'error', 'info']) {
    const payload = notice('Test status', kind);
    inspect(payload);
    assert(payload.flags & MessageFlags.Ephemeral);
    assert.equal('attachments' in edit(payload), false);
  }
  const payload = card({ banner: 'verify', parts: ['Hello'] });
  inspect(payload);
  await access(payload.files[0].attachment);
  assert.equal(edit(payload).files[0].name, 'verify.png');
  assert.deepEqual(edit(payload).attachments, []);
});

for (const type of ['rules', 'verify', 'bugs', 'suggestions', 'screenshots', 'clips', 'fanarts']) {
  test(`panel ${type}: banner, clean text and working controls`, async () => {
    let payload;
    await panels.commands[0].execute({
      guildId: 'test',
      options: { getString: () => type, getChannel: () => null },
      channel: { send: async (value) => { payload = value; return { id: '456' }; } },
      reply: async () => {},
    });
    const { components, buttons } = inspect(payload);
    assert.equal(components[0].items[0].media.url, `attachment://${type}.png`);
    await access(payload.files[0].attachment);
    assert(buttons.some((button) => button.custom_id === 'tr'));
    if (type === 'verify') assert(buttons.some((button) => button.custom_id === 'verify:start'));
    if (type === 'bugs') assert(buttons.some((button) => button.custom_id === 'bug:new'));
  });
}

for (const avatar of [null, 'https://cdn.discordapp.com/embed/avatars/0.png']) {
  test(`verification instructions ${avatar ? 'with' : 'without'} avatar`, () => {
    const phrase = 'hamster apple river sunny';
    const { text, buttons, components } = inspect(renderVerification({ name: 'Builderman' }, phrase, avatar));
    assert(text.includes(`\`\`\`\n${phrase}\n\`\`\``));
    assert(text.includes('**1. Open your profile**'));
    assert(text.includes('15 minutes'));
    assert.deepEqual(buttons.map((button) => button.custom_id), ['verify:check', 'verify:cancel', 'tr']);
    assert.equal(buttons[1].style, ButtonStyle.Secondary);
    assert.equal(components.some((component) => component.type === ComponentType.Section), Boolean(avatar));
    assert.equal(components.at(-1).components.length, 1);
  });
}

for (const status of ['open', 'progress', 'resolved', 'rejected']) {
  test(`bug report ${status}: readable details and unchanged action IDs`, () => {
    const { text, buttons } = inspect(renderBug({
      id: 3, title: 'Cannot harvest', description: 'The crop stays in place.',
      steps: '1. Click crop\n2. Nothing happens', platform: 'PC', status,
      author: '123', created_at: 1700000000000,
    }));
    assert(text.startsWith('## 🐞 Cannot harvest'));
    assert(text.includes('**Platform** PC'));
    assert.equal(buttons.length, 5);
    assert.equal(buttons[0].custom_id, 'bug:set:3:progress');
  });
}

for (const status of ['scheduled', 'active', 'ended', 'cancelled']) {
  test(`giveaway ${status}: preserves banner, eligibility, winners and disabled state`, async () => {
    const payload = renderGiveaway({
      id: 7, prize: 'Golden seeds', description: 'For our farmers', status,
      winner_count: 2, host: '123', starts_at: 1700000000000, ends_at: 1700003600000,
    }, status === 'ended' ? ['456', '789'] : [], 10);
    const { text, buttons, components } = inspect(payload);
    assert.equal(components[0].items[0].media.url, 'attachment://giveaways.png');
    assert.equal(payload.files[0].name, 'giveaways.png');
    await access(payload.files[0].attachment);
    assert.equal(edit(payload).files[0].name, 'giveaways.png');
    assert.deepEqual(edit(payload).attachments, []);
    assert(text.includes('Requires <@&1551331551546056845> at entry and draw'));
    assert(text.includes('20%'));
    assert.equal(buttons[0].custom_id, 'gw:join:7');
    assert.equal(buttons[0].disabled, status !== 'active');
    assert.equal(buttons[1].custom_id, 'gw:participants:7');
    assert.notEqual(buttons[1].disabled, true);
    if (status === 'ended') assert(text.includes('<@456>, <@789>'));
  });
}

test('surveys separate options and preserve voting controls in open and closed states', async () => {
  for (const closed of [0, 1]) {
    const { text, buttons } = inspect(await renderSurvey({
      id: 8, question: 'What should we plant?', options: '["Carrots","Wheat"]', closed,
    }));
    assert(text.startsWith('## What should we plant?'));
    assert(text.includes('\n\n2️⃣'));
    assert.deepEqual(buttons.map((button) => button.custom_id), ['sv:8:0', 'sv:8:1', 'tr']);
    assert.equal(buttons[0].disabled, Boolean(closed));
  }
});

test('suggestions preserve images, vote counts and finished states', async () => {
  for (const status of ['pending', 'considered', 'approved', 'denied']) {
    const { text, components, buttons } = inspect(await renderSuggestion({
      id: 9, content: 'Add a greenhouse', status, author_name: 'Farmer',
      author_avatar: 'https://cdn.discordapp.com/embed/avatars/0.png', image: 'idea.png',
    }));
    assert(text.includes('75%'));
    assert.equal(components[2].items[0].media.url, 'attachment://idea.png');
    assert.equal(buttons[0].custom_id, 'sg:up:9');
    assert.equal(buttons[1].custom_id, 'sg:down:9');
    assert.equal(buttons[0].disabled, ['approved', 'denied'].includes(status));
  }
});

test('links keep their destinations and banner after an edit', async () => {
  const payload = await buildLinksPanel('test');
  const { buttons } = inspect(payload);
  assert.equal(buttons[0].url, 'https://www.roblox.com/');
  assert.equal(edit(payload).files[0].name, 'links.png');
});

test('boost notifications preserve mentions and compact server stats', async () => {
  let payload;
  const channel = { send: async (value) => { payload = value; return { url: 'https://discord.com/' }; } };
  await boosts.commands[0].execute({
    guild: { ...guild, name: 'Farm', premiumTier: 2, premiumSubscriptionCount: 7, channels: { fetch: async () => channel } },
    user: { id: '123', toString: () => '<@123>' }, channel, reply: async () => {},
  });
  const { text } = inspect(payload);
  assert(text.includes('**7** boosts · **Level 2**'));
  assert.deepEqual(payload.allowedMentions.users, ['123']);
});

test('content notifications keep destination and role mentions', async () => {
  let payload;
  await content.commands[0].execute({
    guildId: 'test', member: { permissions: { has: () => true } },
    options: { getString: (name) => name === 'link' ? 'https://example.com/post' : 'A new harvest!' },
    user: { toString: () => '<@123>' }, deferReply: async () => {}, editReply: async () => {},
    client: { channels: { fetch: async () => ({ send: async (value) => { payload = value; return { url: 'https://discord.com/' }; } }) } },
  });
  const { text, buttons } = inspect(payload);
  assert(text.includes('A new harvest!'));
  assert.equal(buttons[0].url, 'https://example.com/post');
  assert.deepEqual(payload.allowedMentions.roles, ['123']);
});

test('locked code messages keep reaction unlocks and a compact progress bar', async () => {
  let payload;
  let reaction;
  await ensureLocked({ channels: { fetch: async () => ({
    send: async (value) => {
      payload = value;
      return { id: '456', react: async (emoji) => { reaction = emoji; } };
    },
  }) } }, 'test');
  const { text } = inspect(payload);
  assert(text.includes('**0 / 123** reactions'));
  assert(text.includes('▱'.repeat(10)));
  assert.equal(reaction, '🎉');
  assert.equal(payload.files[0].name, 'codes.png');
});

test('translation reads merged sections and preserves the verification phrase', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => ({
    ok: true,
    json: async () => [[[new URLSearchParams(options.body).get('q')]]],
  }));
  const source = renderVerification({ name: 'Builderman' }, 'hamster apple river sunny', null);
  let result;
  await translate.handlers.tr({
    user: { id: 'translation-test' },
    message: { id: 'verification-test', components: source.components },
    deferReply: async () => {},
    editReply: async (payload) => { result = payload; },
  });
  const { text } = inspect(result);
  assert(text.includes('## 🌱 One last step'));
  assert(text.includes('```\nhamster apple river sunny\n```'));
  assert(text.includes('**1. Open your profile**'));
});

test('farm emoji lookup uses server IDs, including animated emoji, and warns once for missing assets', (t) => {
  for (const kind of farmKinds) assert.match(farmEmoji(guild, kind), new RegExp(`^<:farm_${kind}:\\d+>$`));
  const animated = { id: 'animated', emojis: { cache: { find: () => ({ toString: () => '<a:farm_heart:123456789012345678>' }) } } };
  assert.equal(farmEmoji(animated, 'heart'), '<a:farm_heart:123456789012345678>');
  const warn = t.mock.method(console, 'warn', () => {});
  const missing = { id: 'missing-test', emojis: { cache: { find: () => undefined } } };
  assert.equal(farmEmoji(missing, 'heart'), '❤️');
  assert.equal(farmEmoji(missing, 'heart'), '❤️');
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(farmEmoji(undefined, 'check'), '✅');
  assert.throws(() => farmEmoji(guild, 'unknown'), /Unknown farm emoji/);
});

test('panels resolve custom emoji from the current server and preserve button IDs', async () => {
  for (const [type, kind] of Object.entries({
    rules: 'paw', verify: 'sprout', bugs: 'bug', suggestions: 'idea',
    screenshots: 'heart', clips: 'paw', fanarts: 'water',
  })) {
    let payload;
    await panels.commands[0].execute({
      guild, guildId: guild.id,
      options: { getString: () => type, getChannel: () => null },
      channel: { send: async (value) => { payload = value; return { id: '456' }; } },
      reply: async () => {},
    });
    const { text, buttons } = inspect(payload);
    assert(text.includes(farmEmoji(guild, kind)));
    if (type === 'verify' || type === 'bugs') {
      assert.equal(buttons[0].emoji.id, customEmojis.find((emoji) => emoji.name === `farm_${kind}`).id);
    }
  }
});

test('dynamic messages use custom emoji in text and buttons, also in edit payloads', async () => {
  const verification = renderVerification({ name: 'Builderman' }, 'hamster apple river sunny', null, guild);
  assert.equal(inspect(verification).buttons[0].emoji.id, customEmojis.find((emoji) => emoji.name === 'farm_check').id);
  const suggestion = await renderSuggestion({
    id: 9, content: 'Add a greenhouse', status: 'approved', author_name: 'Farmer',
    author_avatar: 'https://cdn.discordapp.com/embed/avatars/0.png',
  }, guild);
  const inspected = inspect(suggestion);
  assert(inspected.text.includes(farmEmoji(guild, 'idea')));
  assert(inspected.text.includes(farmEmoji(guild, 'check')));
  assert.equal(inspected.buttons[0].emoji.id, customEmojis.find((emoji) => emoji.name === 'farm_heart').id);
  assert.equal(inspect(edit(suggestion)).buttons[0].emoji.id, inspected.buttons[0].emoji.id);
  const giveaway = renderGiveaway({
    id: 7, prize: 'Seeds', status: 'active', winner_count: 1, host: '123',
    starts_at: 1700000000000, ends_at: 1700003600000,
  }, [], 0, guild);
  assert(inspect(giveaway).text.includes(farmEmoji(guild, 'gift')));
  assert.equal(inspect(giveaway).buttons[0].emoji.id, customEmojis.find((emoji) => emoji.name === 'farm_gift').id);
  const links = inspect(await buildLinksPanel(guild.id, guild));
  assert(links.text.includes(farmEmoji(guild, 'paw')));
});
