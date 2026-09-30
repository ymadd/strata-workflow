// Jev (TypeSafe System One) auto-route prediction for a Strata task.
// Mirrors SKILL.md step 4 AUTO-ROUTE; evolve is never auto-picked, so it is not an option.

export const JEV_MODEL = 'jev-1.13.0' // pinned: aliases move when new releases ship
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'

const MODE_CRITERIA: Record<string, unknown> = {
  solo: { what: 'Not worth a multi-agent run', signals: 'A quick question, one small edit, or a lookup one agent does directly' },
  review: { what: 'Scrutinize a KNOWN change', signals: 'A diff, PR, branch, commit or specific paths to review and give a verdict on' },
  sweep: { what: 'Audit the WHOLE codebase', signals: 'Health check, find issues everywhere, codebase-wide review with no specific diff' },
  panel: { what: 'Choose between several designs or options', signals: 'Propose N approaches and pick one against criteria' },
  debate: { what: 'Stress-test ONE proposition', signals: 'A go/no-go or should-we question with a single claim to argue for and against' },
  research: { what: 'Investigate an open question', signals: 'Find out why/whether/how, gather evidence from the web or data, cited conclusion' },
  scale: { what: 'Mass-produce over a KNOWN work-list', signals: 'Apply the same transform to many listed items, files or records, or a large generation job that should improve itself in rounds toward a goal' },
  delegate: { what: 'ONE heavy implementation done sequentially', signals: 'A single substantial build, migration or fix whose change is already known and does not split into independent parts' },
  debug: { what: 'Find the cause of a bug, then fix it', signals: 'Wrong behaviour, crashes, flaky or intermittent failures, regressions, "worked yesterday" — where the cause is not yet known' },
  conduct: { what: 'An implementation that splits into parallel parts', signals: 'Many endpoints, modules or files that can be changed independently in parallel' },
  ultra: { what: 'Design exploration, then build', signals: 'The WHAT itself is unclear and needs understanding and design before implementation' },
  focus: { what: 'Small exploration of an unknown surface', signals: 'Find and verify a few things when none of the other modes clearly fits' },
}

import type { Route } from '../types'
export type { Route }

export function buildRequest(task: string, domain?: string) {
  return {
    model: JEV_MODEL,
    state: { task, domain: domain ?? null },
    questions: {
      mode: {
        type: 'choice',
        instructions:
          'Which Strata orchestration mode fits this task best? Judge by what the task IS, not by its length. ' +
          'When unsure between a big mode and a small one, prefer the smaller one.',
        criteria: MODE_CRITERIA,
      },
      sensitive: {
        type: 'noul',
        instructions: 'Does the `task` involve client data, personal information, or confidential financial records?',
        criteria: {
          true: 'It names or handles customer/client records, personal data, or non-public financial data',
          false: 'It is about code, designs, public information, or generic questions',
        },
      },
    },
  }
}

export function readResponse(task: string, body: any): Route {
  const mode = body?.answers?.mode
  if (!mode?.choice) return { task, status: 'error', message: 'malformed Jev answer' }
  const ranked = Object.entries((mode.probabilities ?? {}) as Record<string, number>).sort((a, b) => b[1] - a[1])
  const second = ranked.find(([k]) => k !== mode.choice)
  return {
    task,
    status: 'ok',
    choice: mode.choice,
    confidence: mode.confidence ?? ranked[0]?.[1] ?? 0,
    second: second?.[0],
    secondP: second?.[1],
    sensitive: body?.answers?.sensitive?.noul ?? 0,
  }
}
