import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import mysql from 'mysql2/promise';
import { ComponentType, RESTJSONErrorCodes } from 'discord.js';
import { closeDb } from '../src/db.js';
import reactionRoles, { handleReaction, renderReactionRoles, resolveReactionEmoji } from '../src/modules/reaction-roles.js';

const mappings = [
  { key: '🇵🇱', emoji: '🇵🇱', role: 'polish', label: 'Polski' },
  { key: '🇬🇧', emoji: '🇬🇧', role: 'english', label: 'English' },
];
let panel;
let writes;
let calls;
let roleEditable = true;
let failLookup;
let managed = false;
let highest = 1;
const roles = new Set();
const custom = { id: '123456789012345678', available: true, toString: () => '<:farm:123456789012345678>' };
const guild = {
  id: 'guild', ownerId: 'owner',
  emojis: { cache: { get: (id) => id === custom.id ? custom : undefined, find: () => undefined } },
  roles: { fetch: async (id) => ({ id, editable: roleEditable, managed }) },
  members: {
    me: { permissions: { has: () => true } },
    fetch: async () => {
      if (failLookup) throw failLookup;
      return { roles: {
        add: async (id) => { calls.push(`add:${id}`); roles.add(id); },
        remove: async (id) => { calls.push(`remove:${id}`); roles.delete(id); },
      } };
    },
  },
};
const env = {};
before(() => {
  for (const key of ['DB_HOST', 'DB_USER', 'DB_NAME']) {
    env[key] = process.env[key];
    process.env[key] = 'reaction-test';
  }
  mock.method(mysql, 'createPool', () => ({
    async query(sql, params) {
      if (sql.startsWith('SELECT * FROM reaction_role_panels')) {
        if (sql.includes('WHERE message')) return [panel?.message === params[0] && panel.guild === params[1] ? [panel] : []];
        if (sql.includes('WHERE id')) return [panel?.id === params[0] && panel.guild === params[1] ? [panel] : []];
        return [panel ? [panel] : []];
      }
      writes.push({ sql, params });
      if (sql.startsWith('INSERT')) {
        panel = { id: 1, guild: params[0], title: params[1], description: params[2], options: params[3] };
        return [{ affectedRows: 1, insertId: 1 }];
      }
      if (sql.startsWith('UPDATE') && sql.includes('SET options')) panel.options = params[0];
      if (sql.startsWith('UPDATE') && sql.includes('SET channel = ?')) {
        panel.channel = params[0]; panel.message = params[1];
      }
      if (sql.startsWith('UPDATE') && sql.includes('SET channel = NULL')) {
        panel.channel = null; panel.message = null;
      }
      if (sql.startsWith('DELETE')) panel = undefined;
      return [{ affectedRows: 1 }];
    },
    async end() {},
  }));
});
after(async () => {
  await closeDb();
  mock.restoreAll();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function reset(published = false) {
  panel = { id: 1, guild: 'guild', title: 'Languages', description: 'You can choose both languages!', options: JSON.stringify(mappings), message: published ? 'message' : null };
  writes = []; calls = []; roles.clear(); failLookup = undefined;
  roleEditable = true; managed = false; highest = 1;
}

function reaction(emoji, partial = false) {
  return {
    partial, emoji: { name: emoji, id: null },
    message: { id: 'message', guildId: 'guild', guild: partial ? null : guild },
    client: { guilds: { fetch: async () => guild } },
  };
}

async function execute(sub, values = {}, overrides = {}) {
  let response;
  await reactionRoles.commands[0].execute({
    guildId: 'guild', guild,
    member: {
      id: 'admin', permissions: { has: () => true },
      roles: { highest: { comparePositionTo: () => highest } },
    },
    options: {
      getSubcommand: () => sub,
      getInteger: () => values.id ?? 1,
      getString: (name) => values[name] ?? null,
      getRole: () => ({ id: values.role ?? 'french', name: 'Français', editable: roleEditable, managed }),
      getChannel: () => values.channel ?? null,
    },
    deferReply: async () => {},
    editReply: async (payload) => { response = payload; },
    reply: async (payload) => { response = payload; },
    ...overrides,
  });
  return response?.components.map((component) => component.toJSON().content ?? '').join('\n');
}

test('command and panel serialize with bilingual labels and translation button', () => {
  reset();
  reactionRoles.commands[0].data.toJSON();
  const json = renderReactionRoles(panel).components.map((component) => component.toJSON());
  assert(json[0].content.includes('🇵🇱 **Polski**\n🇬🇧 **English**'));
  assert(!json[0].content.includes('—'));
  assert(json[0].content.includes('multiple roles'));
  assert.equal(json.at(-1).type, ComponentType.ActionRow);
  assert.equal(json.at(-1).components[0].custom_id, 'tr');
});

test('emoji parser accepts flags, variation selectors, ZWJ and server emoji', () => {
  assert.equal(resolveReactionEmoji('🇵🇱', guild).key, '🇵🇱');
  assert.equal(resolveReactionEmoji('❤️', guild).key, '❤');
  assert.equal(resolveReactionEmoji('👩‍🌾', guild).emoji, '👩‍🌾');
  assert.equal(resolveReactionEmoji(custom.toString(), guild).key, custom.id);
  for (const invalid of ['hello', '🇵🇱🇬🇧', '<:bad:999999999999999999>', '💡 hello']) {
    assert.throws(() => resolveReactionEmoji(invalid, guild));
  }
});

test('oversized panels are rejected instead of publishing truncated role mappings', () => {
  reset();
  panel.options = JSON.stringify(Array.from({ length: 20 }, () => ({
    emoji: '<:long_emoji_name_12345678901234567:123456789012345678>',
    label: 'a'.repeat(100),
  })));
  panel.description = 'a'.repeat(1000);
  assert.throws(() => renderReactionRoles(panel), /too long/);
});

test('create, configure, publish and delete a panel', async () => {
  reset();
  assert((await execute('create', { title: 'Languages', description: 'Pick both!' })).includes('#1'));
  await execute('add', { emoji: '🇵🇱', role: 'polish', label: 'Polski' });
  await execute('add', { emoji: '🇬🇧', role: 'english', label: 'English' });
  assert.equal(JSON.parse(panel.options).length, 2);
  const reactions = [];
  let deleted = 0;
  const message = { id: 'message', url: 'https://discord.com/panel', react: async (emoji) => { reactions.push(emoji); }, delete: async () => { deleted++; } };
  const channel = {
    id: 'channel', permissionsFor: () => ({ has: () => true }),
    send: async (payload) => { assert.deepEqual(payload.allowedMentions, { parse: [] }); return message; },
  };
  assert((await execute('post', { channel })).includes(message.url));
  assert.deepEqual(reactions, ['🇵🇱', '🇬🇧']);
  assert.equal(panel.message, 'message');
  assert((await execute('add', { emoji: '💡' })).includes('already published'));
  guild.channels = { fetch: async () => ({ messages: { fetch: async () => message } }) };
  await execute('delete');
  assert.equal(panel, undefined);
  assert.equal(deleted, 1);
});

test('draft can replace emoji mapping, remove options, reject duplicate roles and enforce hierarchy', async () => {
  reset();
  assert((await execute('add', { emoji: '💡', role: 'polish' })).includes('only once'));
  await execute('add', { emoji: '🇵🇱', role: 'new-polish', label: 'Polski' });
  assert.equal(JSON.parse(panel.options)[1].role, 'new-polish');
  await execute('remove', { emoji: '🇵🇱' });
  assert.equal(JSON.parse(panel.options).length, 1);
  highest = 0;
  assert((await execute('add', { emoji: '💡' })).includes('Your highest role'));
  highest = 1; roleEditable = false;
  assert((await execute('add', { emoji: '💡' })).includes('Manage Roles'));
  roleEditable = true; managed = true;
  assert((await execute('add', { emoji: '💡' })).includes('managed'));
});

test('publication with failed reaction seeding returns to draft and removes message', async () => {
  reset();
  let deleted = false;
  await assert.rejects(execute('post', { channel: {
    id: 'channel', permissionsFor: () => ({ has: () => true }),
    send: async () => ({ id: 'message', react: async () => { throw new Error('Emoji unavailable'); }, delete: async () => { deleted = true; } }),
  } }), /Emoji unavailable/);
  assert.equal(panel.message, null);
  assert.equal(deleted, true);
});

test('users can select both languages and independently remove one', async () => {
  reset(true);
  const user = { id: 'member', bot: false };
  await handleReaction(reaction('🇵🇱'), user, true);
  await handleReaction(reaction('🇬🇧'), user, true);
  assert.deepEqual([...roles], ['polish', 'english']);
  await handleReaction(reaction('🇵🇱'), user, false);
  assert.deepEqual([...roles], ['english']);
});

test('partial reactions after restart use persistent mappings without fetching removed reaction', async () => {
  reset(true);
  await handleReaction(reaction('🇬🇧', true), { id: 'member' }, false);
  assert.deepEqual(calls, ['remove:english']);
});

test('custom emoji matches by ID even if its display name changes', async () => {
  reset(true);
  panel.options = JSON.stringify([{ key: custom.id, emoji: custom.toString(), role: 'polish' }]);
  const event = reaction('renamed');
  event.emoji.id = custom.id;
  await handleReaction(event, { id: 'member' }, true);
  assert.deepEqual(calls, ['add:polish']);
});

test('bots, DMs, other guilds, unrelated emoji and unconfigured messages are ignored', async () => {
  reset(true);
  await handleReaction(reaction('🇵🇱'), { id: 'bot', bot: true }, true);
  const dm = reaction('🇵🇱'); dm.message.guildId = null;
  await handleReaction(dm, { id: 'member' }, true);
  const other = reaction('🇵🇱'); other.message.guildId = 'other';
  await handleReaction(other, { id: 'member' }, true);
  await handleReaction(reaction('💡'), { id: 'member' }, true);
  panel = undefined;
  await handleReaction(reaction('🇵🇱'), { id: 'member' }, true);
  assert.equal(calls.length, 0);
});

test('rapid add/remove events are serialized and a failed event does not block the next', async () => {
  reset(true);
  const user = { id: 'member' };
  await Promise.all([
    handleReaction(reaction('🇵🇱'), user, true),
    handleReaction(reaction('🇵🇱'), user, false),
  ]);
  assert.deepEqual(calls, ['add:polish', 'remove:polish']);
  roleEditable = false;
  await assert.rejects(handleReaction(reaction('🇵🇱'), user, true), /Manage Roles/);
  roleEditable = true;
  await handleReaction(reaction('🇵🇱'), user, true);
  assert(roles.has('polish'));
});

test('departed members are skipped but network errors are surfaced', async () => {
  reset(true);
  failLookup = Object.assign(new Error('Unknown member'), { code: RESTJSONErrorCodes.UnknownMember });
  await handleReaction(reaction('🇵🇱'), { id: 'member' }, true);
  assert.equal(calls.length, 0);
  failLookup = new Error('Network failed');
  await assert.rejects(handleReaction(reaction('🇵🇱'), { id: 'member' }, true), /Network failed/);
});

test('commands enforce permissions at runtime and restrict lookup to this guild', async () => {
  reset();
  const denied = await execute('create', {}, { member: { permissions: { has: () => false } } });
  assert(denied.includes('Manage Server and Manage Roles'));
  assert.equal(writes.length, 0);
  panel.guild = 'other';
  assert((await execute('delete')).includes('No panel'));
});
