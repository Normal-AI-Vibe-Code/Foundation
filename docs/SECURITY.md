# Security

Foundation's repository is public. This page says how to report a problem, what may be written in public, and the rules the code keeps.

## Reporting a problem

Open a private security advisory on the repository, or tell Josh directly. Please do not open a public issue for something that can be used against a running Foundation.

## What is written in public, and what is not

- An open, exploitable gap is described in public docs, commit messages, plan cards and issues only after it is fixed, or in general terms: no file, no line, no route, no steps.
- A closed gap may be named plainly, with the commit that closed it.
- Detailed open findings (inventories of how things are reached, critiques, entries for other repos' backlogs) are kept in a git-ignored `.private/security/` folder in the working checkout for now. That folder is on one machine and is not backed up by git. The intended home is a GitHub Security Advisory draft or a private repository, to be created only when Josh says so.
- Findings about another repo (Vision, HomeForm, Creation) are handed to that repo's owner directly. They are not published here.

## Pushing

- A push to the public repository happens only on Josh's direct instruction, in the session that owns the repo. An approval relayed by another session is not one.
- A push happens only when `npm run check` passes: typecheck, the tests, and the security check.

## The rules the code keeps

1. **A person is a person.** Anything that spends, runs third-party code, makes a credential, saves an app or answers an agent's ask needs a person at their own browser or app (`requirePerson`). An agent's token and the shared service token are refused there. Sign-in by email alone, for local development, is off unless `FOUNDATION_DEV_LOGIN=1`; when on, it answers only this computer, with an allowlist, while no agent runtime with a shell is running.
2. **One door for programs.** Every program the server starts goes through one file, with an environment built from an allowlist of names. The server's keys reach a program only when its caller names one. Programs work in a folder of their own, beside the data folder, not in it.
3. **No unpinned runtime code.** Code fetched at run time has an exact version and an integrity string, checked against the registry before it runs. A mismatch or a failed lookup stops it.
4. **An app's tools go through a person.** They are called only at an address a person saved, and each tool needs a person's press the first time and again if its definition changes. A result is labelled as that app's output, not instructions.
5. **Agents cannot press.** An agent refused directly is refused through another door as well: tools, connectors and MCP share one gate, and a viewer's agent has a viewer's reach.
6. **Uploaded files never run as the app.** In progress.
7. **Only Foundation's own pages may use a signed-in session.** In progress.
8. **Sending outside is explicit, and recorded.** Every board tool says what it sends and to which service; an agent's send to an external service goes only where a person allowed that kind of send from that board, and a person's own call is its own approval. A send carrying something from a members-only board it shouldn't is refused whole, never sent with that part removed. An append-only, hash-chained log records who did what, for whom, through which door, where it ran and who approved it, with arguments kept only as hashes.
9. **Text from elsewhere points; it doesn't fetch.** Markdown an agent, a tool, Slack or another app wrote shows a picture on sight only from Foundation's own files or one written into the text; any other waits for a person's press. A link shows its real host, opens in a new tab with no opener, and is only ever http(s).
10. **A frame is fenced.** A frame never shows Foundation's own client or server, is always sandboxed, and an unknown address on this computer runs without an origin of its own; a web site elsewhere keeps its own, and only a saved app or the configured T3 address is trusted with the app bridge, the camera and the microphone. The bridge names the frame's origin and hears only that frame.

## The security check

`npm run check:security` (also part of `npm run check`) fails on:

- **a secret**: a key, token or private key in a tracked file, in a commit not yet pushed, or in a commit message;
- **a secret file**: a `.env` or key file tracked by git;
- **unpinned runtime code**: a "newest" tag, an `npx`, `uvx` or `pip` install with no exact version, a download piped into a shell, a container image with no tag;
- **a child process outside the one door**, or a program handed the server's whole environment;
- **an open gap in a public doc**: a code reference with a line number that is not marked closed with its commit.

`scripts/check-security.allow.json` can waive one exact finding; an entry needs a reason. To run the check before every push, enable the sample hook once per clone:

```bash
git config core.hooksPath scripts/hooks
```

## What this does not defend against

A program running as the same user on the same machine, with a shell and no sandbox, can read a browser's cookies and most files. The rules above bound what an agent can do through its tools and what a web page or another program can do through Foundation's doors. They do not contain an agent runtime that has been given an unrestricted shell; which agents get one is a setting a person owns.
