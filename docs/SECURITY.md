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
- **A push to `main` is a release.** The desktop release workflow builds and publishes a signed desktop app from every push to `main` that changes code, and installed apps update from it. So before a push, a person also checks the packaged desktop app: that it signs in, that the agent answers a turn, and that T3 starts.

## The rules the code keeps

1. **A person is a person.** Anything that spends, runs third-party code, makes a credential, saves an app or answers an agent's ask needs a person at their own browser or app (`requirePerson`). An agent's token and the shared service token are refused there. Sign-in by email alone, for local development, is off unless `FOUNDATION_DEV_LOGIN=1`; when on, it answers only this computer, with an allowlist, while no agent runtime with a shell is running.
2. **One door for programs.** Every program the server starts goes through one file, with an environment built from an allowlist of names. The server's keys reach a program only when its caller names one. Programs work in a folder of their own, beside the data folder, not in it.
3. **No unpinned runtime code.** Code fetched at run time has an exact version and an integrity string, checked against the registry before it runs. A mismatch or a failed lookup stops it.
4. **An app's tools go through a person.** They are called only at an address a person saved, and each tool needs a person's press the first time and again if its definition changes. A result is labelled as that app's output, not instructions.
5. **Agents cannot press.** An agent refused directly is refused through another door as well: tools, connectors and MCP share one gate, and a viewer's agent has a viewer's reach.
6. **Uploaded files never run as the app.** A file shows in place only if its type is passive (pictures, video, sound, PDF, plain text, 3D models); anything else, and always a page, a script, a stylesheet or an SVG, is a download of opaque bytes. Every file answer is sandboxed and says not to guess its type.
7. **Only Foundation's own pages may use a signed-in session.** A request that changes something, or opens a socket, with the sign-in cookie must come from Foundation's own page; other pages, on this computer or elsewhere, are refused. The server answers only to its own names. A limit: a browser extension a person installed and gave access to Foundation's address is treated by the browser as that page, so the server cannot tell them apart; such an extension can already read the page and its cookies.
8. **Sending outside is explicit, and recorded.** Every board tool says what it sends and to which service; an agent's send to an external service goes only where a person allowed that kind of send from that board, and a person's own call is its own approval. A send carrying something from a members-only board it shouldn't is refused whole, never sent with that part removed. An append-only, hash-chained log records who did what, for whom, through which door, where it ran and who approved it, with arguments kept only as hashes.
9. **Text from elsewhere points; it doesn't fetch.** Markdown an agent, a tool, Slack or another app wrote shows a picture on sight only from Foundation's own files or one written into the text; any other waits for a person's press. A link shows its real host, opens in a new tab with no opener, and is only ever http(s).
10. **A frame is fenced.** A frame never shows Foundation's own client or server, is always sandboxed, and an unknown address on this computer runs without an origin of its own; a web site elsewhere keeps its own, and only a saved app or the configured T3 address is trusted with the app bridge, the camera and the microphone. The bridge names the frame's origin and hears only that frame.

## What the pass of 2026-11-18 closed

Each was open in the public code before that day. The commit named is the one that closed it.

| What was possible | Closed in |
|---|---|
| Sign-in by email alone was on by default; an agent's token could start a job or an agent run, make itself a longer-lived token, save an app, and make the server fetch an address | 46c55d4 |
| Programs the server started inherited its keys and worked in the data folder; one was fetched unpinned | b574a9e, bbd666c, 7e11ff6 |
| An app's tools were called at an address taken from a card, with no person asked | 8db81ff, 9487956 |
| The Slack agent ran with a shell and file tools, with permission checks bypassed, for anyone who messaged it | 929d6ed |
| Another person's reply in a Slack thread ran the agent with that person's Slack token; a hardcoded sign-in secret; message text in logs | 7c16cad |
| An uploaded file could run as the app | bca7298 |
| A machine's terminal and desktop took input from an agent's connection, and an agent could give itself leave to use a desktop | dfe2fb8 |
| Any page on any local port could use a signed-in session; the server answered to any host name | 093cbff, a153d83 |
| Repo reads could leave a repository's name | eb716a8 |
| The local model lookup asked an address the caller chose | d1b82b2 |
| A members-only board's files, pictures and settings could be reached without membership; an agent's token could change roles | dae199b |
| Messages could be sent to Slack under a person's name without the person; a read could start an agent run | c9cda12, 1a852cd |
| The board agent loaded the person's own Claude Code settings and servers, and kept built-in tools | c169411, bb42ebf |
| The example settings turned dev sign-in on | 3862383 |
| A viewer could start a job | e8feca4 |
| Any signed-in user's search used one person's Slack token; a Slack channel could be read from any board | 3eb09fa |
| Remote pictures in rendered text were fetched on sight; links hid where they went | 3ea4bf2, 9f87368 |
| A frame could show Foundation itself, some frames had no sandbox, and the app bridge posted to any origin | f4109c4, cd664df |
| Agents sent to outside services with no one's say | 73f4156, 1b4f6dc, c9efc66 |
| There was no record of who did what | 9d9cf21, 112292b |
| Finishing a desktop sign-in in a browser handed a session to whoever had started it, unseen | 22145f6 |
| A job could run on any local path with a goal the person never saw | 5c6e615 |
| A page elsewhere could sign a browser in; dev sign-in was fenced against one kind of shell only | 6b3e14e |
| A proxy address carrying a sign-in reached every program | 1c11938 |

What is still open is listed in general terms in `SPEC.md` section 7.

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
