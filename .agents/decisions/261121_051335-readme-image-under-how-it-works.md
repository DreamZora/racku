# Decision: The README's image under "How it works", not at its top

Status: accepted

## Background

- [A README read at a glance, with an image rendered from HTML and a minimal hot-reload example](261121_044629-readme-at-a-glance.md#the-readmes-shape) puts the image first in the README, above its name.
- The user, on seeing that README on 2026-11-21: "Do not put image at top of README.md".
- [A README that explains rack42u](261119_055008-documentation.md#the-readme) puts the README's diagram in its part on how rack42u solves the problem, which the README's "How it works" is.

## Decision

- The README opens with its name, its sentence of what rack42u does, and its line of links, without the image.
- The image heads "How it works", above its four lines, with the comment of its source's hash beside it.
- The rest of [A README read at a glance](261121_044629-readme-at-a-glance.md) stands.

## Alternatives

- **Under the line of links**: the image would still be the first thing after the name.
- **At the end of the README**: far from the part that it shows.

## Impact

- `README.md`, and the section that `test/readme.test.ts` names for the image.

## Implementation

- `README.md`: the image and its comment open "How it works".
- `test/readme.test.ts`: its test of the image names `README.md#how-it-works`.

## Confirmation

- The user asked for this on 2026-11-21, after the README with the image at its top: "Do not put image at top of README.md". The Agent chose where the image goes instead: the part where the documentation decision puts the README's diagram.
