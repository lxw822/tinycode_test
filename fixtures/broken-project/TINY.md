# broken-project

Fixture used by the flagship E2E test.

- `npm test` (node --test) fails because `add()` subtracts.
- The scripted mock model must: run tests → read math.js → edit → rerun tests.
