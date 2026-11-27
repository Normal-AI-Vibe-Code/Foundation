# Link-preview pictures are Foundation's own files (2026-11-26)

A throwaway server (temp data, dev login) on :4460 with the client on :1460. A message in #general with
https://github.com/nodejs/node got its preview within 5 s, and the preview's `image` was `/files/f_a7622e3d7fe79e45`,
a png the server fetched through the link-preview guard and archived under the chat board, carried by the message
(`chat_files`).

In the page, the card's picture was a 256×128 image read from that file. No "Load image" button showed, and the
resource timing listed no request to github.com or githubassets.com: the viewer's browser never asked GitHub.

- `preview-card.png`: the card
- `channel.jpg`: the channel
- `apps/server/test/chat.test.ts` "link previews": the picture's own guard (a redirect to a private address is
  refused, svg is refused), fetched once, kept as image/png under `chat`, readable by a private channel's member and
  not by a non-member or an admin, and not an attachment
