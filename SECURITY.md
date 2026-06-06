# Security Policy

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security vulnerabilities.

Email **security@pathrule.io** with:

- a description of the issue and its impact,
- steps to reproduce (a minimal proof of concept if possible),
- the affected version / commit.

We aim to acknowledge reports within 3 business days and to keep you updated as we
investigate. We will credit reporters who wish to be named once a fix is released.

## Scope

This repository is the **open core** of Pathrule: the local, account-free knowledge
layer (`@pathrule/core`, the embedded SQLite backend, and the local CLI modules). The
local edition makes no network calls except to the bring-your-own-key providers you
explicitly configure, and stores data in a local SQLite file you own.

Cloud/hosted infrastructure, authentication, and billing are **not** part of this
repository and are handled separately; please still report anything you find through
the same address above.

## Supported versions

Security fixes target the latest released version of `@pathrule/cli` / `@pathrule/core`.
Please upgrade to the latest release before reporting, where practical.
