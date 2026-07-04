# Delivery Agent PR Summary

## Summary

Upgrade Rcode into a delivery-first coding agent runtime.

## What changed

- Adds delivery intent detection.
- Adds context budgeting and compaction.
- Adds server-side skill hints.
- Adds dedicated delivery workflow rules.
- Adds tools for git status, git diff, tests, and pull requests.
- Adds permission policy and config entries for those tools.
- Adds docs for delivery workflow and review checklist.

## Testing

Not run in connector environment.

## Risk

- PR opening currently uses GitHub CLI in the local runtime.
- Test command defaults should be validated in real projects.
