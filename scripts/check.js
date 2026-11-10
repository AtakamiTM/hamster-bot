// Offline self-test: loads every module and validates that all commands and message payloads build correctly.
import 'dotenv/config';
import { SlashCommandBuilder } from 'discord.js';
import { closeDb, initDb } from '../src/db.js';
import config from '../src/modules/config.js';
import verify from '../src/modules/verify.js';
import panels from '../src/modules/panels.js';
import surveys, { renderSurvey } from '../src/modules/surveys.js';
import giveaways, { renderGiveaway } from '../src/modules/giveaways.js';
import links, { buildLinksPanel } from '../src/modules/links.js';
import codes from '../src/modules/codes.js';
import suggestions, { renderSuggestion } from '../src/modules/suggestions.js';
import { renderBug } from '../src/modules/bugs.js';
import showcase from '../src/modules/showcase.js';
import content from '../src/modules/content.js';
import { translateToPolish } from '../src/modules/translate.js';
import reactionRoles, { renderReactionRoles } from '../src/modules/reaction-roles.js';

const all = [config, verify, panels, surveys, giveaways, links, codes, suggestions, showcase, content, reactionRoles];
let commandCount = 0;
for (const m of all) {
  for (const c of m.commands ?? []) {
    if (!(c.data instanceof SlashCommandBuilder)) throw new Error('bad command');
    c.data.toJSON();
    commandCount++;
  }
}

const payloads = {
  reactionRoles: renderReactionRoles({
    title: 'Choose your languages',
    description: 'You can choose both languages!',
    options: JSON.stringify([
      { key: '🇵🇱', emoji: '🇵🇱', role: '123', label: 'Polski' },
      { key: '🇬🇧', emoji: '🇬🇧', role: '456', label: 'English' },
    ]),
  }),
  bug: renderBug({ id: 3, title: 'Crash', description: 'It crashes', steps: '1. open', platform: 'PC', status: 'open', author: '1', created_at: Date.now() }),
  giveaway: renderGiveaway(
    { id: 1, prize: 'Test prize', description: 'Short giveaway details', host: '123', winner_count: 1, status: 'active', starts_at: Date.now(), ends_at: Date.now() + 3600_000 },
    [],
    5,
  ),
};

// These payloads read votes / links from MySQL, so they only run when the database is reachable.
let dbOk = false;
try {
  await initDb();
  dbOk = true;
} catch (err) {
  console.warn(`skip DB payloads (survey, suggestion, links): ${err.message}`);
}
if (dbOk) {
  payloads.survey = await renderSurvey({ id: 1, question: 'Which update first?', options: JSON.stringify(['Pets', 'Maps', 'Skins']), closed: 0, ends_at: Date.now() + 3600_000 });
  payloads.suggestion = await renderSuggestion({ id: 7, content: 'Add a hamster wheel\nplease', status: 'pending', author_name: 'Kamil', author_avatar: 'https://cdn.discordapp.com/embed/avatars/0.png' });
  payloads.links = await buildLinksPanel('test-guild');
}
for (const [name, p] of Object.entries(payloads)) {
  JSON.stringify(p.components.map((c) => c.toJSON()));
  console.log(`ok payload: ${name}`);
}

console.log(`ok commands: ${commandCount}`);
console.log(await translateToPolish('**Hello** world, your code is `ABC123`.'));
await closeDb();
