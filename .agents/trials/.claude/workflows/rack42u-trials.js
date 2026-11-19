export const meta = {
  name: 'rack42u-trials',
  description: 'Build the four trial apps on rack42u, two at a time, and merge the problems they meet into issues.json',
  whenToUse: 'When the user asks, in .agents/trials/ of the rack42u repository, to run a round of trials. Pass the token budget the user names as args, such as "2M"; the workflow does not start without one.',
  phases: [
    { title: 'Trials', detail: 'one agent per app, two at a time', model: 'sonnet' },
    { title: 'Merge', detail: 'the problems of every app, merged into issues.json', model: 'sonnet' },
  ],
}

// The trials of rack42u, as .agents/decisions/261119_074252-trial-apps.md decides: four apps, two
// at a time, on Sonnet 5.5, within the token budget that the user gives the run.

const ROUNDS = [
  ['links', 'chat'],
  ['watcher', 'files'],
]
// The output tokens that one trial, and the merge, may take; no round starts that the rest of the
// budget can't cover together with the merge.
const TRIAL_TOKENS = 350000
const MERGE_TOKENS = 60000

const FELL_SHORT = ['skill', 'documentation', 'api', 'error message', 'trial setup']
const COST = ['blocked', 'slowed', 'minor']

const PROBLEM = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'The short title of the problem in TRIAL.md' },
    doing: { type: 'string', description: 'What the agent was doing' },
    happened: { type: 'string', description: 'The command, and its output or the error, as they were' },
    expected: { type: 'string', description: 'What the agent expected' },
    fellShort: { type: 'string', enum: FELL_SHORT },
    where: {
      type: 'string',
      description: 'The section of the skill or of the documentation, or the part of the API, and what it lacked',
    },
    workaround: { type: 'string', description: 'How the agent went on' },
    readSource: { type: 'boolean', description: "Whether the agent had to read rack42u's source to go on" },
    cost: { type: 'string', enum: COST },
  },
  required: ['title', 'doing', 'happened', 'expected', 'fellShort', 'where', 'workaround', 'readSource', 'cost'],
}

const RESULT = {
  type: 'object',
  properties: {
    app: { type: 'string' },
    commit: { type: 'string', description: 'The rack42u commit that the app installed' },
    works: { type: 'array', items: { type: 'string' } },
    doesNotWork: { type: 'array', items: { type: 'string' } },
    checks: {
      type: 'object',
      description: 'Whether each check of SPEC.md passes',
      properties: {
        test: { type: 'boolean', description: '`bun test`' },
        check: { type: 'boolean', description: '`bun check.ts`' },
        change: { type: 'boolean', description: 'The change while the app runs, where the spec asks for one' },
      },
      required: ['test', 'check', 'change'],
    },
    problems: { type: 'array', items: PROBLEM },
  },
  required: ['app', 'commit', 'works', 'doesNotWork', 'checks', 'problems'],
}

const ISSUE = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'The title of the issue, without a prefix' },
    kind: { type: 'string', enum: ['bug', 'documentation', 'enhancement'] },
    apps: { type: 'array', items: { type: 'string' }, description: 'The apps that met the problem' },
    commit: { type: 'string', description: 'The rack42u commit that the apps installed' },
    doing: { type: 'string' },
    happened: { type: 'string', description: 'The commands and output of every app that met it, as they were' },
    expected: { type: 'string' },
    fellShort: { type: 'string', enum: FELL_SHORT },
    where: { type: 'string' },
    workaround: { type: 'string' },
    readSource: { type: 'boolean' },
    cost: { type: 'string', enum: COST, description: 'The highest cost of the problem in any app' },
    sources: {
      type: 'array',
      description: 'The problems of TRIAL.md that this issue merges',
      items: {
        type: 'object',
        properties: { app: { type: 'string' }, title: { type: 'string' } },
        required: ['app', 'title'],
      },
    },
  },
  required: [
    'title', 'kind', 'apps', 'commit', 'doing', 'happened', 'expected',
    'fellShort', 'where', 'workaround', 'readSource', 'cost', 'sources',
  ],
}

const MERGED = {
  type: 'object',
  properties: {
    issues: { type: 'array', items: ISSUE },
    leftOut: {
      type: 'array',
      description: "Problems that only the trial agent's own mistake caused, and that the skill or the documentation couldn't have prevented",
      items: {
        type: 'object',
        properties: { app: { type: 'string' }, title: { type: 'string' }, why: { type: 'string' } },
        required: ['app', 'title', 'why'],
      },
    },
  },
  required: ['issues', 'leftOut'],
}

function trialPrompt(app) {
  return [
    `Build the trial app \`${app}\`, in the subfolder \`${app}/\` of this folder, as \`${app}/SPEC.md\` asks.`,
    `This folder's CLAUDE.md says how to work: what you may know of rack42u, how to add it, which commands you may run, and how to keep \`${app}/TRIAL.md\`. Write each problem into \`${app}/TRIAL.md\` when you meet it.`,
    `When the app is done, or when you can't take it further, finish \`${app}/TRIAL.md\` with its summary.`,
    'Then answer with the result: the rack42u commit you installed, what works and what does not, whether each check of the spec passes, and every problem of TRIAL.md, in its fields.',
  ].join('\n\n')
}

function mergePrompt(results) {
  return [
    'These are the results of a round of trials, in which agents built apps on rack42u, knowing it only from its skill and its documentation:',
    '```json\n' + JSON.stringify(results, null, 2) + '\n```',
    "You can also read each app's `TRIAL.md` in its subfolder of this folder, but change nothing there.",
    'Merge the problems into the list of issues to file for rack42u, one per distinct problem:',
    [
      '- Problems that several apps met, with one cause, are one issue: it names every app, and keeps the commands and output of each.',
      "- A problem that only the trial agent's own mistake caused is an issue only when the skill or the documentation could have prevented it. Otherwise leave it out, and say why.",
      '- `kind` is `bug` when rack42u does not do what its documentation says; `documentation` when the skill or the documentation is wrong, unclear, or missing something; and `enhancement` when the API or an error message should change.',
      '- Keep commands and output as they were: they are the evidence.',
    ].join('\n'),
    'Write the result to `issues.json` in this folder, as the JSON you answer with, and answer with it.',
  ].join('\n\n')
}

/**
 * The output tokens that `args` names: a number, a string such as "2M", "+2M", or "2000k", or an
 * object with such a `budget`; null when it names none.
 */
function budgetOf(value) {
  const given = typeof value === 'object' && value !== null ? value.budget : value
  if (typeof given === 'number') return Number.isFinite(given) && given > 0 ? given : null
  if (typeof given !== 'string') return null
  const match = /^\+?\s*(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(given.trim())
  if (match === null) return null
  const unit = { '': 1, k: 1000, m: 1000000 }[match[2].toLowerCase()]
  const tokens = Number(match[1]) * unit
  return tokens > 0 ? tokens : null
}

// The budget comes from a "+2M" directive in the user's request, or, since such a directive can
// fail to register, from the budget that the user names, which the session passes as args.
const total = budget.total ?? budgetOf(args)
if (total === null) {
  log('A round of trials needs a token budget: pass the one the user names as args, such as "2M".')
  return { error: 'no token budget' }
}
const remaining = () => Math.max(0, total - budget.spent())
log(`Budget: ${Math.round(total / 1000)}k output tokens, ${budget.total ? 'from the directive' : 'from args'}.`)

phase('Trials')
const results = []
for (const round of ROUNDS) {
  const needed = round.length * TRIAL_TOKENS + MERGE_TOKENS
  if (remaining() < needed) {
    log(
      `Not started, for lack of budget: ${round.join(' and ')}, which need ${needed / 1000}k tokens with the merge; ${Math.round(remaining() / 1000)}k are left.`,
    )
    for (const app of round) results.push({ app, notStarted: 'the budget could not cover it' })
    continue
  }
  const done = await parallel(
    round.map(
      (app) => () =>
        agent(trialPrompt(app), { label: `trial:${app}`, phase: 'Trials', schema: RESULT, model: 'sonnet' }),
    ),
  )
  done.forEach((result, index) => {
    const app = round[index]
    if (result === null) {
      log(`The trial of ${app} ended without a result; its TRIAL.md holds what it recorded.`)
      results.push({ app, failed: 'the trial agent ended without a result' })
    } else {
      log(`${app}: ${result.problems.length} problem(s); test ${result.checks.test}, check ${result.checks.check}, change ${result.checks.change}.`)
      results.push(result)
    }
  })
  log(`Spent so far: ${Math.round(budget.spent() / 1000)}k of ${Math.round(total / 1000)}k output tokens.`)
}

phase('Merge')
const merged = await agent(mergePrompt(results), { label: 'merge', phase: 'Merge', schema: MERGED, model: 'sonnet' })
if (merged === null) {
  log('The merge ended without a result; the results of the trials are in the return value.')
  return { results, merged: null }
}
log(`${merged.issues.length} issue(s) to file, ${merged.leftOut.length} problem(s) left out; issues.json holds them.`)
return { results, merged }
