# Session Desk

A shared studio desk for roleplay recording sessions. The engineer starts a session and sends the link round. Everyone in the room sees the same desk and hears the same mix, in sync, through their own browser.

## Run your own copy (one click)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jovantomic364-afk/session-desk)

**Who needs what:** players joining a session need nothing, no accounts at all. Only the person setting up a copy needs a free **GitHub** account and a free **Cloudflare** account.

The button copies this project into your own GitHub account and deploys it to your own Cloudflare account. You get your own address, e.g. `https://session-desk.<you>.workers.dev`. It runs on Cloudflare's free plan, and you don't need a payment card.

No GitHub account? Use **Deploy by hand** below instead. It only needs Node.js and the Cloudflare account.

## Deploy by hand

You need Node.js and a Cloudflare account.

```bash
npm install
npx wrangler login
npx wrangler deploy
```

To deploy changes later, run `npx wrangler deploy` again. To try it locally, run `npx wrangler dev` and open http://localhost:8787 in two browser windows.

## Why it costs nothing to host

- **No R2, no card.** Stems and shared bounces are stored inside each session's own Durable Object, and deleted with the session.
- **Workers Free plan can't bill you.** If a daily limit is reached, the desk stops taking new requests until midnight UTC (01:00 UK summer time). Nothing is charged.
- **The page is free to serve.** The page, script and styles are static files. Cloudflare serves those free and without limit, and they don't count towards the daily limit. Only `/api/*` runs the Worker.
- **Idle sessions cost nothing.** Keep-alives are answered by Cloudflare without waking the session's room. The room only wakes up when someone actually does something.

| Free plan limit (per day unless noted) | What uses it here |
| --- | --- |
| 100,000 Worker requests | Joining, stem uploads and downloads, bounce sharing |
| 100,000 Durable Object requests | The above plus desk changes and chat (20 WebSocket messages count as 1) |
| 13,000 GB-s Durable Object time | Time the session's room is awake, mostly while someone is mixing |
| 5 GB stored in total, 1 GB per session | Stems and bounces; a session is capped at 900 MB |

As a rough estimate, that's on the order of 100 hour-long sessions a day before limits start to bite. If they do, people see an error until the reset, and you're still not charged.

**Keep your account on the Workers Free plan.** If your Cloudflare account is on Workers Paid ($5 a month), usage over the included amounts *is* billed. In that case, host the public copy on a separate free Cloudflare account. You can check under *Workers & Pages → Plans* in the Cloudflare dashboard.

## The desk

**Who controls it**
- **Start a session** makes a 6-character code. The browser that made it is the **engineer**. Send the invite link from the **in room** menu.
- Whoever **has the desk** controls everything that changes the session. Everyone else watches and hears it.
- The engineer can **Hand desk** to anyone and **Take the desk** back.

**Stems**
- Drop WAV/MP3 files, or Suno's stems zip as it is.
- They upload once and load for the whole room.
- Each stem has a limit of 95 MB, and each session has a limit of 900 MB.

**Song map**
- **Sections:** set a loop on the ruler, open **Song map**, then pick a name (Intro, Verse, Chorus…). The sections show as coloured blocks on the ruler. Click one to loop it.
- **Markers:** press **M** while playing, or use **+ At playhead**. Rename them in the Song map. Click a pink marker on the ruler to jump to it.

**Channel rack (FX / Rack button)**
- The rack has, in signal order:
  - Low Cut
  - Phone Box
  - Grit (saturation)
  - Squeeze (compressor)
  - VQ-3 EQ
  - Doubler
- Each strip also has sends to the **Del Perro Hall** reverb and the **Grove St Echo** delay. The echo's timing follows the BPM; change it on the master strip.

**Master rack (top of the master strip)**
- **Low Cut** and the **VQ-3 EQ** on the whole mix.
- **Lombank Limiter** at the very end, after the master fader. Turn up **Push** to make the mix louder; the Reduction meter shows how hard it's working.
- With the limiter on, a final safety ceiling keeps the mix under 0 dB, so bounces don't clip.
- Aim for about −14 LUFS on the loudness meter.

**Mix snapshots**
- Press **STORE**, then **A** or **B**, to save the current mix.
- Press **A** or **B** to switch between them. The whole room hears the comparison.

**Tidy-up**
- **Reorder** tracks by dragging the coloured grip on the left of a track.
- **Recolour** a track by clicking that grip.
- **+ Bus** adds a group fader. Click a strip's **→ Master** label to route the track to a bus.

**Click and count-in**
- **Click** plays a metronome at the session tempo.
- **1-2-3-4** counts in one bar before playback starts.
- Both go to your own speakers only and never into the bounce.

**Meters**
- The mixer shows a live master spectrum and loudness in LUFS (momentary, short-term, integrated).
- Streaming services play songs at about −14 LUFS.

**Bounce mix**
- Renders the mix as a WAV. **Save WAV** keeps it on your computer.
- **Share with room** uploads it so everyone can download it from **Bounces**. The last 12 shared bounces are kept.

**Talkback**
- A chat panel for everyone in the room, not just whoever has the desk.
- Messages sent while the song plays get a pink bar tag. Whoever has the desk can click it to jump there.
- People joining or leaving shows up in the chat.
- Anyone who joins late sees the last 80 messages, and the chat is deleted with the session.

**Credits**
- A session card: studio, track, artist, engineer, date, length, tempo, key and stems.
- **Save image** gives you a PNG; **Copy text** gives you plain text for a post.

**Your own controls**
- Monitor volume and zoom only affect you.
- The audio engine pauses a few seconds after playback stops, so an idle desk uses almost no CPU alongside the game.

**Shortcuts**

| Key | Action |
| --- | --- |
| Space | Play / pause |
| Enter | Back to start |
| L | Loop |
| M | Marker |
| C | Click |
| T | Talkback |
| R | REC light |
| X | Mixer |
| + / − | Zoom |

## Clean-up

A session and everything in it (stems and shared bounces) is deleted when:

- the engineer clicks **End session and delete stems**, or
- nobody has been connected for 20 minutes, or
- the session reaches 24 hours old.

Change these in `src/index.js` (`EMPTY_MS`, `MAX_MS`).

## Files

- `src/index.js`: Worker routes and the `Room` Durable Object (live sync, desk control, audio storage, clean-up)
- `public/index.html`: page layout and styles
- `public/app.js`: the desk
- `public/worklet.js`: loudness meter (runs on the audio thread)
- `wrangler.toml`: the static page and the Durable Object binding (no R2)
