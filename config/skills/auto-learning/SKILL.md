---
name: auto-learning
description: Capture verified, reusable lessons from completed Rcode tasks. Use when explicitly reviewing project learnings or immediately saving a confirmed user preference, project constraint, reliable fix, reusable pattern, or repeatable workflow. 自动学习并沉淀经过验证的可复用经验。
---

# Auto Learning

Save concise lessons that improve later work in the same project. Rcode also runs an independent verifier after eligible completed tasks, so do not force a record merely because this skill is loaded.

## Learning Workflow

1. Finish and verify the requested work before saving a learning record.
2. Identify only knowledge that is likely to matter again:
   - a stable user preference;
   - a project-specific convention or constraint;
   - a reusable implementation or debugging pattern;
   - a confirmed root cause and reliable fix;
   - a repeatable local workflow or environment requirement.
3. Skip ordinary progress, unverified guesses, one-off outputs, raw logs, and facts already obvious from project files.
4. Call `record_learning` only for a clearly qualified lesson. Prefer one strong record over several overlapping records.
5. Provide a stable `dedupeKey` that names the underlying concept so later confirmations update the record instead of duplicating it.
6. Keep the insight self-contained and actionable. Include concrete verification evidence.

## Safety Rules

- Never store passwords, API keys, tokens, cookies, private message contents, personal data, or complete environment dumps.
- Never present an assumption as learned fact. If the result was not verified, do not record it.
- Do not use learning records as a task log or transcript.
- Use category `preference` for user choices, `project` for repository conventions, `pattern` for reusable techniques, `bugfix` for confirmed fixes, and `workflow` for repeatable procedures.
- Set importance from 1 to 5. Use 4 or 5 only when the lesson strongly affects future correctness or safety.

## Record Shape

Provide:

- `title`: a specific summary, usually under 60 characters;
- `insight`: what future work should know or do;
- `category`: one of the supported categories;
- `evidence`: the verification, test, file, or observed behavior that supports it;
- `importance`: 1 to 5.
- `dedupeKey`: a short stable concept key, such as `workflow-run-project-formatter`.

The tool deduplicates equivalent records. Do not rephrase and save the same lesson repeatedly.
