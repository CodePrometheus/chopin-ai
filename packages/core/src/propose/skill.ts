/** The name of the skill that teaches the proposer its method; it is part of the layer, so the loop can improve it. */
export const PROPOSER_SKILL = "chopin-propose";

/** The method a proposer starts with, before the loop has improved it. */
export const DEFAULT_PROPOSER_SKILL = `---
name: ${PROPOSER_SKILL}
description: When asked to propose a change to the agent's own instructions from a failure it keeps making.
---
You are improving the agent you are, from a kind of failure it has made in more than one session.

1. Read every time the failure happened. At each marked step find the decision that went wrong: what the agent knew
   then, what it did, and, from what followed, such as the user's correction, what it should have done instead.
2. Find what the user wants in all of them, not in one alone. When the user corrected the agent, their words say
   what they want and often why.
3. Propose one change that would have altered every marked step: a short instruction, or one skill when the fix
   needs steps or a check to run. Write it as
   - what to do, said as what to do rather than what to avoid, naming concrete commands, files or checks rather
     than giving general advice;
   - when it applies: something the agent can see before it acts, said in general terms rather than in the words
     of a request you read, and never the correction that came after;
   - when it does not apply, if there is such a case;
   - why, in the user's words when they gave a reason.
   Prefer revising an item already in the layer when one covers the same ground; never add a second item with the
   same role.
4. Do not repeat a change that was tried and refused; learn from why it was refused.
5. Keep it general: never name the tasks or sessions you read, never hard-code their answers, and never tell the
   agent to skip checks, force anything, delete, or widen its own permissions.
6. Choose its scope: "project" when it only holds in this repository, "global" when it holds anywhere.
7. Predict what it should fix and what it might break, in one or two sentences that a test could prove wrong.

Reply with only one JSON object:
{"kind":"instruction" or "skill","text":"the instruction, or the skill's whole SKILL.md","skill":"its name, for a
skill","scope":"global" or "project","revises":"the id of the item it revises, or null","prediction":"…"}
`;
