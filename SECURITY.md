# Security Policy

## Supported versions

Only the latest release receives security fixes. DevEye ships as a single
rolling version: update to the latest tag before reporting, the issue may
already be fixed.

The agent updates itself from signed releases. An agent that is more than one
release behind is not supported.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private reporting instead:
[Report a vulnerability](https://github.com/Gerem66/DevEye/security/advisories/new).

Please include:

- what an attacker can do, and from which position (anonymous visitor, workspace
  member, compromised server, compromised agent host);
- the steps to reproduce it, on a self-hosted instance you own;
- the version or commit you tested.

Do not test against an instance you do not own, the hosted service included,
and do not access data that is not yours.

## What to expect

DevEye is maintained by one person. You will get an acknowledgement within
7 days, and an assessment within 14. A confirmed vulnerability is fixed in the
next release, and credited to you in its advisory unless you prefer otherwise.
There is no bug bounty.

Please give the fix 90 days, or until it is released, before you publish.

## Scope

[Docs/SECURITY_MODEL.md](./Docs/SECURITY_MODEL.md) states what DevEye protects
and what it does not. A limit that document already acknowledges (for example,
what a live server can read when password-based encryption is off) is not a
vulnerability. Anything that breaks a guarantee it makes is, and is the most
valuable report you can send.

Out of scope: findings that require physical access or an already compromised
administrator account, missing hardening headers without a demonstrated impact,
and automated scanner output without a working proof.
