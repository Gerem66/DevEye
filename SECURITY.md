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
what a live server can read: everything when password-based encryption is off,
and the protected tier too while a session is unlocked) is not a vulnerability.
Anything that breaks a guarantee it makes is, and is the most valuable report
you can send.

Out of scope: findings that require physical access or an already compromised
administrator account, missing hardening headers without a demonstrated impact,
and automated scanner output without a working proof.

## What is verified automatically

Every push runs the unit tests of the server, the client, the modules and the
agent; a test that checks every query of the core repositories against the
guard it declares (workspace, account, device); a check that prepares, on a
throwaway MySQL database, every SQL statement the server can send, then reads
each one again and rejects any that names a workspace table without bounding
it to a workspace, unless a written exemption gives the reason; a pass
that opens every module in a real browser; and the journeys of the "Tests and
debugging" page, played by throwaway accounts against a server started for the
occasion: signing up and deleting an account, a workspace shared by two, two-
factor authentication, the emailed sign-in code, the forgotten password, and
those the modules declare. Among them, an isolation journey for each module
that has declared its probes: a second account attempts every command of the
module that takes an id, from another workspace and then as a member with no
rights, and everything must be refused without returning anything. The modules
of the repository that do not have their probes yet are named in
`src/features/_sdk/register.isolation.test.ts`. Dependency advisories are checked every week for
the agent's crates and for the server's npm packages.

Code that reads input written by someone else is also run against randomly
drawn input, a hundred draws per property on every push and five thousand
every week on a seed nobody chose: the IMAP commands of a mail client, the
MIME tree of a received message, the frames of an agent, an imported bank
statement, the body of a public form. The properties are the same everywhere:
nothing throws but the expected error, what comes out satisfies the contract
that receives it, and the cost stays bounded by the size of the input. The
other readers (public types, agent, private modules) are not covered yet.

These checks are written and maintained by the project itself. No third party
has audited DevEye or tested it for intrusion yet: read the guarantees of the
security model as claims the code and its tests back, not as certified ones.
