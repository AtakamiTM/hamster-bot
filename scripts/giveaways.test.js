import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import mysql from 'mysql2/promise';
import { RESTJSONErrorCodes } from 'discord.js';
import { closeDb } from '../src/db.js';
import giveaways, { updatePost } from '../src/modules/giveaways.js';

const queries = [];
const savedEnv = {};
let participantCount = 0;
const entrants = new Set();
const drawnWinners = new Set();
const memberGuild = { members: { fetch: async () => ({ roles: { cache: { has: (id) => id === '1551331551546056845' } } }) } };
const giveaway = {
  id: 7, channel: '123', message: '456', prize: 'Seeds',
  status: 'active', winner_count: 1, host: '789', ends_at: 1700000000000,
};
let storedGiveaway = giveaway;

before(() => {
  for (const key of ['DB_HOST', 'DB_USER', 'DB_NAME']) {
    savedEnv[key] = process.env[key];
    process.env[key] = 'giveaway-test';
  }
  mock.method(mysql, 'createPool', () => ({
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.startsWith('DELETE g, e, w')) return [{ affectedRows: 3 }];
      if (sql.includes('COUNT(*) AS count')) return [[{ count: participantCount }]];
      if (sql.startsWith('SELECT * FROM giveaways')) {
        return [[...(storedGiveaway && (params.length === 1 || params[1] === 'test') ? [storedGiveaway] : [])]];
      }
      if (sql.startsWith('SELECT user_id FROM giveaway_entries')) {
        return [entrants.has(params[1]) ? [{ user_id: params[1] }] : []];
      }
      if (sql.startsWith('INSERT IGNORE INTO giveaway_entries')) {
        const changes = entrants.has(params[1]) ? 0 : 1;
        entrants.add(params[1]);
        participantCount = entrants.size;
        return [{ affectedRows: changes }];
      }
      if (sql.startsWith('DELETE FROM giveaway_entries')) {
        entrants.delete(params[1]);
        participantCount = entrants.size;
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('SELECT e.user_id')) {
        if (sql.includes('NOT EXISTS')) {
          return [[...entrants].filter((id) => !drawnWinners.has(id)).map((user_id) => ({ user_id }))];
        }
        const [, limit, offset] = params;
        return [Array.from({ length: Math.max(0, Math.min(limit, participantCount - offset)) },
          (_, index) => ({ user_id: String(1000 + offset + index) }))];
      }
      if (sql.startsWith('UPDATE giveaways')) return [{ affectedRows: 1 }];
      if (sql.startsWith('INSERT INTO giveaway_winners')) {
        drawnWinners.add(params[1]);
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('SELECT COALESCE(MAX(round)')) return [[{ nextRound: 2 }]];
      if (sql.startsWith('SELECT user_id FROM giveaway_winners')) return [[...drawnWinners].map((user_id) => ({ user_id }))];
      throw new Error(`Unexpected query: ${sql}`);
    },
    async end() {},
  }));
});

after(async () => {
  await closeDb();
  mock.restoreAll();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

  async function openParticipants(args, guildId = 'test') {
    let payload;
    let deferred;
    await giveaways.handlers.gw({
      guildId,
      deferReply: async (options) => { deferred = options; },
      deferUpdate: async () => { deferred = 'update'; },
      editReply: async (value) => { payload = value; },
      reply: async (value) => { payload = value; },
    }, ['participants', ...args]);
    return {
      payload, deferred,
      components: payload.components.map((component) => component.toJSON()),
      text: payload.components.map((component) => component.toJSON().content ?? '').join('\n'),
    };
  }

  test('participant list is private, paginated and never mentions users', async () => {
    participantCount = 45;
    storedGiveaway = giveaway;
    const first = await openParticipants(['7']);
    assert.deepEqual(first.deferred, { flags: 64 });
    assert(first.text.includes('1. <@1000>'));
    assert(first.text.includes('20. <@1019>'));
    assert(!first.text.includes('<@1020>'));
    assert(first.text.includes('Page 1 of 3'));
    assert.deepEqual(first.payload.allowedMentions, { parse: [] });
    const controls = first.components.at(-1).components;
    assert.equal(controls[0].disabled, true);
    assert.equal(controls[1].custom_id, 'gw:participants:7:1');
    const last = await openParticipants(['7', '2']);
    assert.equal(last.deferred, 'update');
    assert(last.text.includes('41. <@1040>'));
    assert(last.text.includes('45. <@1044>'));
    assert.equal(last.components.at(-1).components[1].disabled, true);
    const query = queries.find(({ sql }) => sql.startsWith('SELECT e.user_id'));
    assert.doesNotMatch(query.sql, /roblox_links/);
    assert.match(query.sql, /ORDER BY e.joined_at, e.user_id/);
  });

  test('participant page clamps after entrants leave and handles an empty ended giveaway', async () => {
    participantCount = 1;
    const shrunk = await openParticipants(['7', '2']);
    assert(shrunk.text.includes('Page 1 of 1'));
    assert.equal(shrunk.components.length, 1);
    participantCount = 0;
    storedGiveaway = { ...giveaway, status: 'ended' };
    const empty = await openParticipants(['7']);
    assert(empty.text.includes('No participants yet.'));
    assert(empty.text.includes('Page 1 of 1'));
  });

  test('participant lookup rejects missing and cross-server giveaways', async () => {
    storedGiveaway = undefined;
    assert((await openParticipants(['7'])).text.includes('no longer exists'));
    storedGiveaway = giveaway;
    assert((await openParticipants(['7'], 'other-server')).text.includes('no longer exists'));
  });

  test('participant handler rejects invalid IDs and pages before querying', async () => {
    for (const args of [['no'], ['7', '-1'], ['7', '1.5']]) {
      queries.length = 0;
      const result = await openParticipants(args);
      assert(result.text.includes('Invalid giveaway'));
      assert.equal(queries.length, 0);
    }
  });
for (const stage of ['fetch', 'edit']) {
  test(`missing message during ${stage} deletes the giveaway and related data atomically`, async (t) => {
    queries.length = 0;
    const warning = t.mock.method(console, 'warn', () => {});
    const error = Object.assign(new Error('Unknown Message'), { code: RESTJSONErrorCodes.UnknownMessage });
    const client = { channels: { fetch: async () => ({
      messages: { fetch: async (options) => {
        assert.deepEqual(options, { message: '456', force: true });
        if (stage === 'fetch') throw error;
        return { edit: async () => { throw error; } };
      } },
    }) } };
    assert.equal(await updatePost(client, giveaway), false);
    const deletions = queries.filter(({ sql }) => sql.startsWith('DELETE'));
    assert.equal(deletions.length, 1);
    assert.match(deletions[0].sql, /LEFT JOIN giveaway_entries/);
    assert.match(deletions[0].sql, /LEFT JOIN giveaway_winners/);
    assert.deepEqual(deletions[0].params, [7]);
    assert.equal(warning.mock.callCount(), 1);
  });
}

for (const code of [RESTJSONErrorCodes.MissingAccess, RESTJSONErrorCodes.MissingPermissions, RESTJSONErrorCodes.UnknownChannel, 'ECONNRESET']) {
  test(`error ${code} preserves giveaway data`, async (t) => {
    queries.length = 0;
    const log = t.mock.method(console, 'error', () => {});
    const client = { channels: { fetch: async () => {
      throw Object.assign(new Error('Discord request failed'), { code });
    } } };
    assert.equal(await updatePost(client, giveaway), false);
    assert.equal(queries.length, 0);
    assert.equal(log.mock.callCount(), 1);
  });
}

test('concurrent updates cannot overwrite the latest participant count with an older one', async () => {
  participantCount = 1;
  let releaseFirstEdit;
  let firstEditStarted;
  const started = new Promise((resolve) => { firstEditStarted = resolve; });
  const gate = new Promise((resolve) => { releaseFirstEdit = resolve; });
  const edits = [];
  let fetches = 0;
  const client = { channels: { fetch: async () => ({
    messages: { fetch: async () => {
      fetches++;
      return {
        attachments: { some: (predicate) => predicate({ name: 'giveaways.png' }) },
        edit: async (payload) => {
          if (!edits.length) {
            firstEditStarted();
            await gate;
          }
          edits.push(payload);
        },
      };
    } },
  }) } };
  const first = updatePost(client, giveaway);
  await started;
  participantCount = 3;
  const second = updatePost(client, giveaway);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches, 1);
  releaseFirstEdit();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  const text = (payload) => payload.components.map((component) => component.toJSON().content ?? '').join('\n');
  assert(text(edits[0]).includes('**1** entries'));
  assert(text(edits[1]).includes('**3** entries'));
  assert.equal('files' in edits[1], false);
  assert.equal('attachments' in edits[1], false);
});

test('joining and leaving update the displayed count from actual entries', async () => {
  entrants.clear();
  participantCount = 0;
  storedGiveaway = { ...giveaway, starts_at: 0, ends_at: Date.now() + 3600000 };
  const counts = [];
  const client = { channels: { fetch: async () => ({
    messages: { fetch: async () => ({
      edit: async (payload) => {
        const text = payload.components.map((component) => component.toJSON().content ?? '').join('\n');
        counts.push(Number(text.match(/\*\*(\d+)\*\* entries/)[1]));
      },
    }) },
  }) } };
  for (const userId of ['alice', 'bob', 'charlie', 'bob']) {
    await giveaways.handlers.gw({
      guildId: 'test', guild: memberGuild, user: { id: userId }, client,
      deferReply: async () => {}, editReply: async () => {},
      reply: async () => { assert.fail('Unexpected early reply'); },
    }, ['join', '7']);
  }
  assert.deepEqual(counts, [1, 2, 3, 2]);
});

test('failed refresh is reported to the entrant and does not block the next update', async (t) => {
  t.mock.method(console, 'error', () => {});
  storedGiveaway = { ...giveaway, starts_at: 0, ends_at: Date.now() + 3600000 };
  let response;
  await giveaways.handlers.gw({
    guildId: 'test', guild: memberGuild, user: { id: 'dave' },
    client: { channels: { fetch: async () => { throw new Error('Network failed'); } } },
    deferReply: async () => {}, editReply: async (payload) => { response = payload; },
  }, ['join', '7']);
  assert(response.components[0].toJSON().content.includes('Your entry was saved, but'));
  let edited = false;
  assert.equal(await updatePost({ channels: { fetch: async () => ({
    messages: { fetch: async () => ({ edit: async () => { edited = true; } }) },
  }) } }, giveaway), true);
  assert.equal(edited, true);
});

test('entry requires the member role, without querying Roblox links', async () => {
  entrants.clear();
  queries.length = 0;
  storedGiveaway = { ...giveaway, starts_at: 0, ends_at: Date.now() + 3600000 };
  let response;
  let requested;
  await giveaways.handlers.gw({
    guildId: 'test', user: { id: 'without-role' },
    guild: { members: { fetch: async (options) => {
      requested = options;
      return { roles: { cache: { has: () => false } } };
    } } },
    deferReply: async () => {}, editReply: async (payload) => { response = payload; },
  }, ['join', '7']);
  assert.deepEqual(requested, { user: 'without-role', force: true });
  assert(response.components[0].toJSON().content.includes('<@&1551331551546056845>'));
  assert.equal(entrants.size, 0);
  assert(!queries.some(({ sql }) => sql.includes('roblox_links')));
});

for (const action of ['end', 'reroll']) {
  test(`${action} checks current roles, skips departed members and excludes previous winners`, async () => {
    entrants.clear();
    drawnWinners.clear();
    for (const id of ['valid', 'lost-role', 'departed', 'previous']) entrants.add(id);
    if (action === 'reroll') drawnWinners.add('previous');
    storedGiveaway = { ...giveaway, status: action === 'end' ? 'active' : 'ended' };
    const checked = [];
    let response;
    await giveaways.commands[0].execute({
      guildId: 'test', member: { permissions: { has: () => true } },
      options: { getSubcommand: () => action, getInteger: () => 7 },
      deferReply: async () => {},
      editReply: async (payload) => { response = payload; },
      client: {
        guilds: { fetch: async () => ({ members: { fetch: async ({ user, force }) => {
          assert.equal(force, true);
          checked.push(user);
          if (user === 'departed') throw Object.assign(new Error('Unknown Member'), { code: RESTJSONErrorCodes.UnknownMember });
          return { roles: { cache: { has: (role) => user === 'valid' && role === '1551331551546056845' } } };
        } } }) },
        channels: { fetch: async () => ({ messages: { fetch: async () => ({ edit: async () => {} }) } }) },
      },
    });
    assert(drawnWinners.has('valid'));
    assert(!drawnWinners.has('lost-role'));
    assert(!drawnWinners.has('departed'));
    if (action === 'reroll') assert(!checked.includes('previous'));
    assert(response);
  });
}

test('Discord role lookup failure aborts the draw instead of silently excluding entrants', async (t) => {
  t.mock.method(console, 'error', () => {});
  entrants.clear();
  drawnWinners.clear();
  entrants.add('valid');
  storedGiveaway = { ...giveaway, status: 'active' };
  let response;
  await giveaways.commands[0].execute({
    guildId: 'test', member: { permissions: { has: () => true } },
    options: { getSubcommand: () => 'end', getInteger: () => 7 },
    deferReply: async () => {}, editReply: async (payload) => { response = payload; },
    client: { guilds: { fetch: async () => ({ members: { fetch: async () => { throw new Error('Network failed'); } } }) } },
  });
  assert.equal(drawnWinners.size, 0);
  assert(response.components[0].toJSON().content.includes('The draw failed'));
});
