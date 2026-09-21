<!--
The title becomes a release note, so it is checked: conventional prefix,
lowercase subject, no full stop. `feat:`, `fix:`, `docs:`, `ci:`, ...
A change that breaks callers gets a `!` - `feat!: ...`.
-->

## What this changes

<!-- One paragraph. What is different for a caller after this is merged? -->

## Why

<!--
The reasoning, not the mechanics. In two years the diff will still be readable
and the reason will not.
-->

---

## Both editions, or neither

LicenseClient ships two editions that must behave identically. A pull request that
changes behaviour in one and not the other is not merged, **even if both suites
are green** - that only means the tests are not covering the change yet.

- [ ] The behaviour is the same in both editions
- [ ] A test covers it in both, or this change has no behaviour
- [ ] Both suites pass locally

## Version impact

Pick one. The table in [CONTRIBUTING.md](../CONTRIBUTING.md) is the authority.

- [ ] **patch** - a bug fix with no behaviour change
- [ ] **minor** - a new capability, with existing behaviour unchanged
- [ ] **major** - a change to what an existing call returns, or a removal
- [ ] none - documentation, tests or CI only

- [ ] `CHANGELOG.md` records it, or this change does not belong in it

## If a shared vector changed

<!-- Delete this section if `shared/` is untouched. -->

- [ ] I read the vector diff line by line rather than accepting it
- [ ] I did **not** regenerate the vectors to make a failing test pass
- [ ] The description above says what callers will see change
